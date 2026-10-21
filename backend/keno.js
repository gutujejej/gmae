// Fast Keno — one shared draw for every player of every bot.
// 20 numbers are drawn from 1..80. A ticket picks 1..10 numbers and wins by how many of them are drawn.
//
// Money: Keno is played with the Games wallet (bot_users.aviator_balance). The Aviator bonus and the
// registration bonus cannot be used here.
//
// Money safety: like Aviator, a draw is never allowed to pay out more than the platform can afford.
// After bets close, the server tries the draw for nonce 0, 1, 2... of the (already published) seed and uses
// the first draw whose total payouts stay within  stakes in this round + Keno profit so far + keno_reserve
// (per bot). A round that needed a later nonce is flagged `limited`; /verify shows the nonce used.
//
// Live updates use Server-Sent Events (/api/keno/stream). Run ONE backend instance (the round lives in memory).

const crypto = require('crypto');

const BETTING_MS = Number(process.env.KENO_BETTING_MS) || 40000;
const REVEAL_MS = 14000;     // the 20 balls appear one by one
const HOLD_MS = 6000;
const MAX_TICKETS = 5;       // per player per round
const MAX_NONCE = 200;

// Multiplier of the stake: PAYTABLE[numbers picked][numbers hit]. Return to player is about 90-92% for every pick count.
const PAYTABLE = {
  1: { 1: 3.6 },
  2: { 2: 15 },
  3: { 2: 1.8, 3: 48 },
  4: { 2: 1.3, 3: 6.7, 4: 110 },
  5: { 2: 0.6, 3: 3.8, 4: 18, 5: 340 },
  6: { 3: 3.1, 4: 8.1, 5: 61, 6: 715 },
  7: { 3: 1.9, 4: 4.6, 5: 22, 6: 145, 7: 1380 },
  8: { 4: 4.7, 5: 16, 6: 67, 7: 445, 8: 3885 },
  9: { 4: 3.3, 5: 7.8, 6: 29, 7: 130, 8: 1035, 9: 5180 },
  10: { 0: 2.5, 5: 6.4, 6: 20, 7: 86, 8: 615, 9: 3675, 10: 12255 },
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const multiplierFor = (picked, hits) => (PAYTABLE[picked] && PAYTABLE[picked][hits]) || 0;

// 20 different numbers from 1..80, in drawing order. Unbiased: bytes >= 240 are skipped (240 = 3 x 80).
function drawNumbers(seed, nonce) {
  const out = [], used = new Set(); let ctr = 0, buf = Buffer.alloc(0), pos = 0;
  while (out.length < 20) {
    if (pos >= buf.length) { buf = crypto.createHash('sha256').update(`${seed}:${nonce}:${ctr++}`).digest(); pos = 0; }
    const b = buf[pos++]; if (b >= 240) continue;
    const n = (b % 80) + 1;
    if (!used.has(n)) { used.add(n); out.push(n); }
  }
  return out;
}

const maskName = (u) => {
  const n = String((u && (u.username || u.first_name)) || 'Player').replace(/^@/, '');
  return n.slice(0, 1) + '***' + n.slice(-1);
};

module.exports = function attachKeno(app, db, { miniAuth }) {
  let round = null, recent = [], nextTimer = null, liveDirty = false;
  const clients = new Set();
  const fail = (res, code, msg) => res.status(code).json({ error: msg });

  /* ---------------------------- live stream ---------------------------- */
  const send = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* closed */ } };
  const broadcast = (event, data) => { for (const c of clients) send(c, event, data); };

  function liveSummary() {
    const all = round ? [...round.bets.values()] : [];
    return {
      count: all.length,
      tickets: all.sort((a, b) => b.stake - a.stake).slice(0, 60)   // biggest stakes first
        .map((b) => ({ name: b.name, picks: b.picks, stake: b.stake, status: b.status, hits: b.hits ?? null, payout: b.payout || 0 })),
    };
  }
  function snapshot() {
    const s = { now: Date.now(), phase: round ? round.phase : 'starting', results: recent.slice(0, 12), online: clients.size, ...liveSummary() };
    if (round) {
      s.round_id = round.id; s.server_seed_hash = round.hash; s.betting_ends_at = round.endsAt;
      if (round.numbers && (round.phase === 'drawing' || round.phase === 'ended')) {
        s.numbers = round.numbers; s.reveal_started_at = round.revealAt; s.reveal_ms = REVEAL_MS;
      }
    }
    return s;
  }
  app.get('/api/keno/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 2000\n\n');
    send(res, 'state', snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  app.get('/api/keno/state', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(snapshot()); });
  setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (_) { /* closed */ } } }, 15000).unref();
  setInterval(() => { if (liveDirty && clients.size) { liveDirty = false; broadcast('live', liveSummary()); } }, 1000).unref();

  /* ------------------------------ the round ------------------------------ */
  async function startBetting() {
    clearTimeout(nextTimer);
    const seed = crypto.randomBytes(32).toString('hex'), hash = sha256(seed);
    const id = `KNO-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const { error } = await db.from('keno_rounds').insert({ round_id: id, server_seed_hash: hash });
    if (error) { console.error('keno: could not start round:', error.message); nextTimer = setTimeout(() => startBetting().catch(console.error), 3000); return; }
    round = { id, seed, hash, phase: 'betting', endsAt: Date.now() + BETTING_MS, bets: new Map(), numbers: null, nonce: 0, limited: false, caps: new Map() };
    broadcast('betting', { round_id: id, server_seed_hash: hash, betting_ends_at: round.endsAt, now: Date.now(), results: recent.slice(0, 12) });
    nextTimer = setTimeout(() => lockAndDraw().catch((e) => console.error('keno draw error:', e)), BETTING_MS);
  }

  // what each bot's players may win in this round, and the most one ticket can pay
  async function capsFor(bets) {
    const caps = new Map();
    for (const b of bets) { const c = caps.get(b.botId) || { stakes: 0 }; c.stakes += b.stake; caps.set(b.botId, c); }
    await Promise.all([...caps.keys()].map(async (botId) => {
      const [{ data: profit }, { data: bot }] = await Promise.all([
        db.rpc('keno_house_profit', { p_bot_id: botId }),
        db.from('bots').select('keno_reserve,keno_max_payout').eq('id', botId).maybeSingle(),
      ]);
      const c = caps.get(botId);
      c.affordable = c.stakes + Math.max(0, Number(profit) || 0) + Math.max(0, Number(bot && bot.keno_reserve) || 0);
      c.maxPayout = Number(bot && bot.keno_max_payout) > 0 ? Number(bot.keno_max_payout) : 20000;
    }));
    return caps;
  }
  function payoutOf(bet, numbers, caps) {
    const set = new Set(numbers);
    const hits = bet.picks.filter((n) => set.has(n)).length;
    const mult = multiplierFor(bet.picks.length, hits);
    const cap = caps.get(bet.botId) ? caps.get(bet.botId).maxPayout : 20000;
    return { hits, mult, payout: Math.min(round2(bet.stake * mult), cap) };
  }

  async function lockAndDraw() {
    const r = round; if (!r || r.phase !== 'betting') return;
    r.phase = 'locking';
    const bets = [...r.bets.values()].filter((b) => b.status === 'placed');
    let pick = null;
    if (!bets.length) pick = { nonce: 0, numbers: drawNumbers(r.seed, 0) };
    else {
      try { r.caps = await capsFor(bets); } catch (e) { console.error('keno caps error:', e); r.caps = new Map(); }
      let best = null;
      for (let nonce = 0; nonce < MAX_NONCE; nonce++) {
        const numbers = drawNumbers(r.seed, nonce);
        const byBot = new Map(); let total = 0;
        for (const b of bets) { const { payout } = payoutOf(b, numbers, r.caps); byBot.set(b.botId, (byBot.get(b.botId) || 0) + payout); total += payout; }
        const ok = [...byBot].every(([bot, pay]) => r.caps.get(bot) && pay <= r.caps.get(bot).affordable);
        if (ok) { pick = { nonce, numbers }; break; }
        if (!best || total < best.total) best = { nonce, numbers, total };
      }
      if (!pick) { pick = best; console.error('keno: no affordable draw found, using the cheapest one'); }
    }
    r.nonce = pick.nonce; r.numbers = pick.numbers; r.limited = pick.nonce > 0;
    await db.from('keno_rounds').update({ drawn: r.numbers, nonce: r.nonce, limited: r.limited }).eq('round_id', r.id);
    r.phase = 'drawing'; r.revealAt = Date.now();
    broadcast('draw', { round_id: r.id, numbers: r.numbers, reveal_started_at: r.revealAt, reveal_ms: REVEAL_MS, now: Date.now() });
    nextTimer = setTimeout(() => settle().catch((e) => console.error('keno settle error:', e)), REVEAL_MS + 400);
  }

  async function settle() {
    const r = round; if (!r || r.phase !== 'drawing') return;
    const bets = [...r.bets.values()].filter((b) => b.status === 'placed');
    for (let i = 0; i < bets.length; i += 10) {
      await Promise.all(bets.slice(i, i + 10).map(async (b) => {
        const { hits, mult, payout } = payoutOf(b, r.numbers, r.caps);
        const { data, error } = await db.rpc('keno_settle_bet', { p_bet_id: b.id, p_hits: hits, p_mult: mult, p_payout: payout });
        if (error) { console.error('keno settle bet error:', error.message); return; }
        if (data && data.ok) { b.status = payout > 0 ? 'won' : 'lost'; b.hits = hits; b.mult = mult; b.payout = payout; }
      }));
    }
    await db.from('keno_rounds').update({ server_seed: r.seed, ended_at: new Date().toISOString() }).eq('round_id', r.id);
    recent.unshift({ round_id: r.id, numbers: r.numbers }); recent = recent.slice(0, 40);
    r.phase = 'ended';
    broadcast('result', { round_id: r.id, numbers: r.numbers, server_seed: r.seed, nonce: r.nonce, limited: r.limited, now: Date.now(), results: recent.slice(0, 12) });
    broadcast('live', liveSummary());
    nextTimer = setTimeout(() => startBetting().catch(console.error), HOLD_MS);
  }

  /* ------------------------------ player API ------------------------------ */
  const limitsOf = (row) => ({
    min: Number(row.keno_min_bet) > 0 ? Number(row.keno_min_bet) : 5,
    max: Number(row.keno_max_bet) > 0 ? Number(row.keno_max_bet) : 1000,
    maxPayout: Number(row.keno_max_payout) > 0 ? Number(row.keno_max_payout) : 20000,
  });
  const ticketView = (b) => ({ id: b.id, picks: b.picks, stake: b.stake, status: b.status, hits: b.hits ?? null, payout: b.payout || 0 });

  app.get('/api/mini/:botId/keno/me', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      const { data: u } = await db.from('bot_users').select('aviator_balance').eq('bot_id', row.id).eq('telegram_id', a.user.id).maybeSingle();
      const tickets = round ? [...round.bets.values()].filter((b) => b.botId === row.id && b.tg === a.user.id).map(ticketView) : [];
      res.set('Cache-Control', 'no-store');
      res.json({ name: maskName(a.user), balance: u ? Number(u.aviator_balance) : 0, enabled: row.keno_enabled !== false, ...limitsOf(row),
                 maxTickets: MAX_TICKETS, paytable: PAYTABLE, round_id: round ? round.id : null, tickets });
    } catch (e) { console.error('keno me error:', e); fail(res, 500, 'Could not load Keno.'); }
  });

  app.post('/api/mini/:botId/keno/bet', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const row = a.entry.row;
      if (row.keno_enabled === false) return fail(res, 403, 'Keno is switched off.');
      if (!round || round.phase !== 'betting' || Date.now() >= round.endsAt) return fail(res, 400, 'Betting is closed. Wait for the next draw.');
      const picks = [...new Set((Array.isArray(req.body && req.body.picks) ? req.body.picks : []).map(Number))];
      if (!picks.length || picks.length > 10 || picks.some((n) => !Number.isInteger(n) || n < 1 || n > 80)) return fail(res, 400, 'Choose 1 to 10 numbers between 1 and 80.');
      picks.sort((x, y) => x - y);
      const stake = round2(req.body && req.body.stake); const { min, max } = limitsOf(row);
      if (!(stake >= min) || stake > max) return fail(res, 400, `Bet between ${min} and ${max} ETB.`);
      const r = round;
      const { data, error } = await db.rpc('keno_place_bet', { p_bot_id: row.id, p_telegram_id: a.user.id, p_round_id: r.id, p_picks: picks, p_stake: stake, p_username: maskName(a.user), p_max_tickets: MAX_TICKETS });
      if (error) throw error;
      if (!data.ok) {
        const msgs = { insufficient: 'Not enough money in your Games wallet. Deposit first.', too_many: `You can play up to ${MAX_TICKETS} tickets per draw.`, no_account: 'Please send /start to the bot first.' };
        return fail(res, data.reason === 'insufficient' ? 402 : 400, msgs[data.reason] || 'Could not place the bet.');
      }
      if (round !== r || r.phase !== 'betting') {        // betting closed while the database was working
        await db.rpc('keno_cancel_bet', { p_bet_id: data.bet_id });
        return fail(res, 400, 'Betting just closed. Your money was not taken.');
      }
      r.bets.set(data.bet_id, { id: data.bet_id, botId: row.id, tg: a.user.id, name: maskName(a.user), picks, stake, status: 'placed' });
      liveDirty = true;
      res.json({ ok: true, balance: Number(data.balance), ticket: { id: data.bet_id, picks, stake, status: 'placed', hits: null, payout: 0 } });
    } catch (e) { console.error('keno bet error:', e); fail(res, 500, 'Could not place the bet. Please try again.'); }
  });

  app.post('/api/mini/:botId/keno/cancel', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const id = Number(req.body && req.body.id);
      if (!round || round.phase !== 'betting') return fail(res, 400, 'Tickets can only be cancelled while betting is open.');
      const bet = round.bets.get(id);
      if (!bet || bet.botId !== a.entry.row.id || bet.tg !== a.user.id || bet.status !== 'placed') return fail(res, 400, 'Ticket not found.');
      bet.status = 'settling';
      const { data, error } = await db.rpc('keno_cancel_bet', { p_bet_id: id });
      if (error || !data || !data.ok) { bet.status = 'placed'; return fail(res, 400, 'Could not cancel.'); }
      round.bets.delete(id); liveDirty = true;
      res.json({ ok: true, balance: Number(data.balance) });
    } catch (e) { console.error('keno cancel error:', e); fail(res, 500, 'Could not cancel. Please try again.'); }
  });

  app.get('/api/mini/:botId/keno/history', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data, error } = await db.from('keno_bets').select('id,round_id,picks,stake,hits,multiplier,payout,status,created_at')
      .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).neq('status', 'placed').order('created_at', { ascending: false }).limit(30);
    if (error) return fail(res, 500, 'Could not load history.');
    const ids = [...new Set((data || []).map((x) => x.round_id))];
    const { data: rounds } = ids.length ? await db.from('keno_rounds').select('round_id,drawn').in('round_id', ids) : { data: [] };
    const drawn = Object.fromEntries((rounds || []).map((x) => [x.round_id, x.drawn || []]));
    res.set('Cache-Control', 'no-store');
    res.json({ tickets: (data || []).map((t) => ({ id: t.id, picks: t.picks, stake: Number(t.stake), hits: t.hits, mult: t.multiplier ? Number(t.multiplier) : 0, payout: Number(t.payout), status: t.status, at: t.created_at, drawn: drawn[t.round_id] || [] })) });
  });

  // public: finished draws, number statistics, fairness check
  app.get('/api/keno/results', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ results: recent }); });
  let statCache = { at: 0, data: null };
  app.get('/api/keno/stats', async (req, res) => {
    if (!statCache.data || Date.now() - statCache.at > 60000) {
      const { data } = await db.from('keno_rounds').select('drawn').not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(100);
      const counts = Array(81).fill(0);
      for (const d of data || []) for (const n of d.drawn || []) counts[n]++;
      const order = Array.from({ length: 80 }, (_, i) => i + 1).sort((x, y) => counts[y] - counts[x] || x - y);
      statCache = { at: Date.now(), data: { draws: (data || []).length, counts: counts.slice(1), hot: order.slice(0, 8), cold: order.slice(-8).reverse() } };
    }
    res.set('Cache-Control', 'no-store'); res.json(statCache.data);
  });
  app.get('/api/keno/verify/:roundId', async (req, res) => {
    const { data: r } = await db.from('keno_rounds').select('*').eq('round_id', req.params.roundId).maybeSingle();
    if (!r || !r.server_seed) return fail(res, 404, 'Round not found or not finished yet.');
    res.json({ round_id: r.round_id, server_seed: r.server_seed, server_seed_hash: r.server_seed_hash, hash_matches: sha256(r.server_seed) === r.server_seed_hash,
               nonce: r.nonce, limited: !!r.limited, numbers: r.drawn, recomputed: drawNumbers(r.server_seed, r.nonce) });
  });

  /* -------------------------------- start -------------------------------- */
  (async () => {
    try {
      const { data: n, error } = await db.rpc('keno_refund_stale');
      if (error) console.error('keno: refund_stale failed (did you run migration_keno_sports.sql?):', error.message);
      else if (n) console.log(`keno: refunded ${n} tickets from an unfinished round`);
      const { data: last } = await db.from('keno_rounds').select('round_id,drawn').not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(40);
      recent = (last || []).map((x) => ({ round_id: x.round_id, numbers: x.drawn || [] }));
    } catch (e) { console.error('keno startup error:', e); }
    startBetting().catch(console.error);
  })();

  return { PAYTABLE, drawNumbers, multiplierFor };
};
