// Admin tools for ONE games bot (Aviator + Bingo), used from the Mini App's Admin tab.
//
// Who is an admin: the Telegram ID set on the bot (bots.admin_telegram_id, set by the site
// owner) and anyone an admin added from inside the app (game_admins). All admins have the
// same rights; they only ever see and change their own bot.
//
//   GET    /gadmin/me                 am I an admin of this bot?
//   GET    /gadmin/stats              users, online now, money in/out, promo given
//   GET/PUT /gadmin/settings          min deposit, first-deposit bonus, cashback, Aviator limits, payment numbers
//   GET/POST/DELETE /gadmin/coupons   coupon codes (+ POST /coupons/:id/toggle)
//   GET/POST/DELETE /gadmin/admins    add / remove admins by Telegram ID
//   POST   /gadmin/broadcast          text or image to every user of this bot (+ GET /broadcast/:id progress)
//   GET    /gadmin/requests           pending deposits and withdrawals; POST to approve / reject / mark paid

const crypto = require('crypto');

const MAX_IMG_BYTES = 1.5 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp' };
  return null;
}
function decodeImage(input) {
  const raw = String(input || '');
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(raw);
  const b64 = (m ? m[1] : raw).replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, 'Upload a valid image.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_IMG_BYTES) throw new HttpError(413, 'That image is too large. Choose a smaller one.');
  const img = sniffImage(buf);
  if (!img) throw new HttpError(400, 'Images must be JPG, PNG or WebP.');
  return { buf, ...img };
}

module.exports = function attachGameAdmin(app, db, { miniAuth, MINIAPP_BASE, presence }) {
  const jobs = new Map(); // broadcast progress, newest few only

  const wrap = (fn) => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); await fn(req, res); }
    catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('game-admin error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };

  async function isGameAdmin(row, userId) {
    const main = Number(row.admin_telegram_id);
    if (main && main === userId) return true;
    try {
      const { data } = await db.from('game_admins').select('telegram_id').eq('bot_id', row.id).eq('telegram_id', userId).maybeSingle();
      return !!data;
    } catch (_) { return false; }
  }

  // Wraps a handler so that only this bot's admins get in.
  const adminRoute = (method, path, handler) => {
    app[method](`/api/mini/:botId/gadmin${path}`, wrap(async (req, res) => {
      const a = miniAuth(req, res); if (!a) return;
      if (!(await isGameAdmin(a.entry.row, a.user.id))) throw new HttpError(403, 'You are not an admin of this bot.');
      req.g = { entry: a.entry, row: a.entry.row, botId: a.entry.row.id, userId: a.user.id };
      await handler(req, res);
    }));
  };

  app.get('/api/mini/:botId/gadmin/me', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    res.json({ is_admin: await isGameAdmin(a.entry.row, a.user.id) });
  }));

  /* ------------------------------ stats ------------------------------ */
  adminRoute('get', '/stats', async (req, res) => {
    const { data, error } = await db.rpc('gadmin_stats', { p_bot_id: req.g.botId });
    if (error) throw error;
    const { count: coupons } = await db.from('coupons').select('id', { count: 'exact', head: true }).eq('bot_id', req.g.botId).eq('active', true);
    res.json({ ...data, online: presence.online(req.g.botId), coupons_active: coupons || 0 });
  });

  /* ----------------------------- settings ----------------------------- */
  const SETTING_FIELDS = 'min_deposit,first_deposit_bonus_pct,first_deposit_bonus_max,referral_deposit_bonus_pct,cashback_pct,cashback_max,aviator_cashback_pct,aviator_cashback_max,keno_enabled,keno_min_bet,keno_max_bet,keno_max_payout,keno_reserve,aviator_enabled,aviator_min_bet,aviator_max_bet,aviator_reserve,deposit_holder,deposit_phone,deposit_cbe_account,withdraw_min_deposit';
  adminRoute('get', '/settings', async (req, res) => {
    const { data, error } = await db.from('bots').select(SETTING_FIELDS).eq('id', req.g.botId).maybeSingle();
    if (error) throw error;
    res.json(data || {});
  });

  adminRoute('put', '/settings', async (req, res) => {
    const b = req.body || {};
    const patch = {};
    const num = (k, { min = 0, max = 1e9 } = {}) => {
      if (!(k in b)) return;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid value for ${k.replace(/_/g, ' ')}.`);
      patch[k] = round2(n);
    };
    num('min_deposit', { min: 1, max: 1e6 });
    num('first_deposit_bonus_pct', { max: 100 });
    num('first_deposit_bonus_max', { max: 1e6 });
    num('referral_deposit_bonus_pct', { max: 100 });
    num('cashback_pct', { max: 100 });
    num('cashback_max', { max: 1e6 });
    num('aviator_cashback_pct', { max: 100 });
    num('aviator_cashback_max', { max: 1e6 });
    num('keno_min_bet', { min: 1, max: 1e6 });
    num('keno_max_bet', { min: 1, max: 1e7 });
    num('keno_max_payout', { min: 1, max: 1e9 });
    num('keno_reserve', { max: 1e9 });
    if ('keno_enabled' in b) patch.keno_enabled = b.keno_enabled !== false;
    num('aviator_min_bet', { min: 1, max: 1e6 });
    num('aviator_max_bet', { min: 1, max: 1e7 });
    num('aviator_reserve', { max: 1e9 });
    num('withdraw_min_deposit', { max: 1e6 });
    if ('aviator_enabled' in b) patch.aviator_enabled = b.aviator_enabled !== false;
    if ('deposit_holder' in b) patch.deposit_holder = String(b.deposit_holder || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
    if ('deposit_phone' in b) {
      const d = String(b.deposit_phone || '').replace(/\D/g, '');
      if (d && d.length < 9) throw new HttpError(400, 'Enter a valid Telebirr number.');
      patch.deposit_phone = d || null;
    }
    if ('deposit_cbe_account' in b) {
      const d = String(b.deposit_cbe_account || '').replace(/\D/g, '');
      patch.deposit_cbe_account = d || null;
    }
    const cur = req.g.row;
    const lo = patch.aviator_min_bet ?? Number(cur.aviator_min_bet || 5), hi = patch.aviator_max_bet ?? Number(cur.aviator_max_bet || 5000);
    if (lo > hi) throw new HttpError(400, 'The minimum bet is above the maximum bet.');
    if ((patch.keno_min_bet ?? Number(cur.keno_min_bet || 5)) > (patch.keno_max_bet ?? Number(cur.keno_max_bet || 1000))) throw new HttpError(400, 'The Keno minimum bet is above the maximum bet.');
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');
    const { error } = await db.from('bots').update(patch).eq('id', req.g.botId);
    if (error) throw error;
    Object.assign(req.g.row, patch);        // the bot is cached in memory: refresh the live copy
    res.json({ ok: true });
  });

  /* ----------------------------- coupons ----------------------------- */
  adminRoute('get', '/coupons', async (req, res) => {
    const { data, error } = await db.from('coupons')
      .select('id,code,amount,wallet,max_uses,used_count,min_lifetime_deposit,expires_at,active,created_at')
      .eq('bot_id', req.g.botId).order('id', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ coupons: (data || []).map((c) => ({ ...c, amount: Number(c.amount), min_lifetime_deposit: Number(c.min_lifetime_deposit) })) });
  });

  adminRoute('post', '/coupons', async (req, res) => {
    const b = req.body || {};
    const amount = round2(b.amount);
    const maxUses = Math.floor(Number(b.max_uses));
    const minDep = b.min_lifetime_deposit === '' || b.min_lifetime_deposit == null ? 0 : round2(b.min_lifetime_deposit);
    if (!(amount > 0) || amount > 1e6) throw new HttpError(400, 'Enter the coupon amount.');
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1e6) throw new HttpError(400, 'Enter how many people can use it.');
    if (!(minDep >= 0)) throw new HttpError(400, 'Invalid minimum deposit.');
    let expires = null;
    if (b.expires_at) {
      const t = new Date(b.expires_at);
      if (Number.isNaN(t.getTime())) throw new HttpError(400, 'Invalid expiry date.');
      if (t.getTime() <= Date.now()) throw new HttpError(400, 'The expiry date is in the past.');
      expires = t.toISOString();
    }
    let code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (b.code && code.length < 4) throw new HttpError(400, 'A coupon code needs at least 4 letters or numbers.');
    if (!code) code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { data, error } = await db.from('coupons').insert({
      bot_id: req.g.botId, code, amount, max_uses: maxUses, min_lifetime_deposit: minDep, expires_at: expires,
      wallet: b.wallet === 'aviator' ? 'aviator' : 'bingo',
    }).select('id,code').single();
    if (error) {
      if (error.code === '23505') throw new HttpError(409, 'You already have a coupon with that code.');
      throw error;
    }
    res.json({ ok: true, coupon: data });
  });

  adminRoute('post', '/coupons/:id/toggle', async (req, res) => {
    const id = Number(req.params.id);
    const { data: c } = await db.from('coupons').select('active').eq('id', id).eq('bot_id', req.g.botId).maybeSingle();
    if (!c) throw new HttpError(404, 'Coupon not found.');
    const { error } = await db.from('coupons').update({ active: !c.active }).eq('id', id).eq('bot_id', req.g.botId);
    if (error) throw error;
    res.json({ ok: true, active: !c.active });
  });

  adminRoute('delete', '/coupons/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { count } = await db.from('coupon_redemptions').select('id', { count: 'exact', head: true }).eq('coupon_id', id).eq('bot_id', req.g.botId);
    if (count) throw new HttpError(409, 'This coupon was already used. Turn it off instead of deleting it.');
    const { error } = await db.from('coupons').delete().eq('id', id).eq('bot_id', req.g.botId);
    if (error) throw error;
    res.json({ ok: true });
  });

  /* ------------------------------ admins ------------------------------ */
  // Any admin can add or remove another admin by Telegram ID. The main admin (set by the site
  // owner) is always listed and cannot be removed here.
  adminRoute('get', '/admins', async (req, res) => {
    const main = Number(req.g.row.admin_telegram_id) || null;
    const { data, error } = await db.from('game_admins').select('telegram_id,added_by').eq('bot_id', req.g.botId).order('created_at');
    if (error) throw error;
    const list = [];
    if (main) list.push({ telegram_id: main, main: true });
    for (const r of data || []) if (Number(r.telegram_id) !== main) list.push({ telegram_id: Number(r.telegram_id), main: false });
    res.json({ admins: list, you: req.g.userId });
  });

  adminRoute('post', '/admins', async (req, res) => {
    const id = Number(String((req.body && req.body.telegram_id) || '').trim());
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Enter a valid Telegram ID (numbers only).');
    if (Number(req.g.row.admin_telegram_id) === id) throw new HttpError(409, 'That person is already an admin.');
    const { count } = await db.from('game_admins').select('telegram_id', { count: 'exact', head: true }).eq('bot_id', req.g.botId);
    if ((count || 0) >= 20) throw new HttpError(400, 'Admin limit reached (20).');
    const { error } = await db.from('game_admins').upsert(
      { bot_id: req.g.botId, telegram_id: id, added_by: req.g.userId }, { onConflict: 'bot_id,telegram_id', ignoreDuplicates: true });
    if (error) throw error;
    const link = MINIAPP_BASE ? { reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: `${MINIAPP_BASE}/games?b=${req.g.botId}` } }]] } } : {};
    req.g.entry.bot.sendMessage(id, `You are now an admin of ${req.g.row.name || 'this bot'}. Open the app and use the Admin tab.`, link).catch(() => {});
    res.json({ ok: true });
  });

  adminRoute('delete', '/admins/:tid', async (req, res) => {
    const id = Number(req.params.tid);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid Telegram ID.');
    if (Number(req.g.row.admin_telegram_id) === id) throw new HttpError(403, 'The main admin cannot be removed here.');
    const { error } = await db.from('game_admins').delete().eq('bot_id', req.g.botId).eq('telegram_id', id);
    if (error) throw error;
    res.json({ ok: true });
  });

  /* ----------------------------- broadcast ----------------------------- */
  // Sends to every user who has started this bot. Runs in the background at a safe speed
  // (Telegram allows about 30 messages a second); the app polls GET /broadcast/:id.
  adminRoute('post', '/broadcast', async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 3500);
    const photo = b.image ? decodeImage(b.image) : null;
    if (!text && !photo) throw new HttpError(400, 'Write a message or add a photo.');
    for (const j of jobs.values()) if (j.botId === req.g.botId && !j.done) throw new HttpError(409, 'A broadcast is already being sent. Wait for it to finish.');

    const ids = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('bot_users').select('telegram_id').eq('bot_id', req.g.botId).order('telegram_id').range(from, from + 999);
      if (error) throw error;
      for (const r of data || []) ids.push(Number(r.telegram_id));
      if (!data || data.length < 1000) break;
    }
    if (!ids.length) throw new HttpError(409, 'No users have started this bot yet.');

    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, botId: req.g.botId, total: ids.length, sent: 0, failed: 0, blocked: 0, done: false, startedAt: Date.now() };
    jobs.set(id, job);
    if (jobs.size > 20) jobs.delete(jobs.keys().next().value);

    const entry = req.g.entry;
    const markup = b.button && MINIAPP_BASE
      ? { reply_markup: { inline_keyboard: [[{ text: '✈️ Play now', web_app: { url: `${MINIAPP_BASE}/games?b=${req.g.botId}` } }]] } } : {};
    (async () => {
      let fileId = null; // after the first photo upload, reuse Telegram's copy
      for (const tg of ids) {
        try {
          if (photo) {
            const src = fileId || photo.buf;
            const opts = text.length <= 1000 ? { caption: text, ...markup } : { ...markup };
            const m = await entry.bot.sendPhoto(tg, src, opts, fileId ? {} : { filename: `post.${photo.ext}` });
            if (!fileId && m && m.photo && m.photo.length) fileId = m.photo[m.photo.length - 1].file_id;
            if (text.length > 1000) await entry.bot.sendMessage(tg, text, markup);
          } else {
            await entry.bot.sendMessage(tg, text, markup);
          }
          job.sent++;
        } catch (err) {
          const code = err && err.response && err.response.statusCode;
          if (code === 403) job.blocked++; else job.failed++;
          if (code === 429) { const wait = (err.response.body && err.response.body.parameters && err.response.body.parameters.retry_after) || 3; await sleep(wait * 1000); }
        }
        await sleep(45);
      }
      job.done = true; job.finishedAt = Date.now();
    })().catch((e) => { console.error('broadcast crashed:', e); job.done = true; });

    res.json({ ok: true, job_id: id, total: ids.length });
  });

  adminRoute('get', '/broadcast/:id', async (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.botId !== req.g.botId) throw new HttpError(404, 'Broadcast not found.');
    res.json({ total: j.total, sent: j.sent, failed: j.failed, blocked: j.blocked, done: j.done });
  });

  /* ------------------- deposit / withdrawal requests ------------------- */
  adminRoute('get', '/requests', async (req, res) => {
    const [d, w] = await Promise.all([
      db.from('deposits').select('id,telegram_id,amount,note,wallet,verify_state,created_at').eq('bot_id', req.g.botId).eq('status', 'pending').order('created_at').limit(100),
      db.from('withdrawals').select('id,telegram_id,amount,phone,wallet,created_at').eq('bot_id', req.g.botId).eq('status', 'pending').order('created_at').limit(100),
    ]);
    if (d.error) throw d.error; if (w.error) throw w.error;
    res.json({
      deposits: (d.data || []).map((x) => ({ id: x.id, telegram_id: x.telegram_id, amount: Number(x.amount), note: x.note || '', wallet: x.wallet || 'bingo', at: x.created_at })),
      withdrawals: (w.data || []).map((x) => ({ id: x.id, telegram_id: x.telegram_id, amount: Number(x.amount), phone: x.phone, wallet: x.wallet || 'bingo', at: x.created_at })),
    });
  });

  const tell = (req, tg, text, extra) => req.g.entry.bot.sendMessage(tg, text, extra).catch(() => {});

  adminRoute('post', '/deposits/:id/approve', async (req, res) => {
    const id = Number(req.params.id);
    const { data: d } = await db.from('deposits').select('bot_id').eq('id', id).maybeSingle();
    if (!d || Number(d.bot_id) !== req.g.botId) throw new HttpError(404, 'Deposit not found.');
    const { data, error } = await db.rpc('credit_deposit_wallet', { p_deposit_id: id, p_admin: `admin:${req.g.userId}` });
    if (error) throw error;
    if (!data || !data.ok) throw new HttpError(409, 'Already decided.');
    const wl = data.wallet === 'aviator' ? 'Games' : 'Bingo';
    tell(req, data.telegram_id, `✅ Your deposit of *${Number(data.amount)} birr* has been approved.\n${wl} wallet: *${Number(data.new_balance)} birr*${data.bonus > 0 ? `\n🎁 First deposit bonus: *${Number(data.bonus)} birr* (Bingo bonus)` : ''}`, { parse_mode: 'Markdown' });
    if (Number(data.promoter_bonus) > 0 && data.promoter_id) {
      tell(req, data.promoter_id, `🎁 A player you invited made a deposit. You earned *${Number(data.promoter_bonus)} birr* (Bingo bonus).`, { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
  });

  adminRoute('post', '/deposits/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    const { data, error } = await db.from('deposits')
      .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: `admin:${req.g.userId}` })
      .eq('id', id).eq('bot_id', req.g.botId).eq('status', 'pending').select('telegram_id,amount').maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, 'Already decided or not found.');
    tell(req, data.telegram_id, `❌ Your deposit request of ${Number(data.amount)} birr was rejected. Contact support if this seems wrong.`);
    res.json({ ok: true });
  });

  adminRoute('post', '/withdrawals/:id/paid', async (req, res) => {
    const id = Number(req.params.id);
    const { data: w } = await db.from('withdrawals').select('*').eq('id', id).eq('bot_id', req.g.botId).maybeSingle();
    if (!w) throw new HttpError(404, 'Not found.');
    const { data, error } = await db.rpc('mark_withdrawal_paid', { p_withdrawal_id: id, p_admin: `admin:${req.g.userId}` });
    if (error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if (!r || !r.ok) throw new HttpError(409, 'Already decided.');
    tell(req, w.telegram_id, `✅ Your withdrawal of *${Number(w.amount)} birr* has been sent to \`${w.phone}\`.`, { parse_mode: 'Markdown' });
    res.json({ ok: true });
  });

  adminRoute('post', '/withdrawals/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    const { data: w } = await db.from('withdrawals').select('*').eq('id', id).eq('bot_id', req.g.botId).maybeSingle();
    if (!w) throw new HttpError(404, 'Not found.');
    const { data, error } = w.wallet === 'aviator'
      ? await db.rpc('wallet_reject_withdrawal_aviator', { p_withdrawal_id: id })
      : await db.rpc('reject_withdrawal', { p_withdrawal_id: id, p_admin: `admin:${req.g.userId}` });
    if (error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if (!r || !r.ok) throw new HttpError(409, 'Already decided.');
    tell(req, w.telegram_id, `❌ Your withdrawal request of ${Number(w.amount)} birr was rejected and refunded to your wallet.`);
    res.json({ ok: true });
  });

  app.set('isGameAdmin', isGameAdmin);   // sports.js uses it for its admin routes
  return { isGameAdmin };
};
