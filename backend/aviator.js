// Aviator (crash game) — one shared round for every player of every bot.
//
// Wallet: Aviator uses ONLY bot_users.aviator_balance (money the player
// deposited to the Aviator wallet) plus the Aviator bonus (Aviator cashback and Aviator coupons).
// The registration bonus can never be bet here. A bet uses the Aviator bonus first. Free-bet style: the
// bonus part of a stake is not paid back, only the winnings on it are (paid into the real Aviator wallet).
//
// Money safety (the platform must never pay more than it has):
//   Before the plane takes off, the server looks at every bet in the round and,
//   for each bot, works out the most it can afford to pay:
//        affordable = stakes in this round + profit already made from Aviator
//                     on that bot + bots.aviator_reserve
//   If the plane were allowed to fly high enough that everybody could cash out
//   above `affordable`, the crash point is lowered to the highest multiplier that
//   still keeps total payouts <= affordable. Such rounds are flagged `limited`.
//   The seed hash is published before betting as usual; /verify shows both the
//   seed's own crash point and the limited one.
//
// Live updates use Server-Sent Events (/api/aviator/stream). No extra packages.
// Round state lives in memory, so run ONE backend instance (same as Bingo).

const crypto = require('crypto');

const HOUSE_EDGE = 0.97;
const BETTING_MS = 8000;
const POST_ROUND_MS = 4000;
const TICK_MS = 50;
const MAX_SLOTS = 2;
const DEFAULT_MIN_BET = 5;
const DEFAULT_MAX_BET = 5000;
const MAX_AUTO = 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;

function seedToCrashPoint(seed) {
  const int = parseInt(sha256(seed).slice(0, 13), 16);
  const f = int / Math.pow(2, 52);
  if (f === 0) return 1.0;
  return Math.max(1.0, floor2(HOUSE_EDGE / (1 - f)));
}

// Same curve the client draws: m = 1 + 0.05 t + 0.02 t^2   (t in seconds)
const multiplierAt = (t) => round2(1 + 0.05 * t + 0.02 * t * t);

const maskName = (u) => {
  const n = String((u && (u.username || u.first_name)) || 'Player').replace(/^@/, '');
  return n.slice(0, 2) + '***';
};

module.exports = function attachAviator(app, db, { miniAuth, requireAdmin }) {
  let round = null;          // the current round, or null between rounds
  let flyTimer = null;
  let nextTimer = null;
  const clients = new Set(); // SSE connections
  let recent = [];           // last crash points, newest first
  let liveDirty = false;
  let prevRound = null;      // { crash, players, cashed, win, bets } of the round before
  const chat = [];           // last chat messages
  let chatSeq = 0;
  const lastChat = new Map();

  /* ---------------------------------------------------------------- */
  /* live stream                                                       */
  /* ---------------------------------------------------------------- */
  function send(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* closed */ }
  }
  function broadcast(event, data) { for (const c of clients) send(c, event, data); }

  const stateOf = (b) => (b.status === 'settling' ? 'placed' : b.status);
  function liveSummary(r = round) {
    const all = r ? [...r.bets.values()] : [];
    const won = all.filter((b) => b.status === 'cashed_out');
    return {
      players: all.length,
      cashed: won.length,
      win: round2(won.reduce((sum, b) => sum + (b.payout || 0), 0)),
      bets: all.sort((a, b) => b.amount - a.amount).slice(0, 60)
        .map((b) => ({ name: b.name, avatar: b.avatar || 0, amount: b.amount, status: stateOf(b), mult: b.mult || null, payout: b.payout || 0 })),
    };
  }

  function snapshot() {
    const s = { now: Date.now(), phase: round ? round.phase : 'starting', history: recent.slice(0, 40),
                online: clients.size, chat: chat.slice(-40), prev: prevRound, ...liveSummary() };
    if (round) {
      s.round_id = round.id;
      s.server_seed_hash = round.hash;
      if (round.phase === 'betting') s.betting_ends_at = round.bettingEndsAt;
      if (round.phase === 'flying') s.flying_since = round.flyingSince;
      if (round.phase === 'ended') { s.crash_point = round.crash; s.flying_since = round.flyingSince; }
    }
    return s;
  }

  app.get('/api/aviator/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 2000\n\n');
    send(res, 'state', snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/api/aviator/state', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(snapshot());
  });

  setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (_) { /* closed */ } } }, 15000).unref();
  setInterval(() => {
    if (liveDirty && clients.size) { liveDirty = false; broadcast('live', liveSummary()); }
  }, 1000).unref();

  /* ---------------------------------------------------------------- */
  /* round loop                                                        */
  /* ---------------------------------------------------------------- */
  async function startBetting() {
    clearTimeout(nextTimer);
    const seed = crypto.randomBytes(32).toString('hex');
    const hash = sha256(seed);
    const base = seedToCrashPoint(seed);
    const id = `RND-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const { error } = await db.from('aviator_rounds').insert({
      round_id: id, server_seed_hash: hash, base_crash: base, crash_point: base,
    });
    if (error) {
      console.error('aviator: could not start round:', error.message);
      nextTimer = setTimeout(() => startBetting().catch(console.error), 3000);
      return;
    }

    round = { id, seed, hash, base, crash: base, limited: false, phase: 'betting',
              bettingEndsAt: Date.now() + BETTING_MS, flyingSince: null, bets: new Map() };
    broadcast('betting', { round_id: id, server_seed_hash: hash, betting_ends_at: round.bettingEndsAt, now: Date.now(), history: recent.slice(0, 40) });
    nextTimer = setTimeout(() => startFlying().catch(console.error), BETTING_MS);
  }

  // Highest crash point at which total payouts still stay within what each bot can afford.
  async function affordableCrash(r) {
    const perBot = new Map(); // botId -> { stakes }
    for (const b of r.bets.values()) {
      if (b.status !== 'placed') continue;
      const p = perBot.get(b.botId) || { stakes: 0 };
      p.stakes += b.amount;
      perBot.set(b.botId, p);
    }
    let cap = Infinity;
    for (const [botId, p] of perBot) {
      const [{ data: profit }, { data: bot }] = await Promise.all([
        db.rpc('aviator_house_profit', { p_bot_id: botId }),
        db.from('bots').select('aviator_reserve').eq('id', botId).maybeSingle(),
      ]);
      const funds = Math.max(0, Number(profit) || 0) + Math.max(0, Number(bot && bot.aviator_reserve) || 0);
      const affordable = p.stakes + funds;          // stakes are returned to winners too
      cap = Math.min(cap, floor2(affordable / p.stakes));
    }
    return Math.max(1.0, cap);
  }

  async function startFlying() {
    if (!round || round.phase !== 'betting') return;
    round.phase = 'locking'; // bets are closed while we check the numbers
    try {
      const cap = await affordableCrash(round);
      if (cap < round.base) { round.crash = cap; round.limited = true; }
    } catch (err) {
      // If we cannot check the platform's funds, play it safe: nobody wins this round.
      console.error('aviator: solvency check failed, crashing at 1.00x:', err.message || err);
      round.crash = 1.0; round.limited = true;
    }
    await db.from('aviator_rounds').update({ crash_point: round.crash, limited: round.limited }).eq('round_id', round.id);

    round.phase = 'flying';
    round.flyingSince = Date.now();
    broadcast('flying', { round_id: round.id, flying_since: round.flyingSince, now: Date.now() });
    flyTimer = setInterval(tick, TICK_MS);
  }

  const currentMultiplier = () => (round && round.phase === 'flying' ? multiplierAt((Date.now() - round.flyingSince) / 1000) : 1.0);

  let ticking = false;
  async function tick() {
    if (ticking || !round || round.phase !== 'flying') return;
    ticking = true;
    try {
      const m = currentMultiplier();
      if (m >= round.crash) { clearInterval(flyTimer); await endRound(); return; }
      for (const bet of round.bets.values()) {
        if (bet.status === 'placed' && bet.auto && bet.auto <= m) await cashOut(bet, bet.auto);
      }
    } catch (err) { console.error('aviator tick error:', err); } finally { ticking = false; }
  }

  // Pays one bet at the given multiplier. Never pays twice, never pays after a crash.
  async function cashOut(bet, mult) {
    if (bet.status !== 'placed') return null;
    bet.status = 'settling';
    const bonus = bet.bonus || 0;
    const payout = round2((bet.amount - bonus) * mult + bonus * (mult - 1));   // real part pays stake x multiplier, bonus part pays only the winnings
    const { data, error } = await db.rpc('aviator_settle_bet', { p_bet_id: bet.id, p_status: 'cashed_out', p_mult: mult, p_payout: payout });
    if (error) { console.error('aviator cashout error:', error.message); bet.status = 'placed'; return null; }
    if (!data || !data.ok) { bet.status = 'done'; return null; }
    bet.status = 'cashed_out'; bet.mult = mult; bet.payout = payout; bet.balance = Number(data.balance);
    liveDirty = true;
    return bet;
  }

  async function endRound() {
    const r = round;
    r.phase = 'ended';
    const losers = [...r.bets.values()].filter((b) => b.status === 'placed');
    await Promise.all(losers.map(async (b) => {
      b.status = 'lost';
      const { error } = await db.rpc('aviator_settle_bet', { p_bet_id: b.id, p_status: 'lost', p_mult: null, p_payout: 0 });
      if (error) console.error('aviator lose error:', error.message);
    }));
    await db.from('aviator_rounds').update({ server_seed: r.seed, ended_at: new Date().toISOString() }).eq('round_id', r.id);

    recent.unshift(r.crash);
    recent = recent.slice(0, 40);
    broadcast('crash', { round_id: r.id, crash_point: r.crash, server_seed: r.seed, server_seed_hash: r.hash, now: Date.now(), history: recent.slice(0, 40) });
    prevRound = { crash: r.crash, ...liveSummary(r) };
    broadcast('live', liveSummary(r));
    nextTimer = setTimeout(() => startBetting().catch(console.error), POST_ROUND_MS);
  }

  /* ---------------------------------------------------------------- */
  /* player API                                                        */
  /* ---------------------------------------------------------------- */
  const limitsOf = (row) => ({
    min: Number(row.aviator_min_bet) > 0 ? Number(row.aviator_min_bet) : DEFAULT_MIN_BET,
    max: Number(row.aviator_max_bet) > 0 ? Number(row.aviator_max_bet) : DEFAULT_MAX_BET,
  });
  const keyOf = (botId, tg, slot) => `${botId}:${tg}:${slot}`;
  const fail = (res, code, msg) => res.status(code).json({ error: msg });

  async function walletOf(botId, tg) {
    const { data } = await db.from('bot_users').select('aviator_balance,aviator_bonus').eq('bot_id', botId).eq('telegram_id', tg).maybeSingle();
    return { balance: data ? Number(data.aviator_balance) : 0, bonus: data ? Number(data.aviator_bonus) || 0 : 0 };
  }

  app.get('/api/mini/:botId/aviator/me', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const bets = [];
      if (round) {
        for (let slot = 1; slot <= MAX_SLOTS; slot++) {
          const b = round.bets.get(keyOf(row.id, a.user.id, slot));
          if (b) bets.push({ slot, amount: b.amount, auto: b.auto, status: b.status === 'settling' ? 'placed' : b.status, mult: b.mult || null, payout: b.payout || 0, bonus: b.bonus || 0 });
        }
      }
      res.set('Cache-Control', 'no-store');
      const w = await walletOf(row.id, a.user.id);
      res.json({ name: maskName(a.user), balance: w.balance, bonus: w.bonus, enabled: row.aviator_enabled !== false, ...limitsOf(row), round_id: round ? round.id : null, bets });
    } catch (err) { console.error('aviator me error:', err); fail(res, 500, 'Could not load Aviator.'); }
  });

  app.post('/api/mini/:botId/aviator/bet', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      if (row.aviator_enabled === false) return fail(res, 403, 'Aviator is switched off.');
      if (!round || round.phase !== 'betting' || Date.now() >= round.bettingEndsAt) return fail(res, 400, 'Betting is closed for this round.');

      const slot = Number(req.body && req.body.slot);
      const amount = round2(req.body && req.body.amount);
      const { min, max } = limitsOf(row);
      if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) return fail(res, 400, 'Invalid bet slot.');
      if (!(amount >= min) || amount > max) return fail(res, 400, `Bet between ${min} and ${max} ETB.`);
      let auto = req.body && req.body.auto_cashout_at ? round2(req.body.auto_cashout_at) : null;
      if (auto !== null && (!(auto > 1) || auto > MAX_AUTO)) return fail(res, 400, 'Auto cash-out must be above 1.00x.');

      const r = round; // the round we validated against
      const { data, error } = await db.rpc('aviator_place_bet', {
        p_bot_id: row.id, p_telegram_id: a.user.id, p_round_id: r.id,
        p_slot: slot, p_amount: amount, p_auto: auto, p_username: maskName(a.user),
      });
      if (error) throw error;
      if (!data.ok) {
        const msgs = { insufficient: 'Not enough money in your Aviator wallet. Deposit to Aviator first.', already_bet: 'You already have a bet in this slot.', no_account: 'Please send /start to the bot first.' };
        return fail(res, data.reason === 'insufficient' ? 402 : 400, msgs[data.reason] || 'Could not place the bet.');
      }
      // The round may have locked while the database was working: give the money back.
      if (round !== r || r.phase !== 'betting') {
        await db.rpc('aviator_cancel_bet', { p_bet_id: data.bet_id });
        return fail(res, 400, 'Betting just closed. Your money was not taken.');
      }
      const avatar = Math.max(0, Math.min(11, parseInt(req.body && req.body.avatar, 10) || 0));
      r.bets.set(keyOf(row.id, a.user.id, slot), { id: data.bet_id, botId: row.id, tg: a.user.id, slot, amount, bonus: Number(data.bonus_used) || 0, auto, status: 'placed', name: maskName(a.user), avatar });
      liveDirty = true;
      res.json({ ok: true, balance: Number(data.balance), bonus: Number(data.bonus) || 0 });
    } catch (err) { console.error('aviator bet error:', err); fail(res, 500, 'Could not place the bet. Please try again.'); }
  });

  app.post('/api/mini/:botId/aviator/cancel', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const slot = Number(req.body && req.body.slot);
      if (!round || round.phase !== 'betting') return fail(res, 400, 'Bets can only be cancelled while betting is open.');
      const k = keyOf(a.entry.row.id, a.user.id, slot);
      const bet = round.bets.get(k);
      if (!bet || bet.status !== 'placed') return fail(res, 400, 'No bet to cancel.');
      bet.status = 'settling';
      const { data, error } = await db.rpc('aviator_cancel_bet', { p_bet_id: bet.id });
      if (error || !data || !data.ok) { bet.status = 'placed'; return fail(res, 400, 'Could not cancel.'); }
      round.bets.delete(k);
      liveDirty = true;
      res.json({ ok: true, balance: Number(data.balance), bonus: Number(data.bonus) || 0 });
    } catch (err) { console.error('aviator cancel error:', err); fail(res, 500, 'Could not cancel. Please try again.'); }
  });

  app.post('/api/mini/:botId/aviator/cashout', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const slot = Number(req.body && req.body.slot);
      if (!round || round.phase !== 'flying') return fail(res, 400, 'Nothing to cash out right now.');
      const bet = round.bets.get(keyOf(a.entry.row.id, a.user.id, slot));
      if (!bet || bet.status !== 'placed') return fail(res, 400, 'No active bet in that slot.');
      const m = currentMultiplier();
      if (m >= round.crash) return fail(res, 400, 'Too late — the plane already flew away.');
      const done = await cashOut(bet, m);
      if (!done) return fail(res, 400, 'Could not cash out.');
      res.json({ ok: true, mult: m, payout: done.payout, balance: done.balance });
    } catch (err) { console.error('aviator cashout error:', err); fail(res, 500, 'Could not cash out. Please try again.'); }
  });

  app.get('/api/mini/:botId/aviator/my-bets', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('aviator_bets')
      .select('round_id,slot,amount,status,cashed_out_at,payout,created_at')
      .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).neq('status', 'placed')
      .order('created_at', { ascending: false }).limit(20);
    if (error) return fail(res, 500, 'Could not load history.');
    res.set('Cache-Control', 'no-store');
    res.json({ bets: (data || []).map((b) => ({ round_id: b.round_id, slot: b.slot, amount: Number(b.amount), status: b.status, mult: b.cashed_out_at ? Number(b.cashed_out_at) : null, payout: Number(b.payout), at: b.created_at })) });
  });

  // Public: anyone can check a finished round against its published hash.
  app.get('/api/aviator/verify/:roundId', async (req, res) => {
    const { data: r } = await db.from('aviator_rounds').select('*').eq('round_id', req.params.roundId).maybeSingle();
    if (!r || !r.server_seed) return fail(res, 404, 'Round not found or not finished yet.');
    res.json({
      round_id: r.round_id, server_seed: r.server_seed, server_seed_hash: r.server_seed_hash,
      hash_matches: sha256(r.server_seed) === r.server_seed_hash,
      seed_crash_point: seedToCrashPoint(r.server_seed),
      crash_point: Number(r.crash_point), limited: !!r.limited,
    });
  });

  /* ---------------------------------------------------------------- */
  /* chat, online count, top wins                                       */
  /* ---------------------------------------------------------------- */
  setInterval(() => { if (clients.size) broadcast('online', { online: clients.size }); }, 5000).unref();

  app.post('/api/mini/:botId/aviator/chat', (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const key = `${a.entry.row.id}:${a.user.id}`;
    const text = String((req.body && req.body.text) || '')
      .replace(/(https?:\/\/\S+|t\.me\/\S+|www\.\S+)/gi, '***').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return fail(res, 400, 'Write a message first.');
    const now = Date.now();
    if (now - (lastChat.get(key) || 0) < 3000) return fail(res, 429, 'Slow down a little.');
    lastChat.set(key, now);
    const msg = { id: ++chatSeq, name: maskName(a.user), avatar: Math.max(0, Math.min(11, parseInt(req.body && req.body.avatar, 10) || 0)), text, at: now };
    chat.push(msg); if (chat.length > 60) chat.shift();
    broadcast('chat', msg);
    res.json({ ok: true });
  });

  let topCache = { at: 0, rows: [] };
  app.get('/api/aviator/top', async (req, res) => {
    if (Date.now() - topCache.at > 60000) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await db.from('aviator_bets').select('username,amount,cashed_out_at,payout')
        .eq('status', 'cashed_out').gte('created_at', since).order('payout', { ascending: false }).limit(25);
      topCache = { at: Date.now(), rows: (data || []).map((b) => ({ name: b.username || 'P***', amount: Number(b.amount), mult: Number(b.cashed_out_at), payout: Number(b.payout) })) };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ rows: topCache.rows });
  });

  /* ---------------------------------------------------------------- */
  /* admin: earnings + per-bot Aviator settings                         */
  /* ---------------------------------------------------------------- */
  app.get('/api/admin/aviator/earnings', requireAdmin, async (req, res) => {
    const { data, error } = await db.rpc('admin_earnings');
    if (error) return fail(res, 500, error.message);
    res.json(data);
  });

  app.get('/api/admin/aviator/bots', requireAdmin, async (req, res) => {
    const { data, error } = await db.from('bots')
      .select('id,name,bot_type,aviator_enabled,aviator_min_bet,aviator_max_bet,aviator_reserve,deposit_phone,deposit_cbe_account,deposit_holder,admin_telegram_id').order('id');
    if (error) return fail(res, 500, error.message);
    const out = [];
    for (const b of (data || []).filter((x) => (x.bot_type || 'bingo') === 'bingo')) {
      const { data: profit } = await db.rpc('aviator_house_profit', { p_bot_id: b.id });
      out.push({ ...b, profit: Number(profit) || 0 });
    }
    res.json(out);
  });

  app.post('/api/admin/aviator/bots/:id', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('aviator_enabled' in b) patch.aviator_enabled = b.aviator_enabled !== false;
    for (const k of ['aviator_min_bet', 'aviator_max_bet', 'aviator_reserve']) {
      if (k in b) {
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < 0) return fail(res, 400, `Invalid ${k}.`);
        patch[k] = round2(n);
      }
    }
    if ('admin_telegram_id' in b) {
      const v = b.admin_telegram_id;
      if (v === '' || v === null) patch.admin_telegram_id = null;
      else {
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n <= 0) return fail(res, 400, 'The bot admin Telegram ID must be a number.');
        patch.admin_telegram_id = n;
      }
    }
    if ('deposit_holder' in b) patch.deposit_holder = String(b.deposit_holder || '').trim().slice(0, 40) || null;
    if ('deposit_cbe_account' in b) patch.deposit_cbe_account = String(b.deposit_cbe_account || '').replace(/\D/g, '') || null;
    if (patch.aviator_min_bet && patch.aviator_max_bet && patch.aviator_min_bet > patch.aviator_max_bet) return fail(res, 400, 'Min bet is above max bet.');
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change.');
    const { error } = await db.from('bots').update(patch).eq('id', Number(req.params.id));
    if (error) return fail(res, 500, error.message);
    // Registry rows are cached in memory: refresh the live copy.
    const entry = req.app.get('botRegistry') && req.app.get('botRegistry').get(Number(req.params.id));
    if (entry) Object.assign(entry.row, patch);
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- */
  /* start                                                             */
  /* ---------------------------------------------------------------- */
  (async () => {
    try {
      const { data: n, error } = await db.rpc('aviator_refund_stale');
      if (error) console.error('aviator: refund_stale failed (did you run migration_games.sql?):', error.message);
      else if (n) console.log(`aviator: refunded ${n} bets from an unfinished round`);
      const { data: last } = await db.from('aviator_rounds').select('crash_point').not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(40);
      recent = (last || []).map((x) => Number(x.crash_point));
    } catch (err) { console.error('aviator startup error:', err); }
    startBetting().catch(console.error);
  })();

  return { multiplierAt, seedToCrashPoint };
};
