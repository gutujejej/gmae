// Multiple-account guard. One phone (same device id kept by the mini app) = one account per bot.
// The oldest account keeps working; newer accounts on the same phone are suspended, held or only flagged,
// depending on the bot setting "multi_account". Fingerprint + IP matches are a weak signal and only raise an alert.
const E = require('./jb-engine');

const DID = /^[A-Za-z0-9_-]{16,64}$/;
const FP = /^[a-f0-9]{16,64}$/;

async function record(ctx, user, { did, fp, ip }) {
  const { db, bot, S } = ctx;
  if (!DID.test(String(did || ''))) return;                       // no usable device id: nothing to compare
  fp = FP.test(String(fp || '')) ? fp : null;
  ip = String(ip || '').slice(0, 64) || null;
  const now = new Date().toISOString();

  const mine = (await db.from('jb_devices').select('id,trusted').eq('bot_id', bot.id).eq('user_id', user.tg_id).eq('did', did).maybeSingle()).data;
  if (mine) await db.from('jb_devices').update({ last_seen: now, fp, ip }).eq('id', mine.id);
  else await db.from('jb_devices').insert({ bot_id: bot.id, user_id: user.tg_id, did, fp, ip });

  const mode = S.multi_account || 'ban';
  if (mode === 'off') return;
  if (mine && mine.trusted) return;                               // an admin already cleared this account here
  if (await E.roleOf(ctx, user.tg_id)) return;                    // admins may test with a second account

  const same = (await db.from('jb_devices').select('user_id,trusted').eq('bot_id', bot.id).eq('did', did)).data || [];
  const ids = [...new Set(same.map((r) => r.user_id))];
  if (ids.length > 1) { await punish(ctx, ids, new Set(same.filter((r) => r.trusted).map((r) => r.user_id)), mode); return; }

  // weak signal: same fingerprint and same IP used by another account
  if (fp && ip) {
    const w = (await db.from('jb_devices').select('user_id').eq('bot_id', bot.id).eq('fp', fp).eq('ip', ip).neq('user_id', user.tg_id).limit(1)).data || [];
    if (w.length) await E.flag(ctx, user.tg_id, 'same_device_guess', `Looks like the phone of user ${w[0].user_id} (same model and network). Check before acting.`);
  }
}

async function punish(ctx, ids, trusted, mode) {
  const { db, bot } = ctx;
  const users = (await db.from('jb_users').select('tg_id,joined_at,banned,review').eq('bot_id', bot.id).in('tg_id', ids)).data || [];
  if (users.length < 2) return;
  users.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
  const primary = users[0];
  for (const u of users.slice(1)) {
    if (trusted.has(u.tg_id)) continue;
    if (await E.roleOf(ctx, u.tg_id)) continue;
    const already = mode === 'ban' ? u.banned : (mode === 'hold' ? (u.banned || u.review) : false);
    await E.flag(ctx, u.tg_id, 'multi_account', `Same phone as user ${primary.tg_id}. Action: ${mode === 'ban' ? 'suspended' : mode === 'hold' ? 'held for review' : 'alert only'}.`);
    if (already) continue;
    if (mode === 'ban') await E.patchUser(ctx, u.tg_id, { banned: true });
    else if (mode === 'hold') await E.patchUser(ctx, u.tg_id, { review: true });
    if (mode === 'ban') {                                         // no referral reward for a duplicate account
      await db.from('jb_referrals').update({ status: 'rejected' }).eq('bot_id', bot.id).eq('referred_id', u.tg_id).eq('status', 'pending');
    }
    await E.audit(ctx, { id: 'system', role: 'system' }, `guard.${mode}`, u.tg_id, { same_phone_as: primary.tg_id });
  }
}

// An admin reactivated or released this account: stop treating its devices as duplicates.
async function trust(ctx, userId) {
  await ctx.db.from('jb_devices').update({ trusted: true }).eq('bot_id', ctx.bot.id).eq('user_id', userId);
}

module.exports = { record, trust };
