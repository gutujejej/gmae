// Mines + Coin Flip — server-authoritative, provably fair, played with the Games wallet.
//
// Money: stakes come from bot_users.aviator_balance (the Games wallet). The registration bonus is playable too:
// any shortfall is moved into the wallet just before the bet (bonus-cover.js), like Keno / Aviator / Sports.
//
// The browser never sees mine positions or future coin flips. A round lives in the ig_rounds table, so it survives
// a restart and the player can continue it. Starting, progressing and settling are done by SQL functions
// (sql/2026-12_mines_coinflip.sql) so money moves atomically and a round can be paid out only once.
//
// Provably fair: the hash of the NEXT server seed is shown before the player picks a client seed
// (GET .../me -> next_hash). The seed is revealed when the round ends. Every outcome is
// SHA-256(`${serverSeed}:${clientSeed}:${nonce}:${counter}`), the same recipe as the demo games.
//
// Run ONE backend instance (per-player locks are in memory, like the Keno round).

const crypto = require('crypto');
const { coverStake, regBonusOf } = require('./bonus-cover');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;
const sha256Buf = (s) => crypto.createHash('sha256').update(s).digest();
const sha256Hex = (s) => sha256Buf(s).toString('hex');

/* ------------------------------ Mines maths ------------------------------ */
const N = 25, EDGE = 0.97;                       // 5x5 board, 3 percent house edge
function minesMultiplier(k, m) {                 // after k gems with m mines: 0.97 * prod (N-i)/(N-m-i)
  if (k <= 0) return 1;
  let x = EDGE;
  for (let i = 0; i < k; i++) x *= (N - i) / (N - m - i);
  return x;
}
function minePositions(seed, client, nonce, m) { // Fisher-Yates with rejection sampling (same as the demo)
  let counter = 0, pool = Buffer.alloc(0), pos = 0;
  const nextByte = () => { if (pos >= pool.length) { pool = sha256Buf(`${seed}:${client}:${nonce}:${counter++}`); pos = 0; } return pool[pos++]; };
  const randInt = (n) => { const limit = Math.floor(256 / n) * n; for (;;) { const b = nextByte(); if (b < limit) return b % n; } };
  const arr = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = randInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, m).sort((a, b) => a - b);
}

/* ---------------------------- Coin Flip maths ---------------------------- */
const MAX_FLIPS = 10, STEP = 1.94;               // each correct call x1.94 (50% chance, 3 percent edge)
const flipMultiplier = (k) => (k <= 0 ? 1 : Math.pow(STEP, k));
function flipAt(seed, client, nonce, i) {        // the i-th flip: 0 = heads, 1 = tails
  const h = sha256Buf(`${seed}:${client}:${nonce}:${Math.floor(i / 8)}`), k = i % 8;
  const f = (h[k * 4] * 16777216 + (h[k * 4 + 1] << 16) + (h[k * 4 + 2] << 8) + h[k * 4 + 3]) / 4294967296;
  return f < 0.5 ? 0 : 1;
}

/* --------------------------------- module -------------------------------- */
const GAMES = {
  mines:    { min: 5, max: 1000, maxPayout: 20000 },
  coinflip: { min: 1, max: 500,  maxPayout: 20000 },
};

module.exports = function attachInstantGames(app, db, { miniAuth }) {
  const fail = (res, code, msg, extra) => res.status(code).json({ error: msg, ...(extra || {}) });

  const limitsOf = (row, game) => {
    const d = GAMES[game];
    const pos = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
    return { min: pos(row[`${game}_min_bet`], d.min), max: pos(row[`${game}_max_bet`], d.max), maxPayout: pos(row[`${game}_max_payout`], d.maxPayout) };
  };
  const enabledOf = (row, game) => row[`${game}_enabled`] !== false;
  const payoutFor = (stake, mult, cap) => Math.min(floor2(stake * mult), cap);

  // one request at a time per player+game (two taps at once can never race)
  const chains = new Map();
  function withLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  const cleanSeed = (s) => {
    const t = String(s == null ? '' : s).replace(/[^\w.\-]/g, '').slice(0, 32);
    return t || crypto.randomBytes(6).toString('hex');
  };

  async function ensureSeed(botId, tg, game) {
    let { data } = await db.from('ig_seeds').select('server_seed_hash').eq('bot_id', botId).eq('telegram_id', tg).eq('game', game).maybeSingle();
    if (data) return data.server_seed_hash;
    const seed = crypto.randomBytes(32).toString('hex'), hash = sha256Hex(seed);
    await db.from('ig_seeds').upsert({ bot_id: botId, telegram_id: tg, game, server_seed: seed, server_seed_hash: hash }, { onConflict: 'bot_id,telegram_id,game', ignoreDuplicates: true });
    ({ data } = await db.from('ig_seeds').select('server_seed_hash').eq('bot_id', botId).eq('telegram_id', tg).eq('game', game).maybeSingle());
    return data ? data.server_seed_hash : hash;
  }
  const activeRound = async (botId, tg, game) => {
    const { data, error } = await db.from('ig_rounds').select('*').eq('bot_id', botId).eq('telegram_id', tg).eq('game', game).eq('status', 'active').maybeSingle();
    if (error) throw error;
    return data;
  };
  async function wallet(botId, tg) {
    const { data } = await db.from('bot_users').select('aviator_balance,balance').eq('bot_id', botId).eq('telegram_id', tg).maybeSingle();
    return { balance: data ? Number(data.aviator_balance) || 0 : 0, reg_bonus: data ? Number(data.balance) || 0 : 0 };
  }

  // What the player may see of a running round: never the server seed, never the mines / future flips.
  const mineView = (r, cap) => {
    const opened = (r.progress && r.progress.opened) || [], mult = minesMultiplier(opened.length, r.params.mines);
    return { id: r.id, game: 'mines', stake: Number(r.stake), mines: r.params.mines, opened, multiplier: mult, payout: opened.length ? payoutFor(Number(r.stake), mult, cap) : 0,
             next_multiplier: minesMultiplier(opened.length + 1, r.params.mines), server_seed_hash: r.server_seed_hash, client_seed: r.client_seed, nonce: r.nonce };
  };
  const flipView = (r, cap) => {
    const flips = (r.progress && r.progress.flips) || [], k = flips.length;
    return { id: r.id, game: 'coinflip', stake: Number(r.stake), flips, k, multiplier: flipMultiplier(k), payout: k ? payoutFor(Number(r.stake), flipMultiplier(k), cap) : 0,
             next_multiplier: flipMultiplier(k + 1), max_flips: MAX_FLIPS, server_seed_hash: r.server_seed_hash, client_seed: r.client_seed, nonce: r.nonce };
  };
  const reveal = (r) => ({ server_seed: r.server_seed, server_seed_hash: r.server_seed_hash, client_seed: r.client_seed, nonce: r.nonce });

  async function history(botId, tg, game) {
    const { data } = await db.from('ig_rounds').select('id,stake,status,multiplier,payout,params,progress,server_seed,server_seed_hash,client_seed,nonce,created_at')
      .eq('bot_id', botId).eq('telegram_id', tg).eq('game', game).neq('status', 'active').order('id', { ascending: false }).limit(12);
    return (data || []).map((r) => ({ id: r.id, win: r.status === 'won', stake: Number(r.stake), mult: Number(r.multiplier), payout: Number(r.payout), at: r.created_at, params: r.params,
      ...(game === 'mines' ? { opened: (r.progress && r.progress.opened) || [], hit: r.progress && r.progress.hit != null ? r.progress.hit : null,
                               mine_tiles: minePositions(r.server_seed, r.client_seed, r.nonce, r.params.mines) }
                           : { flips: (r.progress && r.progress.flips) || [] }),
      ...reveal(r) }));
  }

  async function me(req, res, game) {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row, lim = limitsOf(row, game);
      const [w, act] = await Promise.all([wallet(row.id, a.user.id), activeRound(row.id, a.user.id, game)]);
      const out = { ...w, enabled: enabledOf(row, game), ...lim, round: act ? (game === 'mines' ? mineView(act, lim.maxPayout) : flipView(act, lim.maxPayout)) : null, history: await history(row.id, a.user.id, game) };
      if (!act) out.next_hash = await ensureSeed(row.id, a.user.id, game);
      if (game === 'mines') Object.assign(out, { tiles: N, edge: EDGE });
      else Object.assign(out, { max_flips: MAX_FLIPS, step: STEP });
      res.set('Cache-Control', 'no-store'); res.json(out);
    } catch (e) { console.error(`${game} me error:`, e); fail(res, 500, 'Could not load the game. Please try again.'); }
  }

  // takes the stake, locks the seed pair, creates the round row
  async function startRound(row, tg, game, stake, clientSeed, params) {
    const lim = limitsOf(row, game);
    if (!enabledOf(row, game)) return { err: [403, 'This game is switched off.'] };
    if (!(stake >= lim.min) || stake > lim.max) return { err: [400, `Bet between ${lim.min} and ${lim.max} ETB.`] };
    await coverStake(db, row.id, tg, stake);           // registration bonus is playable here too
    await ensureSeed(row.id, tg, game);
    const { data, error } = await db.rpc('ig_start', { p_bot_id: row.id, p_telegram_id: tg, p_game: game, p_stake: stake, p_client_seed: clientSeed, p_params: params });
    if (error) throw error;
    if (!data.ok) {
      const msgs = { insufficient: 'Not enough money in your Games wallet. Deposit first.', active: 'You already have a round in progress.', no_account: 'Please send /start to the bot first.', no_seed: 'Please try again.' };
      return { err: [data.reason === 'insufficient' ? 402 : data.reason === 'active' ? 409 : 400, msgs[data.reason] || 'Could not start the round.'] };
    }
    return { id: data.round_id, nonce: data.nonce, balance: Number(data.balance) };
  }

  async function settle(r, status, mult, payout, progress) {
    const { data, error } = await db.rpc('ig_settle', { p_round_id: r.id, p_status: status, p_multiplier: mult, p_payout: payout, p_progress: progress });
    if (error) throw error;
    if (!data.ok) return null;                          // already closed
    return { balance: Number(data.balance), payout: Number(data.payout) };
  }

  /* =============================== MINES =============================== */
  app.get('/api/mini/:botId/mines/me', (req, res) => me(req, res, 'mines'));

  app.post('/api/mini/:botId/mines/start', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, tg = a.user.id;
    const mines = Number(req.body && req.body.mines), stake = round2(req.body && req.body.stake);
    if (!Number.isInteger(mines) || mines < 1 || mines > 24) return fail(res, 400, 'Choose 1 to 24 mines.');
    try {
      await withLock(`${row.id}:${tg}:mines`, async () => {
        const client = cleanSeed(req.body && req.body.client_seed);
        const s = await startRound(row, tg, 'mines', stake, client, { mines });
        if (s.err) { const act = s.err[0] === 409 ? await activeRound(row.id, tg, 'mines') : null; return fail(res, s.err[0], s.err[1], act ? { round: mineView(act, limitsOf(row, 'mines').maxPayout) } : undefined); }
        const r = await activeRound(row.id, tg, 'mines');
        res.json({ ok: true, balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg), round: mineView(r, limitsOf(row, 'mines').maxPayout) });
      });
    } catch (e) { console.error('mines start error:', e); if (!res.headersSent) fail(res, 500, 'Could not start the round. Please try again.'); }
  });

  app.post('/api/mini/:botId/mines/pick', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, tg = a.user.id, tile = Number(req.body && req.body.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= N) return fail(res, 400, 'Pick a tile on the board.');
    try {
      await withLock(`${row.id}:${tg}:mines`, async () => {
        const r = await activeRound(row.id, tg, 'mines');
        if (!r) return fail(res, 400, 'No round in progress. Place a bet first.');
        const cap = limitsOf(row, 'mines').maxPayout, m = r.params.mines, stake = Number(r.stake);
        const opened = [...((r.progress && r.progress.opened) || [])];
        if (opened.includes(tile)) return fail(res, 400, 'That tile is already open.');
        const mineTiles = minePositions(r.server_seed, r.client_seed, r.nonce, m);
        if (mineTiles.includes(tile)) {
          const s = await settle(r, 'lost', 0, 0, { opened, hit: tile });
          if (!s) return fail(res, 409, 'This round is already finished.');
          return res.json({ ok: true, result: 'mine', tile, mine_tiles: mineTiles, opened, ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
        }
        opened.push(tile);
        const k = opened.length, mult = minesMultiplier(k, m), pay = payoutFor(stake, mult, cap);
        if (k === N - m || pay >= cap) {                 // every gem found, or the payout limit is reached: cash out automatically
          const s = await settle(r, 'won', mult, pay, { opened, auto: true });
          if (!s) return fail(res, 409, 'This round is already finished.');
          return res.json({ ok: true, result: 'win', auto: true, tile, opened, multiplier: mult, payout: s.payout, mine_tiles: mineTiles, ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
        }
        await db.rpc('ig_progress', { p_round_id: r.id, p_progress: { opened }, p_multiplier: mult });
        res.json({ ok: true, result: 'gem', tile, opened, multiplier: mult, payout: pay, next_multiplier: minesMultiplier(k + 1, m) });
      });
    } catch (e) { console.error('mines pick error:', e); if (!res.headersSent) fail(res, 500, 'Could not open the tile. Please try again.'); }
  });

  app.post('/api/mini/:botId/mines/cashout', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, tg = a.user.id;
    try {
      await withLock(`${row.id}:${tg}:mines`, async () => {
        const r = await activeRound(row.id, tg, 'mines');
        if (!r) return fail(res, 400, 'No round in progress.');
        const opened = (r.progress && r.progress.opened) || [];
        if (!opened.length) return fail(res, 400, 'Open at least one tile before cashing out.');
        const mult = minesMultiplier(opened.length, r.params.mines), pay = payoutFor(Number(r.stake), mult, limitsOf(row, 'mines').maxPayout);
        const s = await settle(r, 'won', mult, pay, { opened });
        if (!s) return fail(res, 409, 'This round is already finished.');
        res.json({ ok: true, result: 'win', opened, multiplier: mult, payout: s.payout, mine_tiles: minePositions(r.server_seed, r.client_seed, r.nonce, r.params.mines), ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
      });
    } catch (e) { console.error('mines cashout error:', e); if (!res.headersSent) fail(res, 500, 'Could not cash out. Please try again.'); }
  });

  /* ============================== COIN FLIP ============================== */
  app.get('/api/mini/:botId/coinflip/me', (req, res) => me(req, res, 'coinflip'));

  // One call = one flip. With no round running it also places the bet.
  app.post('/api/mini/:botId/coinflip/flip', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, tg = a.user.id, call = Number(req.body && req.body.call);
    if (call !== 0 && call !== 1) return fail(res, 400, 'Choose heads or tails.');
    try {
      await withLock(`${row.id}:${tg}:coinflip`, async () => {
        const cap = limitsOf(row, 'coinflip').maxPayout;
        let r = await activeRound(row.id, tg, 'coinflip'), startBalance = null;
        if (!r) {
          const s = await startRound(row, tg, 'coinflip', round2(req.body && req.body.stake), cleanSeed(req.body && req.body.client_seed), { max: MAX_FLIPS });
          if (s.err) return fail(res, s.err[0], s.err[1]);
          startBalance = s.balance; r = await activeRound(row.id, tg, 'coinflip');
        }
        const flips = [...((r.progress && r.progress.flips) || [])], i = flips.length, stake = Number(r.stake);
        const flip = flipAt(r.server_seed, r.client_seed, r.nonce, i), win = flip === call;
        if (!win) {
          const s = await settle(r, 'lost', 0, 0, { flips: [...flips, flip], called: call, lost_at: i });
          if (!s) return fail(res, 409, 'This round is already finished.');
          return res.json({ ok: true, flip, win: false, ended: true, result: 'lose', flips: [...flips, flip], k: i, ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
        }
        flips.push(flip);
        const k = flips.length, mult = flipMultiplier(k), pay = payoutFor(stake, mult, cap);
        if (k >= MAX_FLIPS || pay >= cap) {              // streak finished or payout limit reached: cash out automatically
          const s = await settle(r, 'won', mult, pay, { flips, auto: true });
          if (!s) return fail(res, 409, 'This round is already finished.');
          return res.json({ ok: true, flip, win: true, ended: true, result: 'win', auto: true, flips, k, multiplier: mult, payout: s.payout, ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
        }
        await db.rpc('ig_progress', { p_round_id: r.id, p_progress: { flips }, p_multiplier: mult });
        res.json({ ok: true, flip, win: true, ended: false, flips, k, multiplier: mult, payout: pay, next_multiplier: flipMultiplier(k + 1),
                   ...(startBalance != null ? { balance: startBalance, reg_bonus: await regBonusOf(db, row.id, tg), server_seed_hash: r.server_seed_hash, client_seed: r.client_seed, nonce: r.nonce } : {}) });
      });
    } catch (e) { console.error('coinflip flip error:', e); if (!res.headersSent) fail(res, 500, 'Could not flip the coin. Please try again.'); }
  });

  app.post('/api/mini/:botId/coinflip/cashout', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, tg = a.user.id;
    try {
      await withLock(`${row.id}:${tg}:coinflip`, async () => {
        const r = await activeRound(row.id, tg, 'coinflip');
        if (!r) return fail(res, 400, 'No round in progress.');
        const flips = (r.progress && r.progress.flips) || [];
        if (!flips.length) return fail(res, 400, 'Win a flip before cashing out.');
        const k = flips.length, mult = flipMultiplier(k), pay = payoutFor(Number(r.stake), mult, limitsOf(row, 'coinflip').maxPayout);
        const s = await settle(r, 'won', mult, pay, { flips });
        if (!s) return fail(res, 409, 'This round is already finished.');
        res.json({ ok: true, result: 'win', flips, k, multiplier: mult, payout: s.payout, ...reveal(r), balance: s.balance, reg_bonus: await regBonusOf(db, row.id, tg) });
      });
    } catch (e) { console.error('coinflip cashout error:', e); if (!res.headersSent) fail(res, 500, 'Could not cash out. Please try again.'); }
  });

  /* ------------------------ public fairness check ------------------------ */
  // Only finished rounds: their seed has already been revealed to the player.
  app.get('/api/instant/verify/:roundId', async (req, res) => {
    const id = Number(req.params.roundId);
    if (!Number.isInteger(id)) return fail(res, 400, 'Bad round id.');
    const { data: r } = await db.from('ig_rounds').select('*').eq('id', id).neq('status', 'active').maybeSingle();
    if (!r) return fail(res, 404, 'Round not found or not finished yet.');
    const out = { round_id: r.id, game: r.game, server_seed: r.server_seed, server_seed_hash: r.server_seed_hash, hash_matches: sha256Hex(r.server_seed) === r.server_seed_hash, client_seed: r.client_seed, nonce: r.nonce };
    if (r.game === 'mines') Object.assign(out, { mines: r.params.mines, mine_tiles: minePositions(r.server_seed, r.client_seed, r.nonce, r.params.mines) });
    else Object.assign(out, { flips: Array.from({ length: MAX_FLIPS }, (_, i) => flipAt(r.server_seed, r.client_seed, r.nonce, i)) });
    res.json(out);
  });

  return { minesMultiplier, minePositions, flipAt, flipMultiplier, GAMES };
};
