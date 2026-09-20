// Deposit / Withdraw as Telegram chat buttons (same reply-keyboard pattern
// as Profile/Balance in server.js), plus the admin approve/reject/pay routes.
//
// Conversation state is kept in memory per (botId, telegramId) — fine for a
// single backend process; if you ever run more than one instance you'd move
// this to a table or Redis.

const MENU_EXTRA = {
  deposit: '💵 ገንዘብ ማስገባት',   // Deposit
  withdraw: '🏧 ገንዘብ ማውጣት',   // Withdraw
  play: '🎯 ጫወታ ጀምር',        // Play
};

// pending[`${botId}:${telegramId}`] = { step: 'awaiting_deposit_amount' | 'awaiting_withdraw_amount' | 'awaiting_withdraw_phone', amount? }
const pending = new Map();
const pendKey = (botId, tgId) => `${botId}:${tgId}`;

module.exports = function attachWalletBot(app, db, { requireAdmin, MINIAPP_BASE }) {

  function extendedMenu(baseKeyboardRows) {
    return {
      keyboard: [
        ...baseKeyboardRows,
        [{ text: MENU_EXTRA.deposit }, { text: MENU_EXTRA.withdraw }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  // Returns true if it handled the message (caller should stop further processing).
  async function handleWalletMessage(bot, row, msg, user) {
    const text = (msg.text || '').trim();
    const chatId = msg.chat.id;
    const key = pendKey(row.id, msg.from.id);

    // --- mid-conversation replies (free text after Deposit/Withdraw tapped) ---
    const state = pending.get(key);
    if (state) {
      if (state.step === 'awaiting_deposit_amount') {
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (!amount || amount <= 0) {
          await bot.sendMessage(chatId, 'Please send a valid amount in birr (numbers only), or type /cancel.');
          return true;
        }
        pending.delete(key);
        const { error } = await db.from('deposits').insert({
          bot_id: row.id, telegram_id: msg.from.id, amount,
        });
        if (error) {
          console.error('deposit insert error:', error);
          await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
          return true;
        }
        await bot.sendMessage(chatId,
          `Deposit request received: *${amount} birr*.\nWaiting for admin approval — you'll be notified here once it's confirmed.`,
          { parse_mode: 'Markdown' });
        return true;
      }

      if (state.step === 'awaiting_withdraw_amount') {
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (!amount || amount <= 0) {
          await bot.sendMessage(chatId, 'Please send a valid amount in birr (numbers only), or type /cancel.');
          return true;
        }
        pending.set(key, { step: 'awaiting_withdraw_phone', amount });
        await bot.sendMessage(chatId, 'Send the Telebirr phone number to receive the payment.');
        return true;
      }

      if (state.step === 'awaiting_withdraw_phone') {
        const phone = text.replace(/[^\d+]/g, '');
        if (phone.length < 9) {
          await bot.sendMessage(chatId, 'Please send a valid phone number, or type /cancel.');
          return true;
        }
        pending.delete(key);
        const { data, error } = await db.rpc('request_withdrawal', {
          p_bot_id: row.id, p_telegram_id: msg.from.id,
          p_amount: state.amount, p_phone: phone,
          p_min_deposit: Number(row.withdraw_min_deposit || 100),
        });
        if (error) { console.error('withdraw rpc error:', error); await bot.sendMessage(chatId, 'Something went wrong. Please try again.'); return true; }
        const r = Array.isArray(data) ? data[0] : data;
        if (!r.ok) {
          const msgs = {
            deposit_required: `You need to deposit at least *${Number(row.withdraw_min_deposit || 100)} birr* at least once before you can withdraw.`,
            insufficient_balance: 'Insufficient game balance for that amount.',
            no_account: 'Please send /start first.',
          };
          await bot.sendMessage(chatId, msgs[r.reason] || 'Could not process withdrawal.', { parse_mode: 'Markdown' });
          return true;
        }
        await bot.sendMessage(chatId,
          `Withdrawal request received: *${state.amount} birr* to \`${phone}\`.\nWaiting for admin to send the payment.`,
          { parse_mode: 'Markdown' });
        return true;
      }
    }

    // --- menu button taps ---
    if (text === MENU_EXTRA.deposit) {
      pending.set(key, { step: 'awaiting_deposit_amount' });
      await bot.sendMessage(chatId,
        `Send *${Number(row.deposit_phone || '0930008319')}* via Telebirr, then reply here with the amount you sent (in birr).`,
        { parse_mode: 'Markdown' });
      return true;
    }

    if (text === MENU_EXTRA.withdraw) {
      const { data: u } = await db.from('bot_users').select('lifetime_deposit,game_balance')
        .eq('bot_id', row.id).eq('telegram_id', msg.from.id).maybeSingle();
      const minDep = Number(row.withdraw_min_deposit || 100);
      if (!u || Number(u.lifetime_deposit) < minDep) {
        await bot.sendMessage(chatId,
          `You need to deposit at least *${minDep} birr* at least once before you can withdraw.`,
          { parse_mode: 'Markdown' });
        return true;
      }
      pending.set(key, { step: 'awaiting_withdraw_amount' });
      await bot.sendMessage(chatId,
        `Your game balance: *${Number(u.game_balance)} birr*.\nHow much would you like to withdraw?`,
        { parse_mode: 'Markdown' });
      return true;
    }

    if (text === MENU_EXTRA.play) {
      if (!MINIAPP_BASE) {
        await bot.sendMessage(chatId, 'The game is not available right now.');
        return true;
      }
      await bot.sendMessage(chatId, `Tap below to play ${row.bingo_name || 'Grand Bingo'}.`, {
        reply_markup: { inline_keyboard: [[{
          text: `🎯 Play ${row.bingo_name || 'Grand Bingo'}`,
          web_app: { url: `${MINIAPP_BASE}/bingo?b=${row.id}` },
        }]] },
      });
      return true;
    }

    if (text === '/cancel') {
      pending.delete(key);
      await bot.sendMessage(chatId, 'Cancelled.');
      return true;
    }

    return false;
  }

  /* ================================================================ */
  /* Admin routes: deposits & withdrawals queues                       */
  /* ================================================================ */

  app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
    const status = req.query.status || 'pending';
    const { data, error } = await db.from('deposits').select('*, bots(name)')
      .eq('status', status).order('created_at', { ascending: true }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map((d) => ({
      id: d.id, botId: d.bot_id, botName: d.bots ? d.bots.name : `#${d.bot_id}`,
      telegramId: d.telegram_id, amount: Number(d.amount), status: d.status, createdAt: d.created_at,
    })));
  });

  app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { data, error } = await db.rpc('approve_deposit', { p_deposit_id: id, p_admin: 'admin' });
    if (error) return res.status(500).json({ error: error.message });
    const r = Array.isArray(data) ? data[0] : data;
    if (!r.ok) return res.status(409).json({ error: 'Already decided or not found.' });

    const entry = req.app.get('botRegistry') && req.app.get('botRegistry').get(r.bot_id);
    if (entry) {
      entry.bot.sendMessage(r.telegram_id,
        `✅ Your deposit of *${Number(r.amount)} birr* has been approved.\nGame balance: *${Number(r.new_balance)} birr*`,
        { parse_mode: 'Markdown' }).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { data, error } = await db.from('deposits')
      .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: 'admin' })
      .eq('id', id).eq('status', 'pending').select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(409).json({ error: 'Already decided or not found.' });

    const entry = req.app.get('botRegistry') && req.app.get('botRegistry').get(data.bot_id);
    if (entry) {
      entry.bot.sendMessage(data.telegram_id,
        `❌ Your deposit request of ${Number(data.amount)} birr was rejected. Contact support if this seems wrong.`
      ).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
    const status = req.query.status || 'pending';
    const { data, error } = await db.from('withdrawals').select('*, bots(name)')
      .eq('status', status).order('created_at', { ascending: true }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map((w) => ({
      id: w.id, botId: w.bot_id, botName: w.bots ? w.bots.name : `#${w.bot_id}`,
      telegramId: w.telegram_id, amount: Number(w.amount), phone: w.phone,
      status: w.status, createdAt: w.created_at,
    })));
  });

  app.post('/api/admin/withdrawals/:id/paid', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { data: w } = await db.from('withdrawals').select('*').eq('id', id).maybeSingle();
    if (!w) return res.status(404).json({ error: 'Not found.' });
    const { data, error } = await db.rpc('mark_withdrawal_paid', { p_withdrawal_id: id, p_admin: 'admin' });
    if (error) return res.status(500).json({ error: error.message });
    const r = Array.isArray(data) ? data[0] : data;
    if (!r.ok) return res.status(409).json({ error: 'Already decided or not found.' });

    const entry = req.app.get('botRegistry') && req.app.get('botRegistry').get(w.bot_id);
    if (entry) {
      entry.bot.sendMessage(w.telegram_id,
        `✅ Your withdrawal of *${Number(w.amount)} birr* has been sent to \`${w.phone}\`.`,
        { parse_mode: 'Markdown' }).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.post('/api/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { data: w } = await db.from('withdrawals').select('*').eq('id', id).maybeSingle();
    if (!w) return res.status(404).json({ error: 'Not found.' });
    const { data, error } = await db.rpc('reject_withdrawal', { p_withdrawal_id: id, p_admin: 'admin' });
    if (error) return res.status(500).json({ error: error.message });
    const r = Array.isArray(data) ? data[0] : data;
    if (!r.ok) return res.status(409).json({ error: 'Already decided or not found.' });

    const entry = req.app.get('botRegistry') && req.app.get('botRegistry').get(w.bot_id);
    if (entry) {
      entry.bot.sendMessage(w.telegram_id,
        `❌ Your withdrawal request of ${Number(w.amount)} birr was rejected and refunded to your game balance.`
      ).catch(() => {});
    }
    res.json({ ok: true });
  });

  return { handleWalletMessage, extendedMenu, MENU_EXTRA };
};
