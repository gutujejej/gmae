// Game account / coin store (eFootball, DLS) inside the Telegram Mini App.
// Mounted from server.js (same pattern as p2p.js).
//
// Flow
//   1. Admin adds items (images + price) in store-admin.html.
//   2. Customer picks an item -> order is created at the ADMIN'S price (read from the
//      database, never from the client) and the item is reserved for 30 minutes.
//   3. Customer picks Telebirr or CBE, sees the admin's number/account, pays, then sends
//      the transaction reference (and optionally a screenshot).
//   4. The backend asks the payment-check API to confirm: transaction is real, amount is
//      the order price, receiver is the admin's number/account. Anything that does not
//      match is rejected. If the checker cannot give a clear answer the order goes to
//      "verifying" for a manual decision. It is NEVER auto-approved on doubt.
//   5. Once paid, the admin and customer chat inside the order (delivery of login
//      details). Admin presses Finish -> order delivered, item sold, chat closed.
//
// Env (set in Railway, never in code):
//   CHECK_API_KEY   your verify.et API key (sent as x-api-key)
//   CHECK_API_URL   optional, defaults to https://verify.et
//
// Posting to groups: admin picks groups the bot is in (bot_channels, see channels.js).

const crypto = require('crypto');

const IMG_BUCKET = 'store-images';
const PROOF_BUCKET = 'store-proofs';
const MAX_IMG_BYTES = 1.5 * 1024 * 1024;
const MAX_PROOF_BYTES = 800 * 1024;
const MAX_IMAGES = 6;
const SIGNED_SECONDS = 60 * 60;
const RESERVE_MINUTES = 30;
const MAX_ATTEMPTS = 3;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const digits = (s) => String(s ?? '').replace(/\D/g, '');

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

function decodeImage(input, maxBytes) {
  const raw = String(input || '');
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(raw);
  const b64 = (m ? m[1] : raw).replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, 'Upload a valid image.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxBytes) throw new HttpError(413, 'That image is too large. Choose a smaller one.');
  const img = sniffImage(buf);
  if (!img) throw new HttpError(400, 'Images must be JPG, PNG or WebP.');
  return { buf, ...img };
}

const newCode = () => 'S' + crypto.randomBytes(4).toString('hex').toUpperCase();

module.exports = function attachStore(app, db, { requireAdmin, miniAuth, MINIAPP_BASE }) {

  const wrap = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('store error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };

  const registry = (req) => req.app.get('botRegistry');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  async function getSettings() {
    const { data, error } = await db.from('store_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    return data || {};
  }

  // Release reservations whose customer never paid.
  async function releaseExpired() {
    const cutoff = new Date(Date.now() - RESERVE_MINUTES * 60 * 1000).toISOString();
    const { data: old } = await db.from('store_orders').select('id,item_id')
      .eq('status', 'awaiting_payment').lt('created_at', cutoff);
    for (const o of old || []) {
      const { data: upd } = await db.from('store_orders').update({ status: 'expired', closed_at: new Date().toISOString() })
        .eq('id', o.id).eq('status', 'awaiting_payment').select('id').maybeSingle();
      if (upd && o.item_id) await db.from('store_items').update({ status: 'available', reserved_at: null })
        .eq('id', o.item_id).eq('status', 'reserved');
    }
  }

  async function signedUrls(bucket, paths) {
    const out = {};
    const list = paths.filter(Boolean);
    if (!list.length) return out;
    const { data } = await db.storage.from(bucket).createSignedUrls(list, SIGNED_SECONDS);
    (data || []).forEach((d) => { if (d.signedUrl) out[d.path] = d.signedUrl; });
    return out;
  }

  async function itemsWithImages(items) {
    if (!items.length) return [];
    const { data: imgs, error } = await db.from('store_item_images').select('item_id,path,sort')
      .in('item_id', items.map((i) => i.id)).order('sort');
    if (error) throw error;
    const urls = await signedUrls(IMG_BUCKET, (imgs || []).map((i) => i.path));
    return items.map((it) => ({
      ...it,
      images: (imgs || []).filter((i) => i.item_id === it.id).map((i) => urls[i.path]).filter(Boolean),
      image_paths: (imgs || []).filter((i) => i.item_id === it.id).map((i) => i.path),
    }));
  }

  const itemOut = (it) => ({
    id: it.id, game: it.game, kind: it.kind, title: it.title, description: it.description,
    coins_amount: it.coins_amount, price: Number(it.price), images: it.images || [],
  });

  const orderOut = (o, extra = {}) => ({
    id: o.id, code: o.code, item_id: o.item_id, pack_id: o.pack_id || null, coins_amount: o.coins_amount ?? null,
    price: Number(o.price), method: o.method,
    reference: o.reference, status: o.status, verify_state: o.verify_state,
    attempts: o.attempts, created_at: o.created_at, paid_at: o.paid_at, ...extra,
  });

  async function notify(entry, chatId, text, openPath) {
    if (!entry || !chatId) return false;
    try {
      const markup = MINIAPP_BASE && openPath
        ? { reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: `${MINIAPP_BASE}${openPath}` } }]] } }
        : {};
      await entry.bot.sendMessage(chatId, text, markup);
      return true;
    } catch (err) {
      console.error('store notify failed:', err.message);
      return false;
    }
  }

  // Tell the store admin: the Telegram ID set on the store bot, plus any extra IDs in
  // STORE_ADMIN_TELEGRAM_IDS. The admin must have pressed Start on the bot once.
  async function notifyAdmins(reg, entry, text) {
    const ids = new Set(String(process.env.STORE_ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
    const own = entry && entry.row && entry.row.store_admin_telegram_id;
    if (own) ids.add(String(own));
    const via = entry || [...reg.values()].find((e) => e.row.bot_type === 'store');
    if (!via) return;
    for (const id of ids) await notify(via, id, text, `/store?b=${via.row.id}&admin=1`);
  }

  /* ---------------------------------------------------------------- */
  /* Payment verification (check API)                                   */
  /* ---------------------------------------------------------------- */
  // Returns { state: 'verified' | 'failed' | 'unverified', reason, detail }.
  //   verified   = real, amount matches, receiver matches
  //   failed     = verify.et answered and something does not match / not found
  //   unverified = service unavailable or answer unclear -> manual review
  //
  // Uses verify.et (https://verify.et/docs/api):
  //   POST /api/verify?waitMs=..   header x-api-key, Idempotency-Key
  //   telebirr -> { bank, transactionNumber, settlementAccount }
  //   cbe      -> { bank, reference, settlementAccount } (+ 8-digit accountSuffix for old FT refs)
  // settlementAccount = the admin's own number/account, so verify.et itself checks the receiver.
  const VERIFY_BASE = (process.env.CHECK_API_URL || 'https://verify.et').replace(/\/+$/, '').replace(/\/api\/verify$/, '');

  function buildBody(method, reference, settings) {
    if (method === 'cbe') {
      const acc = digits(settings.cbe_account);
      const body = { bank: 'cbe', reference, settlementAccount: acc };
      if (/^FT/i.test(reference)) body.accountSuffix = acc.slice(-8); // older CBE references need it
      return body;
    }
    return { bank: 'telebirr', transactionNumber: reference, settlementAccount: digits(settings.telebirr_phone) };
  }

  function receiverMatches(method, receiverAccount, settings) {
    const want = method === 'cbe' ? digits(settings.cbe_account) : digits(settings.telebirr_phone);
    if (!want) return null;
    const raw = String(receiverAccount || '');
    const got = digits(raw);
    if (got.length < 4) return null;
    // Receipts mask the middle ("2519****0897"): then only the visible digits are comparable.
    const masked = /[*xX\u2022]/.test(raw);
    const n = masked ? Math.min(4, got.length) : Math.min(9, got.length, want.length);
    return want.slice(-n) === got.slice(-n);
  }

  async function callVerify(path, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(`${VERIFY_BASE}${path}`, { ...init, signal: ctl.signal });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    } finally { clearTimeout(timer); }
  }

  async function verifyPayment(order, method, reference, settings) {
    const key = process.env.CHECK_API_KEY;
    if (!key) return { state: 'unverified', reason: 'Automatic check is not configured.' };
    const want = method === 'cbe' ? settings.cbe_account : settings.telebirr_phone;
    if (!want) return { state: 'unverified', reason: 'Payment receiver is not set.' };
    const headers = { 'Content-Type': 'application/json', 'x-api-key': key };

    let res;
    try {
      res = await callVerify('/api/verify?waitMs=10000', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': `${order.code}-${method}-${reference}`.slice(0, 255) },
        body: JSON.stringify(buildBody(method, reference, settings)),
      });
    } catch (err) {
      return { state: 'unverified', reason: 'The check service did not respond.' };
    }

    // Service-side problems (bad key, no credits, busy) are never the customer's fault.
    if ([401, 402, 403, 429, 503].includes(res.status) || res.status >= 500) {
      return { state: 'unverified', reason: 'The check service is unavailable.', detail: { http: res.status } };
    }
    if (res.status === 409 || res.status === 422) {
      return { state: 'failed', reason: 'That transaction number is not valid. Check it and try again.', detail: { http: res.status } };
    }

    // 202 = still running: poll the status URL for a few seconds.
    let body = res.json;
    if (res.status === 202 && body && (body.requestId || (body.verification && body.verification.requestId))) {
      const rid = body.requestId || body.verification.requestId;
      for (let i = 0; i < 6; i++) {
        await sleep(2000);
        try {
          const p = await callVerify(`/api/verify/${encodeURIComponent(rid)}`, { headers });
          const d = p.json && p.json.data;
          if (d && !Array.isArray(d) && d.processingStatus === 'completed') {
            // The status endpoint is a summary. Use it only if it carries the full receipt.
            body = { success: p.json.success, data: [d] };
            break;
          }
        } catch { /* keep polling */ }
      }
      if (body === res.json) return { state: 'unverified', reason: 'The check is taking longer than usual.' };
    }
    if (!body) return { state: 'unverified', reason: 'The check service gave no clear answer.' };

    const r = Array.isArray(body.data) ? body.data[0] : null;
    if (!r) return { state: 'unverified', reason: 'The check service gave no clear answer.' };

    const verified = r.verified === true && /^(success|completed|verified)$/i.test(String(r.status || 'success'));
    const amount = r.amount == null ? null : Number(String(r.amount).replace(/[^0-9.]/g, ''));
    const detail = { amount: Number.isFinite(amount) ? amount : null, receiver: r.receiverAccount || null, receiverName: r.receiverName || null, status: r.status || null };

    if (!verified) {
      const st = String(r.status || '').toLowerCase();
      if (/not.?found|fail|invalid|reject|cancel|reverse/.test(st) || r.verified === false) {
        return { state: 'failed', reason: 'The transaction was not found or is not successful.', detail };
      }
      return { state: 'unverified', reason: 'Could not confirm the transaction.', detail };
    }

    if (detail.amount == null) return { state: 'unverified', reason: 'The check did not return an amount.', detail };
    if (Math.abs(detail.amount - round2(Number(order.price))) > 0.009) {
      return { state: 'failed', reason: `Amount does not match. Expected ${money(order.price)} ETB.`, detail };
    }

    // Receiver: verify.et's own settlement match first, then our own check of the receipt.
    const m = r.settlementAccountMatch;
    let receiverOk = null;
    if (m && m.matched === true && m.ambiguous !== true) receiverOk = true;
    else if (m && m.matched === false && m.reason === 'candidate_account_mismatch') receiverOk = false;
    if (receiverOk === null) receiverOk = receiverMatches(method, r.receiverAccount, settings);
    detail.settlement = m ? { matched: m.matched, reason: m.reason } : null;

    if (receiverOk === false) return { state: 'failed', reason: 'The payment was not sent to our account.', detail };
    if (receiverOk === null) return { state: 'unverified', reason: 'The receiver could not be confirmed.', detail };
    return { state: 'verified', detail };
  }

  /* ---------------------------------------------------------------- */
  /* Customer API (Telegram Mini App)                                   */
  /* ---------------------------------------------------------------- */

  // Squads this customer is currently holding (an unpaid order), so they can continue paying.
  async function myHeldItems(telegramId) {
    const { data } = await db.from('store_orders').select('item_id')
      .eq('customer_telegram_id', telegramId).eq('status', 'awaiting_payment').not('item_id', 'is', null);
    return new Set((data || []).map((o) => o.item_id));
  }

  app.get('/api/store/:botId/items', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    await releaseExpired();
    let q = db.from('store_items').select('*').in('status', ['available', 'reserved']).order('created_at', { ascending: false }).limit(100);
    if (req.query.game === 'efootball' || req.query.game === 'dls') q = q.eq('game', req.query.game);
    if (req.query.kind === 'account' || req.query.kind === 'coins') q = q.eq('kind', req.query.kind);
    const { data, error } = await q;
    if (error) throw error;
    const mine = await myHeldItems(a.user.id);
    res.json({ items: (await itemsWithImages(data || [])).map((i) => ({ ...itemOut(i), status: i.status, mine: mine.has(i.id) })) });
  }));

  app.get('/api/store/:botId/items/:id', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('store_items').select('*').eq('id', Number(req.params.id)).maybeSingle();
    if (error) throw error;
    if (!data || data.status === 'hidden') throw new HttpError(404, 'Item not found.');
    const [it] = await itemsWithImages([data]);
    const mine = await myHeldItems(a.user.id);
    res.json({ item: { ...itemOut(it), status: data.status, mine: mine.has(data.id) } });
  }));

  // Coin list for customers: packs the admin entered (coins -> price), grouped by section.
  app.get('/api/store/:botId/coins', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    let q = db.from('store_coin_packs').select('id,game,section,note,coins_amount,price,sort')
      .eq('status', 'available').order('sort').order('coins_amount').limit(300);
    if (req.query.game === 'efootball' || req.query.game === 'dls') q = q.eq('game', req.query.game);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ packs: (data || []).map((p) => ({ ...p, price: Number(p.price) })) });
  }));

  // Create an order. Price always comes from the database.
  //   item_id -> a squad/account: reserved for this customer (one of a kind)
  //   pack_id -> a coin pack from the coin list: can be sold again and again
  app.post('/api/store/:botId/orders', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    await releaseExpired();
    const b = req.body || {};


    const who = {
      bot_id: a.entry.row.id, customer_telegram_id: a.user.id,
      customer_name: clean([a.user.first_name, a.user.last_name].filter(Boolean).join(' ') || a.user.username, 80),
    };
    let item = null, shown, row;

    // Came back to a squad they already started paying for: continue that order.
    if (b.item_id != null && Number.isInteger(Number(b.item_id))) {
      const { data: mine } = await db.from('store_orders').select('*')
        .eq('customer_telegram_id', a.user.id).eq('status', 'awaiting_payment').eq('item_id', Number(b.item_id)).limit(1);
      if (mine && mine[0]) {
        const { data: it } = await db.from('store_items').select('*').eq('id', mine[0].item_id).maybeSingle();
        const s0 = await getSettings();
        return res.json({
          order: orderOut(mine[0]), item: itemOut({ ...it }), reserve_minutes: RESERVE_MINUTES,
          methods: [
            ...(s0.telebirr_phone ? [{ key: 'telebirr', label: 'Telebirr', number: s0.telebirr_phone, name: s0.telebirr_name || '' }] : []),
            ...(s0.cbe_account ? [{ key: 'cbe', label: 'CBE Bank', number: s0.cbe_account, name: s0.cbe_name || '' }] : []),
          ],
        });
      }
    }

    // Two open orders per customer at most, so nobody can lock up the stock.
    const { data: open } = await db.from('store_orders').select('id')
      .eq('customer_telegram_id', a.user.id).eq('status', 'awaiting_payment');
    if ((open || []).length >= 2) throw new HttpError(409, 'Finish or cancel your open orders first.');

    if (b.pack_id != null) {
      const pid = Number(b.pack_id);
      if (!Number.isInteger(pid)) throw new HttpError(400, 'Choose a coin pack.');
      const { data: pack, error: pe } = await db.from('store_coin_packs').select('*').eq('id', pid).eq('status', 'available').maybeSingle();
      if (pe) throw pe;
      if (!pack) throw new HttpError(404, 'This coin pack is no longer available.');
      const title = `${Number(pack.coins_amount).toLocaleString('en-US')} ${pack.game === 'dls' ? 'DLS' : 'eFootball'} coins`;
      row = { code: newCode(), item_id: null, pack_id: pack.id, title, coins_amount: pack.coins_amount, price: pack.price, ...who };
      shown = { id: pack.id, game: pack.game, kind: 'coins', title, coins_amount: Number(pack.coins_amount), price: Number(pack.price), images: [] };
    } else {
      const itemId = Number(b.item_id);
      if (!Number.isInteger(itemId)) throw new HttpError(400, 'Choose an item.');
      const { data: it, error: ie } = await db.from('store_items')
        .update({ status: 'reserved', reserved_at: new Date().toISOString() })
        .eq('id', itemId).eq('status', 'available').select().maybeSingle();
      if (ie) throw ie;
      if (!it) throw new HttpError(409, 'Sorry, this item was just taken.');
      item = it;
      row = { code: newCode(), item_id: it.id, price: it.price, ...who };
      shown = itemOut({ ...it });
    }

    const { data: order, error } = await db.from('store_orders').insert(row).select().single();
    if (error) {
      if (item) await db.from('store_items').update({ status: 'available', reserved_at: null }).eq('id', item.id);
      throw error;
    }
    const s = await getSettings();
    res.json({
      order: orderOut(order), item: shown,
      methods: [
        ...(s.telebirr_phone ? [{ key: 'telebirr', label: 'Telebirr', number: s.telebirr_phone, name: s.telebirr_name || '' }] : []),
        ...(s.cbe_account ? [{ key: 'cbe', label: 'CBE Bank', number: s.cbe_account, name: s.cbe_name || '' }] : []),
      ],
      reserve_minutes: RESERVE_MINUTES,
    });
  }));

  // Customer cancels an unpaid order -> item goes back on sale.
  app.post('/api/store/:botId/orders/:id/cancel', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data: o } = await db.from('store_orders').update({ status: 'expired', closed_at: new Date().toISOString() })
      .eq('id', Number(req.params.id)).eq('customer_telegram_id', a.user.id).eq('status', 'awaiting_payment')
      .select().maybeSingle();
    if (!o) throw new HttpError(409, 'This order cannot be cancelled.');
    if (o.item_id) await db.from('store_items').update({ status: 'available', reserved_at: null }).eq('id', o.item_id).eq('status', 'reserved');
    res.json({ ok: true });
  }));

  // Submit payment reference (+ optional screenshot) and verify.
  app.post('/api/store/:botId/orders/:id/pay', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const body = req.body || {};
    const method = body.method === 'cbe' ? 'cbe' : body.method === 'telebirr' ? 'telebirr' : null;
    const reference = clean(body.reference, 40).replace(/\s+/g, '').toUpperCase();
    if (!method) throw new HttpError(400, 'Choose a payment method.');
    if (!/^[A-Z0-9]{6,32}$/.test(reference)) throw new HttpError(400, 'Enter the transaction / reference number from your receipt.');

    const { data: order, error } = await db.from('store_orders').select('*')
      .eq('id', Number(req.params.id)).eq('customer_telegram_id', a.user.id).maybeSingle();
    if (error) throw error;
    if (!order) throw new HttpError(404, 'Order not found.');
    if (order.status !== 'awaiting_payment') throw new HttpError(409, 'This order is not waiting for payment.');
    if (order.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Contact the admin.');

    // Same receipt cannot pay two orders.
    const { data: dupe } = await db.from('store_orders').select('id')
      .eq('method', method).eq('reference', reference).in('status', ['verifying', 'paid', 'delivered']).limit(1);
    if (dupe && dupe.length) throw new HttpError(409, 'This transaction number was already used.');

    let proofPath = null;
    if (body.proof) {
      const img = decodeImage(body.proof, MAX_PROOF_BYTES);
      proofPath = `${order.id}/${crypto.randomUUID()}.${img.ext}`;
      const { error: ue } = await db.storage.from(PROOF_BUCKET).upload(proofPath, img.buf, { contentType: img.type });
      if (ue) throw ue;
    }

    await db.from('store_orders').update({ attempts: order.attempts + 1 }).eq('id', order.id);
    const settings = await getSettings();
    const result = await verifyPayment(order, method, reference, settings);

    const now = new Date().toISOString();
    const reg = registry(req);
    if (result.state === 'verified') {
      const { data: upd, error: ue } = await db.from('store_orders').update({
        status: 'paid', method, reference, proof_path: proofPath, verify_state: 'verified',
        verify_detail: result.detail || null, paid_at: now,
      }).eq('id', order.id).eq('status', 'awaiting_payment').select().maybeSingle();
      if (ue && ue.code === '23505') throw new HttpError(409, 'This transaction number was already used.');
      if (ue) throw ue;
      if (!upd) throw new HttpError(409, 'This order was already handled.');
      notifyAdmins(reg, a.entry, `Paid and verified: order ${upd.code} (${money(upd.price)} ETB). Open the admin panel to deliver.`);
      return res.json({ result: 'paid', order: orderOut(upd) });
    }

    if (result.state === 'unverified') {
      const { data: upd, error: ue } = await db.from('store_orders').update({
        status: 'verifying', method, reference, proof_path: proofPath, verify_state: 'unverified',
        verify_detail: { reason: result.reason, ...(result.detail || {}) },
      }).eq('id', order.id).eq('status', 'awaiting_payment').select().maybeSingle();
      if (ue && ue.code === '23505') throw new HttpError(409, 'This transaction number was already used.');
      if (ue) throw ue;
      notifyAdmins(reg, a.entry, `Order ${order.code} needs a manual payment check (${method} ${reference}).`);
      return res.json({ result: 'verifying', order: orderOut(upd || order), message: 'We could not confirm this automatically. The admin will check it shortly.' });
    }

    // failed: stays awaiting_payment so they can correct a typo (limited attempts)
    await db.from('store_orders').update({ verify_state: 'failed', verify_detail: { reason: result.reason, ...(result.detail || {}) } }).eq('id', order.id);
    return res.status(422).json({ result: 'failed', error: result.reason || 'Payment could not be confirmed.', attempts_left: Math.max(0, MAX_ATTEMPTS - (order.attempts + 1)) });
  }));

  app.get('/api/store/:botId/orders', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('store_orders').select('*, store_items(title,game,kind)')
      .eq('customer_telegram_id', a.user.id).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    res.json({ orders: (data || []).map((o) => orderOut(o, { title: (o.store_items && o.store_items.title) || o.title })) });
  }));

  async function ownOrder(a, id) {
    const { data, error } = await db.from('store_orders').select('*, store_items(title,game,kind)')
      .eq('id', Number(id)).eq('customer_telegram_id', a.user.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, 'Order not found.');
    return data;
  }

  // Order + chat (chat is only readable once the payment is confirmed).
  app.get('/api/store/:botId/orders/:id', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const o = await ownOrder(a, req.params.id);
    const chatOpen = o.status === 'paid';
    let messages = [];
    if (o.status === 'paid' || o.status === 'delivered') {
      const { data } = await db.from('store_messages').select('id,sender,body,created_at').eq('order_id', o.id).order('id');
      messages = data || [];
    }
    res.json({ order: orderOut(o, { title: (o.store_items && o.store_items.title) || o.title }), chat_open: chatOpen, messages });
  }));

  app.post('/api/store/:botId/orders/:id/messages', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const o = await ownOrder(a, req.params.id);
    if (o.status !== 'paid') throw new HttpError(409, 'Chat is closed.');
    const text = clean((req.body || {}).body, 2000);
    if (!text) throw new HttpError(400, 'Message is empty.');
    const { error } = await db.from('store_messages').insert({ order_id: o.id, sender: 'customer', body: text });
    if (error) throw error;
    notifyAdmins(registry(req), a.entry, `New message on order ${o.code}.`);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------------- */
  /* Admin API                                                          */
  /* ---------------------------------------------------------------- */
  // Every admin route is served twice with the same handler:
  //   /api/admin/store/...            password login (store-admin page on a computer)
  //   /api/store/:botId/admin/...     inside Telegram, ONLY for the Telegram account set as
  //                                   this store bot's admin (the "Admin" switch in the Mini App)
  function miniAdmin(req, res, next) {
    const a = miniAuth(req, res); if (!a) return;
    const adminId = Number(a.entry.row.store_admin_telegram_id);
    if (!adminId || a.user.id !== adminId) return res.status(403).json({ error: 'You are not the admin of this store.' });
    req.miniBotId = a.entry.row.id;
    req.miniEntry = a.entry;
    next();
  }
  function adminRoute(method, path, handler) {
    app[method]('/api/admin/store' + path, requireAdmin, handler);
    app[method]('/api/store/:botId/admin' + path, miniAdmin, handler);
  }

  // Tells the Mini App who is looking, so the Admin switch only exists for the admin.
  app.get('/api/store/:botId/home', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const adminId = Number(a.entry.row.store_admin_telegram_id);
    res.json({ name: a.entry.row.name, is_admin: !!adminId && adminId === a.user.id });
  }));


  // Groups/channels the bot is in (saved by channels.js). Mini admin sees only its own bot's.
  adminRoute('get', '/channels', wrap(async (req, res) => {
    let q = db.from('bot_channels').select('bot_id,chat_id,title,username,chat_type,can_post').order('title', { ascending: true });
    if (req.miniBotId) q = q.eq('bot_id', req.miniBotId);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ channels: (data || []).filter((c) => c.can_post !== false) });
  }));

  adminRoute('get', '/settings', wrap(async (_req, res) => {
    res.json(await getSettings());
  }));

  adminRoute('put', '/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const phone = digits(b.telebirr_phone);
    if (phone && !/^(?:251|0)?[79]\d{8}$/.test(phone)) throw new HttpError(400, 'Telebirr number looks wrong.');
    const cbe = digits(b.cbe_account);
    if (cbe && (cbe.length < 8 || cbe.length > 16)) throw new HttpError(400, 'CBE account number looks wrong.');
    const { data, error } = await db.from('store_settings').upsert({
      id: 1, telebirr_phone: phone || null, telebirr_name: clean(b.telebirr_name, 80) || null,
      cbe_account: cbe || null, cbe_name: clean(b.cbe_name, 80) || null, updated_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json(data);
  }));

  adminRoute('get', '/items', wrap(async (_req, res) => {
    await releaseExpired();
    const { data, error } = await db.from('store_items').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const held = {};
    const reservedIds = (data || []).filter((i) => i.status === 'reserved').map((i) => i.id);
    if (reservedIds.length) {
      const { data: ords } = await db.from('store_orders').select('item_id,code,customer_name,created_at')
        .in('item_id', reservedIds).eq('status', 'awaiting_payment');
      for (const o of ords || []) held[o.item_id] = { code: o.code, customer: o.customer_name, since: o.created_at };
    }
    res.json({ items: (await itemsWithImages(data || [])).map((i) => ({ ...itemOut(i), status: i.status, image_paths: i.image_paths, held_by: held[i.id] || null })) });
  }));

  // Free a squad that is stuck on "Reserved" (cancels the unpaid order holding it).
  adminRoute('post', '/items/:id/release', wrap(async (req, res) => {
    const id = Number(req.params.id);
    await db.from('store_orders').update({ status: 'expired', closed_at: new Date().toISOString() })
      .eq('item_id', id).eq('status', 'awaiting_payment');
    const { data, error } = await db.from('store_items').update({ status: 'available', reserved_at: null })
      .eq('id', id).eq('status', 'reserved').select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, 'This squad is not reserved.');
    res.json({ ok: true });
  }));

  function parseItem(b) {
    const game = b.game === 'dls' ? 'dls' : 'efootball';
    const kind = b.kind === 'coins' ? 'coins' : 'account';
    const price = round2(Number(b.price));
    if (!(price > 0)) throw new HttpError(400, 'Enter a price.');
    const title = clean(b.title, 80);
    if (title.length < 2) throw new HttpError(400, 'Enter a title.');
    const coins = b.coins_amount === '' || b.coins_amount == null ? null : Math.floor(Number(b.coins_amount));
    if (coins !== null && !(coins > 0)) throw new HttpError(400, 'Coins amount must be a positive number.');
    return { game, kind, title, description: clean(b.description, 1000) || null, price, coins_amount: coins };
  }

  async function saveImages(itemId, images, startSort = 0) {
    const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
    let sort = startSort;
    for (const raw of list) {
      const img = decodeImage(raw, MAX_IMG_BYTES);
      const path = `${itemId}/${crypto.randomUUID()}.${img.ext}`;
      const { error } = await db.storage.from(IMG_BUCKET).upload(path, img.buf, { contentType: img.type });
      if (error) throw error;
      await db.from('store_item_images').insert({ item_id: itemId, path, sort: sort++ });
    }
  }

  adminRoute('post', '/items', wrap(async (req, res) => {
    const row = parseItem(req.body || {});
    const { data, error } = await db.from('store_items').insert(row).select().single();
    if (error) throw error;
    await saveImages(data.id, (req.body || {}).images);
    res.json({ ok: true, id: data.id });
  }));

  adminRoute('patch', '/items/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const patch = parseItem({ ...b });
    if (['available', 'hidden'].includes(b.status)) patch.status = b.status;
    const { error } = await db.from('store_items').update(patch).eq('id', id).neq('status', 'sold');
    if (error) throw error;
    if (Array.isArray(b.images) && b.images.length) {
      const { count } = await db.from('store_item_images').select('id', { count: 'exact', head: true }).eq('item_id', id);
      await saveImages(id, b.images.slice(0, Math.max(0, MAX_IMAGES - (count || 0))), count || 0);
    }
    if (Array.isArray(b.remove_image_paths)) {
      for (const p of b.remove_image_paths.slice(0, MAX_IMAGES)) {
        await db.from('store_item_images').delete().eq('item_id', id).eq('path', String(p));
        await db.storage.from(IMG_BUCKET).remove([String(p)]);
      }
    }
    res.json({ ok: true });
  }));

  adminRoute('delete', '/items/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { data: used } = await db.from('store_orders').select('id').eq('item_id', id).limit(1);
    if (used && used.length) {
      await db.from('store_items').update({ status: 'hidden' }).eq('id', id);
      return res.json({ ok: true, hidden: true });
    }
    const { data: imgs } = await db.from('store_item_images').select('path').eq('item_id', id);
    if (imgs && imgs.length) await db.storage.from(IMG_BUCKET).remove(imgs.map((i) => i.path));
    await db.from('store_items').delete().eq('id', id);
    res.json({ ok: true });
  }));

  // Orders list (with 1-hour signed proof links).
  adminRoute('get', '/orders', wrap(async (req, res) => {
    await releaseExpired();
    let q = db.from('store_orders').select('*, store_items(title,game,kind)').order('created_at', { ascending: false }).limit(80);
    if (req.miniBotId) q = q.eq('bot_id', req.miniBotId);
    const st = String(req.query.status || '');
    if (['awaiting_payment', 'verifying', 'paid', 'delivered', 'rejected', 'expired'].includes(st)) q = q.eq('status', st);
    const { data, error } = await q;
    if (error) throw error;
    const urls = await signedUrls(PROOF_BUCKET, (data || []).map((o) => o.proof_path));
    res.json({
      orders: (data || []).map((o) => orderOut(o, {
        title: (o.store_items && o.store_items.title) || o.title, customer_name: o.customer_name,
        customer_telegram_id: o.customer_telegram_id, verify_detail: o.verify_detail,
        proof_url: urls[o.proof_path] || null,
      })),
    });
  }));

  async function adminOrder(req, id) {
    const { data, error } = await db.from('store_orders').select('*').eq('id', Number(id)).maybeSingle();
    if (error) throw error;
    if (!data || (req.miniBotId && Number(data.bot_id) !== req.miniBotId)) throw new HttpError(404, 'Order not found.');
    return data;
  }

  // Manual decision for orders the checker could not confirm.
  adminRoute('post', '/orders/:id/:action(approve|reject)', wrap(async (req, res) => {
    const o = await adminOrder(req, req.params.id);
    if (o.status !== 'verifying') throw new HttpError(409, 'Only orders waiting for a manual check can be decided.');
    const approve = req.params.action === 'approve';
    const { data: upd, error } = await db.from('store_orders').update(approve
      ? { status: 'paid', paid_at: new Date().toISOString() }
      : { status: 'rejected', closed_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'verifying').select().maybeSingle();
    if (error) throw error;
    if (!upd) throw new HttpError(409, 'Already handled.');
    if (!approve && o.item_id) await db.from('store_items').update({ status: 'available', reserved_at: null }).eq('id', o.item_id).eq('status', 'reserved');
    const entry = registry(req).get(o.bot_id);
    notify(entry, o.customer_telegram_id,
      approve ? `Payment for order ${o.code} confirmed. The admin will message you here with your account details.`
        : `Order ${o.code} was rejected. If you already paid, message the admin with your order ID.`,
      `/store?b=${o.bot_id}&order=${o.id}`);
    res.json({ ok: true });
  }));

  adminRoute('get', '/orders/:id/messages', wrap(async (req, res) => {
    const o = await adminOrder(req, req.params.id);
    const { data } = await db.from('store_messages').select('id,sender,body,created_at').eq('order_id', o.id).order('id');
    res.json({ messages: data || [], status: o.status });
  }));

  adminRoute('post', '/orders/:id/messages', wrap(async (req, res) => {
    const o = await adminOrder(req, req.params.id);
    if (o.status !== 'paid') throw new HttpError(409, 'Chat is only open for paid orders.');
    const text = clean((req.body || {}).body, 2000);
    if (!text) throw new HttpError(400, 'Message is empty.');
    const { error } = await db.from('store_messages').insert({ order_id: o.id, sender: 'admin', body: text });
    if (error) throw error;
    // The Telegram ping never contains the message itself (it may hold passwords).
    notify(registry(req).get(o.bot_id), o.customer_telegram_id,
      `New message from the admin on order ${o.code}.`, `/store?b=${o.bot_id}&order=${o.id}`);
    res.json({ ok: true });
  }));

  // Finish: order delivered, item sold, chat closed. wipe=true also deletes the chat.
  adminRoute('post', '/orders/:id/finish', wrap(async (req, res) => {
    const o = await adminOrder(req, req.params.id);
    const { data: upd, error } = await db.from('store_orders').update({ status: 'delivered', closed_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'paid').select().maybeSingle();
    if (error) throw error;
    if (!upd) throw new HttpError(409, 'Only paid orders can be finished.');
    if (o.item_id) await db.from('store_items').update({ status: 'sold', reserved_at: null }).eq('id', o.item_id);
    if ((req.body || {}).wipe === true) await db.from('store_messages').delete().eq('order_id', o.id);
    notify(registry(req).get(o.bot_id), o.customer_telegram_id,
      o.pack_id ? `Order ${o.code} is complete. Your coins were sent. Thank you!`
        : `Order ${o.code} is complete. Thank you! Please change the account password right away.`);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------------- */
  /* Posting an item to groups                                          */
  /* ---------------------------------------------------------------- */

  function caption(item) {
    const gameName = item.game === 'dls' ? 'DLS' : 'eFootball';
    const coins = item.coins_amount ? `\nCoins: ${Number(item.coins_amount).toLocaleString('en-US')}` : '';
    return `${gameName} ${item.kind === 'coins' ? 'coins' : 'account'}\n${item.title}${coins}\nPrice: ${money(item.price)} ETB` +
      (item.description ? `\n\n${item.description}` : '');
  }

  async function loadItemForPost(id) {
    const { data: item } = await db.from('store_items').select('*').eq('id', Number(id)).maybeSingle();
    if (!item || item.status !== 'available') throw new HttpError(409, 'Only items that are for sale can be posted.');
    const { data: first } = await db.from('store_item_images').select('path').eq('item_id', item.id).order('sort').limit(1);
    return { item, imagePath: first && first[0] && first[0].path };
  }

  // Sends one message to each chosen group through the bot. Mini admin: own bot only.
  async function broadcast(req, targets, send) {
    const reg = registry(req);
    const results = [];
    for (const t of targets) {
      const botId = req.miniBotId || Number(t.bot_id);
      const { data: ch } = await db.from('bot_channels').select('chat_id,title,can_post')
        .eq('bot_id', botId).eq('chat_id', t.chat_id).maybeSingle();
      if (!ch) { results.push({ ...t, ok: false, error: 'Not a saved group' }); continue; }
      if (ch.can_post === false) { results.push({ ...t, title: ch.title, ok: false, error: 'Bot cannot post here' }); continue; }
      const entry = reg.get(botId);
      if (!entry) { results.push({ ...t, title: ch.title, ok: false, error: 'Bot is not running' }); continue; }
      try {
        const me = entry.me || (entry.me = await entry.bot.getMe());
        await send(entry, me, ch.chat_id);
        results.push({ ...t, title: ch.title, ok: true });
      } catch (err) {
        const desc = (err && err.response && err.response.body && err.response.body.description) || err.message;
        results.push({ ...t, title: ch.title, ok: false, error: desc });
      }
      await sleep(400);
    }
    const sent = results.filter((r) => r.ok).length;
    return { ok: true, sent, failed: results.length - sent, results };
  }
  const pickTargets = (req) => {
    const targets = Array.isArray((req.body || {}).targets) ? req.body.targets.slice(0, 50) : [];
    if (!targets.length) throw new HttpError(400, 'Pick at least one group.');
    return targets;
  };

  // A squad: photo + price + Buy button.
  adminRoute('post', '/items/:id/post', wrap(async (req, res) => {
    const { item, imagePath } = await loadItemForPost(req.params.id);
    const targets = pickTargets(req);
    let photo = null;
    if (imagePath) {
      const { data } = await db.storage.from(IMG_BUCKET).download(imagePath);
      if (data) photo = Buffer.from(await data.arrayBuffer());
    }
    res.json(await broadcast(req, targets, async (entry, me, chatId) => {
      const opts = { reply_markup: { inline_keyboard: [[{ text: 'Buy now', url: `https://t.me/${me.username}?start=item_${item.id}` }]] } };
      if (photo) await entry.bot.sendPhoto(chatId, photo, { caption: caption(item).slice(0, 1000), ...opts }, { filename: 'item.jpg' });
      else await entry.bot.sendMessage(chatId, caption(item), opts);
    }));
  }));

  // Any message (text, optional photo, optional Open-store button) to the groups/channels
  // the bot is in.
  adminRoute('post', '/announce', wrap(async (req, res) => {
    const b = req.body || {};
    const text = clean(b.text, 3500);
    const photo = b.image ? decodeImage(b.image, MAX_IMG_BYTES).buf : null;
    if (!text && !photo) throw new HttpError(400, 'Write a message or add a photo.');
    const targets = pickTargets(req);
    res.json(await broadcast(req, targets, async (entry, me, chatId) => {
      const opts = b.button ? { reply_markup: { inline_keyboard: [[{ text: 'Open store', url: `https://t.me/${me.username}?start=store` }]] } } : {};
      if (photo && text.length <= 1000) await entry.bot.sendPhoto(chatId, photo, { caption: text, ...opts }, { filename: 'post.jpg' });
      else if (photo) { await entry.bot.sendPhoto(chatId, photo, {}, { filename: 'post.jpg' }); await entry.bot.sendMessage(chatId, text, opts); }
      else await entry.bot.sendMessage(chatId, text, opts);
    }));
  }));

  // The coin list for one game, as a text post with a Buy button.
  adminRoute('post', '/coins/post', wrap(async (req, res) => {
    const game = (req.body || {}).game === 'dls' ? 'dls' : 'efootball';
    const targets = pickTargets(req);
    const packs = await loadPacks(game);
    if (!packs.length) throw new HttpError(409, 'Add coin packs for this game first.');
    const text = coinListText(game, packs);
    res.json(await broadcast(req, targets, async (entry, me, chatId) => {
      await entry.bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: 'Buy coins', url: `https://t.me/${me.username}?start=coins_${game}` }]] } });
    }));
  }));

  // Fallback when the bot is not an admin of a group: the admin posts from their own
  // Telegram account. Returns ready-to-send text and a one-tap share link.
  adminRoute('get', '/items/:id/share', wrap(async (req, res) => {
    const { item } = await loadItemForPost(req.params.id);
    const bots = [...registry(req).values()].filter((e) => e.row.bot_type === 'store' && e.row.active !== false);
    const entry = req.miniEntry || bots[0];
    if (!entry) throw new HttpError(409, 'Add and start a Store bot first.');
    const me = entry.me || (entry.me = await entry.bot.getMe());
    const link = `https://t.me/${me.username}?start=item_${item.id}`;
    const text = caption(item);
    res.json({
      text, link,
      share_url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
    });
  }));

  /* ---------------------------------------------------------------- */
  /* Coin list (coins -> price, sold again and again)                   */
  /* ---------------------------------------------------------------- */
  async function loadPacks(game, includeHidden) {
    let q = db.from('store_coin_packs').select('*').order('sort').order('coins_amount').limit(300);
    if (game) q = q.eq('game', game);
    if (!includeHidden) q = q.eq('status', 'available');
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  function groupSections(packs) {
    const map = new Map();
    for (const p of packs) {
      if (!map.has(p.section)) map.set(p.section, { name: p.section, note: p.note || '', packs: [] });
      map.get(p.section).packs.push(p);
    }
    return [...map.values()];
  }
  function coinListText(game, packs) {
    let out = `${game === 'dls' ? 'DLS' : 'eFootball'} coin list\n`;
    for (const sec of groupSections(packs)) {
      out += `\n${sec.name}${sec.note ? ` (${sec.note})` : ''}\n`;
      for (const p of sec.packs) out += `${Number(p.coins_amount).toLocaleString('en-US')} coins » ${Number(p.price).toLocaleString('en-US')} birr\n`;
    }
    return out.trim();
  }
  function parsePack(b) {
    const game = b.game === 'dls' ? 'dls' : 'efootball';
    const coins = Math.floor(Number(b.coins_amount));
    const price = round2(Number(b.price));
    if (!(coins > 0)) throw new HttpError(400, 'Enter the coin amount.');
    if (!(price > 0)) throw new HttpError(400, 'Enter a price.');
    return {
      game, coins_amount: coins, price,
      section: clean(b.section, 60) || 'All platforms',
      note: clean(b.note, 80) || null,
      sort: Number.isFinite(Number(b.sort)) ? Math.floor(Number(b.sort)) : 0,
    };
  }

  adminRoute('get', '/coin-packs', wrap(async (req, res) => {
    const game = req.query.game === 'dls' ? 'dls' : req.query.game === 'efootball' ? 'efootball' : null;
    res.json({ packs: (await loadPacks(game, true)).map((p) => ({ ...p, price: Number(p.price) })) });
  }));

  adminRoute('post', '/coin-packs', wrap(async (req, res) => {
    const { data, error } = await db.from('store_coin_packs').insert(parsePack(req.body || {})).select().single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  }));

  // Paste a whole list: one pack per line, "coins price" (e.g. "1040 1850" or "1040 > 1850").
  adminRoute('post', '/coin-packs/bulk', wrap(async (req, res) => {
    const b = req.body || {};
    const game = b.game === 'dls' ? 'dls' : 'efootball';
    const section = clean(b.section, 60) || 'All platforms';
    const note = clean(b.note, 80) || null;
    const lines = String(b.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 80);
    if (!lines.length) throw new HttpError(400, 'Paste at least one line.');
    const { data: last } = await db.from('store_coin_packs').select('sort').eq('game', game).eq('section', section).order('sort', { ascending: false }).limit(1);
    let sort = last && last[0] ? Number(last[0].sort) : 0;
    const rows = lines.map((line, i) => {
      const m = /(\d[\d,]*)\D+(\d[\d,]*(?:\.\d+)?)/.exec(line);
      const coins = m ? Number(m[1].replace(/,/g, '')) : 0;
      const price = m ? Number(m[2].replace(/,/g, '')) : 0;
      if (!(coins > 0) || !(price > 0)) throw new HttpError(400, `Line ${i + 1} is not "coins price": ${line.slice(0, 40)}`);
      return { game, section, note, coins_amount: coins, price: round2(price), sort: (sort += 1) };
    });
    const { error } = await db.from('store_coin_packs').insert(rows);
    if (error) throw error;
    res.json({ ok: true, added: rows.length });
  }));

  adminRoute('patch', '/coin-packs/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const patch = parsePack(b);
    if (['available', 'hidden'].includes(b.status)) patch.status = b.status;
    const { error } = await db.from('store_coin_packs').update(patch).eq('id', Number(req.params.id));
    if (error) throw error;
    res.json({ ok: true });
  }));

  adminRoute('delete', '/coin-packs/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { data: used } = await db.from('store_orders').select('id').eq('pack_id', id).limit(1);
    if (used && used.length) { await db.from('store_coin_packs').update({ status: 'hidden' }).eq('id', id); return res.json({ ok: true, hidden: true }); }
    await db.from('store_coin_packs').delete().eq('id', id);
    res.json({ ok: true });
  }));

  // Posting fallback for the coin list (admin posts from their own Telegram).
  adminRoute('get', '/coins/share', wrap(async (req, res) => {
    const game = req.query.game === 'dls' ? 'dls' : 'efootball';
    const packs = await loadPacks(game);
    if (!packs.length) throw new HttpError(409, 'Add coin packs for this game first.');
    const entry = req.miniEntry || [...registry(req).values()].find((e) => e.row.bot_type === 'store' && e.row.active !== false);
    if (!entry) throw new HttpError(409, 'Add and start a Store bot first.');
    const me = entry.me || (entry.me = await entry.bot.getMe());
    const link = `https://t.me/${me.username}?start=coins_${game}`;
    const text = coinListText(game, packs);
    res.json({ text, link, share_url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}` });
  }));

  require('./store-account')({ db, adminRoute, wrap, HttpError, registry, clean, decodeImage, sleep, MAX_IMG_BYTES });

  /* ---------------------------------------------------------------- */
  /* Bot chat: open the store                                           */
  /* ---------------------------------------------------------------- */
  async function handleStart(bot, row, msg) {
    if (!MINIAPP_BASE) return bot.sendMessage(msg.chat.id, 'The store is not available right now.');
    const m = /\/start\s+item_(\d+)/.exec(msg.text || '');
    const c = /\/start\s+coins_(efootball|dls)/.exec(msg.text || '');
    const url = `${MINIAPP_BASE}/store?b=${row.id}${m ? `&item=${m[1]}` : ''}${c ? `&kind=coin&game=${c[1]}` : ''}`;
    await bot.sendMessage(msg.chat.id, `Welcome to ${row.name}.\nBrowse eFootball and DLS squads and the coin list.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Open Store', web_app: { url } }]] } });
  }

  return { handleStart };
};
