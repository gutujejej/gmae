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
  language: '🌐 ቋንቋ (Language)', // Language
};

// pending[`${botId}:${telegramId}`] = { step: 'awaiting_deposit_amount' | 'awaiting_deposit_reference' | 'awaiting_withdraw_amount' | 'awaiting_withdraw_phone', amount?, bank? }
const pending = new Map();
const pendKey = (botId, tgId) => `${botId}:${tgId}`;

// Language choice per (botId, telegramId): 'am' (default) or 'en'.
// In memory like `pending` above — resets if the backend restarts.
const langs = new Map();
const getLang = (botId, tgId) => langs.get(pendKey(botId, tgId)) || 'am';

// Bank accounts shown when the user picks a bank on Deposit.
// Edit the names / numbers here.
const BANKS = {
  telebirr: { label: '📱 TeleBirr', name: 'TeleBirr', holder: 'Yohannes aberham', number: '0953839231' },
  cbebirr:  { label: '🏦 CBEBirr',  name: 'CBEBirr',  holder: 'Yohannes aberham', number: '0953839231' },
};

// Only the deposit flow and language screens are translated. Keys missing
// from a language fall back to Amharic.
const TEXT = {
  am: {
    pickBank: '🏦 የትኛውን የባንክ አማራጭ መጠቀም ይፈልጋሉ?',
    bankInfo: (b) =>
      `🏦 ባንክ: ${b.name}\n\n` +
      `⚠️ *ማሳሰቢያ:* እባክዎ ከ ${b.name} ወደ ${b.name} ብቻ ያስገቡ!\n\n` +
      `እባክዎ ብሩን ወደዚህ አካውንት ያስገቡ:\n` +
      `👤 ስም: ${b.holder}\n` +
      `👉 ቁጥር: \`${b.number}\`\n\n` +
      `ከዚያም *ያስገቡትን የብር መጠን* ብቻ እዚህ ይፃፉልኝ (ምሳሌ: \`100\`):`,
    badAmount: 'እባክዎ ትክክለኛ የብር መጠን ይላኩ (ቁጥር ብቻ) ወይም /cancel ይላኩ።',
    askReference: (b) => `አሁን ከ${b} SMS ወይም ደረሰኝ ላይ ያለውን *የግብይት ቁጥር (transaction/reference code)* ይላኩ።`,
    badReference: 'እባክዎ የግብይት ቁጥሩን ይላኩ ወይም /cancel ይላኩ።',
    depositReceived: (amt, ref) =>
      `የገንዘብ ማስገባት ጥያቄዎ ደርሶናል: *${amt} ብር* (ref: \`${ref}\`).\nአድሚን እስኪያረጋግጥ ይጠብቁ — ሲፀድቅ እዚሁ ይነገርዎታል።`,
    cancelled: '❌ ትዕዛዙ ተቋርጧል።',
    error: 'የሆነ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።',
    pickLang: '🌐 ቋንቋ ይምረጡ / Choose your language:',
    langSet: '✅ ቋንቋ ወደ አማርኛ ተቀይሯል።',
  },
  en: {
    pickBank: '🏦 Which bank option would you like to use?',
    bankInfo: (b) =>
      `🏦 Bank: ${b.name}\n\n` +
      `⚠️ *Note:* Please send only from ${b.name} to ${b.name}!\n\n` +
      `Please send the money to this account:\n` +
      `👤 Name: ${b.holder}\n` +
      `👉 Number: \`${b.number}\`\n\n` +
      `Then reply here with *only the amount you sent* (e.g. \`100\`):`,
    badAmount: 'Please send a valid amount in birr (numbers only), or type /cancel.',
    askReference: (b) => `Now send the *transaction/reference code* from the ${b} SMS or receipt for this payment.`,
    badReference: 'Please send the transaction/reference code (usually a short code from the SMS), or type /cancel.',
    depositReceived: (amt, ref) =>
      `Deposit request received: *${amt} birr* (ref: \`${ref}\`).\nWaiting for admin approval — you'll be notified here once it's confirmed.`,
    cancelled: '❌ Cancelled.',
    error: 'Something went wrong. Please try again.',
    pickLang: '🌐 ቋንቋ ይምረጡ / Choose your language:',
    langSet: '✅ Language changed to English.',
  },
};
const t = (lang, key) => (TEXT[lang] && TEXT[lang][key]) || TEXT.am[key];

module.exports = function attachWalletBot(app, db, { requireAdmin, MINIAPP_BASE }) {

  function extendedMenu(baseKeyboardRows) {
    return {
      keyboard: [
        ...baseKeyboardRows,
        [{ text: MENU_EXTRA.play }],
        [{ text: MENU_EXTRA.deposit }, { text: MENU_EXTRA.withdraw }],
        [{ text: MENU_EXTRA.language }],
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

    // /cancel and the wallet menu buttons must always escape a half-finished
    // step; otherwise they'd be read as the amount / reference / phone.
    if (pending.has(key)) {
      if (text === '/cancel') {
        pending.delete(key);
        await bot.sendMessage(chatId, t(getLang(row.id, msg.from.id), 'cancelled'));
        return true;
      }
      if (Object.values(MENU_EXTRA).includes(text)) pending.delete(key);
    }

    // --- mid-conversation replies (free text after Deposit/Withdraw tapped) ---
    const state = pending.get(key);
    if (state) {
      if (state.step === 'awaiting_deposit_amount') {
        const lang = getLang(row.id, msg.from.id);
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (!amount || amount <= 0) {
          await bot.sendMessage(chatId, t(lang, 'badAmount'));
          return true;
        }
        pending.set(key, { step: 'awaiting_deposit_reference', amount, bank: state.bank });
        await bot.sendMessage(chatId,
          t(lang, 'askReference')((BANKS[state.bank] || BANKS.telebirr).name),
          { parse_mode: 'Markdown' });
        return true;
      }

      if (state.step === 'awaiting_deposit_reference') {
        const lang = getLang(row.id, msg.from.id);
        const reference = text.trim();
        if (!reference || reference.length < 4) {
          await bot.sendMessage(chatId, t(lang, 'badReference'));
          return true;
        }
        pending.delete(key);
        // Same columns as before — the chosen bank is kept in the existing
        // `note` field so no database change is needed.
        const bankName = (BANKS[state.bank] || BANKS.telebirr).name;
        const { error } = await db.from('deposits').insert({
          bot_id: row.id, telegram_id: msg.from.id, amount: state.amount, note: `${bankName}: ${reference}`,
        });
        if (error) {
          console.error('deposit insert error:', error);
          await bot.sendMessage(chatId, t(lang, 'error'));
          return true;
        }
        await bot.sendMessage(chatId, t(lang, 'depositReceived')(state.amount, reference),
          { parse_mode: 'Markdown' });
        return true;
      }

      if (state.step === 'awaiting_withdraw_amount') {
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (!amount || amount <= 0) {
          await bot.sendMessage(chatId, 'Please send a valid amount in birr (numbers only), or type /cancel.');
          return true;
        }

        // Check the requirements NOW, after the amount is entered, so the
        // withdraw button feels real. Order: deposit rule first, then balance.
        const { data: u } = await db.from('bot_users').select('lifetime_deposit,game_balance')
          .eq('bot_id', row.id).eq('telegram_id', msg.from.id).maybeSingle();
        const minDep = Number(row.withdraw_min_deposit || 100);

        if (!u || Number(u.lifetime_deposit) < minDep) {
          pending.delete(key);
          await bot.sendMessage(chatId,
            `You need to deposit at least *${minDep} birr* to withdraw.`,
            { parse_mode: 'Markdown' });
          return true;
        }
        if (amount > Number(u.game_balance)) {
          pending.delete(key);
          await bot.sendMessage(chatId,
            `Insufficient balance. Your withdrawable balance is *${Number(u.game_balance)} birr*.`,
            { parse_mode: 'Markdown' });
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
            deposit_required: `You need to deposit at least *${Number(row.withdraw_min_deposit || 100)} birr* to withdraw.`,
            insufficient_balance: 'Insufficient balance.',
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
      // Clear any half-finished deposit, then let the user pick a bank.
      pending.delete(key);
      const lang = getLang(row.id, msg.from.id);
      await bot.sendMessage(chatId, t(lang, 'pickBank'), {
        reply_markup: { inline_keyboard: [[
          { text: BANKS.telebirr.label, callback_data: 'dep_bank:telebirr' },
          { text: BANKS.cbebirr.label, callback_data: 'dep_bank:cbebirr' },
        ]] },
      });
      return true;
    }

    if (text === MENU_EXTRA.language) {
      await bot.sendMessage(chatId, t(getLang(row.id, msg.from.id), 'pickLang'), {
        reply_markup: { inline_keyboard: [[
          { text: '🇪🇹 አማርኛ', callback_data: 'lang:am' },
          { text: '🇬🇧 English', callback_data: 'lang:en' },
        ]] },
      });
      return true;
    }

    if (text === MENU_EXTRA.withdraw) {
      // Don't reveal any requirement yet — ask for the amount first. The
      // deposit/balance checks run once the user enters it.
      pending.set(key, { step: 'awaiting_withdraw_amount' });
      await bot.sendMessage(chatId,
        `🏧 *Withdraw*\nHow much would you like to withdraw? (numbers only, or /cancel)`,
        { parse_mode: 'Markdown' });
      return true;
    }

    if (text === MENU_EXTRA.play) {
      if (!MINIAPP_BASE) {
        await bot.sendMessage(chatId, 'The game is not available right now.');
        return true;
      }
      await bot.sendMessage(chatId, `Tap below to play ${row.bingo_name || 'Bingo'}.`, {
        reply_markup: { inline_keyboard: [[{
          text: `🎯 Play ${row.bingo_name || 'Bingo'}`,
          web_app: { url: `${MINIAPP_BASE}/bingo?b=${row.id}` },
        }]] },
      });
      return true;
    }

    if (text === '/cancel') {
      pending.delete(key);
      await bot.sendMessage(chatId, t(getLang(row.id, msg.from.id), 'cancelled'));
      return true;
    }

    return false;
  }

  // Handles the inline-button taps for bank choice and language.
  // Returns true if it handled the callback (caller should stop).
  async function handleWalletCallback(bot, row, q) {
    const data = String(q.data || '');
    const chatId = q.message.chat.id;
    const key = pendKey(row.id, q.from.id);

    if (data.startsWith('dep_bank:')) {
      const bank = BANKS[data.slice('dep_bank:'.length)];
      if (!bank) { await bot.answerCallbackQuery(q.id); return true; }
      const lang = getLang(row.id, q.from.id);
      pending.set(key, { step: 'awaiting_deposit_amount', bank: data.slice('dep_bank:'.length) });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, t(lang, 'bankInfo')(bank), { parse_mode: 'Markdown' });
      return true;
    }

    if (data.startsWith('lang:')) {
      const lang = data.slice('lang:'.length) === 'en' ? 'en' : 'am';
      langs.set(key, lang);
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, t(lang, 'langSet'));
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
      telegramId: d.telegram_id, amount: Number(d.amount), reference: d.note || '',
      status: d.status, createdAt: d.created_at,
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

  return { handleWalletMessage, handleWalletCallback, extendedMenu, MENU_EXTRA };
};
