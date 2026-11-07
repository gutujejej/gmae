// Two protections for the registration bots (the ones with the welcome message, channel buttons and a verify button):
//
// 1. HUMAN CHECK. A new user must first pass a tap-to-answer check (pick the animal, or a simple sum).
//    Only after it is passed does the bot send the welcome message and the channel buttons the admin set.
// 2. JOIN CHECK. When the user taps the verify button, the bot first checks that they really joined the channels.
//    The invite is counted for the inviter (and the bonus paid) only after that.
//
// It hooks in by wrapping each bot's update handler, so it needs ONE line in server.js:
//     require('./human-check')(app, db, { requireAdmin });
// Both checks are OFF until the admin switches them on for a bot (admin page -> bot card -> Protection).

const crypto = require('crypto');

const ANIMALS = [['🐘', 'ዝሆን · Elephant'], ['🦁', 'አንበሳ · Lion'], ['🐪', 'ግመል · Camel'], ['🐎', 'ፈረስ · Horse'], ['🐄', 'ላም · Cow'], ['🐑', 'በግ · Sheep'], ['🐕', 'ውሻ · Dog'], ['🐈', 'ድመት · Cat']];
const TXT = {
  head: '🤖 እባክዎ ሰው መሆንዎን ያረጋግጡ።\nPlease prove that you are human.',
  verified: '✅ ተረጋግጧል · Verified',
  wrong: '❌ ስህተት፣ እንደገና ይሞክሩ · Wrong, try again',
  locked: (min) => `ብዙ የተሳሳቱ መልሶች። ከ${min} ደቂቃ በኋላ ይሞክሩ።\nToo many wrong answers. Try again in ${min} minutes.`,
  expired: 'ጊዜው አልፏል። አዲስ ጥያቄ ተልኳል።\nTime is up. A new question was sent.',
  first: 'መጀመሪያ ሰው መሆንዎን ያረጋግጡ።\nPlease verify that you are human first.',
  join: (names) => `እባክዎ መጀመሪያ ይቀላቀሉ · Please join first:\n${names}`,
};
const TRIES = 3, COOLDOWN_MIN = 5, TTL_MS = 3 * 60 * 1000;
const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const rows3 = (btns) => { const out = []; for (let i = 0; i < btns.length; i += 3) out.push(btns.slice(i, i + 3)); return out; };

function animalChallenge() {
  const pick = shuffle(ANIMALS).slice(0, 6);
  const target = pick[crypto.randomInt(pick.length)];
  return { answer: target[0], text: `${TXT.head}\n\n👉 ${target[1]}`, rows: rows3(pick.map(([e]) => ({ text: e, callback_data: `hc:${e}` }))) };
}
function mathChallenge() {
  const a = 3 + crypto.randomInt(17), b = 2 + crypto.randomInt(8), ans = a + b;
  const opts = new Set([ans]);
  while (opts.size < 4) { const w = ans + (crypto.randomInt(13) - 6); if (w > 0) opts.add(w); }
  return { answer: String(ans), text: `${TXT.head}\n\n${a} + ${b} = ?`, rows: [shuffle([...opts]).map((n) => ({ text: String(n), callback_data: `hc:${n}` }))] };
}

// "@name", "t.me/name" or "-100123..." -> something getChatMember understands. Private invite links, bots and websites -> null.
const toChat = (s) => {
  s = String(s || '').trim();
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\?.*)?$/i.exec(s);
  if (m) return `@${m[1]}`;
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) return s;
  if (/^-100\d{5,}$/.test(s)) return s;
  return null;
};

module.exports = function humanCheck(app, db, { requireAdmin }) {
  const registry = app.get('botRegistry');
  if (!registry) { console.warn('[human-check] bot registry not found: protections are OFF'); return null; }
  const cache = new Map();
  let warned = false;

  async function settings(botId) {
    const c = cache.get(botId);
    if (c && c.exp > Date.now()) return c.v;
    let v = { human: 'off', join: false };
    const r = await db.from('bot_guard_settings').select('human_check,verify_joined').eq('bot_id', botId).maybeSingle();
    if (r.error) { if (!warned) { warned = true; console.warn('[human-check] run migration_human_check.sql in Supabase:', r.error.message); } }
    else if (r.data) v = { human: r.data.human_check, join: !!r.data.verify_joined };
    cache.set(botId, { exp: Date.now() + 10000, v });
    return v;
  }
  const hcRow = async (botId, uid) => (await db.from('human_checks').select('*').eq('bot_id', botId).eq('telegram_id', uid).maybeSingle()).data || null;
  const save = (botId, uid, patch) => db.from('human_checks').upsert({ bot_id: botId, telegram_id: uid, ...patch }, { onConflict: 'bot_id,telegram_id' });
  const isRegistered = async (botId, uid) => { const r = await db.from('bot_users').select('bonus_given').eq('bot_id', botId).eq('telegram_id', uid).maybeSingle(); return !!(r.data && r.data.bonus_given); };

  async function sendChallenge(entry, chatId, uid, mode, ref) {
    const c = mode === 'math' ? mathChallenge() : animalChallenge();
    await save(entry.row.id, uid, { answer: c.answer, expires_at: new Date(Date.now() + TTL_MS).toISOString(), tries: 0, ...(ref ? { ref } : {}) });
    return entry.bot.sendMessage(chatId, c.text, { reply_markup: { inline_keyboard: c.rows } });
  }

  async function onAnswer(entry, q, mode) {
    const { bot } = entry, botId = entry.row.id, uid = q.from.id, chat = q.message.chat;
    const del = () => bot.deleteMessage(chat.id, q.message.message_id).catch(() => {});
    const r = await hcRow(botId, uid);
    if (r && r.verified_at) { await bot.answerCallbackQuery(q.id, { text: TXT.verified }).catch(() => {}); return del(); }
    if (r && r.cooldown_until && new Date(r.cooldown_until) > new Date()) {
      const min = Math.max(1, Math.ceil((new Date(r.cooldown_until) - Date.now()) / 60000));
      return bot.answerCallbackQuery(q.id, { text: TXT.locked(min), show_alert: true }).catch(() => {});
    }
    if (!r || !r.answer || !r.expires_at || new Date(r.expires_at) < new Date()) {
      await bot.answerCallbackQuery(q.id, { text: TXT.expired }).catch(() => {});
      await del();
      return sendChallenge(entry, chat.id, uid, mode === 'off' ? 'animal' : mode, null);
    }
    if (String(q.data).slice(3) === r.answer) {
      await save(botId, uid, { verified_at: new Date().toISOString(), answer: null, tries: 0, fails: 0, cooldown_until: null });
      await bot.answerCallbackQuery(q.id, { text: TXT.verified }).catch(() => {});
      await del();
      // Replay the user's /start (with their invite code) so the normal welcome message and channel buttons go out.
      return entry.__orig({ update_id: Date.now(), message: { message_id: q.message.message_id, date: Math.floor(Date.now() / 1000), from: q.from, chat, text: `/start${r.ref ? ` ${r.ref}` : ''}` } });
    }
    const tries = (r.tries || 0) + 1;
    if (tries >= TRIES) {
      await save(botId, uid, { answer: null, tries: 0, fails: (r.fails || 0) + 1, cooldown_until: new Date(Date.now() + COOLDOWN_MIN * 60000).toISOString() });
      await del();
      return bot.answerCallbackQuery(q.id, { text: TXT.locked(COOLDOWN_MIN), show_alert: true }).catch(() => {});
    }
    await save(botId, uid, { tries });
    return bot.answerCallbackQuery(q.id, { text: TXT.wrong }).catch(() => {});
  }

  function candidates(row) {
    const out = [];
    const add = (label, raw) => { const chat = toChat(raw); if (chat && !out.some((c) => c.chat.toLowerCase() === chat.toLowerCase())) out.push({ label: label || chat, chat }); };
    add(row.channel, row.channel); add(row.group_chat, row.group_chat);
    for (const l of row.extra_links || []) add(l && l.text, l && l.url);
    return out;
  }
  async function missingChats(entry, uid) {
    const found = await Promise.all(candidates(entry.row).map(async (c) => {
      try {
        const m = await entry.bot.getChatMember(c.chat, uid);
        return (['left', 'kicked'].includes(m.status) || (m.status === 'restricted' && m.is_member === false)) ? c.label : null;
      } catch (_) { return null; }          // the bot cannot see this chat (not an admin there, private link...): cannot check it
    }));
    return found.filter(Boolean);
  }

  const needsLook = (u) =>
    (u.message && typeof u.message.text === 'string' && /^\/start(?:@\w+)?(?:\s|$)/.test(u.message.text) && u.message.chat && u.message.chat.type === 'private') ||
    (u.callback_query && typeof u.callback_query.data === 'string' && (u.callback_query.data === 'continue' || u.callback_query.data.startsWith('hc:')));

  async function intercept(entry, u) {
    const row = entry.row;
    if (['p2p', 'store'].includes(row.bot_type)) return false;
    const st = await settings(row.id);
    if (u.message) {
      const msg = u.message, uid = msg.from && msg.from.id;
      if (!uid || st.human === 'off') return false;
      if (await isRegistered(row.id, uid)) return false;
      const r = await hcRow(row.id, uid);
      if (r && r.verified_at) return false;
      if (r && r.cooldown_until && new Date(r.cooldown_until) > new Date()) {
        const min = Math.max(1, Math.ceil((new Date(r.cooldown_until) - Date.now()) / 60000));
        await entry.bot.sendMessage(msg.chat.id, TXT.locked(min)); return true;
      }
      const ref = ((/^\/start(?:@\w+)?\s+(\S+)/.exec(msg.text) || [])[1] || '').slice(0, 40) || null;
      await sendChallenge(entry, msg.chat.id, uid, st.human, ref);
      return true;
    }
    const q = u.callback_query;
    if (q.data.startsWith('hc:')) { await onAnswer(entry, q, st.human); return true; }
    const uid = q.from.id;                                    // data === 'continue'
    if (await isRegistered(row.id, uid)) return false;
    if (st.human !== 'off') {
      const r = await hcRow(row.id, uid);
      if (!r || !r.verified_at) {
        await entry.bot.answerCallbackQuery(q.id, { text: TXT.first, show_alert: true }).catch(() => {});
        await sendChallenge(entry, q.message.chat.id, uid, st.human, null);
        return true;
      }
    }
    if (st.join) {
      const missing = await missingChats(entry, uid);
      if (missing.length) {
        const names = missing.map((n) => `• ${n}`).join('\n');
        const text = TXT.join(names);
        await entry.bot.answerCallbackQuery(q.id, { text: text.length > 190 ? TXT.join(`${missing.length}`) : text, show_alert: true }).catch(() => {});
        return true;
      }
    }
    return false;
  }

  function wrap(entry) {
    if (!entry || !entry.bot || entry.__orig) return;
    const orig = entry.bot.processUpdate.bind(entry.bot);
    entry.__orig = orig;
    entry.bot.processUpdate = (update) => {
      if (!update || !needsLook(update)) return orig(update);
      intercept(entry, update).then((handled) => { if (!handled) orig(update); })
        .catch((e) => { console.error('[human-check]', e.message); orig(update); });   // never block the bot because of this module
    };
  }
  const origSet = registry.set.bind(registry);
  registry.set = (k, v) => { wrap(v); return origSet(k, v); };      // bots started later are wrapped too
  for (const e of registry.values()) wrap(e);

  /* ---------- admin page ---------- */
  app.get('/api/admin/guard', requireAdmin, async (_req, res) => {
    const r = await db.from('bot_guard_settings').select('bot_id,human_check,verify_joined');
    const out = {};
    for (const s of r.data || []) out[s.bot_id] = { human: s.human_check, join: !!s.verify_joined };
    res.json(out);
  });
  app.post('/api/admin/guard/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id), b = req.body || {};
    if (!registry.get(id)) return res.status(404).json({ error: 'Bot not found' });
    if (!['off', 'animal', 'math'].includes(b.human)) return res.status(400).json({ error: 'Choose off, animal or math.' });
    const { error } = await db.from('bot_guard_settings').upsert({ bot_id: id, human_check: b.human, verify_joined: !!b.join, updated_at: new Date().toISOString() }, { onConflict: 'bot_id' });
    if (error) return res.status(500).json({ error: /bot_guard_settings/.test(error.message) ? 'Not set up yet. Run migration_human_check.sql in Supabase.' : error.message });
    cache.delete(id);
    res.json({ ok: true });
  });
  app.get('/api/admin/guard/:id/links', requireAdmin, async (req, res) => {
    const entry = registry.get(Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Bot not found' });
    let meId = null; try { meId = (await entry.bot.getMe()).id; } catch (_) {}
    const links = await Promise.all(candidates(entry.row).map(async (c) => {
      let ok = false;
      try { const m = meId && await entry.bot.getChatMember(c.chat, meId); ok = !!m && ['administrator', 'creator'].includes(m.status); } catch (_) {}
      return { label: c.label, ok };
    }));
    res.json({ links });
  });

  return { settings };
};
