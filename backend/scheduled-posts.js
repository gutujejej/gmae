// Scheduled & automatic posts for a games bot (used from the Mini App's Admin > Posts tab).
//
//   GET    /api/mini/:botId/gadmin/posts        list scheduled / past posts
//   POST   /api/mini/:botId/gadmin/posts        create  { text, image?, button, target, send_at, repeat }
//   DELETE /api/mini/:botId/gadmin/posts/:id    cancel a scheduled post
//
//   target = 'users'    -> every user who started the bot (same as Broadcast)
//   target = 'channel'  -> the bot's channel (bots.channel); the bot must be an admin there
//   repeat = 'none' | 'daily' | 'weekly'
//
// A timer checks every 30 seconds for due posts and sends them. Due posts are claimed in the
// database (claim_due_posts, skip locked), so two server instances never send the same post.
// Needs sql/2026-11b_shared_bonus_and_scheduled_posts.sql.

const MAX_IMG_BYTES = 1.5 * 1024 * 1024;
const TICK_MS = 30_000;
const DAY = 86400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function decodeImage(input) {
  const raw = String(input || '');
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(raw);
  const b64 = (m ? m[1] : raw).replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, 'Upload a valid image.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_IMG_BYTES) throw new HttpError(413, 'That image is too large. Choose a smaller one.');
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(400, 'Images must be JPG, PNG or WebP.');
  return { b64, ext };
}

module.exports = function attachScheduledPosts(app, db, { miniAuth, MINIAPP_BASE }) {
  const registry = () => app.get('botRegistry');

  const wrap = (fn) => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); await fn(req, res); }
    catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('scheduled-posts error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
  const adminRoute = (method, path, handler) => {
    app[method](`/api/mini/:botId/gadmin/posts${path}`, wrap(async (req, res) => {
      const a = miniAuth(req, res); if (!a) return;
      const isAdmin = app.get('isGameAdmin');
      if (!isAdmin || !(await isAdmin(a.entry.row, a.user.id))) throw new HttpError(403, 'You are not an admin of this bot.');
      req.g = { row: a.entry.row, botId: a.entry.row.id, userId: a.user.id };
      await handler(req, res);
    }));
  };

  const publicRow = (p) => ({
    id: p.id, target: p.target, text: p.text, has_image: !!p.image_b64, button: p.button,
    send_at: p.send_at, repeat: p.repeat, status: p.status, last_run_at: p.last_run_at, last_result: p.last_result,
  });

  /* ------------------------------ routes ------------------------------ */
  adminRoute('get', '', async (req, res) => {
    const { data, error } = await db.from('scheduled_posts')
      .select('id,target,text,image_b64,button,send_at,repeat,status,last_run_at,last_result')
      .eq('bot_id', req.g.botId).neq('status', 'cancelled').order('send_at', { ascending: false }).limit(60);
    if (error) throw error;
    res.json({ posts: (data || []).map(publicRow), has_channel: !!req.g.row.channel });
  });

  adminRoute('post', '', async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 3500);
    const img = b.image ? decodeImage(b.image) : null;
    if (!text && !img) throw new HttpError(400, 'Write a message or add a photo.');
    const target = b.target === 'channel' ? 'channel' : 'users';
    if (target === 'channel' && !req.g.row.channel) throw new HttpError(400, 'This bot has no channel set. Ask the site owner to add one.');
    const repeat = ['daily', 'weekly'].includes(b.repeat) ? b.repeat : 'none';
    const when = new Date(b.send_at);
    if (isNaN(when.getTime())) throw new HttpError(400, 'Choose a date and time.');
    if (when.getTime() < Date.now() - 60_000) throw new HttpError(400, 'That time is in the past.');
    if (when.getTime() > Date.now() + 366 * DAY) throw new HttpError(400, 'Choose a date within the next year.');

    const { count } = await db.from('scheduled_posts').select('id', { count: 'exact', head: true })
      .eq('bot_id', req.g.botId).in('status', ['scheduled', 'running']);
    if ((count || 0) >= 30) throw new HttpError(409, 'You have 30 posts waiting. Cancel one first.');

    const { data, error } = await db.from('scheduled_posts').insert({
      bot_id: req.g.botId, target, text, image_b64: img ? img.b64 : null, image_ext: img ? img.ext : null,
      button: !!b.button, send_at: when.toISOString(), repeat, created_by: req.g.userId,
    }).select('id,target,text,image_b64,button,send_at,repeat,status,last_run_at,last_result').single();
    if (error) throw error;
    res.json({ ok: true, post: publicRow(data) });
  });

  adminRoute('delete', '/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new HttpError(400, 'Bad id.');
    const { data, error } = await db.from('scheduled_posts').update({ status: 'cancelled' })
      .eq('id', id).eq('bot_id', req.g.botId).in('status', ['scheduled', 'failed']).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new HttpError(409, 'This post can no longer be cancelled.');
    res.json({ ok: true });
  });

  /* ----------------------------- sending ----------------------------- */
  async function sendOne(bot, chatId, post, markup, state) {
    const text = post.text || '';
    if (post.image_b64) {
      const src = state.fileId || Buffer.from(post.image_b64, 'base64');
      const opts = text.length <= 1000 ? { caption: text, ...markup } : { ...markup };
      const m = await bot.sendPhoto(chatId, src, opts, state.fileId ? {} : { filename: `post.${post.image_ext || 'jpg'}` });
      if (!state.fileId && m && m.photo && m.photo.length) state.fileId = m.photo[m.photo.length - 1].file_id;
      if (text.length > 1000) await bot.sendMessage(chatId, text, markup);
    } else {
      await bot.sendMessage(chatId, text, markup);
    }
  }

  async function runPost(post) {
    const entry = registry() && registry().get(post.bot_id);
    const result = { sent: 0, failed: 0, blocked: 0, total: 0 };
    if (!entry) throw new Error('Bot is not running.');
    const bot = entry.bot;
    const markup = post.button && MINIAPP_BASE
      ? { reply_markup: { inline_keyboard: [[{ text: '✈️ Play now', web_app: { url: `${MINIAPP_BASE}/games?b=${post.bot_id}` } }]] } } : {};
    const state = { fileId: null };

    if (post.target === 'channel') {
      const ch = entry.row.channel;
      if (!ch) throw new Error('No channel set.');
      // a web_app button is not allowed in channels, so use a normal link to the bot instead
      const chMarkup = post.button && entry.row.bot_username
        ? { reply_markup: { inline_keyboard: [[{ text: '✈️ Play now', url: `https://t.me/${String(entry.row.bot_username).replace(/^@/, '')}` }]] } } : {};
      result.total = 1;
      await sendOne(bot, ch, post, chMarkup, state);
      result.sent = 1;
      return result;
    }

    const ids = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('bot_users').select('telegram_id').eq('bot_id', post.bot_id).order('telegram_id').range(from, from + 999);
      if (error) throw error;
      for (const r of data || []) ids.push(Number(r.telegram_id));
      if (!data || data.length < 1000) break;
    }
    result.total = ids.length;
    for (const tg of ids) {
      try { await sendOne(bot, tg, post, markup, state); result.sent++; }
      catch (err) {
        const code = err && err.response && err.response.statusCode;
        if (code === 403) result.blocked++; else result.failed++;
        if (code === 429) { const wait = (err.response.body && err.response.body.parameters && err.response.body.parameters.retry_after) || 3; await sleep(wait * 1000); }
      }
      await sleep(45);
    }
    return result;
  }

  async function finish(post, result, errMsg) {
    let patch;
    if (errMsg) {
      patch = { status: 'failed', last_result: { error: errMsg } };
    } else if (post.repeat !== 'none') {
      const step = post.repeat === 'weekly' ? 7 * DAY : DAY;
      let next = new Date(post.send_at).getTime() + step;
      while (next <= Date.now()) next += step;   // never "catch up" with a burst of posts
      patch = { status: 'scheduled', send_at: new Date(next).toISOString(), last_result: result };
    } else {
      patch = { status: 'sent', last_result: result };
    }
    const { error } = await db.from('scheduled_posts').update(patch).eq('id', post.id);
    if (error) console.error('scheduled-posts: could not save result:', error.message);
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // A post stuck in 'running' (server restarted mid-send) is marked failed, never re-sent.
      await db.from('scheduled_posts').update({ status: 'failed', last_result: { error: 'Interrupted by a restart.' } })
        .eq('status', 'running').lt('last_run_at', new Date(Date.now() - 30 * 60_000).toISOString());

      const { data, error } = await db.rpc('claim_due_posts', { p_limit: 3 });
      if (error) { console.error('scheduled-posts claim error:', error.message); return; }
      for (const post of data || []) {
        try { await finish(post, await runPost(post)); }
        catch (e) { console.error(`scheduled post #${post.id} failed:`, e.message); await finish(post, null, String(e.message || e).slice(0, 200)); }
      }
    } catch (e) { console.error('scheduled-posts tick error:', e); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(tick, 10_000);

  return { tick };
};
