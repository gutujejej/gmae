// Cross P2P: market listing, orders, operator admin and image handling.
// Mounted from server.js (same pattern as bingo.js / wallet-bot.js).
//
// Who can do what
// - Anyone:           GET /api/p2p/market (listed platforms and their rates only)
// - Telegram user:    everything under /api/mini/:botId/p2p/... that is not "admin".
//                     Identity comes from Telegram's signed initData (miniAuth),
//                     never from anything the client claims.
// - Platform operator: routes under /api/mini/:botId/p2p/admin/... Allowed only when
//                     the verified Telegram ID is in that platform's admin_ids.
// - Master admin:     /api/admin/p2p/... (dashboard password) sets operator IDs.
//
// Images
// - Payment proofs go to the PRIVATE bucket "p2p-proofs". Operators view them
//   through short-lived signed links created here.
// - Platform logos go to the PUBLIC bucket "p2p-logos".

const crypto = require('crypto');
const express = require('express');

const PROOF_BUCKET = 'p2p-proofs';
const LOGO_BUCKET = 'p2p-logos';
const PROOF_MAX_BYTES = 4 * 1024 * 1024;
const LOGO_MAX_BYTES = 1024 * 1024;
const MAX_ACTIVE_ORDERS_PER_USER = 5;
const MAX_METHODS_PER_PLATFORM = 12;
const SIGNED_URL_SECONDS = 600;

const KINDS = ['telebirr', 'cbe', 'awash', 'abyssinia', 'dashen', 'bank', 'usdt', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TG_NAME = /^[A-Za-z0-9_]{4,32}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Identify an image by its first bytes instead of trusting the client's header.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// Accepts an array or a comma / space / newline separated string of Telegram IDs.
function parseAdminIds(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
  const out = [];
  for (const p of parts) {
    const s = String(p).trim();
    if (!s) continue;
    if (!/^\d{5,15}$/.test(s)) throw new Error(`"${s}" is not a valid Telegram ID (numbers only)`);
    const n = Number(s);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > 10) throw new Error('Maximum 10 operators per platform');
  return out;
}

function cleanTgUsername(raw) {
  const u = String(raw || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  if (!u) return null;
  if (!TG_NAME.test(u)) throw new Error('Telegram username must be 4-32 letters, numbers or underscores');
  return u;
}

function genRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `CP-${s}`;
}

module.exports = function attachP2p(app, db, { requireAdmin, miniAuth, MINIAPP_BASE, upsertUser }) {
  const registry = () => app.get('botRegistry');

  /* ================================================================ */
  /* Helpers                                                           */
  /* ================================================================ */

  const isOperator = (p, tgId) => (p.admin_ids || []).map(Number).includes(Number(tgId));

  const logoUrl = (p) => {
    if (!p.logo_path) return null;
    const { data } = db.storage.from(LOGO_BUCKET).getPublicUrl(p.logo_path);
    const v = p.updated_at ? new Date(p.updated_at).getTime() : 0;
    return `${data.publicUrl}?v=${v}`;
  };

  const publicPlatform = (p) => ({
    id: p.id,
    bot_id: p.bot_id,
    name: p.bots ? p.bots.name : `Platform ${p.id}`,
    bot_username: p.bots ? p.bots.bot_username : null,
    tg_username: p.tg_username || null,
    note: p.note || '',
    buy_rate: Number(p.buy_rate),
    sell_rate: Number(p.sell_rate),
    min_usdt: Number(p.min_usdt),
    max_usdt: Number(p.max_usdt),
    paused: !!p.paused,
    logo_url: logoUrl(p),
    updated_at: p.updated_at,
  });

  const isListed = (p) => Number(p.buy_rate) > 0 || Number(p.sell_rate) > 0;

  async function listedPlatforms() {
    const { data, error } = await db.from('p2p_platforms')
      .select('*, bots!inner(name,bot_username,active)')
      .eq('bots.active', true);
    if (error) throw error;
    return (data || []).filter(isListed);
  }

  async function getListedPlatform(id) {
    if (!Number.isInteger(id)) return null;
    const { data, error } = await db.from('p2p_platforms')
      .select('*, bots!inner(name,bot_username,active)')
      .eq('id', id).eq('bots.active', true).maybeSingle();
    if (error) throw error;
    return data && isListed(data) ? data : null;
  }

  async function platformNames(ids) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return {};
    const { data } = await db.from('p2p_platforms').select('id, bots(name)').in('id', uniq);
    return Object.fromEntries((data || []).map((p) => [p.id, p.bots ? p.bots.name : `Platform ${p.id}`]));
  }

  const userOrder = (o, names) => ({
    id: o.id,
    ref: o.ref,
    platform_id: o.platform_id,
    platform_name: (names && names[o.platform_id]) || '',
    side: o.side,
    amount_usdt: Number(o.amount_usdt),
    rate: Number(o.rate),
    total_etb: Number(o.total_etb),
    status: o.status,
    admin_note: o.admin_note || '',
    has_proof: !!o.proof_path,
    created_at: o.created_at,
  });

  const methodView = (m) => ({
    id: m.id, kind: m.kind, label: m.label,
    account_name: m.account_name || '', account_number: m.account_number,
    network: m.network || '', sort_order: m.sort_order, active: m.active,
  });

  // Telegram message to a user or operator through the platform's own bot.
  async function notify(botId, chatId, text, buttonUrl, buttonText) {
    try {
      const entry = registry() && registry().get(botId);
      if (!entry) return;
      await entry.bot.sendMessage(chatId, text, buttonUrl ? {
        reply_markup: { inline_keyboard: [[{ text: buttonText || 'Open', web_app: { url: buttonUrl } }]] },
      } : {});
    } catch (_) { /* user never started the bot, or blocked it */ }
  }

  const appUrl = (botId, extra = '') => (MINIAPP_BASE ? `${MINIAPP_BASE}/p2p?b=${botId}${extra}` : null);

  async function fetchOwnPlatform(req, res, a) {
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'Invalid platform.' }); return null; }
    const { data: p, error } = await db.from('p2p_platforms')
      .select('*, bots(name,bot_username,active)').eq('id', pid).maybeSingle();
    if (error) throw error;
    if (!p || !isOperator(p, a.user.id)) {
      res.status(403).json({ error: 'You are not an operator of this platform.' });
      return null;
    }
    return p;
  }

  const fail = (res, tag) => (err) => {
    console.error(`${tag}:`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };

  /* ================================================================ */
  /* Telegram bot for a P2P platform                                   */
  /* ================================================================ */

  function attachBot(entry) {
    const { bot } = entry;
    bot.onText(/^\/start/, async (msg) => {
      try {
        // Registers the user so broadcasts from the dashboard reach them.
        await upsertUser(entry.row.id, msg.from, null);
        const url = appUrl(entry.row.id);
        if (!url) return bot.sendMessage(msg.chat.id, 'The market is not available right now.');
        // Clears any old Bingo/wallet menu still showing in this chat.
        await bot.sendMessage(
          msg.chat.id,
          `Welcome to ${entry.row.name}.\n\nOpen the market to compare live USDT rates, then buy or sell in a few taps. Payment details are shown inside the app with one-tap copy.`,
          { reply_markup: { remove_keyboard: true } }
        );
        await bot.sendMessage(
          msg.chat.id,
          'Tap below to open the market.',
          { reply_markup: { inline_keyboard: [[{ text: 'Open Cross P2P', web_app: { url } }]] } }
        );
      } catch (err) {
        console.error('p2p /start error:', err);
        bot.sendMessage(msg.chat.id, 'Something went wrong. Please try again.');
      }
    });
    // Puts an "open app" button next to the message box (best effort).
    const url = appUrl(entry.row.id);
    if (url && typeof bot.setChatMenuButton === 'function') {
      bot.setChatMenuButton({
        menu_button: JSON.stringify({ type: 'web_app', text: 'Cross P2P', web_app: { url } }),
      }).catch(() => {});
    }
  }

  async function ensurePlatform(botRow, { adminIds = [], tgUsername = null } = {}) {
    const { error } = await db.from('p2p_platforms').upsert(
      { bot_id: botRow.id, admin_ids: adminIds, tg_username: tgUsername },
      { onConflict: 'bot_id' }
    );
    if (error) throw error;
  }

  /* ================================================================ */
  /* Public: market                                                    */
  /* ================================================================ */

  app.get('/api/p2p/market', async (_req, res) => {
    try {
      const rows = await listedPlatforms();
      res.set('Cache-Control', 'public, max-age=10');
      res.json(rows.map(publicPlatform));
    } catch (err) { fail(res, 'p2p market')(err); }
  });

  /* ================================================================ */
  /* Mini App: user side                                               */
  /* ================================================================ */

  // Who am I, and do I operate any platform? The client shows "Switch to
  // admin" only when admin_platforms is not empty.
  app.get('/api/mini/:botId/p2p/me', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const { data, error } = await db.from('p2p_platforms')
        .select('id, bots(name)').contains('admin_ids', [a.user.id]);
      if (error) throw error;
      res.set('Cache-Control', 'no-store');
      res.json({
        user: { id: a.user.id, first_name: a.user.first_name || '', username: a.user.username || '' },
        admin_platforms: (data || []).map((p) => ({ id: p.id, name: p.bots ? p.bots.name : `Platform ${p.id}` })),
      });
    } catch (err) { fail(res, 'p2p me')(err); }
  });

  // Payment accounts for an order. Buy orders pay birr to fiat accounts;
  // sell orders send USDT to the platform's wallet.
  app.get('/api/mini/:botId/p2p/platforms/:pid/payment', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await getListedPlatform(Number(req.params.pid));
      if (!p) return res.status(404).json({ error: 'This platform is not available.' });
      const side = req.query.side === 'sell' ? 'sell' : 'buy';
      const { data, error } = await db.from('p2p_payment_methods').select('*')
        .eq('platform_id', p.id).eq('active', true).order('sort_order').order('id');
      if (error) throw error;
      const methods = (data || [])
        .filter((m) => (side === 'sell' ? m.kind === 'usdt' : m.kind !== 'usdt'))
        .map(methodView);
      res.set('Cache-Control', 'no-store');
      // SELL: the customer sends USDT to the operator's Binance UID.
      res.json({ side, methods, binance_uid: side === 'sell' ? (p.binance_uid || '') : '' });
    } catch (err) { fail(res, 'p2p payment')(err); }
  });

  app.get('/api/mini/:botId/p2p/orders', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const { data, error } = await db.from('p2p_orders').select('*')
        .eq('telegram_id', a.user.id).order('created_at', { ascending: false }).limit(30);
      if (error) throw error;
      const names = await platformNames((data || []).map((o) => o.platform_id));
      res.set('Cache-Control', 'no-store');
      res.json((data || []).map((o) => userOrder(o, names)));
    } catch (err) { fail(res, 'p2p orders')(err); }
  });

  app.post('/api/mini/:botId/p2p/orders', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const b = req.body || {};
      const side = b.side === 'sell' ? 'sell' : b.side === 'buy' ? 'buy' : null;
      if (!side) return res.status(400).json({ error: 'Choose buy or sell.' });

      const p = await getListedPlatform(Number(b.platform_id));
      if (!p) return res.status(404).json({ error: 'This platform is not available.' });
      if (p.paused) return res.status(409).json({ error: 'This platform is paused right now.' });

      const rate = Number(side === 'buy' ? p.buy_rate : p.sell_rate);
      if (!(rate > 0)) return res.status(409).json({ error: `This platform is not ${side === 'buy' ? 'selling' : 'buying'} USDT right now.` });

      if (side === 'sell' && !p.binance_uid) {
        return res.status(409).json({ error: 'This platform has not set its Binance UID yet. Please try again later.' });
      }

      const amount = round2(Number(b.amount_usdt));
      if (!(amount > 0)) return res.status(400).json({ error: 'Enter a valid USDT amount.' });
      if (amount < Number(p.min_usdt) || amount > Number(p.max_usdt)) {
        return res.status(400).json({ error: `Amount must be between ${Number(p.min_usdt)} and ${Number(p.max_usdt)} USDT.` });
      }

      // BUY : customer gives their Binance UID (we send USDT there).
      // SELL: customer gives Telebirr phone + name (we send birr there).
      let details, method, payoutName = null;
      if (side === 'buy') {
        details = clean(b.payout_details, 20);
        if (!/^\d{5,15}$/.test(details)) {
          return res.status(400).json({ error: 'Enter your Binance UID (numbers only).' });
        }
        method = 'binance';
      } else {
        details = clean(b.payout_details, 20).replace(/[\s-]/g, '');
        if (!/^\+?\d{9,13}$/.test(details)) {
          return res.status(400).json({ error: 'Enter a valid Telebirr phone number.' });
        }
        payoutName = clean(b.payout_name, 80);
        if (payoutName.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
        method = 'telebirr';
      }

      const { count, error: cErr } = await db.from('p2p_orders').select('id', { count: 'exact', head: true })
        .eq('telegram_id', a.user.id).in('status', ['open', 'submitted']);
      if (cErr) throw cErr;
      if ((count || 0) >= MAX_ACTIVE_ORDERS_PER_USER) {
        return res.status(429).json({ error: 'You have too many unfinished orders. Complete or cancel one first.' });
      }

      let order = null;
      for (let i = 0; i < 4 && !order; i++) {
        const { data, error } = await db.from('p2p_orders').insert({
          ref: genRef(), platform_id: p.id, telegram_id: a.user.id,
          username: a.user.username || null, first_name: a.user.first_name || null,
          side, amount_usdt: amount, rate, total_etb: round2(amount * rate),
          payout_method: method || null, payout_details: details,
          ...(payoutName ? { payout_name: payoutName } : {}),
        }).select().single();
        if (error && error.code === '23505') continue; // ref collision, try another
        if (error) throw error;
        order = data;
      }
      if (!order) throw new Error('Could not allocate an order reference');
      res.status(201).json(userOrder(order, { [p.id]: p.bots.name }));
    } catch (err) { fail(res, 'p2p create order')(err); }
  });

  app.post('/api/mini/:botId/p2p/orders/:oid/cancel', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      if (!UUID.test(req.params.oid)) return res.status(400).json({ error: 'Invalid order.' });
      const { data, error } = await db.from('p2p_orders').update({ status: 'cancelled' })
        .eq('id', req.params.oid).eq('telegram_id', a.user.id).eq('status', 'open').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: 'This order can no longer be cancelled.' });
      res.json({ ok: true });
    } catch (err) { fail(res, 'p2p cancel')(err); }
  });

  // Payment proof: the browser sends one compressed image as the raw request body.
  app.put('/api/mini/:botId/p2p/orders/:oid/proof',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: PROOF_MAX_BYTES }),
    async (req, res) => {
      const a = miniAuth(req, res); if (!a) return;
      try {
        if (!UUID.test(req.params.oid)) return res.status(400).json({ error: 'Invalid order.' });
        const img = sniffImage(req.body);
        if (!img) return res.status(415).json({ error: 'Upload a JPG, PNG or WEBP image.' });
        if (req.body.length > PROOF_MAX_BYTES) return res.status(413).json({ error: 'Image is too large (max 4 MB).' });

        const { data: order, error } = await db.from('p2p_orders').select('*')
          .eq('id', req.params.oid).eq('telegram_id', a.user.id).maybeSingle();
        if (error) throw error;
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (!['open', 'submitted'].includes(order.status)) {
          return res.status(409).json({ error: 'This order is already closed.' });
        }

        const path = `${order.platform_id}/${order.id}.${img.ext}`;
        const { error: upErr } = await db.storage.from(PROOF_BUCKET)
          .upload(path, req.body, { contentType: img.mime, upsert: true });
        if (upErr) throw upErr;
        // A re-upload with a different extension must not leave the old file behind.
        if (order.proof_path && order.proof_path !== path) {
          await db.storage.from(PROOF_BUCKET).remove([order.proof_path]).catch(() => {});
        }

        const wasNew = order.status === 'open';
        const { error: updErr } = await db.from('p2p_orders').update({
          proof_path: path, status: 'submitted', submitted_at: new Date().toISOString(),
        }).eq('id', order.id);
        if (updErr) throw updErr;

        if (wasNew) {
          const { data: p } = await db.from('p2p_platforms').select('bot_id, admin_ids').eq('id', order.platform_id).maybeSingle();
          if (p) {
            const text = `New ${order.side} order ${order.ref}\n${Number(order.amount_usdt)} USDT at ${Number(order.rate)} = ${Number(order.total_etb)} ETB\nProof uploaded. Open the app and switch to admin to review it.`;
            for (const id of p.admin_ids || []) {
              notify(p.bot_id, id, text, appUrl(p.bot_id, '&admin=1'), 'Review order');
            }
          }
        }
        res.json({ ok: true });
      } catch (err) { fail(res, 'p2p proof upload')(err); }
    });

  /* ================================================================ */
  /* Mini App: operator ("Switch to admin")                            */
  /* ================================================================ */

  app.get('/api/mini/:botId/p2p/admin/platforms', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const { data: plats, error } = await db.from('p2p_platforms')
        .select('*, bots(name,bot_username,active)').contains('admin_ids', [a.user.id]).order('id');
      if (error) throw error;
      const ids = (plats || []).map((p) => p.id);
      let methods = [];
      let pending = [];
      if (ids.length) {
        const [m, o] = await Promise.all([
          db.from('p2p_payment_methods').select('*').in('platform_id', ids).order('sort_order').order('id'),
          db.from('p2p_orders').select('platform_id').in('platform_id', ids).eq('status', 'submitted'),
        ]);
        if (m.error) throw m.error;
        if (o.error) throw o.error;
        methods = m.data || [];
        pending = o.data || [];
      }
      res.set('Cache-Control', 'no-store');
      res.json((plats || []).map((p) => ({
        ...publicPlatform(p),
        bot_active: !!(p.bots && p.bots.active),
        methods: methods.filter((x) => x.platform_id === p.id).map(methodView),
        binance_uid: p.binance_uid || '',
        pending_orders: pending.filter((x) => x.platform_id === p.id).length,
      })));
    } catch (err) { fail(res, 'p2p admin platforms')(err); }
  });

  app.patch('/api/mini/:botId/p2p/admin/platforms/:pid', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      const b = req.body || {};
      const patch = {};

      for (const k of ['buy_rate', 'sell_rate']) {
        if (k in b) {
          const n = round2(Number(b[k]));
          if (!(n >= 0 && n <= 1000000)) return res.status(400).json({ error: 'Rates must be between 0 and 1,000,000.' });
          patch[k] = n;
        }
      }
      for (const k of ['min_usdt', 'max_usdt']) {
        if (k in b) {
          const n = round2(Number(b[k]));
          if (!(n > 0 && n <= 10000000)) return res.status(400).json({ error: 'Limits must be greater than 0.' });
          patch[k] = n;
        }
      }
      const min = 'min_usdt' in patch ? patch.min_usdt : Number(p.min_usdt);
      const max = 'max_usdt' in patch ? patch.max_usdt : Number(p.max_usdt);
      if (min > max) return res.status(400).json({ error: 'Minimum cannot be higher than maximum.' });

      if ('paused' in b) patch.paused = !!b.paused;
      if ('binance_uid' in b) {
        const uid = clean(b.binance_uid, 20);
        if (uid && !/^\d{5,15}$/.test(uid)) return res.status(400).json({ error: 'Binance UID must be numbers only (5 to 15 digits).' });
        patch.binance_uid = uid || null;
      }
      if ('note' in b) patch.note = clean(b.note, 120) || null;
      if ('tg_username' in b) {
        try { patch.tg_username = cleanTgUsername(b.tg_username); }
        catch (e) { return res.status(400).json({ error: e.message }); }
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

      const { data, error } = await db.from('p2p_platforms').update(patch).eq('id', p.id)
        .select('*, bots(name,bot_username,active)').single();
      if (error) throw error;
      res.json(publicPlatform(data));
    } catch (err) { fail(res, 'p2p admin patch')(err); }
  });

  app.put('/api/mini/:botId/p2p/admin/platforms/:pid/logo',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: LOGO_MAX_BYTES }),
    async (req, res) => {
      const a = miniAuth(req, res); if (!a) return;
      try {
        const p = await fetchOwnPlatform(req, res, a); if (!p) return;
        const img = sniffImage(req.body);
        if (!img) return res.status(415).json({ error: 'Upload a JPG, PNG or WEBP image.' });
        if (req.body.length > LOGO_MAX_BYTES) return res.status(413).json({ error: 'Logo is too large (max 1 MB).' });

        const path = `${p.id}-${Date.now()}.${img.ext}`;
        const { error: upErr } = await db.storage.from(LOGO_BUCKET)
          .upload(path, req.body, { contentType: img.mime, cacheControl: '31536000' });
        if (upErr) throw upErr;
        const { data, error } = await db.from('p2p_platforms').update({ logo_path: path })
          .eq('id', p.id).select('*, bots(name,bot_username,active)').single();
        if (error) throw error;
        if (p.logo_path) await db.storage.from(LOGO_BUCKET).remove([p.logo_path]).catch(() => {});
        res.json(publicPlatform(data));
      } catch (err) { fail(res, 'p2p logo upload')(err); }
    });

  app.delete('/api/mini/:botId/p2p/admin/platforms/:pid/logo', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      const { error } = await db.from('p2p_platforms').update({ logo_path: null }).eq('id', p.id);
      if (error) throw error;
      if (p.logo_path) await db.storage.from(LOGO_BUCKET).remove([p.logo_path]).catch(() => {});
      res.json({ ok: true });
    } catch (err) { fail(res, 'p2p logo delete')(err); }
  });

  /* ---- payment accounts ---- */

  function readMethod(b, partial) {
    const out = {};
    if (!partial || 'kind' in b) {
      if (!KINDS.includes(b.kind)) throw new Error('Choose a valid account type.');
      out.kind = b.kind;
    }
    if (!partial || 'label' in b) {
      out.label = clean(b.label, 40);
      if (!out.label) throw new Error('Enter a label.');
    }
    if (!partial || 'account_number' in b) {
      out.account_number = clean(b.account_number, 120);
      if (out.account_number.length < 3) throw new Error('Enter the account number or address.');
    }
    if (!partial || 'account_name' in b) out.account_name = clean(b.account_name, 80) || null;
    if (!partial || 'network' in b) out.network = clean(b.network, 20) || null;
    if ('active' in b) out.active = !!b.active;
    if ('sort_order' in b) out.sort_order = Math.max(0, Math.min(999, parseInt(b.sort_order, 10) || 0));
    return out;
  }

  app.post('/api/mini/:botId/p2p/admin/platforms/:pid/methods', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      let row;
      try { row = readMethod(req.body || {}, false); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      const { count } = await db.from('p2p_payment_methods').select('id', { count: 'exact', head: true }).eq('platform_id', p.id);
      if ((count || 0) >= MAX_METHODS_PER_PLATFORM) return res.status(400).json({ error: `Maximum ${MAX_METHODS_PER_PLATFORM} accounts.` });
      const { data, error } = await db.from('p2p_payment_methods')
        .insert({ ...row, platform_id: p.id, sort_order: row.sort_order ?? (count || 0) }).select().single();
      if (error) throw error;
      res.status(201).json(methodView(data));
    } catch (err) { fail(res, 'p2p method create')(err); }
  });

  app.patch('/api/mini/:botId/p2p/admin/platforms/:pid/methods/:mid', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      let patch;
      try { patch = readMethod(req.body || {}, true); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
      const { data, error } = await db.from('p2p_payment_methods').update(patch)
        .eq('id', Number(req.params.mid)).eq('platform_id', p.id).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Account not found.' });
      res.json(methodView(data));
    } catch (err) { fail(res, 'p2p method update')(err); }
  });

  app.delete('/api/mini/:botId/p2p/admin/platforms/:pid/methods/:mid', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      const { error } = await db.from('p2p_payment_methods').delete()
        .eq('id', Number(req.params.mid)).eq('platform_id', p.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { fail(res, 'p2p method delete')(err); }
  });

  /* ---- orders ---- */

  const ORDER_FILTERS = {
    review: ['submitted'],
    open: ['open'],
    completed: ['completed'],
    closed: ['rejected', 'cancelled'],
  };

  app.get('/api/mini/:botId/p2p/admin/platforms/:pid/orders', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const p = await fetchOwnPlatform(req, res, a); if (!p) return;
      const statuses = ORDER_FILTERS[req.query.status] || ORDER_FILTERS.review;
      const { data, error } = await db.from('p2p_orders').select('*')
        .eq('platform_id', p.id).in('status', statuses)
        .order('created_at', { ascending: false }).limit(50);
      if (error) throw error;

      const rows = await Promise.all((data || []).map(async (o) => {
        let proof_url = null;
        if (o.proof_path) {
          const { data: s } = await db.storage.from(PROOF_BUCKET).createSignedUrl(o.proof_path, SIGNED_URL_SECONDS);
          proof_url = s ? s.signedUrl : null;
        }
        return {
          ...userOrder(o, { [p.id]: p.bots ? p.bots.name : '' }),
          customer: { id: o.telegram_id, username: o.username || '', first_name: o.first_name || '' },
          payout_method: o.payout_method || '',
          payout_details: o.payout_details,
          payout_name: o.payout_name || '',
          // BUY: the customer's Binance UID. SELL: our Binance UID the customer was told to pay.
          binance_uid: o.side === 'buy' ? o.payout_details : (p.binance_uid || ''),
          proof_url,
          submitted_at: o.submitted_at,
        };
      }));
      res.set('Cache-Control', 'no-store');
      res.json(rows);
    } catch (err) { fail(res, 'p2p admin orders')(err); }
  });

  async function settleOrder(req, res, outcome) {
    const a = miniAuth(req, res); if (!a) return;
    try {
      if (!UUID.test(req.params.oid)) return res.status(400).json({ error: 'Invalid order.' });
      const { data: order, error } = await db.from('p2p_orders').select('*').eq('id', req.params.oid).maybeSingle();
      if (error) throw error;
      if (!order) return res.status(404).json({ error: 'Order not found.' });

      const { data: p } = await db.from('p2p_platforms').select('*').eq('id', order.platform_id).maybeSingle();
      if (!p || !isOperator(p, a.user.id)) return res.status(403).json({ error: 'You are not an operator of this platform.' });

      const from = outcome === 'completed' ? ['submitted'] : ['open', 'submitted'];
      if (!from.includes(order.status)) return res.status(409).json({ error: 'This order was already handled.' });

      const note = clean((req.body || {}).note, 200);
      if (outcome === 'rejected' && !note) return res.status(400).json({ error: 'Give the customer a short reason.' });

      const { data: upd, error: uErr } = await db.from('p2p_orders').update({
        status: outcome, admin_note: note || null, handled_by: a.user.id,
        completed_at: new Date().toISOString(),
      }).eq('id', order.id).in('status', from).select().maybeSingle();
      if (uErr) throw uErr;
      if (!upd) return res.status(409).json({ error: 'This order was already handled.' });

      const done = outcome === 'completed';
      notify(p.bot_id, order.telegram_id,
        done
          ? `Order ${order.ref} is complete. ${order.side === 'buy' ? `${Number(order.amount_usdt)} USDT was sent to your Binance account.` : `${Number(order.total_etb)} ETB was sent to your Telebirr.`}`
          : `Order ${order.ref} was rejected.\nReason: ${note}`,
        appUrl(p.bot_id, '&tab=orders'), 'My orders');
      res.json({ ok: true });
    } catch (err) { fail(res, 'p2p settle')(err); }
  }

  app.post('/api/mini/:botId/p2p/admin/orders/:oid/complete', (req, res) => settleOrder(req, res, 'completed'));
  app.post('/api/mini/:botId/p2p/admin/orders/:oid/reject', (req, res) => settleOrder(req, res, 'rejected'));

  /* ================================================================ */
  /* Master admin dashboard: assign operator Telegram IDs              */
  /* ================================================================ */

  app.get('/api/admin/p2p/platforms', requireAdmin, async (_req, res) => {
    try {
      const { data, error } = await db.from('p2p_platforms').select('*, bots(name,bot_username)').order('id');
      if (error) throw error;
      const { data: pend } = await db.from('p2p_orders').select('platform_id').eq('status', 'submitted');
      const counts = {};
      (pend || []).forEach((o) => { counts[o.platform_id] = (counts[o.platform_id] || 0) + 1; });
      res.json((data || []).map((p) => ({
        id: p.id, bot_id: p.bot_id, admin_ids: (p.admin_ids || []).map(Number),
        tg_username: p.tg_username || '', buy_rate: Number(p.buy_rate), sell_rate: Number(p.sell_rate),
        paused: !!p.paused, pending_orders: counts[p.id] || 0,
      })));
    } catch (err) { fail(res, 'p2p admin list')(err); }
  });

  app.patch('/api/admin/p2p/platforms/:botId', requireAdmin, async (req, res) => {
    try {
      const patch = {};
      try {
        if ('admin_ids' in req.body) patch.admin_ids = parseAdminIds(req.body.admin_ids);
        if ('tg_username' in req.body) patch.tg_username = cleanTgUsername(req.body.tg_username);
      } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
      const { data, error } = await db.from('p2p_platforms').update(patch)
        .eq('bot_id', Number(req.params.botId)).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Platform not found.' });
      res.json({ ok: true });
    } catch (err) { fail(res, 'p2p admin patch')(err); }
  });

  return { attachBot, ensurePlatform, parseAdminIds, cleanTgUsername };
};
