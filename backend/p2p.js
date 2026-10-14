// Cross P2P: USDT <-> ETB desks inside a Telegram Mini App.
// Mounted from server.js (same pattern as bingo.js / wallet-bot.js).
//
// Who can do what
//   Customers   Telegram Mini App users (signed initData, via miniAuth). They see
//               each active platform's rates, place buy/sell orders and upload a
//               payment proof. They never see admin controls.
//   Desk admin  A Telegram user whose numeric ID is set as p2p_platforms.telegram_id.
//               Found with a database query, not an env var: whoever matches gets
//               the Admin switch, and can review orders and edit rates/payment
//               details for their own platform only.
//   Main admin  The existing password login (requireAdmin). Creates platforms and
//               sets each platform's Telegram ID, and can handle any order.
//
// Payment proofs live in the private Supabase Storage bucket "p2p-proofs"
// (created by migration_p2p.sql). Admins only ever get 1-hour signed links.

const crypto = require('crypto');

const BUCKET = 'p2p-proofs';
const MAX_PROOF_BYTES = 600 * 1024;   // after base64 decoding
const MAX_PENDING_PER_PLATFORM = 3;   // per customer, stops order/upload spam
const SIGNED_URL_SECONDS = 60 * 60;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const round2 = (n) => Math.round(n * 100) / 100;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Identify the image from its first bytes. The client's claimed type is ignored.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

function decodeProof(input) {
  const raw = String(input || '');
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(raw);
  const b64 = (m ? m[1] : raw).replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, 'Upload your payment proof as an image.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_PROOF_BYTES) throw new HttpError(413, 'That image is too large. Choose a smaller screenshot.');
  const img = sniffImage(buf);
  if (!img) throw new HttpError(400, 'The proof must be a JPG, PNG or WebP image.');
  return { buf, ...img };
}

const PHONE_RE = /^(?:\+?251|0)[79]\d{8}$/;

// Validates and normalises platform input. `desk` = a desk admin editing their own
// platform: they can change rates, status and payment details, but not the name or
// the Telegram ID (only the main admin can).
function parsePlatform(body, current, { desk }) {
  const b = body || {};
  const has = (k) => k in b;
  const patch = {};

  if (!desk) {
    if (has('name')) {
      const n = clean(b.name, 40);
      if (n.length < 2) throw new HttpError(400, 'Platform name must be at least 2 characters.');
      patch.name = n;
    }
    if (has('telegram_id')) {
      const t = String(b.telegram_id ?? '').trim();
      if (!/^\d{5,15}$/.test(t)) throw new HttpError(400, 'Telegram ID must be a number with 5 to 15 digits.');
      patch.telegram_id = Number(t);
    }
    if (has('telegram_username')) {
      const u = clean(b.telegram_username, 33).replace(/^@/, '');
      if (u && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(u)) throw new HttpError(400, 'Telegram username is not valid.');
      patch.telegram_username = u || null;
    }
  }

  for (const k of ['buy_rate', 'sell_rate']) {
    if (!has(k)) continue;
    const r = round2(Number(b[k]));
    if (!(r > 0 && r <= 100000)) throw new HttpError(400, 'Rates must be above 0.');
    patch[k] = r;
  }
  if (has('active')) patch.active = b.active === true;

  if (has('telebirr_phone')) {
    const v = clean(b.telebirr_phone, 20).replace(/\s/g, '');
    if (v && !/^\+?\d{7,15}$/.test(v)) throw new HttpError(400, 'Telebirr phone number is not valid.');
    patch.telebirr_phone = v || null;
  }
  if (has('telebirr_name')) patch.telebirr_name = clean(b.telebirr_name, 60) || null;
  if (has('cbe_account')) {
    const v = clean(b.cbe_account, 25).replace(/\s/g, '');
    if (v && !/^\d{6,25}$/.test(v)) throw new HttpError(400, 'CBE account number must be digits only.');
    patch.cbe_account = v || null;
  }
  if (has('cbe_name')) patch.cbe_name = clean(b.cbe_name, 60) || null;
  if (has('binance_uid')) {
    const v = clean(b.binance_uid, 15);
    if (v && !/^\d{5,15}$/.test(v)) throw new HttpError(400, 'Binance UID must be digits only.');
    patch.binance_uid = v || null;
  }

  const buy = patch.buy_rate ?? current.buy_rate;
  const sell = patch.sell_rate ?? current.sell_rate;
  if (buy != null && sell != null && !(Number(sell) < Number(buy))) {
    throw new HttpError(400, 'The sell rate must be lower than the buy rate, or customers could trade both ways at a profit.');
  }
  return patch;
}

const platformPublic = (p) => ({
  id: p.id,
  name: p.name,
  buy_rate: Number(p.buy_rate),
  sell_rate: Number(p.sell_rate),
  // Chat link: a username if the desk set one, otherwise the numeric ID.
  contact_username: p.telegram_username || null,
  contact_id: p.telegram_username ? null : String(p.telegram_id),
});

const platformFull = (p, pending = 0) => ({
  ...platformPublic(p),
  contact_id: String(p.telegram_id),
  telegram_id: String(p.telegram_id),
  telegram_username: p.telegram_username || '',
  active: p.active,
  telebirr_phone: p.telebirr_phone || '',
  telebirr_name: p.telebirr_name || '',
  cbe_account: p.cbe_account || '',
  cbe_name: p.cbe_name || '',
  binance_uid: p.binance_uid || '',
  pending,
});

const orderOut = (o, proofUrl) => ({
  id: o.id,
  code: o.code,
  type: o.type,
  platform_id: o.platform_id,
  platform_name: o.platform_name,
  usdt_amount: Number(o.usdt_amount),
  rate: Number(o.rate),
  etb_total: Number(o.etb_total),
  binance_uid: o.binance_uid || null,
  payout_name: o.payout_name || null,
  payout_phone: o.payout_phone || null,
  customer_telegram_id: String(o.customer_telegram_id),
  customer_username: o.customer_username || null,
  status: o.status,
  created_at: o.created_at,
  decided_at: o.decided_at,
  proof_url: proofUrl || null,
});

module.exports = function attachP2P(app, db, { requireAdmin, miniAuth, MINIAPP_BASE }) {

  const wrap = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('p2p error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };

  const registryOf = (req) => req.app.get('botRegistry');

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  async function withProofUrls(rows) {
    const paths = rows.map((r) => r.proof_path).filter(Boolean);
    const urls = {};
    if (paths.length) {
      const { data } = await db.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
      (data || []).forEach((d) => { if (d.signedUrl) urls[d.path] = d.signedUrl; });
    }
    return rows.map((r) => orderOut(r, urls[r.proof_path]));
  }

  async function pendingCounts(platformIds) {
    const counts = {};
    if (!platformIds.length) return counts;
    const { data, error } = await db.from('p2p_orders').select('platform_id')
      .eq('status', 'pending').in('platform_id', platformIds);
    if (error) throw error;
    (data || []).forEach((r) => { counts[r.platform_id] = (counts[r.platform_id] || 0) + 1; });
    return counts;
  }

  // Role check by query: platforms whose Telegram ID is this user's.
  async function deskPlatforms(user) {
    const { data, error } = await db.from('p2p_platforms').select('*')
      .eq('telegram_id', user.id).order('id');
    if (error) throw error;
    return data || [];
  }
  async function requireDesk(a) {
    const mine = await deskPlatforms(a.user);
    if (!mine.length) throw new HttpError(403, 'This Telegram account is not a desk admin.');
    return mine;
  }

  async function listOrders({ platformIds, status }) {
    let q = db.from('p2p_orders').select('*').order('created_at', { ascending: false }).limit(60);
    if (platformIds) q = q.in('platform_id', platformIds);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return withProofUrls(data || []);
  }

  async function sendTo(entry, chatId, text, markup) {
    try {
      await entry.bot.sendMessage(chatId, text, markup ? { reply_markup: markup } : {});
      return true;
    } catch (err) {
      console.error(`p2p notify failed (${chatId}):`, err.message);
      return false;
    }
  }

  // Tell the desk admin about a new order. Tries the bot assigned to that platform
  // first, then the bot the customer used. A desk admin has to have started a bot
  // for it to be able to message them.
  async function notifyDesk(registry, platform, currentEntry, order) {
    const text =
      `New ${order.type} order ${order.code}\n` +
      `${money(order.usdt_amount)} USDT at ${money(order.rate)} = ${money(order.etb_total)} ETB\n` +
      'Open the admin panel to check the proof and approve it.';
    const entries = [...registry.values()].filter((e) => e.row.bot_type === 'p2p' && e.row.p2p_platform_id === platform.id);
    if (currentEntry && !entries.includes(currentEntry)) entries.push(currentEntry);
    for (const e of entries) {
      const markup = MINIAPP_BASE
        ? { inline_keyboard: [[{ text: 'Open admin panel', web_app: { url: `${MINIAPP_BASE}/p2p?b=${e.row.id}&desk=1` } }]] }
        : null;
      if (await sendTo(e, platform.telegram_id, text, markup)) return;
    }
  }

  function notifyCustomer(registry, o) {
    const entry = registry.get(o.bot_id);
    if (!entry) return;
    let text;
    if (o.status === 'approved') {
      text = o.type === 'buy'
        ? `Order ${o.code} approved by ${o.platform_name}. ${money(o.usdt_amount)} USDT is on its way to Binance UID ${o.binance_uid}.`
        : `Order ${o.code} approved by ${o.platform_name}. ${money(o.etb_total)} ETB is on its way to Telebirr ${o.payout_phone}.`;
    } else {
      text = `Order ${o.code} was rejected by ${o.platform_name}. If you already paid, message the desk with your order ID.`;
    }
    sendTo(entry, o.customer_telegram_id, text);
  }

  // Only a pending order can be decided, and only once.
  async function decide(registry, id, action, { decidedBy, platformIds }) {
    const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null;
    if (!status || !Number.isInteger(id)) throw new HttpError(400, 'Invalid request.');
    let q = db.from('p2p_orders')
      .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'pending');
    if (platformIds) q = q.in('platform_id', platformIds);
    const { data, error } = await q.select().maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, 'This order was already handled, or it is not one of yours.');
    notifyCustomer(registry, data);
    return data;
  }

  /* ---------------------------------------------------------------- */
  /* Bot chat: open the Mini App                                       */
  /* ---------------------------------------------------------------- */
  async function handleStart(bot, row, msg) {
    if (!MINIAPP_BASE) {
      return bot.sendMessage(msg.chat.id, 'Cross P2P is not available right now.');
    }
    await bot.sendMessage(msg.chat.id,
      `Welcome to ${row.name}.\nSee live USDT rates and place an order.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Open Cross P2P', web_app: { url: `${MINIAPP_BASE}/p2p?b=${row.id}` } }]] } });
  }

  /* ---------------------------------------------------------------- */
  /* Public price list (no login, no payment details)                   */
  /* ---------------------------------------------------------------- */
  app.get('/api/p2p/public', wrap(async (_req, res) => {
    const { data, error } = await db.from('p2p_platforms').select('*').eq('active', true).order('name');
    if (error) throw error;
    res.json({ platforms: (data || []).map(platformPublic) });
  }));

  /* ---------------------------------------------------------------- */
  /* Customers (Telegram Mini App)                                      */
  /* ---------------------------------------------------------------- */

  // Platforms + whether this Telegram user is a desk admin (decides if the Admin
  // switch is drawn at all).
  app.get('/api/p2p/:botId/home', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('p2p_platforms').select('*').eq('active', true).order('name');
    if (error) throw error;
    const mine = await deskPlatforms(a.user);
    res.json({
      platforms: (data || []).map(platformPublic),
      bot_platform_id: a.entry.row.p2p_platform_id || null,
      is_admin: mine.length > 0,
    });
  }));

  // Payment details are only handed out when someone opens a trade on that platform.
  app.get('/api/p2p/:botId/platforms/:pid/payment', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data: p, error } = await db.from('p2p_platforms').select('*')
      .eq('id', Number(req.params.pid)).eq('active', true).maybeSingle();
    if (error) throw error;
    if (!p) throw new HttpError(404, 'This platform is not open right now.');
    res.json({
      telebirr_phone: p.telebirr_phone || '', telebirr_name: p.telebirr_name || '',
      cbe_account: p.cbe_account || '', cbe_name: p.cbe_name || '',
      binance_uid: p.binance_uid || '',
    });
  }));

  app.post('/api/p2p/:botId/orders', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const b = req.body || {};

    const type = b.type === 'buy' || b.type === 'sell' ? b.type : null;
    if (!type) throw new HttpError(400, 'Choose buy or sell.');

    const pid = Number(b.platform_id);
    if (!Number.isInteger(pid)) throw new HttpError(400, 'Choose a platform.');
    const { data: p, error: pe } = await db.from('p2p_platforms').select('*')
      .eq('id', pid).eq('active', true).maybeSingle();
    if (pe) throw pe;
    if (!p) throw new HttpError(404, 'This platform is not open right now.');

    const amount = round2(Number(b.amount));
    if (!(amount >= 1 && amount <= 100000)) throw new HttpError(400, 'Enter between 1 and 100,000 USDT.');

    const fields = {};
    if (type === 'buy') {
      const uid = clean(b.binance_uid, 15);
      if (!/^\d{5,15}$/.test(uid)) throw new HttpError(400, 'Enter your Binance UID using digits only.');
      if (!p.telebirr_phone && !p.cbe_account) throw new HttpError(409, 'This platform has not set payment details yet.');
      fields.binance_uid = uid;
    } else {
      const name = clean(b.name, 60);
      const phone = clean(b.phone, 20).replace(/\s/g, '');
      if (name.length < 2) throw new HttpError(400, 'Enter your full name.');
      if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Enter a valid Telebirr number, like 0911234567.');
      if (!p.binance_uid) throw new HttpError(409, 'This platform has not set a Binance UID yet.');
      fields.payout_name = name;
      fields.payout_phone = phone;
    }

    const { count, error: ce } = await db.from('p2p_orders').select('id', { count: 'exact', head: true })
      .eq('customer_telegram_id', a.user.id).eq('platform_id', p.id).eq('status', 'pending');
    if (ce) throw ce;
    if ((count || 0) >= MAX_PENDING_PER_PLATFORM) {
      throw new HttpError(429, 'You already have pending orders on this platform. Wait for the desk to review them.');
    }

    const img = decodeProof(b.proof);
    const code = (type === 'buy' ? 'B-' : 'S-') + crypto.randomBytes(4).toString('hex').toUpperCase();
    const path = `${p.id}/${a.user.id}/${code}.${img.ext}`;

    const up = await db.storage.from(BUCKET).upload(path, img.buf, { contentType: img.type, upsert: false });
    if (up.error) throw up.error;

    // The rate comes from the database, never from the client.
    const rate = Number(type === 'buy' ? p.buy_rate : p.sell_rate);
    const { data: order, error } = await db.from('p2p_orders').insert({
      code, type, platform_id: p.id, platform_name: p.name, bot_id: a.entry.row.id,
      customer_telegram_id: a.user.id, customer_username: a.user.username || null,
      usdt_amount: amount, rate, etb_total: round2(amount * rate),
      proof_path: path, ...fields,
    }).select().single();
    if (error) {
      await db.storage.from(BUCKET).remove([path]).catch(() => {});
      throw error;
    }

    notifyDesk(registryOf(req), p, a.entry, order).catch(console.error);

    res.status(201).json({
      code: order.code, type: order.type, usdt_amount: Number(order.usdt_amount),
      rate: Number(order.rate), etb_total: Number(order.etb_total), status: order.status,
      platform: platformPublic(p),
    });
  }));

  /* ---------------------------------------------------------------- */
  /* Desk admin (Telegram ID matches a platform)                        */
  /* ---------------------------------------------------------------- */

  app.get('/api/p2p/:botId/desk', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const mine = await requireDesk(a);
    const counts = await pendingCounts(mine.map((p) => p.id));
    res.json({ platforms: mine.map((p) => platformFull(p, counts[p.id] || 0)) });
  }));

  app.get('/api/p2p/:botId/desk/orders', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const mine = await requireDesk(a);
    const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    res.json(await listOrders({ platformIds: mine.map((p) => p.id), status }));
  }));

  app.post('/api/p2p/:botId/desk/orders/:id/:action', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const mine = await requireDesk(a);
    const o = await decide(registryOf(req), Number(req.params.id), req.params.action,
      { decidedBy: a.user.id, platformIds: mine.map((p) => p.id) });
    res.json({ ok: true, status: o.status });
  }));

  app.patch('/api/p2p/:botId/desk/platforms/:pid', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const mine = await requireDesk(a);
    const current = mine.find((p) => p.id === Number(req.params.pid));
    if (!current) throw new HttpError(403, 'You can only edit your own platform.');
    const patch = parsePlatform(req.body, current, { desk: true });
    const { data, error } = await db.from('p2p_platforms')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', current.id).select().single();
    if (error) throw error;
    res.json(platformFull(data));
  }));

  /* ---------------------------------------------------------------- */
  /* Main admin (password login, used by admin.html)                    */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/p2p/platforms', requireAdmin, wrap(async (_req, res) => {
    const { data, error } = await db.from('p2p_platforms').select('*').order('id');
    if (error) throw error;
    const counts = await pendingCounts((data || []).map((p) => p.id));
    res.json((data || []).map((p) => platformFull(p, counts[p.id] || 0)));
  }));

  app.post('/api/admin/p2p/platforms', requireAdmin, wrap(async (req, res) => {
    const patch = parsePlatform(req.body, {}, { desk: false });
    if (!patch.name || !patch.telegram_id || patch.buy_rate == null || patch.sell_rate == null) {
      throw new HttpError(400, 'Name, Telegram ID, buy rate and sell rate are required.');
    }
    const { data, error } = await db.from('p2p_platforms').insert(patch).select().single();
    if (error) {
      if (error.code === '23505') throw new HttpError(409, 'A platform with this name already exists.');
      throw error;
    }
    res.status(201).json(platformFull(data));
  }));

  app.patch('/api/admin/p2p/platforms/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { data: current, error: ge } = await db.from('p2p_platforms').select('*').eq('id', id).maybeSingle();
    if (ge) throw ge;
    if (!current) throw new HttpError(404, 'Platform not found.');
    const patch = parsePlatform(req.body, current, { desk: false });
    const { data, error } = await db.from('p2p_platforms')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) {
      if (error.code === '23505') throw new HttpError(409, 'A platform with this name already exists.');
      throw error;
    }
    res.json(platformFull(data));
  }));

  app.delete('/api/admin/p2p/platforms/:id', requireAdmin, wrap(async (req, res) => {
    const { error } = await db.from('p2p_platforms').delete().eq('id', Number(req.params.id));
    if (error) throw error;
    res.json({ ok: true });
  }));

  app.get('/api/admin/p2p/orders', requireAdmin, wrap(async (req, res) => {
    const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    res.json(await listOrders({ status }));
  }));

  app.post('/api/admin/p2p/orders/:id/:action', requireAdmin, wrap(async (req, res) => {
    const o = await decide(registryOf(req), Number(req.params.id), req.params.action, { decidedBy: null });
    res.json({ ok: true, status: o.status });
  }));

  return { handleStart };
};
