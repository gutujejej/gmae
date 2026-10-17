// Mini App wallet for the combined Aviator + Bingo bot.
//
//   Bingo wallet   = game_balance (deposits) + balance (registration bonus)
//   Aviator wallet = aviator_balance (deposits only — the bonus cannot be used here)
//
// Deposits are checked automatically (verify.et), the same way the store checks
// orders. The player can paste the whole Telebirr SMS or just the transaction
// number. Verified -> credited at once to the wallet they picked. Anything the
// check cannot confirm is queued for the admin; a wrong or reused number is
// refused. The amount credited is the amount verify.et reports, never the
// amount the player typed.

const crypto = require('crypto');
const { verifyPayment, parseReceiptText, maskMatchesAccount, round2 } = require('./verify-payment');

const DEFAULT_PHONE = '0930008319';
const DEFAULT_MIN_DEPOSIT = 10;
const minDepOf = (row) => (Number(row.min_deposit) > 0 ? Number(row.min_deposit) : DEFAULT_MIN_DEPOSIT);
const MAX_FAILS_PER_HOUR = 6;

module.exports = function attachPayments(app, db, { miniAuth }) {
  const fails = new Map(); // `${bot}:${tg}` -> [timestamps]
  const failKey = (b, t) => `${b}:${t}`;
  function tooManyFails(k) {
    const now = Date.now();
    const list = (fails.get(k) || []).filter((t) => now - t < 3600_000);
    fails.set(k, list);
    return list.length >= MAX_FAILS_PER_HOUR;
  }
  const noteFail = (k) => { const l = fails.get(k) || []; l.push(Date.now()); fails.set(k, l); };

  const err = (res, code, msg) => res.status(code).json({ error: msg });
  const receiverOf = (row, method) => (method === 'cbe' ? row.deposit_cbe_account : (row.deposit_phone || DEFAULT_PHONE));
  const WALLET_LABEL = { bingo: 'Bingo', aviator: 'Aviator' };

  function tell(req, botId, tg, text) {
    const reg = req.app.get('botRegistry');
    const entry = reg && reg.get(botId);
    if (entry) entry.bot.sendMessage(tg, text, { parse_mode: 'Markdown' }).catch(() => {});
  }

  /* ------------------------------ wallets ------------------------------ */
  app.get('/api/mini/:botId/wallets', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const { data: u } = await db.from('bot_users')
        .select('game_balance,balance,aviator_balance,lifetime_deposit').eq('bot_id', row.id).eq('telegram_id', a.user.id).maybeSingle();
      const dep = Number((u && u.game_balance) || 0);
      const bonus = Number((u && u.balance) || 0);
      const lifetime = Number((u && u.lifetime_deposit) || 0);
      const minWd = Number(row.withdraw_min_deposit || 100);
      const fPct = Number(row.first_deposit_bonus_pct) || 0;
      let eligible = false;
      if (fPct > 0) {
        const { count } = await db.from('deposits').select('id', { count: 'exact', head: true })
          .eq('bot_id', row.id).eq('telegram_id', a.user.id).not('status', 'in', '(pending,rejected)');
        eligible = !count;
      }
      const firstBonus = { pct: fPct, max: Number(row.first_deposit_bonus_max) || 0, eligible };
      const holder = row.deposit_holder || 'Baqale';
      const methods = [{ id: 'telebirr', label: 'Telebirr', bank: 'TELEBIRR', number: receiverOf(row, 'telebirr'), holder }];
      if (row.deposit_cbe_account) methods.push({ id: 'cbe', label: 'CBE Birr', bank: 'CBE', number: row.deposit_cbe_account, holder });
      res.set('Cache-Control', 'no-store');
      res.json({
        name: row.name,
        bingo: { deposit: dep, bonus, playable: round2(dep + bonus) },
        aviator: { balance: Number((u && u.aviator_balance) || 0), enabled: row.aviator_enabled !== false },
        total: round2(dep + bonus + Number((u && u.aviator_balance) || 0)),
        withdrawable: round2(dep + Number((u && u.aviator_balance) || 0)), locked: bonus,
        lifetimeDeposit: lifetime, withdrawMinDeposit: minWd, canWithdraw: lifetime >= minWd,
        minDeposit: minDepOf(row), methods, firstBonus, cashbackPct: Number(row.cashback_pct) || 0, autoCheck: !!process.env.CHECK_API_KEY,
      });
    } catch (e) { console.error('wallets error:', e); err(res, 500, 'Could not load your wallets.'); }
  });

  app.get('/api/mini/:botId/deposits', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('deposits')
      .select('id,amount,status,wallet,method,verify_state,created_at')
      .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).order('created_at', { ascending: false }).limit(12);
    if (error) return err(res, 500, 'Could not load deposits.');
    res.set('Cache-Control', 'no-store');
    res.json({ deposits: (data || []).map((d) => ({ id: d.id, amount: Number(d.amount), status: d.status, wallet: d.wallet || 'bingo', method: d.method, auto: d.verify_state === 'verified', at: d.created_at })) });
  });

  /* ------------------------------ deposit ------------------------------ */
  app.post('/api/mini/:botId/deposit', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const body = req.body || {};
      const wallet = body.wallet === 'aviator' ? 'aviator' : 'bingo';
      if (wallet === 'aviator' && row.aviator_enabled === false) return err(res, 403, 'Aviator is switched off.');
      const method = body.method === 'cbe' ? 'cbe' : 'telebirr';
      const receiver = receiverOf(row, method);
      if (!receiver) return err(res, 400, 'This payment method is not available.');

      // The player may paste the full SMS, a receipt link, or just the number.
      const text = String(body.reference || '').trim().slice(0, 2000);
      const parsed = parseReceiptText(text);
      const bare = text.replace(/\s/g, '');
      const reference = parsed.reference || (/^[A-Za-z0-9]{6,20}$/.test(bare) ? bare.toUpperCase() : null);
      if (!reference) return err(res, 400, 'Paste the payment SMS, or enter the transaction number.');

      const typed = body.amount === '' || body.amount == null ? null : round2(body.amount);
      if (typed != null && !(typed > 0)) return err(res, 400, 'Enter a valid amount.');
      if (typed != null && parsed.amount != null && Math.abs(typed - parsed.amount) > 0.009) {
        return err(res, 400, `The amount you typed (${typed}) is different from the amount in the SMS (${parsed.amount}).`);
      }
      const claimed = typed != null ? typed : parsed.amount;
      if (claimed != null && claimed < minDepOf(row)) return err(res, 400, `The minimum deposit is ${minDepOf(row)} ETB.`);

      const fk = failKey(row.id, a.user.id);
      if (tooManyFails(fk)) return err(res, 429, 'Too many wrong attempts. Please try again in an hour.');

      // A pasted SMS names the receiver (2519****5967): refuse early if it is not our number.
      if (method === 'telebirr' && parsed.receiverMask && maskMatchesAccount(parsed.receiverMask, receiver) === false) {
        noteFail(fk);
        return err(res, 422, 'That payment was not sent to our account.');
      }

      const { data: used } = await db.from('deposits').select('id').ilike('reference', reference).neq('status', 'rejected').limit(1);
      if (used && used.length) return err(res, 409, 'This transaction number was already used.');

      const result = await verifyPayment({ method, reference, receiver, expectedAmount: claimed, idemKey: `dep-${row.id}-${method}-${reference}` });
      const label = method === 'cbe' ? 'CBE' : 'TeleBirr';

      if (result.state === 'failed') {
        noteFail(fk);
        return err(res, 422, result.reason || 'We could not verify that payment.');
      }

      if (result.state === 'unverified') {
        if (claimed == null) return err(res, 400, 'We could not check this automatically. Please also enter the amount you sent.');
        const { error } = await db.from('deposits').insert({
          bot_id: row.id, telegram_id: a.user.id, amount: claimed, wallet, method, reference,
          note: `${label}: ${reference} · ${WALLET_LABEL[wallet]} wallet · needs manual check`,
          verify_state: 'unverified', verify_detail: { reason: result.reason, ...(result.detail || {}) },
        });
        if (error) return err(res, error.code === '23505' ? 409 : 500, error.code === '23505' ? 'This transaction number was already used.' : 'Could not save your deposit.');
        return res.json({ result: 'pending', amount: claimed, wallet, message: 'We could not confirm this automatically. The admin will check it shortly and your wallet will be credited.' });
      }

      // verified: credit what verify.et says was paid
      const amount = result.detail.amount;
      const { data: ins, error: insErr } = await db.from('deposits').insert({
        bot_id: row.id, telegram_id: a.user.id, amount, wallet, method, reference,
        note: `${label}: ${reference} · ${WALLET_LABEL[wallet]} wallet · auto-verified`,
        verify_state: 'verified', verify_detail: result.detail,
      }).select('id').single();
      if (insErr) return err(res, insErr.code === '23505' ? 409 : 500, insErr.code === '23505' ? 'This transaction number was already used.' : 'Could not save your deposit.');

      const { data: cr, error: crErr } = await db.rpc('credit_deposit_wallet', { p_deposit_id: ins.id, p_admin: 'auto-verify' });
      if (crErr || !cr || !cr.ok) {
        console.error('credit_deposit_wallet failed:', crErr && crErr.message);
        return res.json({ result: 'pending', amount, wallet, message: 'Payment confirmed. Your wallet will be credited by the admin in a moment.' });
      }
      const bonus = Number(cr.bonus) || 0;
      tell(req, row.id, a.user.id, `✅ Deposit of *${amount} birr* confirmed.\n${WALLET_LABEL[wallet]} wallet: *${Number(cr.new_balance)} birr*${bonus > 0 ? `\n🎁 First deposit bonus: *${bonus} birr* (Bingo bonus)` : ''}`);
      if (Number(cr.promoter_bonus) > 0 && cr.promoter_id) {
        tell(req, row.id, cr.promoter_id, `🎁 A player you invited made a deposit. You earned *${Number(cr.promoter_bonus)} birr* (Bingo bonus).`);
      }
      res.json({ result: 'credited', amount, wallet, balance: Number(cr.new_balance), bonus });
    } catch (e) { console.error('deposit error:', e); err(res, 500, 'Something went wrong. Please try again.'); }
  });

  /* ------------------------------ promoter (invite) ------------------------------ */
  // The invite link, how many friends joined, and what the player earned from their deposits.
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  app.get('/api/mini/:botId/referral', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const { data: bot } = await db.from('bots').select('referral_deposit_bonus_pct,referral_bonus,bot_username').eq('id', row.id).maybeSingle();
      const { data: me } = await db.from('bot_users').select('referral_code').eq('bot_id', row.id).eq('telegram_id', a.user.id).maybeSingle();
      let code = me && me.referral_code;
      if (me && !code) {           // older players do not have a code yet: give them one
        for (let i = 0; i < 5 && !code; i++) {
          const c = newCode();
          const { data: clash } = await db.from('bot_users').select('telegram_id').eq('bot_id', row.id).eq('referral_code', c).maybeSingle();
          if (!clash) { await db.from('bot_users').update({ referral_code: c }).eq('bot_id', row.id).eq('telegram_id', a.user.id); code = c; }
        }
      }
      const { count: invited } = await db.from('bot_users').select('telegram_id', { count: 'exact', head: true }).eq('bot_id', row.id).eq('referred_by', a.user.id);
      const { data: led } = await db.from('promo_ledger').select('amount').eq('bot_id', row.id).eq('telegram_id', a.user.id).eq('kind', 'referral_deposit');
      const username = (bot && bot.bot_username) || row.bot_username;
      res.set('Cache-Control', 'no-store');
      res.json({
        pct: Number(bot && bot.referral_deposit_bonus_pct) || 0,
        fixed: Number(bot && bot.referral_bonus) || 0,
        invited: invited || 0,
        earned: round2((led || []).reduce((sum, x) => sum + Number(x.amount), 0)),
        link: code && username ? `https://t.me/${username}?start=${code}` : null,
      });
    } catch (e) { console.error('referral error:', e); err(res, 500, 'Could not load your invite details.'); }
  });

  /* ------------------------------ coupons ------------------------------ */
  const couponFails = new Map();
  app.post('/api/mini/:botId/coupon/redeem', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row, k = `${row.id}:${a.user.id}`, now = Date.now();
      const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
      if (code.length < 4) return err(res, 400, 'Enter your coupon code.');
      const recent = (couponFails.get(k) || []).filter((t) => now - t < 3600_000);
      if (recent.length >= 6) return err(res, 429, 'Too many wrong codes. Please try again in an hour.');
      const { data, error } = await db.rpc('coupon_redeem', { p_bot_id: row.id, p_telegram_id: a.user.id, p_code: code });
      if (error) throw error;
      if (!data || !data.ok) {
        if (['invalid', 'inactive', 'expired', 'used_up'].includes(data && data.reason)) { recent.push(now); couponFails.set(k, recent); }
        const msgs = {
          invalid: 'That coupon code is not valid.', inactive: 'This coupon is not active.', expired: 'This coupon has expired.',
          used_up: 'This coupon has been fully used.', already: 'You already used this coupon.', no_account: 'Please send /start to the bot first.',
          deposit_required: `You need to deposit at least ${Number(data && data.need)} ETB in total to use this coupon.`,
        };
        return err(res, 400, msgs[data && data.reason] || 'Could not use this coupon.');
      }
      res.json({ ok: true, amount: Number(data.amount), message: `🎁 ${Number(data.amount)} ETB bonus added. You can play it in Bingo.` });
    } catch (e) { console.error('coupon error:', e); err(res, 500, 'Something went wrong. Please try again.'); }
  });

  /* ------------------------------ cashback ------------------------------ */
  app.get('/api/mini/:botId/cashback', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.rpc('cashback_status', { p_bot_id: a.entry.row.id, p_telegram_id: a.user.id });
    if (error) return err(res, 500, 'Could not load cashback.');
    res.set('Cache-Control', 'no-store');
    res.json(data);
  });
  app.post('/api/mini/:botId/cashback/claim', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.rpc('cashback_claim', { p_bot_id: a.entry.row.id, p_telegram_id: a.user.id });
    if (error) return err(res, 500, 'Could not claim cashback.');
    if (!data || !data.ok) {
      const msgs = { off: 'Cashback is not active right now.', no_loss: 'You have no cashback to claim yet.', still_has_balance: 'Cashback opens when your deposit balance is used up.' };
      return err(res, 400, msgs[data && data.reason] || 'Could not claim cashback.');
    }
    res.json({ ok: true, amount: Number(data.amount), message: `🎁 ${Number(data.amount)} ETB cashback added. You can play it in Bingo.` });
  });

  /* ------------------------- saved withdraw accounts ------------------------- */
  app.get('/api/mini/:botId/withdraw-accounts', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('withdraw_accounts').select('id,name,method,account')
      .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).order('id');
    if (error) return err(res, 500, 'Could not load your accounts.');
    res.set('Cache-Control', 'no-store');
    res.json({ accounts: data || [] });
  });

  app.post('/api/mini/:botId/withdraw-accounts', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const name = String((req.body && req.body.name) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const method = req.body && req.body.method === 'cbe' ? 'cbe' : 'telebirr';
      const account = String((req.body && req.body.account) || '').replace(/[^\d+]/g, '');
      if (name.length < 2) return err(res, 400, 'Enter the account holder name.');
      if (account.length < 9 || account.length > 16) return err(res, 400, 'Enter a valid account / phone number.');
      const { count } = await db.from('withdraw_accounts').select('id', { count: 'exact', head: true })
        .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id);
      if ((count || 0) >= 5) return err(res, 400, 'You can save up to 5 accounts. Remove one first.');
      const { data, error } = await db.from('withdraw_accounts')
        .upsert({ bot_id: a.entry.row.id, telegram_id: a.user.id, name, method, account }, { onConflict: 'bot_id,telegram_id,method,account' })
        .select('id,name,method,account').single();
      if (error) throw error;
      res.json({ account: data });
    } catch (e) { console.error('save account error:', e); err(res, 500, 'Could not save the account.'); }
  });

  app.delete('/api/mini/:botId/withdraw-accounts/:id', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { error } = await db.from('withdraw_accounts').delete()
      .eq('id', Number(req.params.id)).eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id);
    if (error) return err(res, 500, 'Could not remove the account.');
    res.json({ ok: true });
  });

  /* ------------------------------ withdraw ------------------------------ */
  app.post('/api/mini/:botId/withdraw', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const body = req.body || {};
      const wallet = body.wallet === 'aviator' ? 'aviator' : 'bingo';
      const amount = round2(body.amount);
      let phone = String(body.phone || '').replace(/[^\d+]/g, '');
      if (body.account_id) {
        const { data: acc } = await db.from('withdraw_accounts').select('account')
          .eq('id', Number(body.account_id)).eq('bot_id', row.id).eq('telegram_id', a.user.id).maybeSingle();
        if (!acc) return err(res, 400, 'Choose one of your saved accounts.');
        phone = acc.account;
      }
      if (!(amount > 0)) return err(res, 400, 'Enter a valid amount.');
      if (phone.length < 9) return err(res, 400, 'Enter a valid Telebirr phone number.');
      const minDep = Number(row.withdraw_min_deposit || 100);

      let r;
      if (wallet === 'aviator') {
        const { data, error } = await db.rpc('wallet_request_withdrawal_aviator', {
          p_bot_id: row.id, p_telegram_id: a.user.id, p_amount: amount, p_phone: phone, p_min_deposit: minDep });
        if (error) throw error;
        r = data;
      } else {
        const { data, error } = await db.rpc('request_withdrawal', {
          p_bot_id: row.id, p_telegram_id: a.user.id, p_amount: amount, p_phone: phone, p_min_deposit: minDep });
        if (error) throw error;
        r = Array.isArray(data) ? data[0] : data;
      }
      if (!r || !r.ok) {
        const msgs = { deposit_required: `You need to deposit at least ${minDep} birr before you can withdraw.`, insufficient_balance: 'Not enough money in that wallet.', no_account: 'Please send /start to the bot first.' };
        return err(res, 400, msgs[r && r.reason] || 'Could not process the withdrawal.');
      }
      res.json({ ok: true, message: 'Withdrawal requested. The admin will send the payment to your Telebirr number.' });
    } catch (e) { console.error('withdraw error:', e); err(res, 500, 'Something went wrong. Please try again.'); }
  });
};
