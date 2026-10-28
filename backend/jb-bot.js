// Telegram bot behaviour for one task bot (captcha, tasks, wallet, referrals, withdrawals, support).
const { esc, chunk, shuffle, round2, appUrl } = require('./jb-util');
const E = require('./jb-engine');
const { memberOf, isGone } = require('./jb-tg');

const ik = (rows) => ({ inline_keyboard: rows });
const B = (text, data) => ({ text, callback_data: data });
const U = (text, url) => ({ text, url });
const f2 = (n) => Number(n || 0).toFixed(2);
const webUrl = (ctx) => appUrl(ctx.publicUrl, ctx.bot.id);

/* ----------------------------- sending helpers ----------------------------- */
const send = (ctx, chat, text, rows, extra) => ctx.api.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(rows ? { reply_markup: ik(rows) } : {}), ...(extra || {}) });
async function show(ctx, q, text, rows) {
  const m = q.message;
  const base = { chat_id: m.chat.id, message_id: m.message_id, parse_mode: 'HTML', reply_markup: ik(rows || []) };
  try {
    if (m.photo || m.video) await ctx.api.call('editMessageCaption', { ...base, caption: text });
    else await ctx.api.call('editMessageText', { ...base, text, disable_web_page_preview: true });
  } catch (e) {
    if (/not modified/i.test(e.message)) return;
    await send(ctx, m.chat.id, text, rows);
    try { await ctx.api.call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }); } catch (_) { /* ignore */ }
  }
}
const answer = (ctx, q, text, alert) => ctx.api.call('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text: String(text).replace(/<[^>]+>/g, '').slice(0, 190), show_alert: !!alert } : {}) }, 1).catch(() => {});
const del = (ctx, m) => ctx.api.call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }, 1).catch(() => {});

/* ----------------------------- users ----------------------------- */
const parseRef = (payload) => { const m = /^r([0-9a-z]{1,13})$/i.exec(payload || ''); if (!m) return null; const n = parseInt(m[1], 36); return Number.isSafeInteger(n) ? n : null; };
const refCode = (id) => `r${Number(id).toString(36)}`;

async function touchUser(ctx, from, refId) {
  const { db, bot, S } = ctx;
  let u = await E.loadUser(ctx, from.id);
  if (!u) {
    const ins = await db.from('jb_users').insert({ bot_id: bot.id, tg_id: from.id, username: from.username || null, first_name: from.first_name || null, lang: S.lang, captcha_ok: S.captcha === 'off' }).select().single();
    if (ins.error) { u = await E.loadUser(ctx, from.id); if (!u) throw new Error(ins.error.message); return { user: u, isNew: false }; }
    u = ins.data;
    if (refId && refId !== from.id && S.referral_enabled) {
      const referrer = await E.loadUser(ctx, refId);
      if (referrer && !referrer.banned) {
        await db.from('jb_referrals').insert({ bot_id: bot.id, referred_id: from.id, referrer_id: refId });
        const since = new Date(Date.now() - 3600000).toISOString();
        const burst = await db.from('jb_referrals').select('referred_id').eq('bot_id', bot.id).eq('referrer_id', refId).gte('created_at', since);
        if (burst.data && burst.data.length > 15) await E.flag(ctx, refId, 'referral_burst', `${burst.data.length} referrals in one hour`);
      }
    }
    return { user: u, isNew: true };
  }
  await db.from('jb_users').update({ last_seen: new Date().toISOString(), username: from.username || null, first_name: from.first_name || u.first_name, blocked: false }).eq('bot_id', bot.id).eq('tg_id', from.id);
  return { user: { ...u, username: from.username || null, blocked: false }, isNew: false };
}

const setState = (ctx, user, state) => E.patchUser(ctx, user.tg_id, { state });

/* ----------------------------- captcha ----------------------------- */
const ANIMALS = [['🐱', 'cat'], ['🐶', 'dog'], ['🐭', 'mouse'], ['🐰', 'rabbit'], ['🦊', 'fox'], ['🐸', 'frog'], ['🐼', 'panda'], ['🐵', 'monkey'], ['🦁', 'lion'], ['🐯', 'tiger']];
function makeCaptcha(S) {
  const level = S.captcha_level;
  if (S.captcha === 'math') {
    const hi = level === 'easy' ? 9 : level === 'hard' ? 30 : 20;
    const a = 1 + Math.floor(Math.random() * hi), b = 1 + Math.floor(Math.random() * hi);
    const mul = level === 'hard' && Math.random() < 0.5;
    const answer = mul ? (a % 10) * (b % 10) : a + b;
    const q = mul ? `${a % 10} × ${b % 10}` : `${a} + ${b}`;
    const set = new Set([answer]);
    while (set.size < (level === 'easy' ? 4 : 6)) set.add(Math.max(0, answer + Math.floor(Math.random() * 11) - 5));
    return { kind: 'math', q, answer: String(answer), options: shuffle([...set]).map((n) => ({ label: String(n), value: String(n) })) };
  }
  const n = level === 'easy' ? 4 : level === 'hard' ? 8 : 6;
  const pool = shuffle(ANIMALS).slice(0, n);
  const target = pool[Math.floor(Math.random() * pool.length)];
  return { kind: 'emoji', emoji: target[0], name: target[1], answer: target[1], options: pool.map(([e, name]) => ({ label: e, value: name })) };
}

async function sendCaptcha(ctx, user, chat) {
  const t = E.tOf(ctx, user);
  if (user.cooldown_until && new Date(user.cooldown_until).getTime() > Date.now()) {
    return send(ctx, chat, t('captcha_locked', { min: Math.ceil((new Date(user.cooldown_until).getTime() - Date.now()) / 60000) }));
  }
  const c = makeCaptcha(ctx.S);
  await E.patchUser(ctx, user.tg_id, { captcha: { answer: c.answer, exp: Date.now() + ctx.S.captcha_ttl * 1000, at: Date.now(), tries: 0 } });
  const text = c.kind === 'math' ? t('captcha_math', { q: c.q }) : t('captcha_emoji', { name: c.name, emoji: c.emoji });
  return send(ctx, chat, text, chunk(c.options.map((o) => B(o.label, `cap:${o.value}`)), c.options.length > 4 ? 3 : 2));
}

async function onCaptcha(ctx, q, val) {
  const user = await E.loadUser(ctx, q.from.id); if (!user || user.banned) return answer(ctx, q);
  const t = E.tOf(ctx, user); const c = user.captcha;
  if (user.captcha_ok) { await del(ctx, q.message); return answer(ctx, q); }
  if (user.cooldown_until && new Date(user.cooldown_until).getTime() > Date.now()) return answer(ctx, q, t('captcha_locked', { min: Math.ceil((new Date(user.cooldown_until).getTime() - Date.now()) / 60000) }), true);
  if (!c || Date.now() > c.exp) { await answer(ctx, q, t('captcha_new')); await del(ctx, q.message); return sendCaptcha(ctx, user, q.message.chat.id); }
  if (Date.now() - c.at < 800) return answer(ctx, q, t('captcha_fast'));
  if (String(val) === String(c.answer)) {
    await E.patchUser(ctx, user.tg_id, { captcha_ok: true, captcha: null, captcha_fails: 0 });
    await answer(ctx, q, t('captcha_ok'));
    await del(ctx, q.message);
    await E.qualifyReferral(ctx, user.tg_id);
    return advance(ctx, { ...user, captcha_ok: true }, q.message.chat.id, true);
  }
  const tries = (c.tries || 0) + 1; const fails = (user.captcha_fails || 0) + 1;
  if (tries >= ctx.S.captcha_tries) {
    await E.patchUser(ctx, user.tg_id, { captcha: null, captcha_fails: fails, cooldown_until: new Date(Date.now() + ctx.S.captcha_cooldown_min * 60000).toISOString() });
    if (fails >= ctx.S.captcha_tries * 2) await E.flag(ctx, user.tg_id, 'captcha_fails', `${fails} wrong answers`);
    await answer(ctx, q, t('captcha_locked', { min: ctx.S.captcha_cooldown_min }), true);
    return show(ctx, q, t('captcha_locked', { min: ctx.S.captcha_cooldown_min }), []);
  }
  await E.patchUser(ctx, user.tg_id, { captcha: { ...c, tries }, captcha_fails: fails });
  return answer(ctx, q, t('captcha_wrong'), true);
}

/* ----------------------------- phone check ----------------------------- */
async function askPhone(ctx, user, chat) {
  const t = E.tOf(ctx, user);
  return ctx.api.call('sendMessage', { chat_id: chat, text: t('phone_ask'), reply_markup: { keyboard: [[{ text: t('phone_btn'), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
}
async function onContact(ctx, msg) {
  const user = await E.loadUser(ctx, msg.from.id); if (!user || user.banned) return;
  const t = E.tOf(ctx, user); const c = msg.contact;
  if (!c || c.user_id !== msg.from.id) return send(ctx, msg.chat.id, t('phone_own'));
  let phone = String(c.phone_number || '').replace(/[^\d+]/g, ''); if (!phone.startsWith('+')) phone = `+${phone}`;
  if (ctx.S.phone_prefix && !phone.startsWith(ctx.S.phone_prefix)) return send(ctx, msg.chat.id, t('phone_prefix', { prefix: ctx.S.phone_prefix }));
  const dup = await ctx.db.from('jb_users').select('tg_id').eq('bot_id', ctx.bot.id).eq('phone', phone).limit(1);
  if (dup.data && dup.data.length && dup.data[0].tg_id !== msg.from.id) { await E.flag(ctx, msg.from.id, 'duplicate_phone', phone); return send(ctx, msg.chat.id, t('phone_used')); }
  const up = await ctx.db.from('jb_users').update({ phone }).eq('bot_id', ctx.bot.id).eq('tg_id', msg.from.id);
  if (up.error) return send(ctx, msg.chat.id, t('phone_used'));
  await ctx.api.call('sendMessage', { chat_id: msg.chat.id, text: t('captcha_ok'), reply_markup: { remove_keyboard: true } });
  return advance(ctx, { ...user, phone }, msg.chat.id, true);
}

/* ----------------------------- views ----------------------------- */
async function advance(ctx, user, chat, first) {
  if (!user.captcha_ok && ctx.S.captcha !== 'off') return sendCaptcha(ctx, user, chat);
  if (ctx.S.require_phone && !user.phone) return askPhone(ctx, user, chat);
  return sendMenu(ctx, user, chat, first);
}

async function menuView(ctx, user) {
  const t = E.tOf(ctx, user); const S = ctx.S;
  const refs = (await ctx.db.from('jb_referrals').select('referred_id').eq('bot_id', ctx.bot.id).eq('referrer_id', user.tg_id).eq('status', 'qualified')).data || [];
  const fresh = (await E.loadUser(ctx, user.tg_id)) || user;
  const text = t('menu', { name: esc(fresh.first_name || 'friend'), balance: f2(fresh.balance), earned: f2(fresh.total_earned), refs: refs.length });
  const daily = (await ctx.db.from('jb_tasks').select('id').eq('bot_id', ctx.bot.id).eq('type', 'daily').eq('status', 'active').limit(1)).data || [];
  const rows = [[B(`📋 ${t('b_earn')}`, 'earn'), B(`👛 ${t('b_wallet')}`, 'wallet')], [B(`👥 ${t('b_ref')}`, 'ref'), ...(daily.length ? [B(`🎁 ${t('b_daily')}`, `claim:${daily[0].id}`)] : [])], [B(`💸 ${t('b_withdraw')}`, 'wd'), ...(S.leaderboard ? [B(`🏆 ${t('b_top')}`, 'top')] : [])]];
  const url = webUrl(ctx); if (url) rows.push([{ text: `📱 ${t('b_app')}`, web_app: { url } }]);
  rows.push([B(`❓ ${t('b_help')}`, 'help'), B(`🌍 ${t('b_lang')}`, 'lang')]);
  const role = await E.roleOf(ctx, user.tg_id);
  if (role && url) rows.push([{ text: `🛠 ${t('b_admin')}`, web_app: { url } }]);
  return { text, rows };
}
async function sendMenu(ctx, user, chat, first) {
  const v = await menuView(ctx, user); const t = E.tOf(ctx, user);
  if (first) {
    const welcome = ctx.S.welcome_text || t('welcome', { name: esc(user.first_name || 'friend') });
    if (ctx.S.welcome_photo) { try { await ctx.api.call('sendPhoto', { chat_id: chat, photo: ctx.S.welcome_photo, caption: welcome, parse_mode: 'HTML' }); } catch (_) { await send(ctx, chat, welcome); } }
    else await send(ctx, chat, welcome);
  }
  return send(ctx, chat, v.text, v.rows);
}

async function earnView(ctx, user) {
  const t = E.tOf(ctx, user);
  const tasks = await E.listTasks(ctx, user);
  if (!tasks.length) return { text: `${t('earn_title')}\n\n${t('earn_none')}`, rows: [[B(`‹ ${t('b_back')}`, 'menu')]] };
  const mark = { available: '▫️', done: '✅', pending: '⏳', full: '🔒', expired: '🔒', rejected: '✖️' };
  const lines = tasks.map((x) => `${mark[x.status]} ${esc(x.title)} · <b>+${f2(x.reward)} ETB</b>${x.status !== 'available' ? ` (${t(`t_${x.status}`)})` : ''}`);
  const rows = []; const joinBtns = [];
  for (const x of tasks.filter((k) => k.status === 'available')) {
    if (x.type === 'join' && x.url) joinBtns.push(U(`📢 ${x.title} +${f2(x.reward)}`, x.url));
    else if (x.type === 'visit') rows.push([B(`🌐 ${x.title} +${f2(x.reward)}`, `visit:${x.id}`)]);
    else if (x.type === 'custom') rows.push([B(`📝 ${x.title} +${f2(x.reward)}`, `proof:${x.id}`)]);
    else if (x.type === 'daily') rows.push([B(`🎁 ${x.title} +${f2(x.reward)}`, `claim:${x.id}`)]);
  }
  const out = [...chunk(joinBtns, 2), ...rows];
  if (tasks.some((x) => x.type === 'join' && x.status === 'available')) out.push([B(`✅ ${t('b_verify')}`, 'verify')]);
  out.push([B(`‹ ${t('b_back')}`, 'menu')]);
  const rules = ctx.S.recheck_days > 0 && ctx.S.rules_text ? `\n\n<i>${esc(ctx.S.rules_text)}</i>` : '';
  return { text: `${t('earn_title')}\n\n${lines.join('\n')}${rules}`, rows: out };
}

const claimMessage = (t, r) => {
  if (r.ok) return r.status === 'pending' ? t('claim_review') : t('claim_ok', { amount: f2(r.amount) });
  return t(r.error, r.vars || {});
};

async function verifyAll(ctx, q, user) {
  const t = E.tOf(ctx, user);
  const tasks = (await E.listTasks(ctx, user)).filter((x) => x.type === 'join' && x.status === 'available');
  if (!tasks.length) return answer(ctx, q, t('v_none'));
  let total = 0; const missing = [];
  for (const x of tasks) {
    const fresh = (await E.loadUser(ctx, user.tg_id)) || user;
    const r = await E.claimTask(ctx, fresh, x.id);
    if (r.ok) total += r.amount; else if (!['claim_dup'].includes(r.error)) missing.push(`• ${esc(x.title)}: ${t(r.error, r.vars || {}).replace(/<[^>]+>/g, '')}`);
  }
  if (total > 0 && !missing.length) await answer(ctx, q, t('v_ok', { amount: f2(total) }), true);
  else if (total > 0) await answer(ctx, q, `${t('v_ok', { amount: f2(total) })}`, true);
  else await answer(ctx, q, missing.length ? t('v_partial', { list: missing.join('\n') }) : t('v_none'), true);
  const v = await earnView(ctx, (await E.loadUser(ctx, user.tg_id)) || user);
  return show(ctx, q, v.text, v.rows);
}

async function walletView(ctx, user) {
  const t = E.tOf(ctx, user); const u = (await E.loadUser(ctx, user.tg_id)) || user;
  return { text: t('wallet', { balance: f2(u.balance), pending: f2(u.pending), earned: f2(u.total_earned), task: f2(u.earned_task), ref: f2(u.earned_ref), withdrawn: f2(u.withdrawn_total) }), rows: [[B(`💸 ${t('b_withdraw')}`, 'wd')], [B(`‹ ${t('b_back')}`, 'menu')]] };
}

async function refView(ctx, user) {
  const t = E.tOf(ctx, user);
  if (!ctx.S.referral_enabled) return { text: t('ref_off'), rows: [[B(`‹ ${t('b_back')}`, 'menu')]] };
  const all = (await ctx.db.from('jb_referrals').select('status,reward').eq('bot_id', ctx.bot.id).eq('referrer_id', user.tg_id)).data || [];
  const ok = all.filter((r) => r.status === 'qualified');
  const link = `https://t.me/${ctx.bot.username}?start=${refCode(user.tg_id)}`;
  const conds = [ctx.S.referral_require_captcha && ctx.S.captcha !== 'off' ? t('ref_cond_captcha') : null, Number(ctx.S.referral_min_tasks) > 0 ? t('ref_cond_tasks', { n: ctx.S.referral_min_tasks }) : null].filter(Boolean).join(' + ') || t('ref_cond_captcha');
  const text = t('ref', { link, ok: ok.length, wait: all.filter((r) => r.status === 'pending').length, earned: f2(ok.reduce((s, r) => s + Number(r.reward), 0)), reward: f2(ctx.S.referral_reward), cond: conds });
  return { text, rows: [[U(`📤 ${t('b_share')}`, `https://t.me/share/url?url=${encodeURIComponent(link)}`)], [B(`‹ ${t('b_back')}`, 'menu')]] };
}

async function topView(ctx, user, by) {
  const t = E.tOf(ctx, user);
  const rows = await E.rpc(ctx.db, 'jb_leaderboard', { p_bot: ctx.bot.id, p_by: by, p_limit: 10 });
  const medals = ['🥇', '🥈', '🥉'];
  const body = rows && rows.length ? rows.map((r, i) => `${medals[i] || `${i + 1}.`} ${esc(r.label)} — <b>${by === 'earn' ? f2(r.score) + ' ETB' : Number(r.score)}</b>`).join('\n') : t('top_none');
  return { text: `${t('top')}\n\n${body}`, rows: [[B(t('b_by_earn'), 'topx:earn'), B(t('b_by_tasks'), 'topx:tasks'), B(t('b_by_ref'), 'topx:referrals')], [B(`‹ ${t('b_back')}`, 'menu')]] };
}

function helpView(ctx, user) {
  const t = E.tOf(ctx, user);
  const rows = [[B(`💬 ${t('b_support')}`, 'support')]];
  if (ctx.S.support_username) rows.unshift([U(`@${ctx.S.support_username}`, `https://t.me/${ctx.S.support_username}`)]);
  rows.push([B(`‹ ${t('b_back')}`, 'menu')]);
  return { text: ctx.S.help_text ? esc(ctx.S.help_text) : t('help'), rows };
}

/* ----------------------------- withdraw flow ----------------------------- */
const maxFor = (S, u) => Number(S.max_withdraw) > 0 ? Math.min(Number(S.max_withdraw), Number(u.balance)) : Number(u.balance);

async function wdStart(ctx, q, user) {
  const t = E.tOf(ctx, user); const u = (await E.loadUser(ctx, user.tg_id)) || user;
  if (ctx.S.maintenance_withdraw) return show(ctx, q, t('maint'), [[B(`‹ ${t('b_back')}`, 'menu')]]);
  if (u.review) return show(ctx, q, t('wd_err_under_review'), [[B(`‹ ${t('b_back')}`, 'menu')]]);
  if (Number(u.balance) < Number(ctx.S.min_withdraw)) return show(ctx, q, t('wd_min', { min: f2(ctx.S.min_withdraw), balance: f2(u.balance) }), [[B(`‹ ${t('b_back')}`, 'menu')]]);
  await setState(ctx, u, { step: 'method' });
  return show(ctx, q, t('wd_method'), [...chunk(ctx.S.methods.map((m, i) => B(m, `wdm:${i}`)), 2), [B(t('b_cancel'), 'wdno')]]);
}

async function wdSummary(ctx, chat, user, st) {
  const t = E.tOf(ctx, user); const fee = E.feeFor(ctx.S, st.amount);
  return send(ctx, chat, t('wd_confirm', { amount: f2(st.amount), fee: f2(fee), net: f2(st.amount - fee), method: esc(st.method), account: esc(st.account) }), [[B(`✅ ${t('b_confirm')}`, 'wdok'), B(t('b_cancel'), 'wdno')]]);
}

async function wdAmount(ctx, chat, user, st, raw) {
  const t = E.tOf(ctx, user); const u = (await E.loadUser(ctx, user.tg_id)) || user;
  const max = maxFor(ctx.S, u); const min = Number(ctx.S.min_withdraw);
  const amount = raw === 'all' ? round2(max) : round2(Number(String(raw).replace(/,/g, '')));
  if (!Number.isFinite(amount) || amount < min || amount > max) return send(ctx, chat, t('wd_bad_amount', { min: f2(min), max: f2(max) }));
  const next = { ...st, step: 'confirm', amount };
  await setState(ctx, u, next);
  return wdSummary(ctx, chat, u, next);
}

async function wdConfirm(ctx, q, user) {
  const t = E.tOf(ctx, user); const st = user.state;
  if (!st || st.step !== 'confirm') return answer(ctx, q);
  try {
    const id = await E.requestWithdraw(ctx, user, { amount: st.amount, method: st.method, account: st.account });
    await setState(ctx, user, null);
    return show(ctx, q, t('wd_sent', { id }), [[B(`‹ ${t('b_back')}`, 'menu')]]);
  } catch (e) {
    await setState(ctx, user, null);
    const key = `wd_err_${e.code}`; const msg = e.code === 'maint' ? t('maint') : t(key) === key ? t('wd_bad_amount', { min: f2(ctx.S.min_withdraw), max: f2(maxFor(ctx.S, user)) }) : t(key);
    return show(ctx, q, msg, [[B(`‹ ${t('b_back')}`, 'menu')]]);
  }
}

/* ----------------------------- messages ----------------------------- */
async function onMessage(ctx, msg) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const text = msg.text || '';
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  const { user, isNew } = await touchUser(ctx, msg.from, m ? parseRef(m[1]) : null);
  if (user.banned) return;
  const t = E.tOf(ctx, user);
  if (ctx.bot.status === 'paused' && !(await E.roleOf(ctx, user.tg_id))) return send(ctx, msg.chat.id, t('maint'));
  if (msg.contact) return onContact(ctx, msg);
  if (m) return advance(ctx, user, msg.chat.id, isNew || !user.captcha_ok);
  if (!user.captcha_ok && ctx.S.captcha !== 'off') return sendCaptcha(ctx, user, msg.chat.id);
  if (ctx.S.require_phone && !user.phone) return askPhone(ctx, user, msg.chat.id);
  if (text === '/cancel') { await setState(ctx, user, null); return send(ctx, msg.chat.id, t('cancelled')); }
  if (text.startsWith('/admin')) {
    const role = await E.roleOf(ctx, user.tg_id); const url = webUrl(ctx);
    if (!role || !url) return sendMenu(ctx, user, msg.chat.id);
    return send(ctx, msg.chat.id, `<b>${esc(ctx.bot.name || 'Admin')}</b>`, [[{ text: `🛠 ${t('b_admin')}`, web_app: { url } }]]);
  }
  if (text.startsWith('/help')) { const v = helpView(ctx, user); return send(ctx, msg.chat.id, v.text, v.rows); }
  if (text.startsWith('/')) return sendMenu(ctx, user, msg.chat.id);
  const st = user.state;
  if (st && st.step === 'account') {
    const acc = text.trim();
    if (acc.length < 3 || acc.length > 60) return send(ctx, msg.chat.id, t('wd_bad_account'));
    const next = { ...st, step: 'amount', account: acc }; await setState(ctx, user, next);
    const u = (await E.loadUser(ctx, user.tg_id)) || user;
    return send(ctx, msg.chat.id, t('wd_amount', { min: f2(ctx.S.min_withdraw), max: f2(maxFor(ctx.S, u)) }), [[B(`${t('b_all')} (${f2(maxFor(ctx.S, u))})`, 'wdall')], [B(t('b_cancel'), 'wdno')]]);
  }
  if (st && st.step === 'amount') return wdAmount(ctx, msg.chat.id, user, st, text.trim());
  if (st && st.step === 'proof') {
    await setState(ctx, user, null);
    const r = await E.claimTask(ctx, (await E.loadUser(ctx, user.tg_id)) || user, st.task, { proof: text });
    await send(ctx, msg.chat.id, claimMessage(t, r));
    if (r.ok && r.status === 'pending') for (const a of await E.adminIds(ctx, 'review')) { try { await send(ctx, a, `<b>New task proof</b>\n${esc(r.title)}\nFrom: ${esc(user.first_name || '')} (${user.tg_id})\n${esc(text.slice(0, 300))}\n\nReview it in the admin panel.`); } catch (_) { /* ignore */ } }
    return;
  }
  if (st && st.step === 'support') {
    await setState(ctx, user, null);
    const tk = await ctx.db.from('jb_tickets').insert({ bot_id: ctx.bot.id, user_id: user.tg_id, subject: text.slice(0, 80) }).select().single();
    if (!tk.error) await ctx.db.from('jb_ticket_msgs').insert({ ticket_id: tk.data.id, from_admin: false, body: text.slice(0, 1000) });
    for (const a of await E.adminIds(ctx, 'support')) { try { await send(ctx, a, E.tOf(ctx, null)('adm_ticket', { user: `${esc(user.first_name || '')} (${user.tg_id})`, text: esc(text.slice(0, 300)) })); } catch (_) { /* ignore */ } }
    return send(ctx, msg.chat.id, t('support_sent'));
  }
  return sendMenu(ctx, user, msg.chat.id);
}

/* ----------------------------- callbacks ----------------------------- */
async function onCallback(ctx, q) {
  const data = String(q.data || ''); const from = q.from;
  if (!q.message) return answer(ctx, q);
  if (data.startsWith('cap:')) return onCaptcha(ctx, q, data.slice(4));
  const { user } = await touchUser(ctx, from, null);
  if (user.banned) return answer(ctx, q);
  const t = E.tOf(ctx, user);
  if (ctx.bot.status === 'paused' && !(await E.roleOf(ctx, user.tg_id))) return answer(ctx, q, t('maint'), true);
  if (!user.captcha_ok && ctx.S.captcha !== 'off' && !data.startsWith('wd:')) { await answer(ctx, q, t('captcha_first')); return sendCaptcha(ctx, user, q.message.chat.id); }
  const back = [[B(`‹ ${t('b_back')}`, 'menu')]];
  const [k, a, b] = data.split(':');
  switch (k) {
    case 'menu': { await setState(ctx, user, null); const v = await menuView(ctx, user); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'earn': { const v = await earnView(ctx, user); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'verify': return verifyAll(ctx, q, user);
    case 'claim': {
      const r = await E.claimTask(ctx, user, Number(a));
      await answer(ctx, q, claimMessage(t, r), !r.ok);
      const v = await earnView(ctx, (await E.loadUser(ctx, user.tg_id)) || user); return show(ctx, q, v.text, v.rows);
    }
    case 'visit': {
      const task = (await ctx.db.from('jb_tasks').select('*').eq('id', Number(a)).eq('bot_id', ctx.bot.id).maybeSingle()).data;
      if (!task || task.status !== 'active') return answer(ctx, q, t('claim_unavail'), true);
      await E.startVisit(ctx, user, task.id);
      await answer(ctx, q);
      return show(ctx, q, `<b>${esc(task.title)}</b>\n${esc(task.description || '')}\n\n${t('visit_open', { sec: task.min_seconds })}`, [[...(task.url ? [U('Open', task.url)] : []), B(`✅ ${t('b_verify')}`, `claim:${task.id}`)], ...back]);
    }
    case 'proof': { await setState(ctx, user, { step: 'proof', task: Number(a) }); await answer(ctx, q); return show(ctx, q, t('proof_ask'), [[B(t('b_cancel'), 'wdno')]]); }
    case 'wallet': { const v = await walletView(ctx, user); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'ref': { const v = await refView(ctx, user); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'top': case 'topx': { const v = await topView(ctx, user, a || 'earn'); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'help': { const v = helpView(ctx, user); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
    case 'support': { await setState(ctx, user, { step: 'support' }); await answer(ctx, q); return show(ctx, q, t('support_ask'), [[B(t('b_cancel'), 'wdno')]]); }
    case 'lang': {
      if (a) { await E.patchUser(ctx, user.tg_id, { lang: a === 'am' ? 'am' : 'en' }); const nu = { ...user, lang: a === 'am' ? 'am' : 'en' }; const v = await menuView(ctx, nu); await show(ctx, q, v.text, v.rows); return answer(ctx, q); }
      await show(ctx, q, t('lang_pick'), [[B('English', 'lang:en'), B('አማርኛ', 'lang:am')], ...back]); return answer(ctx, q);
    }
    case 'wd': {
      if (a === 'a' || a === 'r') return adminWithdraw(ctx, q, user, a === 'a', Number(b));
      await answer(ctx, q); return wdStart(ctx, q, user);
    }
    case 'wdm': { const method = ctx.S.methods[Number(a)]; if (!method) return answer(ctx, q); await setState(ctx, user, { step: 'account', method }); await answer(ctx, q); return show(ctx, q, t('wd_account', { method: esc(method) }), [[B(t('b_cancel'), 'wdno')]]); }
    case 'wdall': { const st = user.state; if (!st || st.step !== 'amount') return answer(ctx, q); await answer(ctx, q); return wdAmount(ctx, q.message.chat.id, user, st, 'all'); }
    case 'wdok': await answer(ctx, q); return wdConfirm(ctx, q, user);
    case 'wdno': { await setState(ctx, user, null); await answer(ctx, q, t('cancelled')); const v = await menuView(ctx, user); return show(ctx, q, v.text, v.rows); }
    default: return answer(ctx, q);
  }
}

async function adminWithdraw(ctx, q, user, approve, id) {
  const role = await E.roleOf(ctx, user.tg_id);
  if (!role || !E.can(role, 'finance')) return answer(ctx, q, 'Not allowed', true);
  try {
    await E.setWithdrawStatus(ctx, { id: user.tg_id, role }, id, approve ? 'approved' : 'rejected', approve ? null : 'Rejected by admin');
    await answer(ctx, q, approve ? 'Approved' : 'Rejected');
    return show(ctx, q, `${q.message.text || ''}\n\n<b>${approve ? 'Approved' : 'Rejected'}</b>`.replace(/<(?!\/?b>)[^>]*>/g, ''), []);
  } catch (e) { return answer(ctx, q, e.code === 'bad_transition' ? 'Already handled' : 'Error', true); }
}

async function onMyChatMember(ctx, ev) {
  if (!ev.chat || ev.chat.type !== 'private') return;
  const status = ev.new_chat_member && ev.new_chat_member.status;
  if (status === 'kicked') await ctx.db.from('jb_users').update({ blocked: true }).eq('bot_id', ctx.bot.id).eq('tg_id', ev.from.id);
  if (status === 'member') await ctx.db.from('jb_users').update({ blocked: false }).eq('bot_id', ctx.bot.id).eq('tg_id', ev.from.id);
}

async function handleUpdate(ctx, update) {
  if (update.message) return onMessage(ctx, update.message);
  if (update.callback_query) return onCallback(ctx, update.callback_query);
  if (update.my_chat_member) return onMyChatMember(ctx, update.my_chat_member);
}

module.exports = { handleUpdate, refCode, parseRef, makeCaptcha, menuView, webUrl };
