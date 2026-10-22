// Partner API: lets other platforms ("partners") use your games through an API key you give them.
//
//   Partners call   https://<your backend>/api/partner/v1/...      with   X-API-Key: spk_...
//   You manage them from the Admin tab: create a key, pick which games it may use, pause it, rotate it.
//
// What a partner can read (everything is read-only; no player names, balances or tickets are ever shared):
//   sports   leagues, upcoming matches with 1/X/2 + double-chance odds, finished results
//   keno     live round state, latest draws, number statistics, paytable, fairness check, live stream
//   aviator  live round state, round history, fairness check, live stream
//
// Safety:
//   * keys are random (192 bit). Only a SHA-256 hash is stored, the key itself is shown once when created.
//   * every key has its own requests-per-minute limit; wrong keys are throttled per IP.
//   * a paused or deleted key stops working within 30 seconds at most.
//   * Keno and Aviator are read through this server's own public endpoints, then cleaned (no names, no chat).
//
// Run migration_partners.sql once in the Supabase SQL editor. No new environment variables are needed
// (PUBLIC_URL is used only to show the partner the right address).

const crypto = require('crypto');
const { Readable } = require('stream');
const sportsHelpers = require('./sports').helpers;

const GAMES = ['sports', 'aviator', 'keno'];
const KEY_PREFIX = 'spk_';
const MAX_PARTNERS = 25;                 // per bot
const AUTH_CACHE_MS = 30 * 1000;
const FEED_CACHE_MS = 1000;              // live endpoints are read at most once per second from inside the server
const EVENTS_CACHE_MS = 8 * 1000;
const NO_BET_BEFORE_MS = 60 * 1000;      // same rule as the player app: matches leave the feed one minute before kick-off
const MAX_STREAMS_PER_PARTNER = 5;
const BAD_KEY_PER_MIN = 20;              // wrong keys per IP per minute before we answer 429

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

module.exports = function attachPartners(app, db, { miniAuth, leagues = [], paytable = null, port = 3000 }) {
  const PUBLIC = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const SELF = `http://127.0.0.1:${port}`;
  const leagueKeys = new Set((leagues || []).map((l) => l.key));

  const authCache = new Map();           // key hash -> { p, exp }
  const buckets = new Map();             // partner id -> { m, n }
  const badIp = new Map();               // ip -> { m, n }
  const usage = new Map();               // `${id}|${day}|${game}` -> requests not yet saved
  const streams = new Map();             // partner id -> open stream count

  /* ----------------------------- usage counting ----------------------------- */
  const countUse = (partnerId, game) => { const k = `${partnerId}|${dayOf()}|${game}`; usage.set(k, (usage.get(k) || 0) + 1); };
  async function flushUsage() {
    if (!usage.size) return;
    const batch = [...usage.entries()]; usage.clear();
    for (const [k, n] of batch) {
      const [id, day, game] = k.split('|');
      const { error } = await db.rpc('partner_usage_bump', { p_partner_id: Number(id), p_day: day, p_game: game, p_n: n });
      if (error) { console.error('partners: usage save failed:', error.message); usage.set(k, (usage.get(k) || 0) + n); }
    }
  }
  setInterval(() => flushUsage().catch(() => {}), 60 * 1000).unref();

  /* ------------------------------- the response ------------------------------ */
  const sendError = (res, err) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error('partner api error:', err);
    return res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  };

  /* --------------------------- authentication + limits ------------------------ */
  function readKey(req) {
    const h = req.get('X-API-Key');
    if (h) return h.trim();
    const a = req.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(a);
    return m ? m[1].trim() : '';
  }
  async function loadPartner(hash) {
    const c = authCache.get(hash);
    if (c && c.exp > Date.now()) return c.p;
    const { data, error } = await db.from('api_partners').select('*').eq('key_hash', hash).maybeSingle();
    if (error) throw error;
    authCache.set(hash, { p: data || null, exp: Date.now() + AUTH_CACHE_MS });
    if (authCache.size > 2000) authCache.clear();
    return data || null;
  }
  const guard = (game) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const key = readKey(req);
      const p = key.startsWith(KEY_PREFIX) && key.length < 80 ? await loadPartner(sha256(key)) : null;
      if (!p) {
        const m = Math.floor(Date.now() / 60000), ip = req.ip || 'x';
        let b = badIp.get(ip); if (!b || b.m !== m) { b = { m, n: 0 }; badIp.set(ip, b); }
        if (badIp.size > 5000) badIp.clear();
        if (++b.n > BAD_KEY_PER_MIN) { res.set('Retry-After', '60'); throw new HttpError(429, 'too_many_attempts', 'Too many wrong keys. Wait a minute.'); }
        throw new HttpError(401, 'invalid_api_key', 'Missing or wrong API key. Send it in the X-API-Key header.');
      }
      if (!p.active) throw new HttpError(403, 'key_paused', 'This API key is paused. Contact the platform.');
      if (game && !(p.games || []).includes(game)) throw new HttpError(403, 'game_not_allowed', `This API key cannot use ${game}.`);
      // per-minute limit
      const m = Math.floor(Date.now() / 60000), lim = Number(p.rate_limit_per_min) || 60;
      let b = buckets.get(p.id); if (!b || b.m !== m) { b = { m, n: 0 }; buckets.set(p.id, b); }
      b.n++;
      res.set({ 'X-RateLimit-Limit': String(lim), 'X-RateLimit-Remaining': String(Math.max(0, lim - b.n)), 'X-RateLimit-Reset': String((m + 1) * 60) });
      if (b.n > lim) { res.set('Retry-After', String(60 - Math.floor((Date.now() % 60000) / 1000))); throw new HttpError(429, 'rate_limited', `Limit of ${lim} requests per minute reached.`); }
      countUse(p.id, game || 'general');
      req.partner = p;
      next();
    } catch (e) { sendError(res, e); }
  };
  const route = (path, game, handler) => app.get(`/api/partner/v1${path}`, guard(game), async (req, res) => {
    try { await handler(req, res); } catch (e) { sendError(res, e); }
  });
  const list = (data, meta) => ({ data, meta: { generated_at: new Date().toISOString(), ...meta } });

  /* ------------------------------ read our own live data ---------------------- */
  const feedCache = new Map();
  async function inner(path) {
    const c = feedCache.get(path);
    if (c && c.exp > Date.now()) return c.v;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${SELF}${path}`, { signal: ctl.signal });
      const body = await r.json().catch(() => ({}));
      const v = { status: r.status, body };
      if (r.ok) { feedCache.set(path, { v, exp: Date.now() + FEED_CACHE_MS }); if (feedCache.size > 300) feedCache.clear(); }
      return v;
    } catch (_) { throw new HttpError(502, 'upstream_unavailable', 'The game service did not answer. Try again in a moment.'); }
    finally { clearTimeout(t); }
  }
  // remove everything that identifies a player or is chat
  const BLOCK = new Set(['bets', 'tickets', 'chat', 'prev', 'online', 'name', 'username', 'avatar', 'users', 'players_list']);
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) if (!BLOCK.has(k)) out[k] = clean(v);
    return out;
  };
  const withCount = (raw, c) => ({ ...c, ...(Array.isArray(raw.tickets) ? { tickets_count: raw.count != null ? raw.count : raw.tickets.length } : {}), ...(Array.isArray(raw.bets) && raw.players == null ? { players: raw.bets.length } : {}) });

  /* --------------------------------- live stream ------------------------------ */
  async function relay(req, res, path, allowed) {
    const p = req.partner;
    if ((streams.get(p.id) || 0) >= MAX_STREAMS_PER_PARTNER) throw new HttpError(429, 'too_many_streams', `At most ${MAX_STREAMS_PER_PARTNER} live streams at the same time.`);
    const ctl = new AbortController();
    let up;
    try { up = await fetch(`${SELF}${path}`, { signal: ctl.signal, headers: { Accept: 'text/event-stream' } }); } catch (_) { up = null; }
    if (!up || !up.ok || !up.body) throw new HttpError(502, 'upstream_unavailable', 'The live stream is not available right now.');
    streams.set(p.id, (streams.get(p.id) || 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 2000\n\n');
    let done = false;
    const end = () => { if (done) return; done = true; clearInterval(ping); ctl.abort(); streams.set(p.id, Math.max(0, (streams.get(p.id) || 1) - 1)); try { res.end(); } catch (_) {} };
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { end(); } }, 15000);
    req.on('close', end);
    try {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of Readable.fromWeb(up.body)) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
          if (!data || !allowed.includes(ev)) continue;
          let obj; try { obj = JSON.parse(data); } catch (_) { continue; }
          const out = clean(obj);
          if (Array.isArray(obj.tickets)) out.tickets_count = obj.count != null ? obj.count : obj.tickets.length;
          if (Array.isArray(obj.bets) && obj.players == null) out.players = obj.bets.length;
          res.write(`event: ${ev}\ndata: ${JSON.stringify(out)}\n\n`);
        }
      }
    } catch (_) { /* upstream closed or client left */ } finally { end(); }
  }

  /* ================================== index =================================== */
  route('', null, (req, res) => {
    const p = req.partner;
    res.json({
      name: 'Partner API', version: 'v1', partner: p.name, games: p.games, rate_limit_per_min: p.rate_limit_per_min,
      endpoints: {
        sports: ['GET /sports/leagues', 'GET /sports/events', 'GET /sports/events/{id}', 'GET /sports/results'],
        keno: ['GET /keno/state', 'GET /keno/results', 'GET /keno/stats', 'GET /keno/paytable', 'GET /keno/verify/{roundId}', 'GET /keno/stream'],
        aviator: ['GET /aviator/state', 'GET /aviator/verify/{roundId}', 'GET /aviator/stream'],
      },
    });
  });
  route('/me', null, async (req, res) => {
    const p = req.partner;
    const { data } = await db.from('api_partner_usage').select('day,game,requests').eq('partner_id', p.id).gte('day', dayOf(Date.now() - 6 * 86400000));
    const today = dayOf(); let t = 0, w = 0;
    for (const r of data || []) { w += Number(r.requests); if (r.day === today) t += Number(r.requests); }
    res.json({ partner: p.name, games: p.games, active: p.active, rate_limit_per_min: p.rate_limit_per_min, requests_today: t, requests_7_days: w });
  });

  /* ================================== sports ================================== */
  const evCache = new Map();             // bot id -> { exp, rows }
  async function openEvents(botId) {
    const c = evCache.get(botId);
    if (c && c.exp > Date.now()) return c.rows;
    const now = Date.now();
    const { data, error } = await db.from('sports_events').select('*').eq('bot_id', botId).in('status', ['open', 'suspended'])
      .gt('kickoff', new Date(now + NO_BET_BEFORE_MS).toISOString()).lt('kickoff', new Date(now + 30 * 86400000).toISOString())
      .order('kickoff', { ascending: true }).limit(1000);
    if (error) throw error;
    evCache.set(botId, { exp: now + EVENTS_CACHE_MS, rows: data || [] });
    return data || [];
  }
  const allowedLeague = (p, e) => !(p.leagues && p.leagues.length) || (e.league_key && p.leagues.includes(e.league_key));
  function oddsFor(e, margin) {
    const m = Number(margin) || 0;
    if (m <= 0) return { '1': Number(e.odds_1), X: Number(e.odds_x), '2': Number(e.odds_2), '1X': Number(e.odds_1x), '12': Number(e.odds_12), X2: Number(e.odds_x2) };
    const x = sportsHelpers.marketsFrom(sportsHelpers.applyMargin(e.odds_1, m), sportsHelpers.applyMargin(e.odds_x, m), sportsHelpers.applyMargin(e.odds_2, m));
    return { '1': x.odds_1, X: x.odds_x, '2': x.odds_2, '1X': x.odds_1x, '12': x.odds_12, X2: x.odds_x2 };
  }
  const eventOut = (e, p) => ({
    id: e.id, league: { key: e.league_key || null, name: e.league_name, country: e.country || null },
    home: e.home, away: e.away, kickoff: e.kickoff, status: e.status, odds: oddsFor(e, p.margin_pct), updated_at: e.updated_at || null,
  });
  const intParam = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const dateParam = (v, name) => { if (v == null || v === '') return null; const t = new Date(v); if (Number.isNaN(t.getTime())) throw new HttpError(400, 'bad_request', `${name} must be an ISO date, e.g. 2026-10-25T12:00:00Z.`); return t; };

  route('/sports/leagues', 'sports', async (req, res) => {
    const rows = (await openEvents(req.partner.bot_id)).filter((e) => allowedLeague(req.partner, e));
    const m = new Map();
    for (const e of rows) { const k = e.league_key || e.league_name; if (!m.has(k)) m.set(k, { key: e.league_key || null, name: e.league_name, country: e.country || null, matches: 0 }); m.get(k).matches++; }
    res.json(list([...m.values()], { count: m.size }));
  });
  route('/sports/events', 'sports', async (req, res) => {
    let rows = (await openEvents(req.partner.bot_id)).filter((e) => allowedLeague(req.partner, e));
    const from = dateParam(req.query.from, 'from'), to = dateParam(req.query.to, 'to');
    if (req.query.league) rows = rows.filter((e) => e.league_key === String(req.query.league));
    if (from) rows = rows.filter((e) => new Date(e.kickoff) >= from);
    if (to) rows = rows.filter((e) => new Date(e.kickoff) < to);
    if (req.query.status === 'open') rows = rows.filter((e) => e.status === 'open');
    const limit = intParam(req.query.limit, 200, 1, 500), offset = intParam(req.query.offset, 0, 0, 100000);
    res.json(list(rows.slice(offset, offset + limit).map((e) => eventOut(e, req.partner)), { total: rows.length, limit, offset }));
  });
  route('/sports/events/:id', 'sports', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'bad_request', 'The match id must be a number.');
    const { data: e, error } = await db.from('sports_events').select('*').eq('id', id).eq('bot_id', req.partner.bot_id).maybeSingle();
    if (error) throw error;
    if (!e || !allowedLeague(req.partner, e)) throw new HttpError(404, 'not_found', 'Match not found.');
    const out = eventOut(e, req.partner);
    if (e.status === 'finished') out.score = { home: e.result_home, away: e.result_away };
    res.json({ data: out });
  });
  route('/sports/results', 'sports', async (req, res) => {
    const since = dateParam(req.query.since, 'since') || new Date(Date.now() - 48 * 3600000);
    const limit = intParam(req.query.limit, 200, 1, 500);
    const { data, error } = await db.from('sports_events').select('id,league_key,league_name,country,home,away,kickoff,status,result_home,result_away,updated_at')
      .eq('bot_id', req.partner.bot_id).in('status', ['finished', 'cancelled']).gte('updated_at', since.toISOString()).order('updated_at', { ascending: true }).limit(limit);
    if (error) throw error;
    const out = (data || []).filter((e) => allowedLeague(req.partner, e)).map((e) => ({
      id: e.id, league: { key: e.league_key || null, name: e.league_name, country: e.country || null }, home: e.home, away: e.away, kickoff: e.kickoff,
      status: e.status, score: e.status === 'finished' ? { home: e.result_home, away: e.result_away } : null, settled_at: e.updated_at,
    }));
    res.json(list(out, { count: out.length, since: since.toISOString() }));
  });

  /* ================================== keno ==================================== */
  route('/keno/state', 'keno', async (req, res) => {
    const r = await inner('/api/keno/state');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Keno is not available right now.');
    res.json({ data: withCount(r.body, clean(r.body)) });
  });
  route('/keno/results', 'keno', async (req, res) => {
    const r = await inner('/api/keno/results');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Keno is not available right now.');
    const limit = intParam(req.query.limit, 20, 1, 40);
    const rows = (r.body.results || []).slice(0, limit);
    res.json(list(rows, { count: rows.length }));
  });
  route('/keno/stats', 'keno', async (req, res) => {
    const r = await inner('/api/keno/stats');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Keno is not available right now.');
    res.json({ data: r.body });
  });
  route('/keno/paytable', 'keno', (req, res) => {
    // the paytable comes straight from keno.js, so it can never drift from what players get
    res.json({ data: { numbers_range: [1, 80], drawn_per_round: 20, max_picks: 10, multipliers: paytable } });
  });
  route('/keno/verify/:roundId', 'keno', async (req, res) => {
    const r = await inner(`/api/keno/verify/${encodeURIComponent(String(req.params.roundId).slice(0, 80))}`);
    if (r.status === 404) throw new HttpError(404, 'not_found', 'Round not found or not finished yet.');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Keno is not available right now.');
    res.json({ data: r.body });
  });
  route('/keno/stream', 'keno', (req, res) => relay(req, res, '/api/keno/stream', ['state', 'betting', 'draw', 'result', 'live']));

  /* ================================= aviator ================================== */
  route('/aviator/state', 'aviator', async (req, res) => {
    const r = await inner('/api/aviator/state');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Aviator is not available right now.');
    res.json({ data: withCount(r.body, clean(r.body)), curve: 'multiplier = 1 + 0.05*t + 0.02*t^2, t = seconds since flying_since (server time), rounded to 2 decimals' });
  });
  route('/aviator/verify/:roundId', 'aviator', async (req, res) => {
    const r = await inner(`/api/aviator/verify/${encodeURIComponent(String(req.params.roundId).slice(0, 80))}`);
    if (r.status === 404) throw new HttpError(404, 'not_found', 'Round not found or not finished yet.');
    if (r.status !== 200) throw new HttpError(502, 'upstream_unavailable', 'Aviator is not available right now.');
    res.json({ data: r.body });
  });
  route('/aviator/stream', 'aviator', (req, res) => relay(req, res, '/api/aviator/stream', ['state', 'betting', 'flying', 'crash', 'live']));

  app.use('/api/partner', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint. GET /api/partner/v1 lists them.' } }));

  /* ============================= admin (per bot) ============================== */
  const wrapAdmin = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const a = miniAuth(req, res); if (!a) return;
      const isAdmin = app.get('isGameAdmin');
      if (!isAdmin || !(await isAdmin(a.entry.row, a.user.id))) throw new HttpError(403, 'forbidden', 'You are not an admin of this bot.');
      req.g = { botId: a.entry.row.id, userId: a.user.id };
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error('partners admin error:', e);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
  const adminRoute = (method, path, fn) => app[method](`/api/mini/:botId/gadmin/partners${path}`, wrapAdmin(fn));
  const newKey = () => KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const view = (p, use) => ({
    id: p.id, name: p.name, active: p.active, games: p.games, margin_pct: Number(p.margin_pct), rate_limit_per_min: p.rate_limit_per_min,
    leagues: p.leagues || null, key_hint: `${p.key_prefix}…`, created_at: p.created_at, last_used_at: p.last_used_at,
    today: (use && use.today) || 0, week: (use && use.week) || 0,
  });
  function readBody(b, partial) {
    const out = {};
    if (!partial || 'name' in b) {
      const n = String(b.name || '').replace(/\s+/g, ' ').trim();
      if (n.length < 2 || n.length > 60) throw new HttpError(400, 'bad_request', 'Enter the partner name (2 to 60 letters).');
      out.name = n;
    }
    if (!partial || 'games' in b) {
      const g = [...new Set((Array.isArray(b.games) ? b.games : []).filter((x) => GAMES.includes(x)))];
      if (!g.length) throw new HttpError(400, 'bad_request', 'Choose at least one game.');
      out.games = g;
    }
    if ('margin_pct' in b) { const m = Number(b.margin_pct); if (!Number.isFinite(m) || m < 0 || m > 30) throw new HttpError(400, 'bad_request', 'Margin must be between 0 and 30.'); out.margin_pct = round2(m); }
    if ('rate_limit_per_min' in b) { const r = Math.round(Number(b.rate_limit_per_min)); if (!Number.isFinite(r) || r < 10 || r > 6000) throw new HttpError(400, 'bad_request', 'Requests per minute must be between 10 and 6000.'); out.rate_limit_per_min = r; }
    if ('leagues' in b) { const l = (Array.isArray(b.leagues) ? b.leagues : []).filter((k) => leagueKeys.has(k)); out.leagues = l.length ? l : null; }
    if ('active' in b) out.active = !!b.active;
    return out;
  }
  const mine = async (req) => {
    const id = Number(req.params.id);
    const { data } = await db.from('api_partners').select('*').eq('id', id).eq('bot_id', req.g.botId).maybeSingle();
    if (!data) throw new HttpError(404, 'not_found', 'Partner not found.');
    return data;
  };

  adminRoute('get', '', async (req, res) => {
    const { data, error } = await db.from('api_partners').select('*').eq('bot_id', req.g.botId).order('created_at', { ascending: false });
    if (error) throw error;
    const ids = (data || []).map((p) => p.id);
    const use = {};
    if (ids.length) {
      const { data: rows } = await db.from('api_partner_usage').select('partner_id,day,requests').in('partner_id', ids).gte('day', dayOf(Date.now() - 6 * 86400000));
      const today = dayOf();
      for (const r of rows || []) { const u = use[r.partner_id] || (use[r.partner_id] = { today: 0, week: 0 }); u.week += Number(r.requests); if (r.day === today) u.today += Number(r.requests); }
    }
    res.json({ partners: (data || []).map((p) => view(p, use[p.id])), base_url: `${PUBLIC}/api/partner/v1`, games: GAMES, catalog: leagues.map((l) => ({ key: l.key, name: l.name, country: l.country })) });
  });
  adminRoute('post', '', async (req, res) => {
    const d = readBody(req.body || {}, false);
    const { count } = await db.from('api_partners').select('id', { count: 'exact', head: true }).eq('bot_id', req.g.botId);
    if ((count || 0) >= MAX_PARTNERS) throw new HttpError(400, 'limit', `You can have up to ${MAX_PARTNERS} partners. Delete one you no longer use.`);
    const key = newKey();
    const row = { bot_id: req.g.botId, name: d.name, games: d.games, margin_pct: d.margin_pct ?? 0, rate_limit_per_min: d.rate_limit_per_min ?? 60, leagues: d.leagues ?? null, key_hash: sha256(key), key_prefix: key.slice(0, 8), active: true };
    const { data, error } = await db.from('api_partners').insert(row).select('*').single();
    if (error) throw error;
    res.json({ ok: true, partner: view(data), api_key: key });
  });
  adminRoute('put', '/:id', async (req, res) => {
    await mine(req);
    const d = readBody(req.body || {}, true);
    if (!Object.keys(d).length) throw new HttpError(400, 'bad_request', 'Nothing to change.');
    const { error } = await db.from('api_partners').update(d).eq('id', Number(req.params.id)).eq('bot_id', req.g.botId);
    if (error) throw error;
    authCache.clear(); evCache.clear();
    res.json({ ok: true });
  });
  adminRoute('post', '/:id/rotate', async (req, res) => {
    await mine(req);
    const key = newKey();
    const { error } = await db.from('api_partners').update({ key_hash: sha256(key), key_prefix: key.slice(0, 8) }).eq('id', Number(req.params.id)).eq('bot_id', req.g.botId);
    if (error) throw error;
    authCache.clear();
    res.json({ ok: true, api_key: key });
  });
  adminRoute('delete', '/:id', async (req, res) => {
    await mine(req);
    const { error } = await db.from('api_partners').delete().eq('id', Number(req.params.id)).eq('bot_id', req.g.botId);
    if (error) throw error;
    authCache.clear();
    res.json({ ok: true });
  });

  return { flushUsage };
};
