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

// Optional membership-based buttons (channel / group). Only rendered when the
// admin has actually filled them in — a bot with neither set shows none.
function joinButtons(row) {
  const out = [];
  if (row.channel) out.push([{ text: 'Join Channel', url: `https://t.me/${stripAt(row.channel)}` }]);
  if (row.group_chat) out.push([{ text: 'Join Group', url: `https://t.me/${stripAt(row.group_chat)}` }]);
  return out;
}

function keyboard(row) {
  return {
    inline_keyboard: [
      ...joinButtons(row),
      ...(row.extra_links || []).map((l) => [{ text: l.text, url: l.url }]),
      [{ text: row.continue_text || 'Continue', callback_data: 'continue' }],
    ],
  };
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

async function upsertUser(botId, from) {
  await db.from('bot_users').upsert(
    {
      bot_id: botId,
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
    },
    { onConflict: 'bot_id,telegram_id', ignoreDuplicates: true }
  );
  const { data } = await db
    .from('bot_users').select('*')
    .eq('bot_id', botId).eq('telegram_id', from.id).single();
  return data;
}

function attachHandlers(entry) {
  const { bot } = entry;
  // Always read fresh settings so admin edits apply instantly
  const row = () => entry.row;

  bot.onText(/\/start/, async (msg) => {
    try {
      const user = await upsertUser(row().id, msg.from);
      if (user.bonus_given) {
        return bot.sendMessage(
          msg.chat.id,
          `You are already registered.\nBalance: *${Number(user.balance)} birr*`,
          { parse_mode: 'Markdown' }
        );
      }
      const r = row();
      const steps = joinButtons(r).length
        ? `Complete the steps below, then tap *${md(r.continue_text || 'Continue')}* to receive your *${Number(r.bonus)} birr* registration bonus.`
        : `Tap *${md(r.continue_text || 'Continue')}* to receive your *${Number(r.bonus)} birr* registration bonus.`;
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

      const { data, error } = await db.rpc('claim_bonus', {
        p_bot_id: r.id, p_telegram_id: q.from.id, p_amount: Number(r.bonus),
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

      if (r.continue_url) {
        await bot.editMessageText(balanceText, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: 'Open', url: r.continue_url }]] },
        });
      } else {
        await bot.editMessageText(balanceText, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
        });
      }
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

app.post('/api/admin/bots', requireAdmin, async (req, res) => {
  const { name, token, channel, group_chat, bonus, verify: v, continue_url, continue_text } = req.body;
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
    continue_url: continue_url || null,
    continue_text: (continue_text || 'Continue').slice(0, 30),
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
  const allowed = ['name', 'channel', 'group_chat', 'bonus', 'verify', 'active', 'continue_url', 'continue_text'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if ('name' in patch) {
    patch.name = String(patch.name).trim().slice(0, 60);
    if (!patch.name) return res.status(400).json({ error: 'Name cannot be empty' });
  }
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
