require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_URL,
  FRONTEND_URL,
  ADMIN_PASSWORD,
  JWT_SECRET,
  WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_URL,
  ADMIN_PASSWORD, JWT_SECRET, WEBHOOK_SECRET,
})) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL || '*' }));

/* ------------------------------------------------------------------ */
/* Bot registry: botId -> { row, bot }                                 */
/* ------------------------------------------------------------------ */
const registry = new Map();

const stripAt = (s) => s.replace(/^@/, '');

// Escape characters that would break Telegram's Markdown formatting
const md = (s) => String(s).replace(/([_*`\[])/g, '\\$1');

// Admin input, one button per line: "Button text | https://... " (or "@botname" / "t.me/...")
// These are fully custom buttons the admin controls — nothing is fixed to
// "join channel" / "join group" anymore.
function parseLinks(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const i = l.indexOf('|');
    const text = i === -1 ? '' : l.slice(0, i).trim();
    let url = (i === -1 ? l : l.slice(i + 1)).trim();
    if (url.startsWith('@')) url = `https://t.me/${url.slice(1)}`;
    else if (/^t\.me\//i.test(url)) url = `https://${url}`;
    if (!/^https:\/\/\S+$/i.test(url)) throw new Error(`Invalid link: "${l}"`);
    if (!text) throw new Error(`Missing button text: "${l}"`);
    out.push({ text: text.slice(0, 60), url });
  }
  if (out.length > 10) throw new Error('Maximum 10 buttons');
  return out;
}

// Every link button the user is expected to open, each with a stable key so
// clicks can be recorded and checked later. Order matches what the user sees.
function requiredButtons(row) {
  const out = [];
  if (row.channel) out.push({ key: 'channel', text: 'Join Channel', url: `https://t.me/${stripAt(row.channel)}` });
  if (row.group_chat) out.push({ key: 'group', text: 'Join Group', url: `https://t.me/${stripAt(row.group_chat)}` });
  // Keyed by a hash of the destination, not by position: if the admin reorders
  // or renames buttons, past clicks stay attached to the same link, and a
  // changed link correctly counts as "not clicked yet".
  (row.extra_links || []).forEach((l) => out.push({
    key: 'u:' + crypto.createHash('sha1').update(l.url).digest('hex').slice(0, 12),
    text: l.text,
    url: l.url,
  }));
  return out;
}

// The Mini App is a page on your Vercel frontend (app.html). Telegram opens it
// inside the chat, so there is no "Open Link?" confirmation popup. It must be
// https, or Telegram refuses to send the button.
const MINIAPP_BASE = FRONTEND_URL && /^https:\/\//i.test(FRONTEND_URL)
  ? FRONTEND_URL.replace(/\/$/, '') : null;
if (!MINIAPP_BASE) {
  console.warn('FRONTEND_URL is missing or not https: "must open every button" cannot be enforced.');
}

// Label of the chat button that launches the Mini App. Change it here.
const TASKS_BUTTON_TEXT = 'Open Tasks';

// Enforcement only applies when the admin wants it, there is something to
// open, and the Mini App is reachable. Otherwise users would be blocked with
// no way to satisfy the rule.
const trackingOn = (row) =>
  row.require_all_clicks !== false && requiredButtons(row).length > 0 && !!MINIAPP_BASE;

function keyboard(row) {
  const cont = [{ text: row.continue_text || 'Continue', callback_data: 'continue' }];
  if (trackingOn(row)) {
    return {
      inline_keyboard: [
        [{ text: TASKS_BUTTON_TEXT, web_app: { url: `${MINIAPP_BASE}/app?b=${row.id}` } }],
        cont,
      ],
    };
  }
  // No enforcement: plain direct buttons, which open instantly with no popup.
  return {
    inline_keyboard: [
      ...requiredButtons(row).map((b) => [{ text: b.text, url: b.url }]),
      cont,
    ],
  };
}

// Verifies the signed login data Telegram gives a Mini App (initData) using
// the bot's own token, exactly as Telegram documents. Returns the Telegram
// user, or null if it is missing, forged, or older than 24 hours.
function verifyInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(String(initData || ''));
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (hash.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;
    const user = JSON.parse(params.get('user'));
    return user && Number.isInteger(user.id) ? user : null;
  } catch { return null; }
}

// Which of the required buttons has this user NOT opened yet?
async function unclickedButtons(row, telegramId) {
  const needed = requiredButtons(row);
  if (!needed.length) return [];
  const { data, error } = await db.from('button_clicks')
    .select('button_key').eq('bot_id', row.id).eq('telegram_id', telegramId);
  if (error) throw error;
  const done = new Set((data || []).map((c) => c.button_key));
  return needed.filter((b) => !done.has(b.key));
}

async function isMember(bot, chat, userId) {
  try {
    const m = await bot.getChatMember(chat, userId);
    return ['member', 'administrator', 'creator'].includes(m.status);
  } catch (err) {
    console.error(`getChatMember failed (${chat}):`, err.message);
    return false;
  }
}

// Short, human-shareable referral code (uppercase letters + digits, no 0/O/1/I).
function genReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

async function uniqueReferralCode(botId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genReferralCode();
    const { data } = await db.from('bot_users')
      .select('telegram_id').eq('bot_id', botId).eq('referral_code', code).maybeSingle();
    if (!data) return code;
  }
  // Astronomically unlikely, but fall back to something guaranteed unique.
  return genReferralCode() + Date.now().toString(36).slice(-3).toUpperCase();
}

const referralLink = (botUsername, code) => `https://t.me/${botUsername}?start=${code}`;

async function upsertUser(botId, from, referredByCode) {
  const { data: existing } = await db
    .from('bot_users').select('*')
    .eq('bot_id', botId).eq('telegram_id', from.id).maybeSingle();

  if (existing) {
    // Keep username/name fresh, but never touch referral fields once set.
    await db.from('bot_users').update({
      username: from.username || null,
      first_name: from.first_name || null,
    }).eq('bot_id', botId).eq('telegram_id', from.id);
    return { ...existing, username: from.username || null, first_name: from.first_name || null };
  }

  let referredBy = null;
  if (referredByCode) {
    const { data: referrer } = await db.from('bot_users')
      .select('telegram_id').eq('bot_id', botId).eq('referral_code', referredByCode).maybeSingle();
    // Can't refer yourself, and the code must belong to this bot.
    if (referrer && referrer.telegram_id !== from.id) referredBy = referrer.telegram_id;
  }

  const code = await uniqueReferralCode(botId);
  const { data, error } = await db.from('bot_users').insert({
    bot_id: botId,
    telegram_id: from.id,
    username: from.username || null,
    first_name: from.first_name || null,
    referral_code: code,
    referred_by: referredBy,
  }).select().single();

  if (error) {
    // Someone else inserted the same user concurrently (rare double /start) — just fetch it.
    const { data: fetched } = await db.from('bot_users').select('*')
      .eq('bot_id', botId).eq('telegram_id', from.id).single();
    return fetched;
  }
  return data;
}

function attachHandlers(entry) {
  const { bot } = entry;
  // Always read fresh settings so admin edits apply instantly
  const row = () => entry.row;

  bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
    try {
      const referredByCode = (match && match[1] || '').trim().toUpperCase() || null;
      const user = await upsertUser(row().id, msg.from, referredByCode);
      if (user.bonus_given) {
        return bot.sendMessage(
          msg.chat.id,
          `You are already registered.\nBalance: *${Number(user.balance)} birr*`,
          { parse_mode: 'Markdown' }
        );
      }
      const r = row();
      const hasButtons = requiredButtons(r).length > 0;
      const cont = md(r.continue_text || 'Continue');
      const steps = trackingOn(r)
        ? `Tap *${md(TASKS_BUTTON_TEXT)}* and open *every* task, then tap *${cont}* to receive your *${Number(r.bonus)} birr* registration bonus.`
        : hasButtons
          ? `Complete the steps below, then tap *${cont}* to receive your *${Number(r.bonus)} birr* registration bonus.`
          : `Tap *${cont}* to receive your *${Number(r.bonus)} birr* registration bonus.`;
      await bot.sendMessage(
        msg.chat.id,
        `Welcome to ${md(r.name)}.\n\n${steps}`,
        { parse_mode: 'Markdown', reply_markup: keyboard(r) }
      );
    } catch (err) {
      console.error('/start error:', err);
      bot.sendMessage(msg.chat.id, 'Something went wrong. Please try again.');
    }
  });

  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;
    try {
      if (q.data !== 'continue') return bot.answerCallbackQuery(q.id);

      const r = row();
      const user = await upsertUser(r.id, q.from);

      if (user.bonus_given) {
        return bot.answerCallbackQuery(q.id, {
          text: 'You already received your bonus.', show_alert: true,
        });
      }

      // Every button must have been opened before Continue is allowed.
      if (trackingOn(r)) {
        const missing = await unclickedButtons(r, q.from.id);
        if (missing.length) {
          const names = missing.map((b) => `• ${b.text}`).join('\n');
          const head = `Tap ${TASKS_BUTTON_TEXT} and open all tasks first (${missing.length} left)`;
          const text = `${head}:\n${names}`;
          return bot.answerCallbackQuery(q.id, {
            text: text.length > 200 ? `${head}.` : text,
            show_alert: true,
          });
        }
      }

      // Membership check only runs when the admin has both set a
      // channel/group AND turned verification on. If either is left
      // blank, joining is not required.
      if (r.verify && r.channel && r.group_chat) {
        const [inChannel, inGroup] = await Promise.all([
          isMember(bot, r.channel, q.from.id),
          isMember(bot, r.group_chat, q.from.id),
        ]);
        if (!inChannel || !inGroup) {
          const missing = [];
          if (!inChannel) missing.push('the channel');
          if (!inGroup) missing.push('the group');
          return bot.answerCallbackQuery(q.id, {
            text: `Please join ${missing.join(' and ')} first.`, show_alert: true,
          });
        }
      }

      const { data, error } = await db.rpc('claim_bonus_with_referral', {
        p_bot_id: r.id, p_telegram_id: q.from.id,
        p_amount: Number(r.bonus), p_referral_amount: Number(r.referral_bonus || 0),
      });
      if (error) throw error;
      const res = Array.isArray(data) ? data[0] : data;

      // The user only ever sees a confirmation in the chat. If the admin
      // configured a continue_url (e.g. a Mini App startapp link), it is
      // never shown as text — the button below silently opens it.
      await bot.answerCallbackQuery(q.id, {
        text: res.credited ? 'Bonus added.' : 'Bonus already claimed.',
      });

      const balanceText =
        `Registration complete.\nYou received *${Number(r.bonus)} birr* as a registration bonus.\n` +
        `Balance: *${Number(res.new_balance)} birr*`;

      const buttons = [];
      if (r.continue_url) buttons.push([{ text: 'Open', url: r.continue_url }]);
      if (Number(r.referral_bonus) > 0 && r.bot_username) {
        // Users created before the referral program existed won't have a
        // code yet — assign one now so their Share button always works.
        let code = user.referral_code;
        if (!code) {
          code = await uniqueReferralCode(r.id);
          await db.from('bot_users').update({ referral_code: code })
            .eq('bot_id', r.id).eq('telegram_id', q.from.id);
        }
        const link = referralLink(r.bot_username, code);
        const shareText = `Join and get a bonus: ${Number(r.bonus)} birr`;
        buttons.push([{
          text: 'Share Referral Link',
          url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`,
        }]);
      }

      await bot.editMessageText(balanceText, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
        ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
    } catch (err) {
      console.error('callback error:', err);
      bot.answerCallbackQuery(q.id, { text: 'Error, please try again.', show_alert: true });
    }
  });
}

async function startBot(row) {
  const bot = new TelegramBot(row.token); // webhook mode
  const entry = { row, bot };
  attachHandlers(entry);
  await bot.setWebHook(`${PUBLIC_URL}/telegram/webhook/${row.id}`, {
    secret_token: WEBHOOK_SECRET,
  });
  registry.set(row.id, entry);
}

async function stopBot(id) {
  const entry = registry.get(id);
  if (!entry) return;
  try { await entry.bot.deleteWebHook(); } catch (_) {}
  registry.delete(id);
}

/* ------------------------------------------------------------------ */
/* Telegram webhook (one route, many bots)                             */
/* ------------------------------------------------------------------ */
app.post('/telegram/webhook/:id', (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  const entry = registry.get(Number(req.params.id));
  if (!entry) return res.sendStatus(404);
  entry.bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ------------------------------------------------------------------ */
/* Admin auth (signed token, no extra dependencies)                    */
/* ------------------------------------------------------------------ */
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
};

const verify = (token) => {
  try {
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    if (sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
};

const requireAdmin = (req, res, next) => {
  const token = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!verify(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: sign({ exp: Date.now() + 12 * 60 * 60 * 1000 }) });
});

/* ------------------------------------------------------------------ */
/* Admin API: manage bots                                              */
/* ------------------------------------------------------------------ */
const publicBot = (b, stats = {}) => ({
  id: b.id, name: b.name, bot_username: b.bot_username,
  channel: b.channel || '', group_chat: b.group_chat || '', bonus: Number(b.bonus),
  verify: b.verify, active: b.active, created_at: b.created_at,
  extra_links: b.extra_links || [],
  continue_url: b.continue_url || '', continue_text: b.continue_text || 'Continue',
  referral_bonus: Number(b.referral_bonus || 0),
  require_all_clicks: b.require_all_clicks !== false,
  users: stats.users || 0, claimed: stats.claimed || 0,
  token_preview: '····' + b.token.slice(-6),
});

app.get('/api/admin/bots', requireAdmin, async (_req, res) => {
  const { data: bots, error } = await db.from('bots').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });

  const { data: users } = await db.from('bot_users').select('bot_id,bonus_given');
  const stats = {};
  (users || []).forEach((u) => {
    stats[u.bot_id] ||= { users: 0, claimed: 0 };
    stats[u.bot_id].users++;
    if (u.bonus_given) stats[u.bot_id].claimed++;
  });
  res.json(bots.map((b) => publicBot(b, stats[b.id])));
});

// Top inviters leaderboard. ?bot_id=<id|all>  ?days=<n|all>  (defaults: all, all)
app.get('/api/admin/top-inviters', requireAdmin, async (req, res) => {
  const botId = req.query.bot_id && req.query.bot_id !== 'all' ? Number(req.query.bot_id) : null;
  const days = req.query.days && req.query.days !== 'all' ? Number(req.query.days) : null;
  if ((botId !== null && !Number.isInteger(botId)) || (days !== null && !(days > 0 && days <= 3650))) {
    return res.status(400).json({ error: 'Invalid filter' });
  }

  const { data, error } = await db.rpc('top_inviters', { p_bot_id: botId, p_days: days, p_limit: 5 });
  if (error) {
    const missing = error.code === 'PGRST202' || /top_inviters/.test(error.message || '');
    return res.status(500).json({
      error: missing ? 'Leaderboard not set up yet. Run migration_v6.sql in Supabase.' : error.message,
    });
  }

  const { data: bots } = await db.from('bots').select('id,name');
  const names = Object.fromEntries((bots || []).map((b) => [b.id, b.name]));

  res.json((data || []).map((r) => ({
    bot_id: r.bot_id,
    bot_name: names[r.bot_id] || `Bot #${r.bot_id}`,
    telegram_id: r.telegram_id,
    username: r.username || null,
    first_name: r.first_name || null,
    invited: Number(r.invited),
    completed: Number(r.completed),
    last_invite: r.last_invite,
  })));
});

app.post('/api/admin/bots', requireAdmin, async (req, res) => {
  const { name, token, channel, group_chat, bonus, verify: v, continue_url, continue_text, referral_bonus, require_all_clicks } = req.body;
  if (!name || !token) {
    return res.status(400).json({ error: 'name and token are required' });
  }
  if (continue_url && !/^https:\/\/\S+$/i.test(continue_url)) {
    return res.status(400).json({ error: 'Continue redirect must be a valid https:// URL' });
  }

  let links;
  try { links = parseLinks(req.body.extra_links); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Validate the token with Telegram before saving
  let me;
  try {
    me = await new TelegramBot(token).getMe();
  } catch {
    return res.status(400).json({ error: 'Invalid bot token' });
  }

  const { data, error } = await db.from('bots').insert({
    name, token, bot_username: me.username,
    channel: channel ? (channel.startsWith('@') ? channel : '@' + channel) : null,
    group_chat: group_chat ? (group_chat.startsWith('@') ? group_chat : '@' + group_chat) : null,
    bonus: Number(bonus) || 20,
    verify: v !== false,
    extra_links: links,
    require_all_clicks: require_all_clicks !== false,
    continue_url: continue_url || null,
    continue_text: (continue_text || 'Continue').slice(0, 30),
    referral_bonus: referral_bonus === undefined || referral_bonus === '' ? 10 : Math.max(0, Number(referral_bonus) || 0),
  }).select().single();

  if (error) {
    const dup = error.code === '23505';
    return res.status(dup ? 409 : 500).json({ error: dup ? 'This bot is already added' : error.message });
  }

  try {
    await startBot(data);
  } catch (err) {
    await db.from('bots').delete().eq('id', data.id);
    return res.status(500).json({ error: 'Webhook setup failed: ' + err.message });
  }
  res.status(201).json(publicBot(data));
});

app.patch('/api/admin/bots/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['name', 'channel', 'group_chat', 'bonus', 'verify', 'active', 'continue_url', 'continue_text', 'referral_bonus', 'require_all_clicks'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if ('name' in patch) {
    patch.name = String(patch.name).trim().slice(0, 60);
    if (!patch.name) return res.status(400).json({ error: 'Name cannot be empty' });
  }
  if ('referral_bonus' in patch) {
    patch.referral_bonus = Math.max(0, Number(patch.referral_bonus) || 0);
  }
  if ('require_all_clicks' in patch) patch.require_all_clicks = patch.require_all_clicks !== false;
  // Empty string means "clear this field" (no forced channel/group).
  if ('channel' in patch) {
    const c = String(patch.channel || '').trim();
    patch.channel = c ? (c.startsWith('@') ? c : '@' + c) : null;
  }
  if ('group_chat' in patch) {
    const g = String(patch.group_chat || '').trim();
    patch.group_chat = g ? (g.startsWith('@') ? g : '@' + g) : null;
  }
  if ('continue_url' in patch) {
    const u = String(patch.continue_url || '').trim();
    if (u && !/^https:\/\/\S+$/i.test(u)) return res.status(400).json({ error: 'Continue redirect must be a valid https:// URL' });
    patch.continue_url = u || null;
  }
  if ('continue_text' in patch) {
    patch.continue_text = String(patch.continue_text || 'Continue').trim().slice(0, 30) || 'Continue';
  }
  if ('extra_links' in req.body) {
    try { patch.extra_links = parseLinks(req.body.extra_links); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }

  const { data, error } = await db.from('bots').update(patch).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const entry = registry.get(id);
  if (data.active && entry) entry.row = data;                 // live update
  if (data.active && !entry) await startBot(data).catch(console.error);
  if (!data.active && entry) await stopBot(id);

  res.json(publicBot(data));
});

app.delete('/api/admin/bots/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await stopBot(id);
  const { error } = await db.from('bots').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Broadcast: runs in the background, in small batches                 */
/* ------------------------------------------------------------------ */
const jobs = new Map(); // jobId -> { total, sent, failed, done }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchUserIds(botId) {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('bot_users').select('telegram_id')
      .eq('bot_id', botId).order('telegram_id').range(from, from + 999);
    if (error) throw error;
    ids.push(...data.map((u) => u.telegram_id));
    if (data.length < 1000) break;
  }
  return ids;
}

async function safeSend(bot, chatId, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bot.sendMessage(chatId, text);
      return true;
    } catch (err) {
      const wait = err.response && err.response.body && err.response.body.parameters
        && err.response.body.parameters.retry_after;
      if (attempt === 0 && wait) { await sleep((wait + 1) * 1000); continue; }
      return false; // usually: the user blocked the bot
    }
  }
  return false;
}

async function runBroadcast(id, job, lists, text) {
  try {
    for (const { bot, ids } of lists) {
      for (let i = 0; i < ids.length; i += 25) {
        const results = await Promise.all(ids.slice(i, i + 25).map((uid) => safeSend(bot, uid, text)));
        results.forEach((ok) => (ok ? job.sent++ : job.failed++));
        await sleep(1000); // stay under Telegram's ~30 messages/second limit
      }
    }
  } catch (err) {
    console.error('Broadcast error:', err);
  }
  job.done = true;
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
}

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Message is empty' });
    if (text.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 characters)' });

    const targets = !req.body.bot_id || req.body.bot_id === 'all'
      ? [...registry.values()]
      : [registry.get(Number(req.body.bot_id))].filter(Boolean);
    if (!targets.length) return res.status(400).json({ error: 'No active bot selected' });

    const lists = [];
    let total = 0;
    for (const t of targets) {
      const ids = await fetchUserIds(t.row.id);
      lists.push({ bot: t.bot, ids });
      total += ids.length;
    }

    const id = crypto.randomUUID();
    const job = { total, sent: 0, failed: 0, done: false };
    jobs.set(id, job);
    res.json({ id, total });
    runBroadcast(id, job, lists, text);
  } catch (err) {
    console.error('Broadcast start error:', err);
    res.status(500).json({ error: 'Could not start broadcast' });
  }
});

app.get('/api/admin/broadcast/:id', requireAdmin, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Broadcast not found' });
  res.json(job);
});

/* ------------------------------------------------------------------ */
/* Public endpoints                                                    */
/* ------------------------------------------------------------------ */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ */
/* Mini App API (called by frontend/app.html inside Telegram)          */
/* ------------------------------------------------------------------ */
// Every call carries Telegram's signed login data as "Authorization: tma <initData>".
// The user is whoever Telegram signed for, never something the client claims.
function miniAuth(req, res) {
  const entry = registry.get(Number(req.params.botId));
  if (!entry) { res.status(404).json({ error: 'This bot is not available.' }); return null; }
  const initData = (req.get('Authorization') || '').replace(/^tma\s+/i, '');
  const user = verifyInitData(initData, entry.row.token);
  if (!user) { res.status(401).json({ error: 'Please open this page from Telegram.' }); return null; }
  return { entry, user };
}

async function miniState(row, telegramId) {
  const needed = requiredButtons(row);
  const { data, error } = await db.from('button_clicks')
    .select('button_key').eq('bot_id', row.id).eq('telegram_id', telegramId);
  if (error) throw error;
  const done = new Set((data || []).map((c) => c.button_key));
  const buttons = needed.map((b) => ({ key: b.key, text: b.text, opened: done.has(b.key) }));
  const opened = buttons.filter((b) => b.opened).length;
  return {
    name: row.name,
    enforced: trackingOn(row),
    buttons,
    opened,
    total: buttons.length,
    complete: opened === buttons.length,
  };
}

app.get('/api/mini/:botId/state', async (req, res) => {
  const a = miniAuth(req, res); if (!a) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await miniState(a.entry.row, a.user.id));
  } catch (err) {
    console.error('mini state error:', err);
    res.status(500).json({ error: 'Could not load. Please try again.' });
  }
});

// Records the tap first, then hands back the link to open. If the write
// fails the link is not returned, so a click can never happen unrecorded.
app.post('/api/mini/:botId/click', async (req, res) => {
  const a = miniAuth(req, res); if (!a) return;
  try {
    const row = a.entry.row;
    const btn = requiredButtons(row).find((b) => b.key === String((req.body || {}).key));
    if (!btn) return res.status(404).json({ error: 'This button no longer exists.' });

    const { error } = await db.from('button_clicks').upsert(
      { bot_id: row.id, telegram_id: a.user.id, button_key: btn.key },
      { onConflict: 'bot_id,telegram_id,button_key', ignoreDuplicates: true }
    );
    if (error) throw error;

    res.set('Cache-Control', 'no-store');
    res.json({ url: btn.url, ...(await miniState(row, a.user.id)) });
  } catch (err) {
    console.error('mini click error:', err);
    res.status(500).json({ error: 'Could not save. Please try again.' });
  }
});

app.get('/api/public', async (_req, res) => {
  const { data: bots } = await db.from('bots').select('id,name,bot_username,bonus').eq('active', true).order('id');
  const { data: users } = await db.from('bot_users').select('bonus_given');
  res.json({
    bots: bots || [],
    totalUsers: (users || []).length,
    bonusesClaimed: (users || []).filter((u) => u.bonus_given).length,
  });
});

/* ------------------------------------------------------------------ */
/* Boot: load every active bot from the database                       */
/* ------------------------------------------------------------------ */
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  const { data: bots, error } = await db.from('bots').select('*').eq('active', true);
  if (error) return console.error('Failed to load bots:', error.message);
  for (const row of bots) {
    try { await startBot(row); console.log(`Started bot #${row.id} (@${row.bot_username})`); }
    catch (err) { console.error(`Bot #${row.id} failed:`, err.message); }
  }
});
