// Lets the store admin connect his OWN Telegram account and post to groups/channels he is
// already a member of, from the Mini App (for groups where the bot is not an admin).
//
// Needs (Railway variables):
//   TG_API_ID, TG_API_HASH   from https://my.telegram.org  (API development tools)
//   STORE_SESSION_KEY        a long random secret (24+ characters). Encrypts the saved login.
// And the npm package "telegram" (GramJS): `npm install telegram`
//
// Safety:
//  - The saved login (session) is encrypted with AES-256-GCM and never sent to the browser.
//  - The 2-step-verification password is used once to sign in and is never stored.
//  - Posts are spaced out and capped per day. Telegram limits accounts that post a lot, so
//    a spare account is safer than your main one. Disconnect logs the session out.

const crypto = require('crypto');

const SPACING_MS = 10000;        // wait between two groups
const MAX_TARGETS = 25;          // groups per send
const DAILY_CAP = 120;           // messages per day per store
const LOGIN_TTL_MS = 10 * 60 * 1000;
const CLIENT_TTL_MS = 10 * 60 * 1000;

module.exports = function attachAccount({ db, adminRoute, scope, wrap, HttpError, registry, clean, decodeImage, sleep, MAX_IMG_BYTES }) {
  const API_ID = Number(process.env.TG_API_ID);
  const API_HASH = process.env.TG_API_HASH;
  const SECRET = process.env.STORE_SESSION_KEY || '';
  const configured = () => Number.isInteger(API_ID) && API_ID > 0 && !!API_HASH && SECRET.length >= 24;

  /* ---- encryption of the saved session ---- */
  const aesKey = () => crypto.scryptSync(SECRET, 'store-account-session-v1', 32);
  function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  function decrypt(b64) {
    const raw = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  /* ---- GramJS is loaded only when needed ---- */
  let gram = null;
  function lib() {
    if (gram) return gram;
    try {
      gram = {
        TelegramClient: require('telegram').TelegramClient,
        Api: require('telegram').Api,
        StringSession: require('telegram/sessions').StringSession,
        CustomFile: require('telegram/client/uploads').CustomFile,
      };
    } catch {
      throw new HttpError(501, 'The "telegram" package is not installed on the server. Run: npm install telegram');
    }
    return gram;
  }
  function need() {
    if (!configured()) throw new HttpError(501, 'Account posting is not set up on the server (TG_API_ID, TG_API_HASH, STORE_SESSION_KEY).');
    return lib();
  }
  const newClient = (session) => {
    const { TelegramClient, StringSession } = need();
    return new TelegramClient(new StringSession(session || ''), API_ID, API_HASH, { connectionRetries: 3 });
  };

  const botIdOf = (req) => scope(req);   // the store this admin call is about

  const pending = new Map();   // botId -> { client, phone, hash, at }
  const clients = new Map();   // botId -> { client, timer }
  const jobs = new Map();      // jobId -> job
  const sentToday = new Map(); // botId -> { day, n }

  async function loadRow(botId) {
    const { data, error } = await db.from('store_accounts').select('*').eq('bot_id', botId).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function liveClient(botId) {
    const cached = clients.get(botId);
    if (cached) { clearTimeout(cached.timer); cached.timer = setTimeout(() => drop(botId), CLIENT_TTL_MS); cached.timer.unref && cached.timer.unref(); return cached.client; }
    const row = await loadRow(botId);
    if (!row) throw new HttpError(409, 'Connect your Telegram account first.');
    let session;
    try { session = decrypt(row.session_enc); } catch { throw new HttpError(500, 'Could not read the saved login. Disconnect and connect again.'); }
    const client = newClient(session);
    await client.connect();
    const timer = setTimeout(() => drop(botId), CLIENT_TTL_MS); timer.unref && timer.unref();
    clients.set(botId, { client, timer });
    return client;
  }
  async function drop(botId) {
    const c = clients.get(botId); if (!c) return;
    clients.delete(botId); clearTimeout(c.timer);
    try { await c.client.disconnect(); } catch { /* ignore */ }
  }
  const tgError = (err) => String((err && (err.errorMessage || err.message)) || err || 'Telegram error');

  /* ---------------------------------------------------------------- */
  adminRoute('get', '/account', wrap(async (req, res) => {
    const botId = await botIdOf(req);
    const row = configured() ? await loadRow(botId) : null;
    const p = row && row.phone ? row.phone : '';
    res.json({ configured: configured(), connected: !!row, phone: p ? p.slice(0, 4) + '****' + p.slice(-2) : null });
  }));

  adminRoute('post', '/account/send-code', wrap(async (req, res) => {
    need();
    const botId = await botIdOf(req);
    const phone = clean((req.body || {}).phone, 20).replace(/[\s-]/g, '');
    if (!/^\+\d{9,15}$/.test(phone)) throw new HttpError(400, 'Enter the phone number with country code, like +2519...');
    const old = pending.get(botId); if (old) { try { await old.client.disconnect(); } catch { /* ignore */ } }
    const client = newClient('');
    try {
      await client.connect();
      const r = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
      pending.set(botId, { client, phone, hash: r.phoneCodeHash, at: Date.now() });
    } catch (err) {
      try { await client.disconnect(); } catch { /* ignore */ }
      const m = tgError(err);
      if (/PHONE_NUMBER_INVALID/.test(m)) throw new HttpError(400, 'Telegram says this phone number is not valid.');
      if (/FLOOD/.test(m)) throw new HttpError(429, 'Too many tries. Wait a while and try again.');
      throw new HttpError(502, 'Telegram did not send the code: ' + m);
    }
    res.json({ ok: true });
  }));

  adminRoute('post', '/account/verify', wrap(async (req, res) => {
    const { Api } = need();
    const botId = await botIdOf(req);
    const p = pending.get(botId);
    if (!p || Date.now() - p.at > LOGIN_TTL_MS) { pending.delete(botId); throw new HttpError(409, 'The code expired. Start again.'); }
    const code = clean((req.body || {}).code, 10).replace(/\D/g, '');
    const password = String((req.body || {}).password || '').slice(0, 256);
    if (!code) throw new HttpError(400, 'Enter the code Telegram sent you.');

    try {
      try {
        await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.hash, phoneCode: code }));
      } catch (err) {
        if (tgError(err) !== 'SESSION_PASSWORD_NEEDED') throw err;
        if (!password) return res.json({ ok: false, need_password: true });
        let last = null;
        await p.client.signInWithPassword({ apiId: API_ID, apiHash: API_HASH }, {
          password: async () => password,
          onError: async (e) => { last = e; return true; },
        }).catch(() => { throw last || new Error('PASSWORD_HASH_INVALID'); });
      }
    } catch (err) {
      const m = tgError(err);
      if (/PHONE_CODE_INVALID/.test(m)) throw new HttpError(400, 'That code is wrong.');
      if (/PHONE_CODE_EXPIRED/.test(m)) { pending.delete(botId); throw new HttpError(409, 'The code expired. Start again.'); }
      if (/PASSWORD_HASH_INVALID/.test(m)) throw new HttpError(400, 'Wrong 2-step verification password.');
      if (/FLOOD/.test(m)) throw new HttpError(429, 'Too many tries. Wait a while and try again.');
      throw new HttpError(502, 'Could not sign in: ' + m);
    }

    const session = p.client.session.save();
    const { error } = await db.from('store_accounts').upsert({
      bot_id: botId, phone: p.phone, session_enc: encrypt(session),
    });
    if (error) throw error;
    pending.delete(botId);
    await drop(botId);
    clients.set(botId, { client: p.client, timer: setTimeout(() => drop(botId), CLIENT_TTL_MS) });
    res.json({ ok: true, connected: true });
  }));

  adminRoute('delete', '/account', wrap(async (req, res) => {
    const botId = await botIdOf(req);
    if (configured()) {
      try { const c = await liveClient(botId); const { Api } = lib(); await c.invoke(new Api.auth.LogOut()); } catch { /* already gone */ }
    }
    await drop(botId);
    await db.from('store_accounts').delete().eq('bot_id', botId);
    res.json({ ok: true });
  }));

  // Groups and channels this account can post in.
  adminRoute('get', '/account/dialogs', wrap(async (req, res) => {
    const botId = await botIdOf(req);
    const client = await liveClient(botId);
    let list;
    try { list = await client.getDialogs({ limit: 300 }); }
    catch (err) { throw new HttpError(502, 'Could not load your chats: ' + tgError(err)); }
    const out = [];
    for (const d of list) {
      if (!(d.isGroup || d.isChannel)) continue;
      const e = d.entity || {};
      const isOwner = !!e.creator;
      const adminPost = !!(e.adminRights && e.adminRights.postMessages);
      const banned = !!(e.defaultBannedRights && e.defaultBannedRights.sendMessages) && !isOwner && !e.adminRights;
      if (d.isChannel && !d.isGroup && !isOwner && !adminPost) continue;   // channels: only where he can post
      if (banned) continue;
      out.push({ id: String(d.id), title: d.title || String(d.id), type: d.isGroup ? 'group' : 'channel' });
    }
    res.json({ dialogs: out });
  }));

  // Start a send. It runs in the background (groups are spaced out), poll /account/jobs/:id.
  adminRoute('post', '/account/post', wrap(async (req, res) => {
    const { CustomFile } = need();
    const botId = await botIdOf(req);
    const b = req.body || {};
    const text = clean(b.text, 3500);
    const photo = b.image ? decodeImage(b.image, MAX_IMG_BYTES) : null;
    if (!text && !photo) throw new HttpError(400, 'Write a message or add a photo.');
    const ids = [...new Set((Array.isArray(b.targets) ? b.targets : []).map(String))].slice(0, MAX_TARGETS);
    if (!ids.length) throw new HttpError(400, 'Pick at least one group.');

    const day = new Date().toISOString().slice(0, 10);
    const cap = sentToday.get(botId) && sentToday.get(botId).day === day ? sentToday.get(botId) : { day, n: 0 };
    if (cap.n + ids.length > DAILY_CAP) throw new HttpError(429, 'Daily posting limit reached for this account. Try again tomorrow.');
    cap.n += ids.length; sentToday.set(botId, cap);

    const client = await liveClient(botId);
    const dialogs = await client.getDialogs({ limit: 300 });
    const byId = new Map(dialogs.map((d) => [String(d.id), d]));

    const job = { id: require('crypto').randomUUID(), status: 'running', total: ids.length, done: 0, results: [], at: Date.now() };
    jobs.set(job.id, job);
    for (const [k, j] of jobs) if (Date.now() - j.at > 60 * 60 * 1000) jobs.delete(k);

    (async () => {
      for (let i = 0; i < ids.length; i++) {
        const d = byId.get(ids[i]);
        const title = d ? d.title : ids[i];
        if (!d) { job.results.push({ title, ok: false, error: 'Chat not found' }); job.done++; continue; }
        try {
          if (photo) {
            const file = new CustomFile('post.jpg', photo.buf.length, '', photo.buf);
            if (text.length <= 1000) await client.sendFile(d.inputEntity, { file, caption: text });
            else { await client.sendFile(d.inputEntity, { file }); await client.sendMessage(d.inputEntity, { message: text }); }
          } else {
            await client.sendMessage(d.inputEntity, { message: text });
          }
          job.results.push({ title, ok: true });
        } catch (err) {
          const m = tgError(err);
          job.results.push({ title, ok: false, error: m });
          if (/FLOOD_WAIT|PEER_FLOOD/.test(m)) {   // Telegram asked us to stop: do not push on
            job.status = 'stopped'; job.message = 'Telegram asked to slow down. Stopped to protect your account.'; job.done = job.total; return;
          }
        }
        job.done++;
        if (i < ids.length - 1) await sleep(SPACING_MS);
      }
      job.status = 'done';
    })().catch((err) => { job.status = 'stopped'; job.message = tgError(err); });

    res.json({ ok: true, job_id: job.id, total: job.total, seconds: Math.ceil((ids.length - 1) * SPACING_MS / 1000) });
  }));

  adminRoute('get', '/account/jobs/:id', wrap(async (req, res) => {
    const j = jobs.get(String(req.params.id));
    if (!j) throw new HttpError(404, 'Job not found.');
    res.json({ status: j.status, total: j.total, done: j.done, results: j.results, message: j.message || null });
  }));
};
