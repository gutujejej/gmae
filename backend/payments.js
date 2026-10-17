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

const { verifyPayment, parseReceiptText, maskMatchesAccount, round2 } = require('./verify-payment');

const DEFAULT_PHONE = '0930008319';
const MIN_DEPOSIT = 10;
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
      const methods = [{ id: 'telebirr', label: 'TeleBirr', number: receiverOf(row, 'telebirr') }];
      if (row.deposit_cbe_account) methods.push({ id: 'cbe', label: 'CBE', number: row.deposit_cbe_account });
      res.set('Cache-Control', 'no-store');
      res.json({
        name: row.name,
        bingo: { deposit: dep, bonus, playable: round2(dep + bonus) },
        aviator: { balance: Number((u && u.aviator_balance) || 0), enabled: row.aviator_enabled !== false },
        lifetimeDeposit: lifetime, withdrawMinDeposit: minWd, canWithdraw: lifetime >= minWd,
        minDeposit: MIN_DEPOSIT, methods, autoCheck: !!process.env.CHECK_API_KEY,
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
      if (claimed != null && claimed < MIN_DEPOSIT) return err(res, 400, `The minimum deposit is ${MIN_DEPOSIT} ETB.`);

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
      tell(req, row.id, a.user.id, `✅ Deposit of *${amount} birr* confirmed.\n${WALLET_LABEL[wallet]} wallet: *${Number(cr.new_balance)} birr*`);
      res.json({ result: 'credited', amount, wallet, balance: Number(cr.new_balance) });
    } catch (e) { console.error('deposit error:', e); err(res, 500, 'Something went wrong. Please try again.'); }
  });

  /* ------------------------------ withdraw ------------------------------ */
  app.post('/api/mini/:botId/withdraw', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const body = req.body || {};
      const wallet = body.wallet === 'aviator' ? 'aviator' : 'bingo';
      const amount = round2(body.amount);
      const phone = String(body.phone || '').replace(/[^\d+]/g, '');
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
