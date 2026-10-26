// Controller (platform owner) tools: connect bots, assign bot admins, rotate tokens, pause bots.
// The controller is only identified by SUPER_ADMIN_IDS. Bot admins never see the controller anywhere.
const { createApi } = require('./jb-tg');
const { encrypt, randomSecret } = require('./jb-crypto');
const { HttpError, esc, appUrl } = require('./jb-util');
const E = require('./jb-engine');

async function setupTelegram(api, bot, publicUrl) {
  if (!publicUrl) return;
  await api.call('setWebhook', { url: `${publicUrl}/jb/hook/${bot.id}`, secret_token: bot.secret, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  await api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open', web_app: { url: appUrl(publicUrl, bot.id) } } }).catch(() => {});
  await api.call('setMyCommands', { commands: [{ command: 'start', description: 'Start' }, { command: 'menu', description: 'Main menu' }, { command: 'help', description: 'Help' }] }).catch(() => {});
}

async function getMe(token) {
  try { return await createApi(token).call('getMe', {}, 1); } catch (_) { throw new HttpError(400, 'Telegram did not accept this token. Copy it again from BotFather.'); }
}

async function connectBot({ db, registry, publicUrl }, token, createdBy) {
  token = String(token || '').trim();
  if (!/^\d{6,12}:[\w-]{30,}$/.test(token)) throw new HttpError(400, 'That does not look like a BotFather token.');
  const me = await getMe(token);
  if (!me.is_bot) throw new HttpError(400, 'This token does not belong to a bot.');
  const ex = await db.from('jb_bots').select('id').eq('tg_id', me.id).maybeSingle();
  if (ex.data) throw new HttpError(409, 'This bot is already connected.');
  const ins = await db.from('jb_bots').insert({ tg_id: me.id, username: me.username, name: me.first_name, token_enc: encrypt(token), token_last4: token.slice(-4), secret: randomSecret(), created_by: createdBy }).select().single();
  if (ins.error) throw new HttpError(500, 'Could not save the bot.');
  const bot = ins.data;
  await db.from('jb_tasks').insert({ bot_id: bot.id, type: 'daily', title: 'Daily check-in', description: 'Come back every day for a reward.', reward: 0.5, sort: 0 });
  await setupTelegram(createApi(token), bot, publicUrl);
  registry.invalidate(bot.id);
  return bot;
}

async function rotateToken({ db, registry, publicUrl }, botId, token) {
  token = String(token || '').trim();
  const bot = (await db.from('jb_bots').select('*').eq('id', botId).maybeSingle()).data;
  if (!bot) throw new HttpError(404, 'Bot not found.');
  const me = await getMe(token);
  if (me.id !== Number(bot.tg_id)) throw new HttpError(400, 'This token belongs to a different bot.');
  const secret = randomSecret();
  const up = await db.from('jb_bots').update({ token_enc: encrypt(token), token_last4: token.slice(-4), secret }).eq('id', botId);
  if (up.error) throw new HttpError(500, 'Could not save the token.');
  await setupTelegram(createApi(token), { ...bot, secret }, publicUrl);
  registry.invalidate(botId);
  return true;
}

async function addAdmin(db, registry, botId, tgId, role) {
  tgId = Number(tgId);
  if (!Number.isSafeInteger(tgId) || tgId <= 0) throw new HttpError(400, 'Enter the numeric Telegram id.');
  if (!['owner', 'admin', 'finance', 'moderator', 'support'].includes(role)) throw new HttpError(400, 'Unknown role.');
  const ex = await db.from('jb_admins').select('tg_id').eq('bot_id', botId).eq('tg_id', tgId).maybeSingle();
  if (ex.data) await db.from('jb_admins').update({ role }).eq('bot_id', botId).eq('tg_id', tgId);
  else await db.from('jb_admins').insert({ bot_id: botId, tg_id: tgId, role });
}

async function listBots(db) {
  const bots = (await db.from('jb_bots').select('id,tg_id,username,name,status,token_last4,created_at').order('id', { ascending: true })).data || [];
  const out = [];
  for (const b of bots) {
    const users = await db.from('jb_users').select('tg_id', { count: 'exact', head: true }).eq('bot_id', b.id);
    const admins = (await db.from('jb_admins').select('tg_id,role').eq('bot_id', b.id)).data || [];
    out.push({ ...b, users: users.count || 0, admins });
  }
  return out;
}

/* ---- the controller's own bot (talk to it to manage systems) ---- */
async function handleFactoryUpdate(deps, api, update) {
  const m = update.message;
  if (!m || !m.from || !m.chat || m.chat.type !== 'private') return;
  const say = (text, extra) => api.call('sendMessage', { chat_id: m.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) });
  if (!E.superIds().includes(String(m.from.id))) return say('This bot is private.');
  const text = (m.text || '').trim();
  try {
    if (/^\d{6,12}:[\w-]{30,}$/.test(text)) {
      const bot = await connectBot(deps, text, m.from.id);
      api.call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});   // do not leave the token in the chat
      return say(`Connected <b>@${esc(bot.username)}</b> as system #${bot.id}.\n\nNext: give it an admin.\n<code>/addadmin ${bot.id} TELEGRAM_ID owner</code>\n\nThe admin opens the bot, sends /admin, and manages everything. They will not see you.`);
    }
    const a = text.split(/\s+/);
    if (a[0] === '/addadmin') { await addAdmin(deps.db, deps.registry, Number(a[1]), a[2], a[3] || 'owner'); return say('Admin saved.'); }
    if (a[0] === '/pause' || a[0] === '/resume') { await deps.db.from('jb_bots').update({ status: a[0] === '/pause' ? 'paused' : 'active' }).eq('id', Number(a[1])); deps.registry.invalidate(Number(a[1])); return say(a[0] === '/pause' ? 'Paused.' : 'Active.'); }
    if (a[0] === '/bots') { const l = await listBots(deps.db); return say(l.length ? l.map((b) => `#${b.id} @${esc(b.username)} · ${b.status} · ${b.users} users · admins: ${b.admins.length}`).join('\n') : 'No systems yet. Send me a BotFather token to create one.'); }
    const rows = deps.publicUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Open controller', web_app: { url: appUrl(deps.publicUrl, 'controller') } }]] } } : {};
    return say('<b>Controller</b>\n\nSend me a BotFather token to create a new system.\n/bots list systems\n/addadmin BOT_ID TELEGRAM_ID ROLE\n/pause BOT_ID · /resume BOT_ID', rows);
  } catch (e) { return say(esc(e.message || 'Something went wrong.')); }
}

module.exports = { connectBot, rotateToken, addAdmin, listBots, setupTelegram, handleFactoryUpdate };
