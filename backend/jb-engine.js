// Business rules shared by the bot and the mini-app API. Every balance change goes through SQL functions (see schema.sql).
const { memberOf, isGone } = require('./jb-tg');
const { addisDate, round2, HttpError } = require('./jb-util');
const { makeT } = require('./jb-i18n');

const rpc = async (db, fn, args) => {
  const { data, error } = await db.rpc(fn, args);
  if (error) { const e = new Error(error.message); e.code = String(error.message).trim(); throw e; }
  return data;
};
const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

/* ------------------------------ roles and permissions ------------------------------ */
const PERMS = {
  owner: '*',
  admin: ['dashboard', 'users', 'tasks', 'posts', 'broadcast', 'settings', 'finance', 'support', 'review', 'audit', 'campaigns'],
  finance: ['dashboard', 'finance', 'audit'],
  moderator: ['dashboard', 'users', 'tasks', 'review', 'flags'],
  support: ['dashboard', 'support', 'users'],
};
const can = (role, perm) => role === 'controller' || (PERMS[role] === '*') || (PERMS[role] || []).includes(perm);

const superIds = () => String(process.env.SUPER_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
async function roleOf(ctx, tgId) {
  if (superIds().includes(String(tgId))) return 'controller';
  const r = await ctx.db.from('jb_admins').select('role').eq('bot_id', ctx.bot.id).eq('tg_id', tgId).maybeSingle();
  return (r.data && r.data.role) || null;
}
async function adminIds(ctx, perm) {
  const rows = must(await ctx.db.from('jb_admins').select('tg_id,role').eq('bot_id', ctx.bot.id));
  return rows.filter((r) => can(r.role, perm)).map((r) => Number(r.tg_id));
}

/* ------------------------------ small helpers ------------------------------ */
const tOf = (ctx, user) => makeT((user && user.lang) || ctx.S.lang);
const today = (ctx) => addisDate(Date.now() + (Number(ctx.S.tz_offset) - 3) * 3600000);

async function audit(ctx, actor, action, target, detail) {
  try {
    await ctx.db.from('jb_audit').insert({ bot_id: ctx.bot.id, actor: actor.controller ? 'platform' : String(actor.id), role: actor.controller ? 'platform' : actor.role, action, target: target == null ? null : String(target), detail: detail || null });
  } catch (_) { /* audit must never break the action */ }
}

async function notifyUser(ctx, userId, text, kb) {
  try {
    const u = (await ctx.db.from('jb_users').select('notify,blocked').eq('bot_id', ctx.bot.id).eq('tg_id', userId).maybeSingle()).data;
    if (u && u.notify === false) return false;
    await ctx.api.call('sendMessage', { chat_id: userId, text: text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) }, 2);
    return true;
  } catch (e) {
    if (isGone(e)) await ctx.db.from('jb_users').update({ blocked: true }).eq('bot_id', ctx.bot.id).eq('tg_id', userId);
    return false;
  }
}

async function flag(ctx, userId, kind, detail) {
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const dup = await ctx.db.from('jb_flags').select('id').eq('bot_id', ctx.bot.id).eq('user_id', userId).eq('kind', kind).gte('created_at', since).limit(1);
    if (dup.data && dup.data.length) return;
    await ctx.db.from('jb_flags').insert({ bot_id: ctx.bot.id, user_id: userId, kind, detail: String(detail || '').slice(0, 300) });
  } catch (_) { /* ignore */ }
}

const loadUser = async (ctx, id) => (await ctx.db.from('jb_users').select('*').eq('bot_id', ctx.bot.id).eq('tg_id', id).maybeSingle()).data;
const patchUser = async (ctx, id, patch) => { must(await ctx.db.from('jb_users').update(patch).eq('bot_id', ctx.bot.id).eq('tg_id', id)); };

/* ------------------------------ campaigns ------------------------------ */
async function activeCampaign(ctx) {
  const nowIso = new Date().toISOString();
  const rows = must(await ctx.db.from('jb_campaigns').select('*').eq('bot_id', ctx.bot.id).eq('active', true).lte('starts_at', nowIso).gte('ends_at', nowIso).limit(1));
  return rows[0] || null;
}
const taskReward = (task, camp) => round2(Number(task.reward) * (1 + (camp ? Number(camp.task_bonus_pct) : 0) / 100));

/* ------------------------------ tasks ------------------------------ */
async function listTasks(ctx, user) {
  const now = Date.now();
  const tasks = must(await ctx.db.from('jb_tasks').select('*').eq('bot_id', ctx.bot.id).eq('status', 'active').order('sort', { ascending: true }).order('id', { ascending: true }));
  const claims = must(await ctx.db.from('jb_task_claims').select('task_id,day_key,status').eq('bot_id', ctx.bot.id).eq('user_id', user.tg_id));
  const camp = await activeCampaign(ctx);
  const day = today(ctx);
  const out = [];
  for (const t of tasks) {
    if (t.starts_at && new Date(t.starts_at).getTime() > now) continue;
    const expired = t.expires_at && new Date(t.expires_at).getTime() <= now;
    const mine = claims.filter((c) => c.task_id === t.id && (t.type !== 'daily' || c.day_key === day));
    let status = 'available';
    if (mine.some((c) => c.status === 'approved')) status = 'done';
    else if (mine.some((c) => c.status === 'pending')) status = 'pending';
    else if (mine.some((c) => c.status === 'rejected')) status = 'rejected';
    else if (mine.some((c) => c.status === 'reversed')) status = 'done';
    else if (expired) status = 'expired';
    else if (t.type !== 'daily' && t.max_participants != null && t.participants_count >= t.max_participants) status = 'full';
    out.push({ id: t.id, type: t.type, title: t.title, description: t.description, url: t.url || (t.username ? `https://t.me/${t.username}` : null), reward: taskReward(t, camp), base_reward: Number(t.reward), min_seconds: t.min_seconds, expires_at: t.expires_at, max_participants: t.max_participants, participants_count: t.participants_count, status });
  }
  return out;
}

const CLAIM_ERRORS = { duplicate: 'claim_dup', task_full: 'claim_full', task_expired: 'claim_expired', task_unavailable: 'claim_unavail', task_daily_full: 'claim_daily_full' };

async function riskCheck(ctx, user) {
  const since = new Date(Date.now() - 3600000).toISOString();
  const rows = must(await ctx.db.from('jb_task_claims').select('id').eq('bot_id', ctx.bot.id).eq('user_id', user.tg_id).gte('created_at', since));
  const limit = Number(ctx.S.flag_claims_per_hour);
  if (rows.length > limit) await flag(ctx, user.tg_id, 'rapid_claims', `${rows.length} claims in one hour`);
  if (rows.length > limit * 2) { await patchUser(ctx, user.tg_id, { review: true }); return false; }
  return true;
}

// returns { ok:true, status:'approved'|'pending', amount } or { ok:false, error:<i18n key>, vars }
async function claimTask(ctx, user, taskId, opts = {}) {
  const { S } = ctx;
  if (S.maintenance_tasks) return { ok: false, error: 'maint' };
  if (user.banned) return { ok: false, error: 'banned' };
  if (user.review) return { ok: false, error: 'review_hold' };
  if (!user.captcha_ok && S.captcha !== 'off') return { ok: false, error: 'captcha_first' };
  const task = (await ctx.db.from('jb_tasks').select('*').eq('id', taskId).eq('bot_id', ctx.bot.id).maybeSingle()).data;
  if (!task || task.status !== 'active') return { ok: false, error: 'claim_unavail' };
  if (task.expires_at && new Date(task.expires_at).getTime() <= Date.now()) return { ok: false, error: 'claim_expired' };
  if (task.starts_at && new Date(task.starts_at).getTime() > Date.now()) return { ok: false, error: 'claim_unavail' };

  let proof = null;
  if (task.type === 'join') {
    if (!task.chat_id) return { ok: false, error: 'claim_unavail' };
    const m = await memberOf(ctx.api, task.chat_id, user.tg_id);
    if (m === null) return { ok: false, error: 'v_cannot', vars: { title: task.title } };
    if (m === false) return { ok: false, error: 'v_not', vars: { title: task.title } };
  } else if (task.type === 'visit') {
    const started = user.state && user.state.visits && user.state.visits[task.id];
    if (!started || Date.now() - started < Number(task.min_seconds) * 1000) return { ok: false, error: 'wait_visit' };
  } else if (task.type === 'custom') {
    proof = String(opts.proof || '').trim().slice(0, 500);
    if (proof.length < 3) return { ok: false, error: 'proof_short' };
  }
  if (!(await riskCheck(ctx, user))) return { ok: false, error: 'review_hold' };

  const camp = await activeCampaign(ctx);
  const reward = taskReward(task, camp);
  try {
    const r = await rpc(ctx.db, 'jb_claim_task', { p_bot: ctx.bot.id, p_task: task.id, p_user: user.tg_id, p_day: task.type === 'daily' ? today(ctx) : '', p_proof: proof, p_reward: reward });
    if (r.status === 'approved') await qualifyReferral(ctx, user.tg_id);
    return { ok: true, status: r.status, amount: reward, title: task.title };
  } catch (e) {
    if (CLAIM_ERRORS[e.code]) return { ok: false, error: CLAIM_ERRORS[e.code] };
    throw e;
  }
}

async function startVisit(ctx, user, taskId) {
  const state = { ...(user.state || {}), visits: { ...((user.state && user.state.visits) || {}), [taskId]: Date.now() } };
  await patchUser(ctx, user.tg_id, { state });
}

async function reviewClaim(ctx, actor, claimId, approve) {
  const r = await rpc(ctx.db, 'jb_review_claim', { p_bot: ctx.bot.id, p_claim: claimId, p_approve: approve, p_by: actor.controller ? 0 : actor.id });
  await audit(ctx, actor, approve ? 'claim.approve' : 'claim.reject', claimId, r);
  const u = await loadUser(ctx, r.user_id);
  const t = tOf(ctx, u);
  await notifyUser(ctx, r.user_id, approve ? t('claim_ok', { amount: Number(r.reward).toFixed(2) }) : `${r.title}: ${t('t_rejected')}`);
  if (approve) await qualifyReferral(ctx, r.user_id);
  return r;
}

/* ------------------------------ referrals ------------------------------ */
async function qualifyReferral(ctx, referredId) {
  const { S } = ctx;
  if (!S.referral_enabled) return null;
  const ref = (await ctx.db.from('jb_referrals').select('*').eq('bot_id', ctx.bot.id).eq('referred_id', referredId).maybeSingle()).data;
  if (!ref || ref.status !== 'pending') return null;
  const referred = await loadUser(ctx, referredId);
  const referrer = await loadUser(ctx, ref.referrer_id);
  if (!referred || !referrer || referrer.banned || referred.banned) return null;
  if (S.referral_require_captcha && S.captcha !== 'off' && !referred.captcha_ok) return null;
  if (Number(S.referral_min_tasks) > 0) {
    const done = must(await ctx.db.from('jb_task_claims').select('id,task_id').eq('bot_id', ctx.bot.id).eq('user_id', referredId).eq('status', 'approved'));
    if (done.length < Number(S.referral_min_tasks)) return null;
  }
  if (Number(S.referral_cap) > 0) {
    const q = must(await ctx.db.from('jb_referrals').select('referred_id').eq('bot_id', ctx.bot.id).eq('referrer_id', ref.referrer_id).eq('status', 'qualified'));
    if (q.length >= Number(S.referral_cap)) { await ctx.db.from('jb_referrals').update({ status: 'rejected' }).eq('bot_id', ctx.bot.id).eq('referred_id', referredId); return null; }
  }
  const camp = await activeCampaign(ctx);
  const amount = round2(Number(S.referral_reward) + (camp ? Number(camp.referral_bonus) : 0));
  const paid = await rpc(ctx.db, 'jb_credit', { p_bot: ctx.bot.id, p_user: ref.referrer_id, p_amount: amount, p_kind: 'referral', p_ref: `r${referredId}`, p_note: 'Referral reward' });
  must(await ctx.db.from('jb_referrals').update({ status: 'qualified', reward: Number(paid) || 0, qualified_at: new Date().toISOString() }).eq('bot_id', ctx.bot.id).eq('referred_id', referredId).eq('status', 'pending'));
  if (Number(paid) > 0) await notifyUser(ctx, ref.referrer_id, tOf(ctx, referrer)('ref_ok_note', { name: referred.first_name || 'A friend', amount: Number(paid).toFixed(2) }));
  return Number(paid);
}

/* ------------------------------ withdrawals ------------------------------ */
const feeFor = (S, amount) => round2(Number(amount) * Number(S.fee_pct) / 100 + Number(S.fee_flat));

async function requestWithdraw(ctx, user, { amount, method, account }) {
  const { S } = ctx;
  if (S.maintenance_withdraw) throw Object.assign(new Error('maint'), { code: 'maint' });
  amount = round2(amount);
  if (!S.methods.includes(method)) throw Object.assign(new Error('bad_method'), { code: 'bad_method' });
  account = String(account || '').trim();
  if (account.length < 3 || account.length > 60) throw Object.assign(new Error('bad_account'), { code: 'bad_account' });
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('bad_amount'), { code: 'bad_amount' });
  const id = await rpc(ctx.db, 'jb_request_withdraw', { p_bot: ctx.bot.id, p_user: user.tg_id, p_amount: amount, p_fee: feeFor(S, amount), p_method: method, p_account: account, p_min: Number(S.min_withdraw), p_max: Number(S.max_withdraw) });
  if (S.auto_approve) await rpc(ctx.db, 'jb_set_withdraw_status', { p_bot: ctx.bot.id, p_id: id, p_status: 'approved', p_by: 0, p_note: 'auto', p_ref: null });
  // tell the people who handle money
  const ids = await adminIds(ctx, 'finance');
  const w = `<b>New withdrawal #${id}</b>\nUser: ${user.first_name || ''} (${user.tg_id})\nAmount: ${amount.toFixed(2)} ETB (net ${(amount - feeFor(S, amount)).toFixed(2)})\n${method}: ${account}`;
  for (const a of ids) { try { await ctx.api.call('sendMessage', { chat_id: a, text: w, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `wd:a:${id}` }, { text: 'Reject', callback_data: `wd:r:${id}` }]] } }, 1); } catch (_) { /* ignore */ } }
  return id;
}

async function setWithdrawStatus(ctx, actor, id, status, note, payRef) {
  const r = await rpc(ctx.db, 'jb_set_withdraw_status', { p_bot: ctx.bot.id, p_id: id, p_status: status, p_by: actor.controller ? 0 : actor.id, p_note: note || null, p_ref: payRef || null });
  await audit(ctx, actor, `withdraw.${status}`, id, { note, payRef, amount: r.amount });
  const u = await loadUser(ctx, r.user_id); const t = tOf(ctx, u);
  const vars = { id, net: Number(r.net).toFixed(2), amount: Number(r.amount).toFixed(2), ref: payRef || '-', note: note || '' };
  await notifyUser(ctx, r.user_id, t(`wd_s_${status}`, vars));
  return r;
}

/* ------------------------------ manual adjustment (reason required) ------------------------------ */
async function adjustBalance(ctx, actor, userId, amount, reason) {
  amount = round2(amount);
  if (!Number.isFinite(amount) || amount === 0) throw new HttpError(400, 'Enter an amount.');
  if (String(reason || '').trim().length < 5) throw new HttpError(400, 'A reason (at least 5 letters) is required.');
  const done = await rpc(ctx.db, 'jb_credit', { p_bot: ctx.bot.id, p_user: userId, p_amount: amount, p_kind: 'adjust', p_ref: null, p_note: String(reason).trim().slice(0, 200) });
  await audit(ctx, actor, 'wallet.adjust', userId, { amount, applied: done, reason });
  return Number(done);
}

/* ------------------------------ membership recheck (reversal only when the admin enabled the published rule) ------------------------------ */
async function recheckMembership(ctx, limit = 40) {
  const { S } = ctx;
  const days = Number(S.recheck_days);
  if (!days) return 0;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const claims = must(await ctx.db.from('jb_task_claims').select('id,task_id,user_id,reward,checked_at').eq('bot_id', ctx.bot.id).eq('status', 'approved').gte('created_at', since).order('checked_at', { ascending: true }).limit(limit));
  let reversed = 0;
  for (const c of claims) {
    const task = (await ctx.db.from('jb_tasks').select('*').eq('id', c.task_id).maybeSingle()).data;
    if (!task || task.type !== 'join' || !task.chat_id) { await ctx.db.from('jb_task_claims').update({ checked_at: new Date().toISOString() }).eq('id', c.id); continue; }
    const m = await memberOf(ctx.api, task.chat_id, c.user_id);
    await ctx.db.from('jb_task_claims').update({ checked_at: new Date().toISOString() }).eq('id', c.id);
    if (m !== false) continue;
    await flag(ctx, c.user_id, 'left_channel', `left ${task.title}`);
    if (S.reverse_on_leave) {
      const amt = await rpc(ctx.db, 'jb_reverse_claim', { p_bot: ctx.bot.id, p_claim: c.id, p_note: `left ${task.title}` });
      if (Number(amt) > 0) {
        reversed++;
        const u = await loadUser(ctx, c.user_id);
        await notifyUser(ctx, c.user_id, tOf(ctx, u)('reversed', { amount: Number(amt).toFixed(2), title: task.title, rules: S.rules_text || 'Stay in the channel to keep the reward.' }));
        await audit(ctx, { controller: true }, 'claim.reverse', c.id, { user: c.user_id, amount: Number(amt) });
      }
    }
  }
  return reversed;
}

module.exports = { rpc, must, can, PERMS, roleOf, adminIds, superIds, tOf, today, audit, notifyUser, flag, loadUser, patchUser, activeCampaign, taskReward, listTasks, claimTask, startVisit, reviewClaim, qualifyReferral, feeFor, requestWithdraw, setWithdrawStatus, adjustBalance, recheckMembership };
