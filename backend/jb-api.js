// Mini-app API. Everything is checked on the server: Telegram signature, role, ownership, limits.
const { checkInitData } = require('./jb-auth');
const { HttpError, round2 } = require('./jb-util');
const { clean } = require('./jb-settings');
const { sendRich } = require('./jb-tg');
const E = require('./jb-engine');
const Jobs = require('./jb-jobs');
const Ctl = require('./jb-controller');
const { refCode } = require('./jb-bot');

const must = E.must;
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
const iso = (v, name, required) => { if (v == null || v === '') { if (required) throw new HttpError(400, `${name} is required.`); return null; } const d = new Date(v); if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} is not a valid date.`); return d.toISOString(); };
const txt = (v, max, name, min = 0) => { const s = String(v == null ? '' : v).trim(); if (s.length < min) throw new HttpError(400, `${name} is required.`); return s.slice(0, max); };
const url = (v, name) => { const s = String(v || '').trim(); if (!s) return null; if (!/^https:\/\/\S+$/i.test(s)) throw new HttpError(400, `${name} must be a full https link.`); return s.slice(0, 500); };
const intOrNull = (v, min, max, name) => { if (v == null || v === '') return null; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`); return n; };

const PUBLIC_KEYS = ['min_withdraw', 'max_withdraw', 'fee_pct', 'fee_flat', 'methods', 'referral_enabled', 'referral_reward', 'referral_min_tasks', 'maintenance_tasks', 'maintenance_withdraw', 'leaderboard', 'rules_text', 'recheck_days', 'reverse_on_leave', 'lang', 'support_username', 'help_text', 'captcha', 'require_phone'];

function mount(app, { db, registry, publicUrl, factoryToken }) {
  const limits = new Map();
  const limited = (key, max) => { const m = Math.floor(Date.now() / 60000); const b = limits.get(key); if (!b || b.m !== m) { limits.set(key, { m, n: 1 }); if (limits.size > 20000) limits.clear(); return false; } return ++b.n > max; };

  const fail = (res, e) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    const map = { duplicate: 'You already did this.', task_full: 'This task is full.', task_expired: 'This task has ended.', task_unavailable: 'This task is not available.', task_daily_full: 'Today\'s limit is reached.', pending_exists: 'You already have a withdrawal in progress.', low_balance: 'Not enough balance.', below_min: 'Below the minimum withdrawal.', above_max: 'Above the maximum withdrawal.', under_review: 'Your account is under review.', not_pending: 'Already handled.', bad_transition: 'That status change is not allowed.', maint: 'This part is paused for maintenance.', bad_method: 'Choose a withdrawal method.', bad_account: 'Check the account number.', bad_amount: 'Enter a valid amount.', not_found: 'Not found.' };
    if (e && map[e.code]) return res.status(400).json({ error: map[e.code], code: e.code });
    console.error('api error:', e && e.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };

  async function authenticate(req) {
    const ctx = await registry.ctxFor(req.params.botId);
    if (!ctx) throw new HttpError(404, 'This system does not exist.');
    const tg = checkInitData(req.get('x-init-data'), ctx.api.token);
    if (!tg) throw new HttpError(401, 'Open this page from Telegram.');
    if (limited(`${ctx.bot.id}:${tg.id}`, 150)) throw new HttpError(429, 'Too many requests. Slow down a little.');
    const role = await E.roleOf(ctx, tg.id);
    if (ctx.bot.status === 'paused' && !role) throw new HttpError(503, 'This bot is paused.');
    req.ctx = ctx; req.tg = tg; req.role = role;
    req.actor = { id: tg.id, role, controller: role === 'controller' };
  }
  const route = (method, path, perm, handler) => app[method](`/jb/api/:botId${path}`, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await authenticate(req);
      if (perm === 'user') {
        const u = await userRow(req);
        if (u.banned) throw new HttpError(403, 'Your account is suspended.');
        req.user = u;
      } else if (perm) {
        if (!req.role) throw new HttpError(403, 'You are not an admin of this system.');
        if (perm !== 'any' && !E.can(req.role, perm)) throw new HttpError(403, 'Your role cannot do this.');
      }
      const out = await handler(req, res);
      if (!res.headersSent && out !== undefined) res.json(out);
    } catch (e) { fail(res, e); }
  });

  async function userRow(req) {
    const { ctx, tg } = req;
    let u = await E.loadUser(ctx, tg.id);
    if (!u) {
      const ins = await ctx.db.from('jb_users').insert({ bot_id: ctx.bot.id, tg_id: tg.id, username: tg.username || null, first_name: tg.first_name || null, lang: ctx.S.lang, captcha_ok: ctx.S.captcha === 'off' }).select().single();
      u = ins.error ? await E.loadUser(ctx, tg.id) : ins.data;
    } else {
      await ctx.db.from('jb_users').update({ last_seen: new Date().toISOString(), username: tg.username || null }).eq('bot_id', ctx.bot.id).eq('tg_id', tg.id);
    }
    return u;
  }
  const pub = (S) => Object.fromEntries(PUBLIC_KEYS.map((k) => [k, S[k]]));
  const safeUser = (u) => ({ id: u.tg_id, name: u.first_name, username: u.username, lang: u.lang, notify: u.notify, captcha_ok: u.captcha_ok, phone: !!u.phone, balance: Number(u.balance), pending: Number(u.pending), total_earned: Number(u.total_earned), earned_task: Number(u.earned_task), earned_ref: Number(u.earned_ref), withdrawn_total: Number(u.withdrawn_total), review: u.review });

  /* =============================== user =============================== */
  route('get', '/home', 'user', async (req) => {
    const { ctx, user } = req;
    const tasks = await E.listTasks(ctx, user);
    const refs = must(await ctx.db.from('jb_referrals').select('status,reward').eq('bot_id', ctx.bot.id).eq('referrer_id', user.tg_id));
    const ann = must(await ctx.db.from('jb_announcements').select('id,title,body,pinned').eq('bot_id', ctx.bot.id).eq('active', true).order('created_at', { ascending: false }).limit(5));
    const camp = await E.activeCampaign(ctx);
    const recent = must(await ctx.db.from('jb_ledger').select('amount,kind,note,created_at').eq('bot_id', ctx.bot.id).eq('user_id', user.tg_id).order('created_at', { ascending: false }).limit(8));
    return {
      user: safeUser(user), role: req.role === 'controller' ? 'owner' : req.role, bot: { name: ctx.bot.name, username: ctx.bot.username, status: ctx.bot.status },
      settings: pub(ctx.S), tasks, announcements: ann.sort((a, b) => Number(b.pinned) - Number(a.pinned)),
      campaign: camp ? { name: camp.name, ends_at: camp.ends_at, task_bonus_pct: Number(camp.task_bonus_pct), referral_bonus: Number(camp.referral_bonus) } : null,
      referrals: { link: `https://t.me/${ctx.bot.username}?start=${refCode(user.tg_id)}`, qualified: refs.filter((r) => r.status === 'qualified').length, pending: refs.filter((r) => r.status === 'pending').length, earned: round2(refs.filter((r) => r.status === 'qualified').reduce((s, r) => s + Number(r.reward), 0)) },
      recent,
    };
  });
  route('post', '/tasks/:id/claim', 'user', async (req) => {
    const r = await E.claimTask(req.ctx, req.user, Number(req.params.id), { proof: (req.body || {}).proof });
    const t = E.tOf(req.ctx, req.user);
    if (!r.ok) return { ok: false, message: t(r.error, r.vars || {}).replace(/<[^>]+>/g, ''), error: r.error };
    return { ok: true, status: r.status, amount: r.amount, message: r.status === 'pending' ? t('claim_review') : t('claim_ok', { amount: r.amount.toFixed(2) }).replace(/<[^>]+>/g, '') };
  });
  route('post', '/tasks/:id/visit', 'user', async (req) => { await E.startVisit(req.ctx, req.user, Number(req.params.id)); return { ok: true }; });
  route('post', '/verify', 'user', async (req) => {
    const { ctx } = req; const t = E.tOf(ctx, req.user);
    const tasks = (await E.listTasks(ctx, req.user)).filter((x) => x.type === 'join' && x.status === 'available');
    let total = 0; const problems = [];
    for (const x of tasks) {
      const u = (await E.loadUser(ctx, req.user.tg_id)) || req.user;
      const r = await E.claimTask(ctx, u, x.id);
      if (r.ok) total += r.amount; else if (r.error !== 'claim_dup') problems.push({ task: x.title, reason: t(r.error, r.vars || {}).replace(/<[^>]+>/g, '') });
    }
    return { ok: true, earned: round2(total), problems, checked: tasks.length };
  });
  route('get', '/wallet', 'user', async (req) => {
    const { ctx, user } = req;
    const u = (await E.loadUser(ctx, user.tg_id)) || user;
    const ledger = must(await ctx.db.from('jb_ledger').select('id,amount,kind,note,created_at').eq('bot_id', ctx.bot.id).eq('user_id', user.tg_id).order('created_at', { ascending: false }).limit(50));
    const wds = must(await ctx.db.from('jb_withdrawals').select('id,amount,fee,net,method,status,pay_ref,note,created_at').eq('bot_id', ctx.bot.id).eq('user_id', user.tg_id).order('created_at', { ascending: false }).limit(20));
    return { user: safeUser(u), ledger, withdrawals: wds };
  });
  route('post', '/withdraw', 'user', async (req) => {
    const b = req.body || {};
    const id = await E.requestWithdraw(req.ctx, req.user, { amount: Number(b.amount), method: String(b.method || ''), account: b.account });
    return { ok: true, id };
  });
  route('post', '/me', 'user', async (req) => {
    const b = req.body || {}; const patch = {};
    if (b.lang === 'am' || b.lang === 'en') patch.lang = b.lang;
    if (typeof b.notify === 'boolean') patch.notify = b.notify;
    if (Object.keys(patch).length) await E.patchUser(req.ctx, req.user.tg_id, patch);
    return { ok: true };
  });
  route('get', '/leaderboard', 'user', async (req) => {
    const by = ['earn', 'tasks', 'referrals'].includes(req.query.by) ? req.query.by : 'earn';
    return { by, rows: await E.rpc(req.ctx.db, 'jb_leaderboard', { p_bot: req.ctx.bot.id, p_by: by, p_limit: 20 }) };
  });
  route('post', '/tickets', 'user', async (req) => {
    const text = txt((req.body || {}).text, 1000, 'Message', 3);
    const tk = await req.ctx.db.from('jb_tickets').insert({ bot_id: req.ctx.bot.id, user_id: req.user.tg_id, subject: text.slice(0, 80) }).select().single();
    if (tk.error) throw new Error(tk.error.message);
    await req.ctx.db.from('jb_ticket_msgs').insert({ ticket_id: tk.data.id, from_admin: false, body: text });
    return { ok: true, id: tk.data.id };
  });
  route('get', '/tickets', 'user', async (req) => {
    const rows = must(await req.ctx.db.from('jb_tickets').select('id,subject,status,created_at').eq('bot_id', req.ctx.bot.id).eq('user_id', req.user.tg_id).order('created_at', { ascending: false }).limit(10));
    for (const r of rows) r.messages = must(await req.ctx.db.from('jb_ticket_msgs').select('from_admin,body,created_at').eq('ticket_id', r.id).order('created_at', { ascending: true }));
    return { tickets: rows };
  });

  /* =============================== admin: overview =============================== */
  route('get', '/a/stats', 'dashboard', async (req) => ({ stats: await E.rpc(req.ctx.db, 'jb_stats', { p_bot: req.ctx.bot.id }), role: req.role === 'controller' ? 'owner' : req.role }));

  /* =============================== admin: users =============================== */
  route('get', '/a/users', 'users', async (req) => {
    const { ctx } = req; const q = String(req.query.q || '').trim().replace(/[%,]/g, '');
    const page = Math.max(0, Number(req.query.page) || 0); const per = 20;
    const cols = 'tg_id,username,first_name,captcha_ok,phone,banned,blocked,review,balance,pending,total_earned,joined_at,last_seen';
    let rows;
    if (q) {
      const byId = /^\d+$/.test(q) ? must(await ctx.db.from('jb_users').select(cols).eq('bot_id', ctx.bot.id).eq('tg_id', Number(q))) : [];
      const byName = must(await ctx.db.from('jb_users').select(cols).eq('bot_id', ctx.bot.id).ilike('username', `%${q}%`).limit(per));
      const byFirst = must(await ctx.db.from('jb_users').select(cols).eq('bot_id', ctx.bot.id).ilike('first_name', `%${q}%`).limit(per));
      const seen = new Set(); rows = [...byId, ...byName, ...byFirst].filter((r) => (seen.has(r.tg_id) ? false : seen.add(r.tg_id)));
    } else {
      let qb = ctx.db.from('jb_users').select(cols).eq('bot_id', ctx.bot.id);
      const f = req.query.filter;
      if (f === 'verified') qb = qb.eq('captcha_ok', true); else if (f === 'unverified') qb = qb.eq('captcha_ok', false); else if (f === 'banned') qb = qb.eq('banned', true); else if (f === 'review') qb = qb.eq('review', true);
      rows = must(await qb.order('joined_at', { ascending: false }).range(page * per, page * per + per - 1));
    }
    return { users: rows, page, per };
  });
  route('get', '/a/users/:id', 'users', async (req) => {
    const { ctx } = req; const id = Number(req.params.id);
    const u = await E.loadUser(ctx, id); if (!u) throw new HttpError(404, 'User not found.');
    const [ledger, claims, refs, flags, wds] = await Promise.all([
      ctx.db.from('jb_ledger').select('amount,kind,note,created_at').eq('bot_id', ctx.bot.id).eq('user_id', id).order('created_at', { ascending: false }).limit(30),
      ctx.db.from('jb_task_claims').select('task_id,status,reward,created_at').eq('bot_id', ctx.bot.id).eq('user_id', id).order('created_at', { ascending: false }).limit(30),
      ctx.db.from('jb_referrals').select('referred_id,status,reward,created_at').eq('bot_id', ctx.bot.id).eq('referrer_id', id).order('created_at', { ascending: false }).limit(30),
      ctx.db.from('jb_flags').select('id,kind,detail,status,created_at').eq('bot_id', ctx.bot.id).eq('user_id', id).order('created_at', { ascending: false }).limit(10),
      ctx.db.from('jb_withdrawals').select('id,amount,status,method,created_at').eq('bot_id', ctx.bot.id).eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    ]);
    const { state, captcha, ...rest } = u;
    return { user: rest, ledger: ledger.data || [], claims: claims.data || [], referrals: refs.data || [], flags: flags.data || [], withdrawals: wds.data || [] };
  });
  const userAction = (path, perm, fn) => route('post', `/a/users/:id/${path}`, perm, async (req) => {
    const id = Number(req.params.id); const u = await E.loadUser(req.ctx, id); if (!u) throw new HttpError(404, 'User not found.');
    const out = await fn(req, id, u); return out || { ok: true };
  });
  userAction('ban', 'users', async (req, id) => { const banned = !!(req.body || {}).banned; await E.patchUser(req.ctx, id, { banned }); await E.audit(req.ctx, req.actor, banned ? 'user.suspend' : 'user.reactivate', id); });
  userAction('review', 'users', async (req, id) => { const review = !!(req.body || {}).review; await E.patchUser(req.ctx, id, { review }); await E.audit(req.ctx, req.actor, review ? 'user.hold' : 'user.release', id); });
  userAction('reset-captcha', 'users', async (req, id) => { await E.patchUser(req.ctx, id, { captcha_ok: false, captcha: null, captcha_fails: 0, cooldown_until: null }); await E.audit(req.ctx, req.actor, 'user.reset_verification', id); });
  userAction('adjust', 'finance', async (req, id) => { const b = req.body || {}; const applied = await E.adjustBalance(req.ctx, req.actor, id, Number(b.amount), b.reason); return { ok: true, applied }; });

  /* =============================== admin: channels and tasks =============================== */
  route('get', '/a/channels', 'tasks', async (req) => ({ channels: must(await req.ctx.db.from('jb_channels').select('*').eq('bot_id', req.ctx.bot.id).order('id', { ascending: true })) }));
  route('post', '/a/channels', 'tasks', async (req) => {
    const { ctx } = req; let ref = String((req.body || {}).ref || '').trim();
    if (!ref) throw new HttpError(400, 'Enter the @username or id of the channel or group.');
    if (/^https?:\/\/t\.me\/[A-Za-z0-9_]+$/i.test(ref)) ref = `@${ref.split('/').pop()}`;
    if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(ref)) ref = `@${ref}`;
    let chat;
    try { chat = await ctx.api.call('getChat', { chat_id: ref }, 1); } catch (_) { throw new HttpError(400, 'I cannot find that chat. Check the name and add the bot as an admin.'); }
    let me; try { me = await ctx.api.call('getChatMember', { chat_id: chat.id, user_id: ctx.bot.tg_id }, 1); } catch (_) { me = null; }
    if (!me || !['administrator', 'creator'].includes(me.status)) throw new HttpError(400, 'Add this bot as an admin of the chat first (it needs to read members and post messages).');
    let link = chat.invite_link || null;
    if (!link && !chat.username) { try { link = await ctx.api.call('exportChatInviteLink', { chat_id: chat.id }, 1); } catch (_) { link = null; } }
    const ex = await ctx.db.from('jb_channels').select('id').eq('bot_id', ctx.bot.id).eq('chat_id', chat.id).maybeSingle();
    if (ex.data) throw new HttpError(409, 'This chat is already added.');
    const ins = await ctx.db.from('jb_channels').insert({ bot_id: ctx.bot.id, chat_id: chat.id, title: String(chat.title || ref).slice(0, 80), username: chat.username || null, invite_link: link, kind: chat.type === 'channel' ? 'channel' : 'group' }).select().single();
    if (ins.error) throw new Error(ins.error.message);
    await E.audit(ctx, req.actor, 'channel.add', ins.data.id, { chat: chat.id });
    return { ok: true, channel: ins.data };
  });
  route('delete', '/a/channels/:id', 'tasks', async (req) => { await req.ctx.db.from('jb_channels').delete().eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); await E.audit(req.ctx, req.actor, 'channel.remove', req.params.id); return { ok: true }; });

  async function taskBody(req, b, existing) {
    const { ctx } = req; const o = {};
    const type = existing ? existing.type : String(b.type || '');
    if (!['join', 'daily', 'visit', 'custom'].includes(type)) throw new HttpError(400, 'Choose a task type.');
    if (!existing) o.type = type;
    if (!existing || 'title' in b) o.title = txt(b.title, 80, 'Title', 2);
    if ('description' in b) o.description = txt(b.description, 300, 'Description');
    if (!existing || 'reward' in b) { const r = Number(b.reward); if (!Number.isFinite(r) || r < 0 || r > 100000) throw new HttpError(400, 'Reward must be between 0 and 100000 ETB.'); o.reward = round2(r); }
    if ('max_participants' in b) o.max_participants = intOrNull(b.max_participants, 1, 10000000, 'Maximum participants');
    if ('daily_limit' in b) o.daily_limit = intOrNull(b.daily_limit, 1, 10000000, 'Daily limit');
    if ('min_seconds' in b) o.min_seconds = intOrNull(b.min_seconds, 3, 600, 'Wait seconds') || 10;
    if ('starts_at' in b) o.starts_at = iso(b.starts_at, 'Start date');
    if ('expires_at' in b) o.expires_at = iso(b.expires_at, 'Expiry date');
    if ('status' in b) { if (!['active', 'paused', 'archived'].includes(b.status)) throw new HttpError(400, 'Unknown status.'); o.status = b.status; }
    if ('sort' in b) o.sort = intOrNull(b.sort, -1000, 1000, 'Order') || 0;
    if (type === 'custom') o.requires_review = true;
    if (type === 'join' && (!existing || 'channel_id' in b)) {
      const ch = (await ctx.db.from('jb_channels').select('*').eq('bot_id', ctx.bot.id).eq('id', Number(b.channel_id)).maybeSingle()).data;
      if (!ch) throw new HttpError(400, 'Choose one of your connected channels or groups.');
      Object.assign(o, { channel_id: ch.id, chat_id: ch.chat_id, username: ch.username, url: ch.invite_link || (ch.username ? `https://t.me/${ch.username}` : null) });
    }
    if ((type === 'visit' || type === 'custom') && (!existing || 'url' in b)) o.url = url(b.url, 'Link');
    if (type === 'visit' && !existing && !o.url) throw new HttpError(400, 'A visit task needs a link.');
    return o;
  }
  route('get', '/a/tasks', 'tasks', async (req) => {
    const rows = must(await req.ctx.db.from('jb_tasks').select('*').eq('bot_id', req.ctx.bot.id).neq('status', 'archived').order('sort', { ascending: true }).order('id', { ascending: true }));
    return { tasks: rows };
  });
  route('post', '/a/tasks', 'tasks', async (req) => {
    const o = await taskBody(req, req.body || {}, null);
    const ins = await req.ctx.db.from('jb_tasks').insert({ bot_id: req.ctx.bot.id, ...o }).select().single();
    if (ins.error) throw new Error(ins.error.message);
    await E.audit(req.ctx, req.actor, 'task.create', ins.data.id, { title: o.title, reward: o.reward });
    return { ok: true, task: ins.data };
  });
  route('put', '/a/tasks/:id', 'tasks', async (req) => {
    const ex = (await req.ctx.db.from('jb_tasks').select('*').eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).maybeSingle()).data;
    if (!ex) throw new HttpError(404, 'Task not found.');
    const o = await taskBody(req, req.body || {}, ex);
    if (!Object.keys(o).length) throw new HttpError(400, 'Nothing to change.');
    must(await req.ctx.db.from('jb_tasks').update(o).eq('id', ex.id));
    await E.audit(req.ctx, req.actor, 'task.update', ex.id, o);
    return { ok: true };
  });
  route('delete', '/a/tasks/:id', 'tasks', async (req) => { await req.ctx.db.from('jb_tasks').update({ status: 'archived' }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); await E.audit(req.ctx, req.actor, 'task.archive', req.params.id); return { ok: true }; });

  /* =============================== admin: review queue =============================== */
  route('get', '/a/claims', 'review', async (req) => {
    const rows = must(await req.ctx.db.from('jb_task_claims').select('id,task_id,user_id,status,proof,reward,created_at').eq('bot_id', req.ctx.bot.id).eq('status', 'pending').order('created_at', { ascending: true }).limit(50));
    const tasks = must(await req.ctx.db.from('jb_tasks').select('id,title').eq('bot_id', req.ctx.bot.id));
    return { claims: rows.map((c) => ({ ...c, task: (tasks.find((t) => t.id === c.task_id) || {}).title })) };
  });
  route('post', '/a/claims/:id/:action', 'review', async (req) => {
    if (!['approve', 'reject'].includes(req.params.action)) throw new HttpError(400, 'Unknown action.');
    await E.reviewClaim(req.ctx, req.actor, Number(req.params.id), req.params.action === 'approve'); return { ok: true };
  });

  /* =============================== admin: withdrawals =============================== */
  route('get', '/a/withdrawals', 'finance', async (req) => {
    const st = req.query.status; let qb = req.ctx.db.from('jb_withdrawals').select('*').eq('bot_id', req.ctx.bot.id);
    if (st === 'open') qb = qb.in('status', ['pending', 'approved', 'processing']); else if (st) qb = qb.eq('status', String(st));
    const rows = must(await qb.order('created_at', { ascending: false }).limit(60));
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const users = ids.length ? must(await req.ctx.db.from('jb_users').select('tg_id,first_name,username').eq('bot_id', req.ctx.bot.id).in('tg_id', ids)) : [];
    return { withdrawals: rows.map((r) => ({ ...r, user: users.find((u) => u.tg_id === r.user_id) || null })) };
  });
  route('post', '/a/withdrawals/:id/status', 'finance', async (req) => {
    const b = req.body || {}; const st = String(b.status || '');
    if (!['approved', 'processing', 'paid', 'rejected'].includes(st)) throw new HttpError(400, 'Unknown status.');
    if (st === 'paid' && String(b.pay_ref || '').trim().length < 3) throw new HttpError(400, 'Enter the payment reference before marking it paid.');
    if (st === 'rejected' && String(b.note || '').trim().length < 3) throw new HttpError(400, 'Write a short reason for rejecting.');
    await E.setWithdrawStatus(req.ctx, req.actor, Number(req.params.id), st, txt(b.note, 200, 'Note'), txt(b.pay_ref, 100, 'Reference'));
    return { ok: true };
  });

  /* =============================== admin: scheduled posts =============================== */
  async function postBody(req, b, partial) {
    const { ctx } = req; const o = {};
    if (!partial || 'text' in b) o.text = txt(b.text, 3500, 'Text');
    if (!partial || 'media_type' in b) { o.media_type = b.media_type || 'none'; if (!['none', 'photo', 'video'].includes(o.media_type)) throw new HttpError(400, 'Media must be photo or video.'); o.media_url = o.media_type === 'none' ? null : url(b.media_url, 'Media link'); if (o.media_type !== 'none' && !o.media_url) throw new HttpError(400, 'Add the media link.'); }
    if (!partial || 'button_text' in b || 'button_url' in b) { o.button_text = txt(b.button_text, 40, 'Button text') || null; o.button_url = url(b.button_url, 'Button link'); if (!!o.button_text !== !!o.button_url) throw new HttpError(400, 'A button needs both text and link.'); }
    if (!partial || 'targets' in b) {
      const ids = (Array.isArray(b.targets) ? b.targets : []).map(Number).filter(Number.isInteger);
      const ok = ids.length ? must(await ctx.db.from('jb_channels').select('id').eq('bot_id', ctx.bot.id).in('id', ids)).map((c) => c.id) : [];
      if (!ok.length) throw new HttpError(400, 'Choose at least one channel or group.');
      o.targets = ok;
    }
    if (!partial || 'run_at' in b) o.run_at = iso(b.run_at, 'Date and time', true);
    if (!partial || 'repeat' in b) { o.repeat = b.repeat || 'none'; if (!['none', 'daily', 'weekly'].includes(o.repeat)) throw new HttpError(400, 'Repeat must be none, daily or weekly.'); }
    if (!partial && !o.text && o.media_type === 'none') throw new HttpError(400, 'Write the post text or add media.');
    return o;
  }
  route('get', '/a/posts', 'posts', async (req) => {
    const posts = must(await req.ctx.db.from('jb_posts').select('*').eq('bot_id', req.ctx.bot.id).order('run_at', { ascending: false }).limit(60));
    return { posts };
  });
  route('post', '/a/posts', 'posts', async (req) => {
    const o = await postBody(req, req.body || {}, false);
    const ins = await req.ctx.db.from('jb_posts').insert({ bot_id: req.ctx.bot.id, ...o }).select().single();
    if (ins.error) throw new Error(ins.error.message);
    await E.audit(req.ctx, req.actor, 'post.schedule', ins.data.id, { run_at: o.run_at, repeat: o.repeat });
    return { ok: true, post: ins.data };
  });
  route('put', '/a/posts/:id', 'posts', async (req) => {
    const ex = (await req.ctx.db.from('jb_posts').select('*').eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).maybeSingle()).data;
    if (!ex) throw new HttpError(404, 'Post not found.');
    const o = await postBody(req, req.body || {}, true);
    if ((req.body || {}).reschedule) o.status = 'scheduled';
    must(await req.ctx.db.from('jb_posts').update(o).eq('id', ex.id));
    await E.audit(req.ctx, req.actor, 'post.edit', ex.id); return { ok: true };
  });
  route('delete', '/a/posts/:id', 'posts', async (req) => { await req.ctx.db.from('jb_posts').update({ status: 'cancelled' }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); await E.audit(req.ctx, req.actor, 'post.cancel', req.params.id); return { ok: true }; });
  route('post', '/a/posts/:id/send-now', 'posts', async (req) => {
    const p = (await req.ctx.db.from('jb_posts').select('*').eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).maybeSingle()).data;
    if (!p) throw new HttpError(404, 'Post not found.');
    const results = await Jobs.publishPost(req.ctx, p, `now-${Date.now()}`);
    await E.audit(req.ctx, req.actor, 'post.send_now', p.id); return { ok: true, results };
  });
  route('post', '/a/posts/:id/retry', 'posts', async (req) => {
    const p = (await req.ctx.db.from('jb_posts').select('*').eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).maybeSingle()).data;
    if (!p || !p.last_run_at) throw new HttpError(404, 'Nothing to retry.');
    const results = await Jobs.publishPost(req.ctx, p, new Date(p.last_run_at).toISOString());   // same run key: channels that already got it are skipped
    if (results.every((r) => r.ok) && p.status === 'error') await req.ctx.db.from('jb_posts').update({ status: 'done' }).eq('id', p.id);
    return { ok: true, results };
  });
  route('get', '/a/posts/:id/history', 'posts', async (req) => ({ history: must(await req.ctx.db.from('jb_published').select('*').eq('bot_id', req.ctx.bot.id).eq('post_id', Number(req.params.id)).order('created_at', { ascending: false }).limit(60)) }));

  /* =============================== admin: broadcasts =============================== */
  route('get', '/a/broadcasts', 'broadcast', async (req) => ({ broadcasts: must(await req.ctx.db.from('jb_broadcasts').select('*').eq('bot_id', req.ctx.bot.id).order('created_at', { ascending: false }).limit(30)) }));
  async function bcBody(b) {
    const mt = b.media_type || 'none'; if (!['none', 'photo', 'video'].includes(mt)) throw new HttpError(400, 'Media must be photo or video.');
    const o = { text: txt(b.text, 3500, 'Text'), media_type: mt, media_url: mt === 'none' ? null : url(b.media_url, 'Media link'), button_text: txt(b.button_text, 40, 'Button text') || null, button_url: url(b.button_url, 'Button link') };
    if (!!o.button_text !== !!o.button_url) throw new HttpError(400, 'A button needs both text and link.');
    if (!o.text && !o.media_url) throw new HttpError(400, 'Write a message or add media.');
    return o;
  }
  route('post', '/a/broadcasts/preview', 'broadcast', async (req) => {
    const o = await bcBody(req.body || {});
    try { await sendRich(req.ctx.api, req.tg.id, o); } catch (_) { throw new HttpError(400, 'I could not message you. Open the bot and press /start first.'); }
    return { ok: true };
  });
  route('post', '/a/broadcasts', 'broadcast', async (req) => {
    const b = req.body || {}; const o = await bcBody(b);
    const audience = ['all', 'verified', 'active', 'task_doers'].includes(b.audience) ? b.audience : 'all';
    const total = await Jobs.countAudience(req.ctx, audience);
    if (total > 100 && b.confirm !== true) return { ok: false, needs_confirm: true, total };
    const ins = await req.ctx.db.from('jb_broadcasts').insert({ bot_id: req.ctx.bot.id, ...o, audience, total, run_at: iso(b.run_at, 'Date') || new Date().toISOString() }).select().single();
    if (ins.error) throw new Error(ins.error.message);
    await E.audit(req.ctx, req.actor, 'broadcast.create', ins.data.id, { audience, total });
    return { ok: true, broadcast: ins.data };
  });
  route('post', '/a/broadcasts/:id/cancel', 'broadcast', async (req) => {
    await req.ctx.db.from('jb_broadcasts').update({ status: 'cancelled' }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).in('status', ['queued', 'running']);
    await E.audit(req.ctx, req.actor, 'broadcast.cancel', req.params.id); return { ok: true };
  });

  /* =============================== admin: settings, bot, admins =============================== */
  route('get', '/a/settings', 'settings', async (req) => ({ settings: req.ctx.S, bot: { id: req.ctx.bot.id, name: req.ctx.bot.name, username: req.ctx.bot.username, description: req.ctx.bot.description, status: req.ctx.bot.status, token_last4: req.ctx.bot.token_last4 } }));
  route('put', '/a/settings', 'settings', async (req) => {
    const b = req.body || {}; const patch = clean(b.settings || {});
    const next = { ...(req.ctx.bot.settings || {}), ...patch };
    const botPatch = { settings: next };
    if ('name' in b) botPatch.name = txt(b.name, 64, 'Name', 2);
    if ('description' in b) botPatch.description = txt(b.description, 250, 'Description');
    if ('status' in b) { if (!['active', 'paused'].includes(b.status)) throw new HttpError(400, 'Status must be active or paused.'); botPatch.status = b.status; }
    must(await req.ctx.db.from('jb_bots').update(botPatch).eq('id', req.ctx.bot.id));
    registry.invalidate(req.ctx.bot.id);
    if (botPatch.name) req.ctx.api.call('setMyName', { name: botPatch.name }, 1).catch(() => {});
    if ('description' in botPatch) req.ctx.api.call('setMyDescription', { description: botPatch.description }, 1).catch(() => {});
    await E.audit(req.ctx, req.actor, 'settings.update', null, { keys: Object.keys(patch), status: botPatch.status });
    return { ok: true };
  });
  route('post', '/a/token', 'admins', async (req) => { await Ctl.rotateToken({ db, registry, publicUrl }, req.ctx.bot.id, (req.body || {}).token); await E.audit(req.ctx, req.actor, 'token.rotate'); return { ok: true }; });
  route('get', '/a/admins', 'admins', async (req) => ({ admins: must(await req.ctx.db.from('jb_admins').select('tg_id,role,added_at').eq('bot_id', req.ctx.bot.id)) }));
  route('post', '/a/admins', 'admins', async (req) => { const b = req.body || {}; await Ctl.addAdmin(db, registry, req.ctx.bot.id, b.tg_id, String(b.role || 'admin')); await E.audit(req.ctx, req.actor, 'admin.save', b.tg_id, { role: b.role }); return { ok: true }; });
  route('delete', '/a/admins/:id', 'admins', async (req) => {
    const rows = must(await req.ctx.db.from('jb_admins').select('tg_id,role').eq('bot_id', req.ctx.bot.id));
    const target = rows.find((r) => String(r.tg_id) === String(req.params.id));
    if (target && target.role === 'owner' && rows.filter((r) => r.role === 'owner').length < 2 && req.role !== 'controller') throw new HttpError(400, 'A system needs at least one owner.');
    await req.ctx.db.from('jb_admins').delete().eq('bot_id', req.ctx.bot.id).eq('tg_id', Number(req.params.id)); await E.audit(req.ctx, req.actor, 'admin.remove', req.params.id); return { ok: true };
  });

  /* =============================== admin: audit, flags, announcements, campaigns, support, export =============================== */
  route('get', '/a/audit', 'audit', async (req) => ({ audit: must(await req.ctx.db.from('jb_audit').select('*').eq('bot_id', req.ctx.bot.id).order('created_at', { ascending: false }).limit(80)) }));
  route('get', '/a/flags', 'flags', async (req) => ({ flags: must(await req.ctx.db.from('jb_flags').select('*').eq('bot_id', req.ctx.bot.id).eq('status', 'open').order('created_at', { ascending: false }).limit(60)) }));
  route('post', '/a/flags/:id', 'flags', async (req) => {
    const st = String((req.body || {}).status || ''); if (!['dismissed', 'actioned'].includes(st)) throw new HttpError(400, 'Unknown status.');
    await req.ctx.db.from('jb_flags').update({ status: st }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); await E.audit(req.ctx, req.actor, `flag.${st}`, req.params.id); return { ok: true };
  });
  route('get', '/a/announcements', 'settings', async (req) => ({ announcements: must(await req.ctx.db.from('jb_announcements').select('*').eq('bot_id', req.ctx.bot.id).order('created_at', { ascending: false }).limit(30)) }));
  route('post', '/a/announcements', 'settings', async (req) => {
    const b = req.body || {}; const ins = await req.ctx.db.from('jb_announcements').insert({ bot_id: req.ctx.bot.id, title: txt(b.title, 80, 'Title', 2), body: txt(b.body, 400, 'Text'), pinned: !!b.pinned }).select().single();
    if (ins.error) throw new Error(ins.error.message); await E.audit(req.ctx, req.actor, 'announcement.create', ins.data.id); return { ok: true };
  });
  route('delete', '/a/announcements/:id', 'settings', async (req) => { await req.ctx.db.from('jb_announcements').update({ active: false }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); return { ok: true }; });
  route('get', '/a/campaigns', 'campaigns', async (req) => ({ campaigns: must(await req.ctx.db.from('jb_campaigns').select('*').eq('bot_id', req.ctx.bot.id).order('starts_at', { ascending: false }).limit(30)) }));
  route('post', '/a/campaigns', 'campaigns', async (req) => {
    const b = req.body || {}; const s = iso(b.starts_at, 'Start', true), e = iso(b.ends_at, 'End', true);
    if (new Date(e) <= new Date(s)) throw new HttpError(400, 'The end must be after the start.');
    const pct = Number(b.task_bonus_pct || 0), rb = Number(b.referral_bonus || 0);
    if (!(pct >= 0 && pct <= 500) || !(rb >= 0 && rb <= 100000)) throw new HttpError(400, 'Check the bonus amounts.');
    const ins = await req.ctx.db.from('jb_campaigns').insert({ bot_id: req.ctx.bot.id, name: txt(b.name, 60, 'Name', 2), starts_at: s, ends_at: e, task_bonus_pct: round2(pct), referral_bonus: round2(rb) }).select().single();
    if (ins.error) throw new Error(ins.error.message); await E.audit(req.ctx, req.actor, 'campaign.create', ins.data.id); return { ok: true };
  });
  route('delete', '/a/campaigns/:id', 'campaigns', async (req) => { await req.ctx.db.from('jb_campaigns').update({ active: false }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); return { ok: true }; });
  route('get', '/a/tickets', 'support', async (req) => {
    const rows = must(await req.ctx.db.from('jb_tickets').select('*').eq('bot_id', req.ctx.bot.id).order('created_at', { ascending: false }).limit(40));
    for (const r of rows) r.messages = must(await req.ctx.db.from('jb_ticket_msgs').select('from_admin,body,created_at').eq('ticket_id', r.id).order('created_at', { ascending: true }));
    return { tickets: rows };
  });
  route('post', '/a/tickets/:id/reply', 'support', async (req) => {
    const tk = (await req.ctx.db.from('jb_tickets').select('*').eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)).maybeSingle()).data;
    if (!tk) throw new HttpError(404, 'Ticket not found.');
    const text = txt((req.body || {}).text, 1000, 'Reply', 2);
    await req.ctx.db.from('jb_ticket_msgs').insert({ ticket_id: tk.id, from_admin: true, body: text });
    const u = await E.loadUser(req.ctx, tk.user_id);
    await E.notifyUser(req.ctx, tk.user_id, E.tOf(req.ctx, u)('support_reply', { text }));
    await E.audit(req.ctx, req.actor, 'ticket.reply', tk.id); return { ok: true };
  });
  route('post', '/a/tickets/:id/close', 'support', async (req) => { await req.ctx.db.from('jb_tickets').update({ status: 'closed' }).eq('bot_id', req.ctx.bot.id).eq('id', Number(req.params.id)); return { ok: true }; });
  route('get', '/a/export/:kind', 'finance', async (req, res) => {
    const { ctx } = req; const kind = req.params.kind; let rows, cols;
    if (kind === 'users') { rows = must(await ctx.db.from('jb_users').select('tg_id,username,first_name,captcha_ok,phone,banned,balance,pending,total_earned,joined_at').eq('bot_id', ctx.bot.id).limit(50000)); cols = ['tg_id', 'username', 'first_name', 'captcha_ok', 'phone', 'banned', 'balance', 'pending', 'total_earned', 'joined_at']; }
    else if (kind === 'ledger') { rows = must(await ctx.db.from('jb_ledger').select('id,user_id,amount,kind,note,created_at').eq('bot_id', ctx.bot.id).order('id', { ascending: false }).limit(50000)); cols = ['id', 'user_id', 'amount', 'kind', 'note', 'created_at']; }
    else if (kind === 'withdrawals') { rows = must(await ctx.db.from('jb_withdrawals').select('id,user_id,amount,fee,net,method,account,status,pay_ref,created_at,resolved_at').eq('bot_id', ctx.bot.id).order('id', { ascending: false }).limit(50000)); cols = ['id', 'user_id', 'amount', 'fee', 'net', 'method', 'account', 'status', 'pay_ref', 'created_at', 'resolved_at']; }
    else throw new HttpError(404, 'Unknown report.');
    await E.audit(ctx, req.actor, 'export', kind, { rows: rows.length });
    res.set('Content-Type', 'text/csv; charset=utf-8'); res.send(toCsv(rows, cols));
  });

  /* =============================== controller (platform owner) =============================== */
  const ctl = (method, path, handler) => app[method](`/jb/ctl${path}`, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!factoryToken) throw new HttpError(503, 'The controller bot is not configured.');
      const tg = checkInitData(req.get('x-init-data'), factoryToken);
      if (!tg || !E.superIds().includes(String(tg.id))) throw new HttpError(403, 'Controller only.');
      const out = await handler(req, res, tg); if (!res.headersSent && out !== undefined) res.json(out);
    } catch (e) { fail(res, e); }
  });
  ctl('get', '/bots', async () => ({ bots: await Ctl.listBots(db) }));
  ctl('post', '/bots', async (req, res, tg) => { const bot = await Ctl.connectBot({ db, registry, publicUrl }, (req.body || {}).token, tg.id); return { ok: true, bot: { id: bot.id, username: bot.username, name: bot.name } }; });
  ctl('post', '/bots/:id/admins', async (req) => { const b = req.body || {}; await Ctl.addAdmin(db, registry, Number(req.params.id), b.tg_id, String(b.role || 'owner')); return { ok: true }; });
  ctl('post', '/bots/:id/status', async (req) => { const st = (req.body || {}).status; if (!['active', 'paused'].includes(st)) throw new HttpError(400, 'Status must be active or paused.'); await db.from('jb_bots').update({ status: st }).eq('id', Number(req.params.id)); registry.invalidate(Number(req.params.id)); return { ok: true }; });
  ctl('post', '/bots/:id/token', async (req) => { await Ctl.rotateToken({ db, registry, publicUrl }, Number(req.params.id), (req.body || {}).token); return { ok: true }; });
}

module.exports = { mount };
