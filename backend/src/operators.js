/* ====================================================================== */
/*  operators.js                                                          */
/*  API-sharing / seamless-wallet partner integration for Aviator - lets  */
/*  another platform embed the game, Spribe-style: THEY keep the         */
/*  player's balance on their own database/server; we never touch it     */
/*  directly. Every bet debits their wallet via a signed callback, every  */
/*  win credits it back the same way. No local user account or wagering   */
/*  logic is involved for operator play - a player only ever exists here  */
/*  as an operator-supplied player_id.                                    */
/*                                                                        */
/*  Kept in two clearly marked sections, mirroring the rest of this       */
/*  codebase's merge convention:                                          */
/*    SECTION 1 - operator management (admin CRUD) + launch/session auth  */
/*                + the signed HTTP client that calls the operator back   */
/*    SECTION 2 - bet/cancel/cashout/history routes an operator's         */
/*                embedded player uses, sharing game.js's live round      */
/*                clock but settling through the operator's wallet        */
/*                instead of a local users.balance column                 */
/* ====================================================================== */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query, pool, logger } = require('./core');
const { requireAuth, requireAdmin } = require('./users');

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

/* ======================================================================
 *  SECTION 1 — operator management, launch flow, seamless-wallet client
 * ==================================================================== */

const LAUNCH_TOKEN_TTL_SECONDS = 60; // launch link must be exchanged quickly
const SESSION_TOKEN_TTL = '6h'; // how long an embedded play session stays valid

function generateApiKey() {
  return `opk_${crypto.randomBytes(16).toString('hex')}`;
}

function generateApiSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function getOperatorById(id) {
  const { rows } = await query('SELECT * FROM operators WHERE id = $1 AND is_active = TRUE', [id]);
  return rows[0] || null;
}

// Debits the operator's player wallet before a bet is accepted. Throws
// with a `.code` of 'INSUFFICIENT_FUNDS' or 'CALLBACK_FAILED' on failure -
// the bet routes below treat either as "reject the bet", exactly like a
// local insufficient-balance check would.
async function debitOperatorWallet(operator, { player_id, round_id, amount, currency, txn_id }) {
  const body = { operator_id: operator.id, player_id, round_id, txn_id, amount, currency, type: 'debit' };
  const payload = JSON.stringify(body);
  const signature = sign(payload, operator.api_secret);

  let res;
  try {
    res = await fetch(`${operator.callback_url}/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': operator.api_key, 'X-Signature': signature },
      body: payload,
    });
  } catch (err) {
    const e = new Error(`Operator debit callback unreachable: ${err.message}`);
    e.code = 'CALLBACK_FAILED';
    throw e;
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 402 || data.error === 'INSUFFICIENT_FUNDS') {
    const e = new Error('Insufficient funds in operator wallet');
    e.code = 'INSUFFICIENT_FUNDS';
    throw e;
  }
  if (!res.ok || typeof data.balance !== 'number') {
    const e = new Error(`Operator debit callback rejected the request (status ${res.status})`);
    e.code = 'CALLBACK_FAILED';
    throw e;
  }

  return { balance: data.balance };
}

// Credits the operator's player wallet after a win (manual or auto
// cashout), or a refund (cancelled bet). Best-effort: a win/refund that
// already happened locally is never rolled back because the operator's
// callback had a transient error - failures are logged for
// reconciliation instead of thrown.
async function creditOperatorWallet(operator, { player_id, round_id, amount, currency, txn_id }) {
  const body = { operator_id: operator.id, player_id, round_id, txn_id, amount, currency, type: 'credit' };
  const payload = JSON.stringify(body);
  const signature = sign(payload, operator.api_secret);

  try {
    const res = await fetch(`${operator.callback_url}/credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': operator.api_key, 'X-Signature': signature },
      body: payload,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error('[operators] Credit callback rejected', { operator_id: operator.id, player_id, round_id, status: res.status });
      return { balance: null };
    }
    return { balance: typeof data.balance === 'number' ? data.balance : null };
  } catch (err) {
    logger.error('[operators] Credit callback unreachable', { operator_id: operator.id, player_id, round_id, error: err.message });
    return { balance: null };
  }
}

/* ---------------- PUBLIC provider routes (mount at /api/operator) ------ */

const operatorPublicRouter = express.Router();

const launchValidation = [
  body('api_key').isString().notEmpty(),
  body('api_secret').isString().notEmpty(),
  body('player_id').isString().trim().isLength({ min: 1, max: 128 }),
  body('currency').isString().trim().isLength({ min: 3, max: 8 }),
  body('return_url').optional({ nullable: true }).isURL(),
];

// POST /api/operator/launch - server-to-server call from the operator's
// own backend (never from a player's browser - requires their secret).
// Verifies their key+secret, then issues a short-lived one-time launch
// token embedded in a game URL for them to redirect/iframe their player
// into. The token carries no balance - that's always fetched fresh from
// the operator at session-start time below.
operatorPublicRouter.post('/launch', launchValidation, handleValidation, async (req, res, next) => {
  try {
    const { api_key, api_secret, player_id, currency, return_url } = req.body;

    const { rows } = await query('SELECT * FROM operators WHERE api_key = $1 AND is_active = TRUE', [api_key]);
    const operator = rows[0];
    if (!operator || operator.api_secret !== api_secret) {
      return res.status(401).json({ error: 'Invalid operator credentials' });
    }

    const launchToken = jwt.sign(
      { operator_id: operator.id, player_id, currency, return_url: return_url || null, purpose: 'operator_launch' },
      process.env.JWT_SECRET,
      { expiresIn: LAUNCH_TOKEN_TTL_SECONDS }
    );

    const baseUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

    res.json({
      launch_url: `${baseUrl}/embed/aviator?token=${launchToken}`,
      expires_in: LAUNCH_TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/session/start - called by the embedded game
// frontend (not the operator's backend) right after it loads with a
// launch token in the URL. Exchanges the one-time token for a
// longer-lived session token used to authenticate the rest of the
// player's bet/cashout calls, and checks in on their starting balance.
operatorPublicRouter.post('/session/start', [body('launch_token').isString().notEmpty()], handleValidation, async (req, res, next) => {
  try {
    let payload;
    try {
      payload = jwt.verify(req.body.launch_token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Launch link expired or invalid - ask the operator to relaunch' });
    }
    if (payload.purpose !== 'operator_launch') {
      return res.status(401).json({ error: 'Invalid launch token' });
    }

    const operator = await getOperatorById(payload.operator_id);
    if (!operator) return res.status(401).json({ error: 'Operator not found or deactivated' });

    let balance = null;
    try {
      const signature = sign(JSON.stringify({ operator_id: operator.id, player_id: payload.player_id }), operator.api_secret);
      const balRes = await fetch(
        `${operator.callback_url}/balance?player_id=${encodeURIComponent(payload.player_id)}&operator_id=${operator.id}`,
        { headers: { 'X-Api-Key': operator.api_key, 'X-Signature': signature } }
      );
      const balData = await balRes.json().catch(() => ({}));
      if (balRes.ok && typeof balData.balance === 'number') balance = balData.balance;
    } catch (err) {
      logger.warn('[operators] Balance check-in failed at session start', { operator_id: operator.id, error: err.message });
    }

    const sessionToken = jwt.sign(
      { operator_id: operator.id, player_id: payload.player_id, currency: payload.currency, purpose: 'operator_session' },
      process.env.JWT_SECRET,
      { expiresIn: SESSION_TOKEN_TTL }
    );

    res.json({
      session_token: sessionToken,
      player_id: payload.player_id,
      currency: payload.currency,
      balance,
      operator_name: operator.name,
      return_url: payload.return_url || null,
    });
  } catch (err) {
    next(err);
  }
});

// Identifies an operator-funded play session from the same Bearer-token
// slot a normal user JWT would use, but with purpose 'operator_session'.
// Attaches req.operatorSession instead of req.user so the game routes in
// SECTION 2 below can branch cleanly between "local wallet" and
// "seamless wallet" players.
async function attachOperatorSession(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next();

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next();
    }
    if (payload.purpose !== 'operator_session') return next();

    const operator = await getOperatorById(payload.operator_id);
    if (!operator) return res.status(401).json({ error: 'Operator not found or deactivated' });

    req.operatorSession = { operator, player_id: payload.player_id, currency: payload.currency };
    next();
  } catch (err) {
    next(err);
  }
}

/* ---------------- ADMIN routes (mount at /api/admin/operators) --------- */

const operatorAdminRouter = express.Router();
operatorAdminRouter.use(requireAuth, requireAdmin);

// GET /api/admin/operators
operatorAdminRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, api_key, callback_url, currency, is_active, created_at FROM operators ORDER BY created_at DESC`
    );
    res.json({ operators: rows });
  } catch (err) {
    next(err);
  }
});

const createOperatorValidation = [
  body('name').isString().trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('callback_url').isURL({ require_tld: false }).withMessage('Enter a valid callback base URL'),
  body('currency').isString().trim().isLength({ min: 3, max: 8 }).withMessage('Currency code required (e.g. ETB, USD)'),
];

// POST /api/admin/operators - creates a new operator, generating its
// api_key/api_secret. The secret is returned ONLY in this response - it
// is never shown again, matching how most provider APIs issue secrets.
operatorAdminRouter.post('/', createOperatorValidation, handleValidation, async (req, res, next) => {
  try {
    const { name, callback_url, currency } = req.body;
    const apiKey = generateApiKey();
    const apiSecret = generateApiSecret();

    const { rows } = await query(
      `INSERT INTO operators (name, api_key, api_secret, callback_url, currency, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, api_key, callback_url, currency, is_active, created_at`,
      [name.trim(), apiKey, apiSecret, callback_url.trim().replace(/\/$/, ''), currency.trim().toUpperCase()]
    );

    logger.info('Admin created operator', { admin: req.user.username, operator: name });

    res.status(201).json({ operator: rows[0], api_secret: apiSecret });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/operators/:id/status - enable/disable an operator.
// Deactivating immediately blocks new launches and new bets from that
// operator's players (attachOperatorSession re-checks is_active on every
// request via getOperatorById), without deleting their history.
operatorAdminRouter.patch(
  '/:id/status',
  [body('isActive').isBoolean().withMessage('isActive must be a boolean')],
  handleValidation,
  async (req, res, next) => {
    try {
      const { rows } = await query('UPDATE operators SET is_active = $1 WHERE id = $2 RETURNING id, is_active', [
        req.body.isActive,
        req.params.id,
      ]);
      if (rows.length === 0) return res.status(404).json({ error: 'Operator not found' });

      logger.info('Admin changed operator status', { admin: req.user.username, operatorId: req.params.id, isActive: req.body.isActive });

      res.json({ message: 'Operator status updated', operator: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/admin/operators/:id/regenerate-secret - rotates the
// api_secret (e.g. if it leaked). Returned once, same as creation.
operatorAdminRouter.post('/:id/regenerate-secret', async (req, res, next) => {
  try {
    const newSecret = generateApiSecret();
    const { rows } = await query('UPDATE operators SET api_secret = $1 WHERE id = $2 RETURNING id', [newSecret, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Operator not found' });

    logger.info('Admin regenerated operator secret', { admin: req.user.username, operatorId: req.params.id });

    res.json({ message: 'Secret regenerated', api_secret: newSecret });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/operators/:id
operatorAdminRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('DELETE FROM operators WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Operator not found' });

    logger.info('Admin deleted operator', { admin: req.user.username, operatorId: req.params.id });

    res.json({ message: 'Operator deleted' });
  } catch (err) {
    next(err);
  }
});

/* ======================================================================
 *  SECTION 2 — operator-embedded play: bet / cancel / cashout / history
 *  Mount at /api/operator-game. Every route here is reached only via an
 *  operator session token (attachOperatorSession), never a local user.
 * ==================================================================== */

const operatorGameRouter = express.Router();
operatorGameRouter.use(attachOperatorSession);

function requireOperatorSession(req, res, next) {
  if (!req.operatorSession) {
    return res.status(401).json({ error: 'Missing or invalid operator session token' });
  }
  next();
}

function newTxnId() {
  return `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// GET /api/operator-game/state - current round snapshot for page
// load/reconnect (mirrors what 'round:*' socket events otherwise carry).
operatorGameRouter.get('/state', requireOperatorSession, (req, res) => {
  const { getCurrentRound, currentMultiplier } = require('./game');
  const currentRound = getCurrentRound();
  if (!currentRound) return res.json({ round: null });

  res.json({
    round_id: currentRound.round_id,
    phase: currentRound.phase,
    server_seed_hash: currentRound.server_seed_hash,
    multiplier: currentRound.phase === 'flying' ? currentMultiplier() : null,
  });
});

const betValidation = [
  body('amount').isFloat({ gt: 0, max: 1000000 }).withMessage('Amount must be a positive number'),
  body('slot').isInt({ min: 1, max: 2 }).withMessage('Slot must be 1 or 2'),
  body('auto_cashout_at')
    .optional({ nullable: true })
    .isFloat({ gt: 1.0, max: 10000 })
    .withMessage('Auto-cashout target must be greater than 1.00x'),
];

// POST /api/operator-game/bet - debits the OPERATOR's wallet first
// (seamless wallet contract: funds must leave the player's balance on
// the operator's side, synchronously, before we accept the bet), then
// records the bet locally against the operator + player_id.
operatorGameRouter.post('/bet', requireOperatorSession, betValidation, handleValidation, async (req, res, next) => {
  try {
    const { getCurrentRound } = require('./game');
    const currentRound = getCurrentRound();
    if (!currentRound || currentRound.phase !== 'betting') {
      return res.status(400).json({ error: 'Betting is closed for this round' });
    }

    const { operator, player_id, currency } = req.operatorSession;
    const amount = Number(req.body.amount);
    const slot = parseInt(req.body.slot, 10);
    const autoCashoutAt = req.body.auto_cashout_at ? Number(req.body.auto_cashout_at) : null;

    const existing = await query(
      'SELECT id FROM operator_bets WHERE round_id = $1 AND operator_id = $2 AND player_id = $3 AND slot = $4',
      [currentRound.round_id, operator.id, player_id, slot]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: `You already placed a bet in slot ${slot} this round` });
    }

    const txnId = newTxnId();

    let debitResult;
    try {
      debitResult = await debitOperatorWallet(operator, { player_id, round_id: currentRound.round_id, amount, currency, txn_id: txnId });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_FUNDS') {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      logger.error('[operators] Debit failed', { operator_id: operator.id, player_id, error: err.message });
      return res.status(502).json({ error: 'Could not reach operator wallet - bet not placed' });
    }

    await query(
      `INSERT INTO operator_bets (round_id, operator_id, player_id, slot, amount, currency, auto_cashout_at, debit_txn_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'placed')`,
      [currentRound.round_id, operator.id, player_id, slot, amount, currency, autoCashoutAt, txnId]
    );

    res.status(201).json({ message: 'Bet placed', round_id: currentRound.round_id, slot, balance: debitResult.balance });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator-game/cancel-bet - refunds via the operator's credit
// callback and removes the bet row.
const cancelBetValidation = [body('slot').isInt({ min: 1, max: 2 }).withMessage('Slot must be 1 or 2')];

operatorGameRouter.post('/cancel-bet', requireOperatorSession, cancelBetValidation, handleValidation, async (req, res, next) => {
  try {
    const { getCurrentRound } = require('./game');
    const currentRound = getCurrentRound();
    if (!currentRound || currentRound.phase !== 'betting') {
      return res.status(400).json({ error: 'Bets can only be cancelled while betting is open' });
    }

    const { operator, player_id, currency } = req.operatorSession;
    const slot = parseInt(req.body.slot, 10);

    const { rows: betRows } = await query(
      'SELECT * FROM operator_bets WHERE round_id = $1 AND operator_id = $2 AND player_id = $3 AND slot = $4',
      [currentRound.round_id, operator.id, player_id, slot]
    );
    const bet = betRows[0];
    if (!bet || bet.status !== 'placed') {
      return res.status(400).json({ error: 'No active bet in that slot to cancel' });
    }

    await query('DELETE FROM operator_bets WHERE id = $1', [bet.id]);

    const txnId = newTxnId();
    const creditResult = await creditOperatorWallet(operator, {
      player_id,
      round_id: currentRound.round_id,
      amount: Number(bet.amount),
      currency,
      txn_id: txnId,
    });

    res.json({ message: 'Bet cancelled', slot, balance: creditResult.balance });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator-game/cashout - credits the operator's wallet for
// the payout, then marks the bet cashed out. The credit is best-effort
// (see creditOperatorWallet) rather than able to roll back a win that
// already happened.
const cashoutValidation = [body('slot').isInt({ min: 1, max: 2 }).withMessage('Slot must be 1 or 2')];

operatorGameRouter.post('/cashout', requireOperatorSession, cashoutValidation, handleValidation, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { getCurrentRound, currentMultiplier } = require('./game');
    const currentRound = getCurrentRound();
    if (!currentRound || currentRound.phase !== 'flying') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active round to cash out from' });
    }

    const { operator, player_id, currency } = req.operatorSession;
    const slot = parseInt(req.body.slot, 10);

    const { rows: betRows } = await client.query(
      'SELECT * FROM operator_bets WHERE round_id = $1 AND operator_id = $2 AND player_id = $3 AND slot = $4 FOR UPDATE',
      [currentRound.round_id, operator.id, player_id, slot]
    );
    const bet = betRows[0];
    if (!bet || bet.status !== 'placed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active bet in that slot to cash out' });
    }

    const multiplier = currentMultiplier();
    if (multiplier >= currentRound.crash_point) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Too late - round already crashed' });
    }

    const payout = Math.round(Number(bet.amount) * multiplier * 100) / 100;
    const txnId = newTxnId();

    await client.query(`UPDATE operator_bets SET status = 'cashed_out', cashed_out_at = $1, payout = $2, credit_txn_id = $3 WHERE id = $4`, [
      multiplier,
      payout,
      txnId,
      bet.id,
    ]);

    await client.query('COMMIT');

    const creditResult = await creditOperatorWallet(operator, {
      player_id,
      round_id: currentRound.round_id,
      amount: payout,
      currency,
      txn_id: txnId,
    });

    res.json({ message: 'Cashed out', slot, multiplier, payout, balance: creditResult.balance });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/operator-game/history
operatorGameRouter.get('/history', requireOperatorSession, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT round_id, crash_point, ended_at FROM game_rounds WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 20`
    );
    res.json({ rounds: rows.map((r) => ({ ...r, crash_point: Number(r.crash_point) })) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- called from game.js's tick loop / endRound ----------- */

// Server-side auto-cashout for operator bets - mirrors
// processAutoCashouts() in game.js but credits through the operator's
// wallet instead of a local users.balance column.
async function processOperatorAutoCashouts(round_id, multiplier) {
  const { broadcast } = require('./game');
  const { rows: dueBets } = await query(
    `SELECT * FROM operator_bets
     WHERE round_id = $1 AND status = 'placed' AND auto_cashout_at IS NOT NULL AND auto_cashout_at <= $2`,
    [round_id, multiplier]
  );

  for (const bet of dueBets) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: lockedRows } = await client.query('SELECT * FROM operator_bets WHERE id = $1 FOR UPDATE', [bet.id]);
      const locked = lockedRows[0];
      if (!locked || locked.status !== 'placed') {
        await client.query('ROLLBACK');
        continue;
      }

      const { rows: opRows } = await client.query('SELECT * FROM operators WHERE id = $1', [locked.operator_id]);
      const operator = opRows[0];
      if (!operator) {
        await client.query('ROLLBACK');
        continue;
      }

      const cashoutMultiplier = Number(locked.auto_cashout_at);
      const payout = Math.round(Number(locked.amount) * cashoutMultiplier * 100) / 100;
      const txnId = newTxnId();

      await client.query(`UPDATE operator_bets SET status = 'cashed_out', cashed_out_at = $1, payout = $2, credit_txn_id = $3 WHERE id = $4`, [
        cashoutMultiplier,
        payout,
        txnId,
        locked.id,
      ]);

      await client.query('COMMIT');

      const creditResult = await creditOperatorWallet(operator, {
        player_id: locked.player_id,
        round_id,
        amount: payout,
        currency: locked.currency,
        txn_id: txnId,
      });

      broadcast('operator_bet:auto_cashed_out', {
        round_id,
        operator_id: operator.id,
        player_id: locked.player_id,
        slot: locked.slot,
        multiplier: cashoutMultiplier,
        payout,
        balance: creditResult.balance,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[operators] Auto-cashout failed', { betId: bet.id, error: err.message });
    } finally {
      client.release();
    }
  }
}

// Marks every still-placed operator bet in a round as lost once it
// crashes. No wallet call needed - the stake was already debited from
// the operator at bet time and simply isn't returned.
async function settleOperatorLosses(round_id) {
  try {
    await query(`UPDATE operator_bets SET status = 'lost', payout = 0 WHERE round_id = $1 AND status = 'placed'`, [round_id]);
  } catch (err) {
    logger.error('[operators] Failed to settle operator losses', { round_id, error: err.message });
  }
}

/* ------------------------------------------------------------------ */
/*  Exports                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  operatorPublicRouter,  // mount at /api/operator
  operatorAdminRouter,   // mount at /api/admin/operators
  operatorGameRouter,    // mount at /api/operator-game
  attachOperatorSession,
  processOperatorAutoCashouts,
  settleOperatorLosses,
};
