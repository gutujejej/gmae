// Sports betting (soccer): 1 / X / 2 and double chance 1X / 12 / X2, single and multi (accumulator) tickets.
//
// Money: played with the Games wallet (bot_users.aviator_balance). The Aviator bonus and the registration bonus
// cannot be used here.
//
// Matches come from two places, per bot:
//   * the bot's admin adds them by hand (league, teams, kick-off, odds), or
//   * automatically from the internet (The Odds API, https://the-odds-api.com) when ODDS_API_KEY is set and the
//     admin turned on "auto import" and picked leagues. Odds are averaged over bookmakers, the admin's margin is
//     taken off, and double-chance odds are worked out from the 1X2 odds. Finished games are settled
//     automatically from the same service; the admin can always enter or correct a result by hand.
//
//   ODDS_API_KEY            your key from the-odds-api.com
//   SPORTS_ODDS_SYNC_MIN    how often to fetch new odds (default 360 = every 6 hours; every fetch uses credits)
//   SPORTS_SCORES_SYNC_MIN  how often to look for finished games (default 60)

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const MARKETS = ['1', 'X', '2', '1X', '12', 'X2'];
const COL = { '1': 'odds_1', X: 'odds_x', '2': 'odds_2', '1X': 'odds_1x', '12': 'odds_12', X2: 'odds_x2' };
const MAX_LEGS = 20;
const NO_BET_BEFORE_MS = 60 * 1000;   // betting closes one minute before kick-off

// League keys are The Odds API sport keys. A key the service does not know is simply skipped.
const LEAGUES = [
  { key: 'soccer_epl', country: 'England', name: 'Premier League', hot: true },
  { key: 'soccer_spain_la_liga', country: 'Spain', name: 'La Liga', hot: true },
  { key: 'soccer_italy_serie_a', country: 'Italy', name: 'Serie A', hot: true },
  { key: 'soccer_germany_bundesliga', country: 'Germany', name: 'Bundesliga', hot: true },
  { key: 'soccer_france_ligue_one', country: 'France', name: 'Ligue 1', hot: false },
  { key: 'soccer_uefa_champs_league', country: 'Europe', name: 'Champions League', hot: true },
  { key: 'soccer_uefa_europa_league', country: 'Europe', name: 'Europa League', hot: true },
  { key: 'soccer_netherlands_eredivisie', country: 'Netherlands', name: 'Eredivisie', hot: false },
  { key: 'soccer_switzerland_superleague', country: 'Switzerland', name: 'Super League', hot: false },
  { key: 'soccer_sweden_superettan', country: 'Sweden', name: 'Superettan', hot: false },
  { key: 'soccer_efl_champ', country: 'England', name: 'Championship', hot: false },
  { key: 'soccer_portugal_primeira_liga', country: 'Portugal', name: 'Primeira Liga', hot: false },
  { key: 'soccer_turkey_super_league', country: 'Turkey', name: 'Super Lig', hot: false },
  { key: 'soccer_belgium_first_div', country: 'Belgium', name: 'Pro League', hot: false },
  { key: 'soccer_scotland_premiership', country: 'Scotland', name: 'Premiership', hot: false },
];
const leagueMeta = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));

/* ---------------------------- pure helpers ---------------------------- */
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clampOdds = (o) => Math.max(1.01, round2(o));
const applyMargin = (o, pct) => clampOdds(Number(o) * (1 - Math.max(0, Number(pct) || 0) / 100));

// 1X2 -> all six markets. Double chance = 1 / (1/a + 1/b), worked out from the odds that will actually be offered.
function marketsFrom(o1, ox, o2) {
  const dc = (a, b) => clampOdds(1 / (1 / a + 1 / b));
  return { odds_1: clampOdds(o1), odds_x: clampOdds(ox), odds_2: clampOdds(o2), odds_1x: dc(o1, ox), odds_12: dc(o1, o2), odds_x2: dc(ox, o2) };
}
function legWins(market, h, a) {
  switch (market) {
    case '1': return h > a;
    case 'X': return h === a;
    case '2': return h < a;
    case '1X': return h >= a;
    case '12': return h !== a;
    case 'X2': return h <= a;
    default: return false;
  }
}
// Is the ticket decided? One lost leg loses it at once; otherwise it waits for every leg. Void legs count as odds 1.
function evaluateBet(legs, stake, maxPayout) {
  if (legs.some((l) => l.status === 'lost')) return { final: true, status: 'lost', payout: 0 };
  if (legs.some((l) => l.status === 'open')) return { final: false };
  const won = legs.filter((l) => l.status === 'won');
  if (!won.length) return { final: true, status: 'void', payout: round2(stake) };      // every match void: stake back
  const odds = won.reduce((p, l) => p * Number(l.odds), 1);
  return { final: true, status: 'won', payout: Math.min(round2(stake * odds), maxPayout) };
}
// One game from The Odds API -> average 1/X/2 over all bookmakers.
function normalizeEvent(ev) {
  const sums = { home: [], draw: [], away: [] };
  for (const bk of ev.bookmakers || []) {
    const m = (bk.markets || []).find((x) => x.key === 'h2h'); if (!m) continue;
    for (const o of m.outcomes || []) {
      if (o.name === ev.home_team) sums.home.push(Number(o.price));
      else if (o.name === ev.away_team) sums.away.push(Number(o.price));
      else if (String(o.name).toLowerCase() === 'draw') sums.draw.push(Number(o.price));
    }
  }
  if (!sums.home.length || !sums.draw.length || !sums.away.length) return null;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { ext_id: ev.id, home: ev.home_team, away: ev.away_team, kickoff: ev.commence_time, o1: avg(sums.home), ox: avg(sums.draw), o2: avg(sums.away) };
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

module.exports = function attachSports(app, db, { miniAuth }) {
  const ODDS_KEY = process.env.ODDS_API_KEY || '';
  const ODDS_EVERY = (Number(process.env.SPORTS_ODDS_SYNC_MIN) || 360) * 60000;
  const SCORES_EVERY = (Number(process.env.SPORTS_SCORES_SYNC_MIN) || 60) * 60000;
  const state = { lastOdds: 0, lastScores: 0, remaining: null, lastResult: null };

  const wrap = (fn) => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); await fn(req, res); }
    catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('sports error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
  const adminRoute = (method, path, handler) => {
    app[method](`/api/mini/:botId/gadmin/sports${path}`, wrap(async (req, res) => {
      const a = miniAuth(req, res); if (!a) return;
      const isAdmin = app.get('isGameAdmin');
      if (!isAdmin || !(await isAdmin(a.entry.row, a.user.id))) throw new HttpError(403, 'You are not an admin of this bot.');
      req.g = { entry: a.entry, row: a.entry.row, botId: a.entry.row.id, userId: a.user.id };
      await handler(req, res);
    }));
  };
  const notify = (botId, tg, text) => {
    const reg = app.get('botRegistry'); const entry = reg && reg.get(botId);
    if (entry) entry.bot.sendMessage(tg, text).catch(() => {});
  };
  const chunk = (arr, n = 150) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  /* ------------------------------ settlement ------------------------------ */
  async function settleBets(botId, betIds) {
    if (!betIds.length) return 0;
    const { data: bot } = await db.from('bots').select('sports_max_payout').eq('id', botId).maybeSingle();
    const maxPayout = Number(bot && bot.sports_max_payout) > 0 ? Number(bot.sports_max_payout) : 50000;
    let done = 0;
    for (const betId of betIds) {
      const { data: bet } = await db.from('sports_bets').select('id,stake,status').eq('id', betId).eq('status', 'open').maybeSingle();
      if (!bet) continue;
      const { data: legs } = await db.from('sports_bet_legs').select('status,odds').eq('bet_id', betId);
      const ev = evaluateBet(legs || [], Number(bet.stake), maxPayout);
      if (!ev.final) continue;
      const { data, error } = await db.rpc('sports_settle_bet', { p_bet_id: betId, p_status: ev.status, p_payout: ev.payout });
      if (error || !data || !data.ok) { if (error) console.error('sports settle error:', error.message); continue; }
      done++;
      if (ev.status === 'won') notify(botId, Number(data.telegram_id), `🏆 Your sports ticket won! ${round2(ev.payout)} ETB was added to your Games wallet.`);
      else if (ev.status === 'void') notify(botId, Number(data.telegram_id), `↩️ A sports ticket was cancelled. ${round2(ev.payout)} ETB was returned to your Games wallet.`);
    }
    return done;
  }
  async function resolveEvent(ev, mode, h, a) {
    const now = new Date().toISOString();
    const patch = mode === 'void' ? { status: 'cancelled', updated_at: now } : { status: 'finished', result_home: h, result_away: a, updated_at: now };
    const { error } = await db.from('sports_events').update(patch).eq('id', ev.id);
    if (error) throw error;
    const { data: legs } = await db.from('sports_bet_legs').select('id,bet_id,market').eq('event_id', ev.id).eq('status', 'open');
    const groups = { won: [], lost: [], void: [] }; const betIds = new Set();
    for (const l of legs || []) {
      const st = mode === 'void' ? 'void' : (legWins(l.market, h, a) ? 'won' : 'lost');
      groups[st].push(l.id); betIds.add(l.bet_id);
    }
    for (const st of ['won', 'lost', 'void']) for (const ids of chunk(groups[st])) await db.from('sports_bet_legs').update({ status: st }).in('id', ids);
    const tickets = await settleBets(ev.bot_id, [...betIds]);
    return { legs: (legs || []).length, tickets };
  }

  /* ----------------------- odds from the internet ----------------------- */
  async function oddsGet(path) {
    if (!ODDS_KEY) return null;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`${ODDS_BASE}${path}${path.includes('?') ? '&' : '?'}apiKey=${ODDS_KEY}`, { signal: ctl.signal });
      const rem = r.headers.get('x-requests-remaining'); if (rem != null) state.remaining = Number(rem);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; } finally { clearTimeout(t); }
  }
  async function fetchLeague(key) {
    const data = await oddsGet(`/sports/${key}/odds/?regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`);
    return Array.isArray(data) ? data.map(normalizeEvent).filter(Boolean) : [];
  }
  async function importForBot(row, cache = new Map()) {
    const leagues = (row.sports_leagues || []).filter((k) => leagueMeta[k]);
    const margin = Number(row.sports_margin_pct) >= 0 ? Number(row.sports_margin_pct) : 5;
    let created = 0, updated = 0, skipped = 0;
    for (const key of leagues) {
      if (!cache.has(key)) cache.set(key, await fetchLeague(key));
      const meta = leagueMeta[key];
      for (const ev of cache.get(key)) {
        if (new Date(ev.kickoff).getTime() < Date.now() + 5 * 60000) { skipped++; continue; }
        const m = marketsFrom(applyMargin(ev.o1, margin), applyMargin(ev.ox, margin), applyMargin(ev.o2, margin));
        const { data: ex } = await db.from('sports_events').select('id,status,odds_locked').eq('bot_id', row.id).eq('ext_id', ev.ext_id).maybeSingle();
        if (!ex) {
          const { error } = await db.from('sports_events').insert({
            bot_id: row.id, ext_id: ev.ext_id, league_key: key, league_name: `${meta.name}`, country: meta.country, home: ev.home, away: ev.away,
            kickoff: ev.kickoff, ...m, top: !!meta.hot, source: 'auto' });
          if (error) console.error('sports import insert error:', error.message); else created++;
        } else if (ex.status === 'open' && !ex.odds_locked) {
          await db.from('sports_events').update({ kickoff: ev.kickoff, ...m, updated_at: new Date().toISOString() }).eq('id', ex.id); updated++;
        } else skipped++;
      }
    }
    return { created, updated, skipped };
  }
  async function syncOdds() {
    if (!ODDS_KEY) return;
    const { data: bots } = await db.from('bots').select('id,sports_leagues,sports_margin_pct').eq('sports_auto_import', true).eq('sports_enabled', true);
    const cache = new Map(); const total = { created: 0, updated: 0 };
    for (const b of bots || []) { const r = await importForBot(b, cache); total.created += r.created; total.updated += r.updated; }
    state.lastOdds = Date.now(); state.lastResult = total;
  }
  async function syncScores() {
    if (!ODDS_KEY) return;
    const cutoff = new Date(Date.now() - 110 * 60000).toISOString();
    const { data: pending } = await db.from('sports_events').select('id,bot_id,ext_id,league_key,home,away,kickoff')
      .eq('source', 'auto').in('status', ['open', 'suspended']).lt('kickoff', cutoff).limit(500);
    const byLeague = new Map();
    for (const e of pending || []) { if (!byLeague.has(e.league_key)) byLeague.set(e.league_key, []); byLeague.get(e.league_key).push(e); }
    for (const [key, list] of byLeague) {
      const scores = await oddsGet(`/sports/${key}/scores/?daysFrom=3&dateFormat=iso`);
      if (!Array.isArray(scores)) continue;
      const byId = new Map(scores.filter((s) => s.completed && Array.isArray(s.scores)).map((s) => [s.id, s]));
      for (const e of list) {
        const s = byId.get(e.ext_id); if (!s) continue;
        const h = s.scores.find((x) => x.name === s.home_team), a = s.scores.find((x) => x.name === s.away_team);
        const hn = h ? parseInt(h.score, 10) : NaN, an = a ? parseInt(a.score, 10) : NaN;
        if (Number.isInteger(hn) && Number.isInteger(an)) { try { await resolveEvent(e, 'result', hn, an); } catch (err) { console.error('sports auto-settle error:', err); } }
      }
    }
    state.lastScores = Date.now();
  }
  if (ODDS_KEY) {
    setTimeout(() => { syncOdds().then(syncScores).catch((e) => console.error('sports first sync error:', e)); }, 20000).unref();
    setInterval(() => {
      if (Date.now() - state.lastOdds >= ODDS_EVERY) syncOdds().catch((e) => console.error('sports odds sync error:', e));
      if (Date.now() - state.lastScores >= SCORES_EVERY) syncScores().catch((e) => console.error('sports scores sync error:', e));
    }, 5 * 60000).unref();
  }

  /* ------------------------------ player API ------------------------------ */
  const limitsOf = (row) => ({
    enabled: row.sports_enabled !== false,
    min: Number(row.sports_min_stake) > 0 ? Number(row.sports_min_stake) : 10,
    max: Number(row.sports_max_stake) > 0 ? Number(row.sports_max_stake) : 5000,
    maxPayout: Number(row.sports_max_payout) > 0 ? Number(row.sports_max_payout) : 50000,
  });
  const eventView = (e) => ({
    id: e.id, league_key: e.league_key, league: e.league_name, country: e.country, home: e.home, away: e.away, kickoff: e.kickoff, top: !!e.top,
    odds: { '1': Number(e.odds_1), X: Number(e.odds_x), '2': Number(e.odds_2), '1X': Number(e.odds_1x), '12': Number(e.odds_12), X2: Number(e.odds_x2) },
  });

  app.get('/api/mini/:botId/sports/info', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data: u } = await db.from('bot_users').select('aviator_balance').eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).maybeSingle();
    res.json({ name: a.entry.row.name, balance: u ? Number(u.aviator_balance) : 0, maxLegs: MAX_LEGS, ...limitsOf(a.entry.row) });
  }));

  // Upcoming games. Filters: from / to (ISO), top=1 (Hot tab), league (key), q (search).
  app.get('/api/mini/:botId/sports/events', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const now = Date.now();
    const { data, error } = await db.from('sports_events').select('*').eq('bot_id', a.entry.row.id).eq('status', 'open')
      .gt('kickoff', new Date(now + NO_BET_BEFORE_MS).toISOString()).lt('kickoff', new Date(now + 14 * 86400000).toISOString())
      .order('kickoff', { ascending: true }).limit(500);
    if (error) throw error;
    let list = data || [];
    const q = String(req.query.q || '').trim().toLowerCase();
    if (req.query.from) list = list.filter((e) => new Date(e.kickoff) >= new Date(req.query.from));
    if (req.query.to) list = list.filter((e) => new Date(e.kickoff) < new Date(req.query.to));
    if (req.query.top === '1') list = list.filter((e) => e.top);
    if (q) list = list.filter((e) => `${e.home} ${e.away} ${e.league_name}`.toLowerCase().includes(q));
    const leagues = []; const seen = new Map();
    for (const e of list) {
      const k = e.league_key || e.league_name;
      if (!seen.has(k)) { seen.set(k, { key: k, name: e.league_name, country: e.country, count: 0 }); leagues.push(seen.get(k)); }
      seen.get(k).count++;
    }
    if (req.query.league) list = list.filter((e) => (e.league_key || e.league_name) === req.query.league);
    res.json({ events: list.slice(0, 300).map(eventView), leagues });
  }));

  app.post('/api/mini/:botId/sports/bet', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const row = a.entry.row, lim = limitsOf(row), body = req.body || {};
    if (!lim.enabled) throw new HttpError(403, 'Sports betting is switched off.');
    const kind = body.kind === 'multi' ? 'multi' : 'single';
    const stake = round2(body.stake);
    if (!(stake >= lim.min) || stake > lim.max) throw new HttpError(400, `Stake between ${lim.min} and ${lim.max} ETB.`);
    const legsIn = Array.isArray(body.legs) ? body.legs : [];
    if (!legsIn.length || legsIn.length > MAX_LEGS) throw new HttpError(400, `Choose 1 to ${MAX_LEGS} matches.`);
    if (kind === 'multi' && legsIn.length < 2) throw new HttpError(400, 'A multi bet needs at least 2 matches.');
    const ids = legsIn.map((l) => Number(l.event_id));
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Only one pick per match.');
    const { data: events, error } = await db.from('sports_events').select('*').eq('bot_id', row.id).in('id', ids);
    if (error) throw error;
    const byId = new Map((events || []).map((e) => [Number(e.id), e]));
    const legs = [];
    for (const l of legsIn) {
      const ev = byId.get(Number(l.event_id)); const market = String(l.market);
      if (!ev || ev.status !== 'open' || new Date(ev.kickoff).getTime() < Date.now() + NO_BET_BEFORE_MS) {
        const e = new HttpError(409, `${ev ? `${ev.home} v ${ev.away}` : 'A match'} is no longer open for betting.`); e.code = 'closed'; throw e;
      }
      if (!MARKETS.includes(market)) throw new HttpError(400, 'Invalid pick.');
      const odds = Number(ev[COL[market]]);
      if (Math.abs(odds - Number(l.odds)) > 0.004) { const e = new HttpError(409, 'Odds changed. Check your slip and try again.'); e.code = 'odds_changed'; throw e; }
      legs.push({ event_id: ev.id, market, odds });
    }
    const bets = kind === 'multi'
      ? (() => { const total = legs.reduce((p, l) => p * l.odds, 1); return [{ kind, stake, total_odds: round2(total), potential: Math.min(round2(stake * total), lim.maxPayout), legs }]; })()
      : legs.map((l) => ({ kind, stake, total_odds: l.odds, potential: Math.min(round2(stake * l.odds), lim.maxPayout), legs: [l] }));
    const { data, error: rpcErr } = await db.rpc('sports_place_bets', { p_bot_id: row.id, p_telegram_id: a.user.id, p_bets: bets });
    if (rpcErr) throw rpcErr;
    if (!data.ok) {
      const msgs = { insufficient: 'Not enough money in your Games wallet. Deposit first.', no_account: 'Please send /start to the bot first.' };
      throw new HttpError(data.reason === 'insufficient' ? 402 : 400, msgs[data.reason] || 'Could not place the bet.');
    }
    res.json({ ok: true, balance: Number(data.balance), tickets: bets.length, total_stake: round2(stake * bets.length) });
  }));

  app.get('/api/mini/:botId/sports/my-bets', wrap(async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    const { data: bets, error } = await db.from('sports_bets').select('id,kind,stake,total_odds,potential,status,payout,created_at')
      .eq('bot_id', a.entry.row.id).eq('telegram_id', a.user.id).order('created_at', { ascending: false }).limit(40);
    if (error) throw error;
    const ids = (bets || []).map((b) => b.id);
    const { data: legs } = ids.length ? await db.from('sports_bet_legs').select('bet_id,event_id,market,odds,status').in('bet_id', ids) : { data: [] };
    const evIds = [...new Set((legs || []).map((l) => l.event_id))];
    const { data: evs } = evIds.length ? await db.from('sports_events').select('id,home,away,kickoff,result_home,result_away').in('id', evIds) : { data: [] };
    const evMap = new Map((evs || []).map((e) => [e.id, e]));
    res.json({ bets: (bets || []).map((b) => ({
      id: b.id, kind: b.kind, stake: Number(b.stake), total_odds: Number(b.total_odds), potential: Number(b.potential), status: b.status, payout: Number(b.payout), at: b.created_at,
      legs: (legs || []).filter((l) => l.bet_id === b.id).map((l) => { const e = evMap.get(l.event_id) || {}; return { market: l.market, odds: Number(l.odds), status: l.status, home: e.home, away: e.away, kickoff: e.kickoff, rh: e.result_home, ra: e.result_away }; }),
    })) });
  }));

  /* ------------------------------ admin API ------------------------------ */
  adminRoute('get', '/events', async (req, res) => {
    const f = req.query.filter || 'upcoming', now = new Date().toISOString();
    let q = db.from('sports_events').select('*').eq('bot_id', req.g.botId);
    if (f === 'finished') q = q.in('status', ['finished', 'cancelled']).order('kickoff', { ascending: false });
    else if (f === 'result') q = q.in('status', ['open', 'suspended']).lte('kickoff', now).order('kickoff', { ascending: true });
    else q = q.in('status', ['open', 'suspended']).gt('kickoff', now).order('kickoff', { ascending: true });
    const { data, error } = await q.limit(200);
    if (error) throw error;
    const ids = (data || []).map((e) => e.id);
    const { data: legs } = ids.length ? await db.from('sports_bet_legs').select('event_id').in('event_id', ids).eq('status', 'open') : { data: [] };
    const open = {}; for (const l of legs || []) open[l.event_id] = (open[l.event_id] || 0) + 1;
    res.json({ events: (data || []).map((e) => ({ ...eventView(e), status: e.status, source: e.source, locked: e.odds_locked, result_home: e.result_home, result_away: e.result_away, open_bets: open[e.id] || 0 })) });
  });

  const readEvent = (b, partial) => {
    const out = {};
    const text = (k, max) => { if (k in b) { const v = String(b[k] || '').replace(/\s+/g, ' ').trim().slice(0, max); if (!v) throw new HttpError(400, `Enter the ${k.replace('_', ' ')}.`); out[k] = v; } else if (!partial) throw new HttpError(400, `Enter the ${k.replace('_', ' ')}.`); };
    text('league_name', 60); text('home', 60); text('away', 60);
    if (out.home && out.away && out.home.toLowerCase() === out.away.toLowerCase()) throw new HttpError(400, 'Home and away must be different teams.');
    if ('kickoff' in b || !partial) {
      const t = new Date(b.kickoff); if (Number.isNaN(t.getTime())) throw new HttpError(400, 'Enter a valid kick-off date and time.');
      out.kickoff = t.toISOString();
    }
    if ('odds_1' in b || 'odds_x' in b || 'odds_2' in b || !partial) {
      const o = [b.odds_1, b.odds_x, b.odds_2].map(Number);
      if (o.some((x) => !Number.isFinite(x) || x < 1.01 || x > 1000)) throw new HttpError(400, 'Odds must be between 1.01 and 1000.');
      Object.assign(out, marketsFrom(o[0], o[1], o[2]));
    }
    if ('top' in b) out.top = !!b.top;
    return out;
  };
  adminRoute('post', '/events', async (req, res) => {
    const d = readEvent(req.body || {}, false);
    if (new Date(d.kickoff).getTime() < Date.now() + NO_BET_BEFORE_MS) throw new HttpError(400, 'The kick-off time must be in the future.');
    const meta = leagueMeta[req.body.league_key];
    const { data, error } = await db.from('sports_events').insert({ ...d, bot_id: req.g.botId, source: 'manual', odds_locked: true, league_key: meta ? meta.key : null, country: meta ? meta.country : (String(req.body.country || '').slice(0, 40) || null) }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  });
  adminRoute('put', '/events/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { data: ev } = await db.from('sports_events').select('id,status').eq('id', id).eq('bot_id', req.g.botId).maybeSingle();
    if (!ev) throw new HttpError(404, 'Match not found.');
    if (!['open', 'suspended'].includes(ev.status)) throw new HttpError(409, 'This match is finished.');
    const b = req.body || {}; const d = readEvent(b, true);
    if ('status' in b) { if (!['open', 'suspended'].includes(b.status)) throw new HttpError(400, 'Invalid status.'); d.status = b.status; }
    if ('odds_1' in d) d.odds_locked = true;
    if (!Object.keys(d).length) throw new HttpError(400, 'Nothing to change.');
    const { error } = await db.from('sports_events').update({ ...d, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  });
  adminRoute('delete', '/events/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { count } = await db.from('sports_bet_legs').select('id', { count: 'exact', head: true }).eq('event_id', id);
    if (count) throw new HttpError(409, 'Players already bet on this match. Cancel it instead of deleting it.');
    const { error } = await db.from('sports_events').delete().eq('id', id).eq('bot_id', req.g.botId);
    if (error) throw error;
    res.json({ ok: true });
  });
  const loadOpenEvent = async (req) => {
    const { data: ev } = await db.from('sports_events').select('*').eq('id', Number(req.params.id)).eq('bot_id', req.g.botId).maybeSingle();
    if (!ev) throw new HttpError(404, 'Match not found.');
    if (!['open', 'suspended'].includes(ev.status)) throw new HttpError(409, 'This match is already finished.');
    return ev;
  };
  adminRoute('post', '/events/:id/result', async (req, res) => {
    const ev = await loadOpenEvent(req);
    const h = Number(req.body && req.body.home), a = Number(req.body && req.body.away);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 99 || a > 99) throw new HttpError(400, 'Enter both scores (whole numbers).');
    res.json({ ok: true, ...(await resolveEvent(ev, 'result', h, a)) });
  });
  adminRoute('post', '/events/:id/void', async (req, res) => {
    const ev = await loadOpenEvent(req);
    res.json({ ok: true, ...(await resolveEvent(ev, 'void')) });
  });

  adminRoute('post', '/import', async (req, res) => {
    if (!ODDS_KEY) throw new HttpError(400, 'Auto import is not set up yet. Add ODDS_API_KEY to your backend settings.');
    const { data: row } = await db.from('bots').select('id,sports_leagues,sports_margin_pct').eq('id', req.g.botId).maybeSingle();
    if (!row || !(row.sports_leagues || []).length) throw new HttpError(400, 'Choose at least one league first and save.');
    res.json({ ok: true, ...(await importForBot(row)), credits_left: state.remaining });
  });

  const CONFIG_FIELDS = 'sports_enabled,sports_min_stake,sports_max_stake,sports_max_payout,sports_margin_pct,sports_auto_import,sports_leagues';
  adminRoute('get', '/config', async (req, res) => {
    const { data, error } = await db.from('bots').select(CONFIG_FIELDS).eq('id', req.g.botId).maybeSingle();
    if (error) throw error;
    res.json({ ...data, catalog: LEAGUES, key_configured: !!ODDS_KEY, last_odds_sync: state.lastOdds || null, last_scores_sync: state.lastScores || null, credits_left: state.remaining });
  });
  adminRoute('put', '/config', async (req, res) => {
    const b = req.body || {}, patch = {};
    const num = (k, min, max) => { if (!(k in b)) return; const n = Number(b[k]); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid value for ${k.replace(/_/g, ' ')}.`); patch[k] = round2(n); };
    num('sports_min_stake', 1, 1e6); num('sports_max_stake', 1, 1e7); num('sports_max_payout', 1, 1e9); num('sports_margin_pct', 0, 40);
    if ('sports_enabled' in b) patch.sports_enabled = b.sports_enabled !== false;
    if ('sports_auto_import' in b) patch.sports_auto_import = !!b.sports_auto_import;
    if ('sports_leagues' in b) patch.sports_leagues = (Array.isArray(b.sports_leagues) ? b.sports_leagues : []).filter((k) => leagueMeta[k]);
    const cur = req.g.row;
    if ((patch.sports_min_stake ?? Number(cur.sports_min_stake || 10)) > (patch.sports_max_stake ?? Number(cur.sports_max_stake || 5000))) throw new HttpError(400, 'The minimum stake is above the maximum stake.');
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');
    const { error } = await db.from('bots').update(patch).eq('id', req.g.botId);
    if (error) throw error;
    Object.assign(req.g.row, patch);   // the bot is cached in memory: refresh the live copy
    res.json({ ok: true });
  });

  return { marketsFrom, legWins, evaluateBet, normalizeEvent, applyMargin, LEAGUES };
};
module.exports.helpers = { marketsFrom, legWins, evaluateBet, normalizeEvent, applyMargin, clampOdds };
