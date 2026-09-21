// Channels the bot is an admin of, plus posting to them from the admin panel.
//
// How it works: Telegram has no "list my channels" call for bots. A bot only
// learns about a channel when Telegram sends it a `my_chat_member` update
// (added / promoted / removed). We save those in `bot_channels` and let the
// admin post to them.
//
// Needs this table (run channels.sql once in the Supabase SQL Editor).
//
// Exposes:
//   handleMyChatMember(botId, update)   -> called from server.js on that update
//   routes:  GET  /api/admin/channels
//            POST /api/admin/channels/refresh
//            POST /api/admin/channels/post

module.exports = function attachChannels(app, db, { requireAdmin, getEntry }) {
  const TYPES = new Set(['channel', 'supergroup', 'group']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- called when Telegram tells us the bot's status in a chat changed ----
  async function handleMyChatMember(botId, upd) {
    try {
      const chat = upd && upd.chat;
      const member = upd && upd.new_chat_member;
      if (!chat || !member || !TYPES.has(chat.type)) return;

      const status = member.status;
      const isAdmin = status === 'administrator' || status === 'creator';
      const canPost = chat.type === 'channel'
        ? isAdmin && member.can_post_messages !== false
        : isAdmin || status === 'member';

      if (status === 'left' || status === 'kicked') {
        // Removed: forget it so the admin never tries to post there.
        await db.from('bot_channels').delete()
          .eq('bot_id', botId).eq('chat_id', chat.id);
        return;
      }

      await db.from('bot_channels').upsert({
        bot_id: botId,
        chat_id: chat.id,
        title: chat.title || null,
        username: chat.username || null,
        chat_type: chat.type,
        is_admin: isAdmin,
        can_post: canPost,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'bot_id,chat_id' });
    } catch (err) {
      console.error('my_chat_member save error:', err.message);
    }
  }

  // ---- list channels (all bots, or one) ----
  app.get('/api/admin/channels', requireAdmin, async (req, res) => {
    try {
      let q = db.from('bot_channels')
        .select('bot_id, chat_id, title, username, chat_type, is_admin, can_post, updated_at')
        .order('title', { ascending: true });
      if (req.query.bot_id) q = q.eq('bot_id', Number(req.query.bot_id));
      const { data, error } = await q;
      if (error) throw error;
      res.json(data || []);
    } catch (err) {
      console.error('list channels error:', err);
      res.status(500).json({ error: 'Could not load channels' });
    }
  });

  // ---- re-check saved channels with Telegram (drops ones the bot left) ----
  app.post('/api/admin/channels/refresh', requireAdmin, async (req, res) => {
    try {
      const { data: rows, error } = await db.from('bot_channels').select('bot_id, chat_id');
      if (error) throw error;
      let checked = 0, removed = 0, updated = 0;
      for (const r of rows || []) {
        const entry = getEntry(r.bot_id);
        if (!entry) continue; // bot is stopped; leave it alone
        checked++;
        try {
          const me = entry.me || (entry.me = await entry.bot.getMe());
          const m = await entry.bot.getChatMember(r.chat_id, me.id);
          const isAdmin = m.status === 'administrator' || m.status === 'creator';
          const gone = m.status === 'left' || m.status === 'kicked';
          if (gone) {
            await db.from('bot_channels').delete().eq('bot_id', r.bot_id).eq('chat_id', r.chat_id);
            removed++;
          } else {
            await db.from('bot_channels').update({
              is_admin: isAdmin,
              can_post: isAdmin && m.can_post_messages !== false,
              updated_at: new Date().toISOString(),
            }).eq('bot_id', r.bot_id).eq('chat_id', r.chat_id);
            updated++;
          }
        } catch (err) {
          // Telegram says the chat is gone / bot was removed while we were offline.
          const code = err && err.response && err.response.body && err.response.body.error_code;
          if (code === 400 || code === 403) {
            await db.from('bot_channels').delete().eq('bot_id', r.bot_id).eq('chat_id', r.chat_id);
            removed++;
          }
        }
        await sleep(60); // gentle on Telegram's rate limits
      }
      res.json({ ok: true, checked, updated, removed });
    } catch (err) {
      console.error('refresh channels error:', err);
      res.status(500).json({ error: 'Could not refresh channels' });
    }
  });

  // ---- post a message to chosen channels ----
  app.post('/api/admin/channels/post', requireAdmin, async (req, res) => {
    try {
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Message is empty' });
      if (text.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 characters)' });

      // targets: [{ bot_id, chat_id }, ...] chosen in the panel
      const targets = Array.isArray(req.body.targets) ? req.body.targets : [];
      if (!targets.length) return res.status(400).json({ error: 'Pick at least one channel' });
      if (targets.length > 50) return res.status(400).json({ error: 'Too many channels at once (max 50)' });

      const results = [];
      for (const t of targets) {
        const botId = Number(t.bot_id);
        const chatId = t.chat_id;

        // Only post to a channel we have on record for that bot — never a raw id.
        const { data: ch } = await db.from('bot_channels')
          .select('chat_id, title, can_post')
          .eq('bot_id', botId).eq('chat_id', chatId).maybeSingle();
        if (!ch) { results.push({ bot_id: botId, chat_id: chatId, ok: false, error: 'Not a saved channel' }); continue; }
        if (ch.can_post === false) { results.push({ bot_id: botId, chat_id: chatId, title: ch.title, ok: false, error: 'Bot cannot post here' }); continue; }

        const entry = getEntry(botId);
        if (!entry) { results.push({ bot_id: botId, chat_id: chatId, title: ch.title, ok: false, error: 'Bot is not running' }); continue; }

        try {
          await entry.bot.sendMessage(ch.chat_id, text);
          results.push({ bot_id: botId, chat_id: chatId, title: ch.title, ok: true });
        } catch (err) {
          const desc = (err && err.response && err.response.body && err.response.body.description) || err.message;
          results.push({ bot_id: botId, chat_id: chatId, title: ch.title, ok: false, error: desc });
        }
        await sleep(300); // channels have a stricter per-chat limit than DMs
      }

      const sent = results.filter((r) => r.ok).length;
      res.json({ ok: true, sent, failed: results.length - sent, results });
    } catch (err) {
      console.error('post to channels error:', err);
      res.status(500).json({ error: 'Could not post' });
    }
  });

  return { handleMyChatMember };
};
