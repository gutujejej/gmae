const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const { query, pool } = require('./core');
const { requireAuth } = require('./users');

const router = express.Router();

/* ==================================================================== */
/*  PROVABLY-FAIR CRASH POINT GENERATION                                 */
/*  (unchanged from before - seed hash published before round starts,    */
/*  raw seed revealed after round ends for independent verification)     */
/* ==================================================================== */

const HOUSE_EDGE = 0.97;

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function seedToCrashPoint(seed) {
  const hash = sha256(seed);
  const int = parseInt(hash.slice(0, 13), 16);
  const maxInt = Math.pow(2, 52);
  const f = int / maxInt;
  if (f === 0) return 1.0;
  const raw = HOUSE_EDGE / (1 - f);
  return Math.max(1.0, Math.floor(raw * 100) / 100);
}

function generateRoundId() {
  return `RND-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ==================================================================== */
/*  ROUND STATE MACHINE                                                  */
/* ==================================================================== */

const BETTING_PHASE_MS = 8000;
const POST_ROUND_MS = 4000;
const TICK_MS = 100;
const MAX_SLOTS = 2; // dual bet slots per user per round
const MIN_BET_BIRR = 4;

let currentRound = null;
let ioRef = null;
let roundTimer = null;

function currentMultiplier() {
  if (!currentRound || currentRound.phase !== 'flying') return 1.0;
  const elapsedSec = (Date.now() - currentRound.startedFlyingAt) / 1000;
  const m = 1 + 0.05 * elapsedSec + 0.02 * elapsedSec * elapsedSec;
  return Math.round(m * 100) / 100;
}

async function startBettingPhase() {
  const server_seed = crypto.randomBytes(32).toString('hex');
  const server_seed_hash = sha256(server_seed);
  const crash_point = seedToCrashPoint(server_seed);
  const round_id = generateRoundId();

  currentRound = { round_id, server_seed, server_seed_hash, crash_point, phase: 'betting', startedFlyingAt: null };

  await query(
    `INSERT INTO game_rounds (round_id, server_seed_hash, crash_point, started_at) VALUES ($1, $2, $3, now())`,
    [round_id, server_seed_hash, crash_point]
  );

  broadcast('round:betting', {
    round_id,
    server_seed_hash,
    betting_duration_ms: BETTING_PHASE_MS,
  });

  // Place auto-bets for anyone with auto-bet enabled on either slot.
  await placeAutoBets(round_id);

  roundTimer = setTimeout(startFlyingPhase, BETTING_PHASE_MS);
}

/**
 * Reads everyone's auto_bet_settings and places matching bets for this new
 * round, deducting balances the same way a manual bet would. Runs once at
 * the start of each betting phase, entirely server-side.
 *
 * "Auto-bet next round" means exactly that - ONE round, not every round
 * forever. Each setting is disabled immediately after being used, in the
 * same transaction as the bet itself, so a user who checked the box once
 * can never have bets silently placed on their behalf in rounds after the
 * one they asked for - including while they're not even connected.
 */
async function placeAutoBets(round_id) {
  const { rows: settings } = await query('SELECT * FROM auto_bet_settings WHERE enabled = TRUE');

  for (const setting of settings) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: userRows } = await client.query(
        'SELECT balance, bonus_balance FROM users WHERE id = $1 FOR UPDATE',
        [setting.user_id]
      );
      const user = userRows[0];
      const totalAvailable = (user?.balance || 0) + (user?.bonus_balance || 0);
      if (!user || totalAvailable < setting.amount) {
        // Not enough balance - skip this slot, but still turn the
        // one-shot setting off so it doesn't keep silently retrying
        // every round until the user notices and unchecks it.
        await client.query('UPDATE auto_bet_settings SET enabled = FALSE WHERE user_id = $1 AND slot = $2', [
          setting.user_id,
          setting.slot,
        ]);
        await client.query('COMMIT');
        continue;
      }

      const fromBalance = Math.min(setting.amount, user.balance);
      const fromBonus = setting.amount - fromBalance;

      await client.query('UPDATE users SET balance = balance - $1, bonus_balance = bonus_balance - $2 WHERE id = $3', [
        fromBalance,
        fromBonus,
        setting.user_id,
      ]);
      await client.query(
        `INSERT INTO bets (round_id, user_id, slot, amount, bonus_amount, auto_cashout_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (round_id, user_id, slot) DO NOTHING`,
        [round_id, setting.user_id, setting.slot, setting.amount, fromBonus, setting.auto_cashout_at]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status, round_id) VALUES ($1, 'bet', $2, 'completed', $3)`,
        [setting.user_id, setting.amount, round_id]
      );
      // One-shot: this round is the "next round" the user asked for -
      // turn it off now so it doesn't fire again next round too.
      await client.query('UPDATE auto_bet_settings SET enabled = FALSE WHERE user_id = $1 AND slot = $2', [
        setting.user_id,
        setting.slot,
      ]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[game] Failed to place auto-bet', { user_id: setting.user_id, error: err.message });
    } finally {
      client.release();
    }
  }
}

function startFlyingPhase() {
  currentRound.phase = 'flying';
  currentRound.startedFlyingAt = Date.now();

  broadcast('round:flying', { round_id: currentRound.round_id });

  const tick = setInterval(async () => {
    const m = currentMultiplier();

    if (m >= currentRound.crash_point) {
      clearInterval(tick);
      await endRound();
      return;
    }

    // Server-side auto-cashout: check every placed bet with an
    // auto_cashout_at target that the current multiplier has now reached.
    // This runs on the server's own tick, never trusting client timing.
    await processAutoCashouts(m);

    // Lazy require avoids a circular require at module-load time
    // (operators.js requires game.js for the shared round state).
    await require('./operators').processOperatorAutoCashouts(currentRound.round_id, m);

    broadcast('round:tick', { round_id: currentRound.round_id, multiplier: m });
  }, TICK_MS);
}

/**
 * Finds bets in the current round that are still 'placed', have a
 * non-null auto_cashout_at, and whose target the current multiplier has
 * reached or passed - then cashes them out exactly as a manual cashout
 * would, crediting balance and recording the transaction.
 */
async function processAutoCashouts(multiplier) {
  const { rows: dueBets } = await query(
    `SELECT * FROM bets
     WHERE round_id = $1 AND status = 'placed' AND auto_cashout_at IS NOT NULL AND auto_cashout_at <= $2`,
    [currentRound.round_id, multiplier]
  );

  for (const bet of dueBets) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-check status under lock in case of a race with a manual cashout.
      const { rows: lockedBetRows } = await client.query('SELECT * FROM bets WHERE id = $1 FOR UPDATE', [bet.id]);
      const lockedBet = lockedBetRows[0];
      if (!lockedBet || lockedBet.status !== 'placed') {
        await client.query('ROLLBACK');
        continue;
      }

      const cashoutMultiplier = Number(lockedBet.auto_cashout_at);
      const payoutCents = Math.round(lockedBet.amount * cashoutMultiplier);

      // Split the payout the same way the stake was split: the
      // bonus-funded fraction of the win stays in bonus_balance (still
      // locked behind wagering), the real-money fraction becomes
      // withdrawable balance.
      const bonusFraction = lockedBet.amount > 0 ? lockedBet.bonus_amount / lockedBet.amount : 0;
      const payoutToBonus = Math.round(payoutCents * bonusFraction);
      const payoutToBalance = payoutCents - payoutToBonus;

      await client.query(
        `UPDATE bets SET status = 'cashed_out', cashed_out_at = $1, payout = $2 WHERE id = $3`,
        [cashoutMultiplier, payoutCents, lockedBet.id]
      );
      await client.query('UPDATE users SET balance = balance + $1, bonus_balance = bonus_balance + $2 WHERE id = $3', [
        payoutToBalance,
        payoutToBonus,
        lockedBet.user_id,
      ]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status, round_id) VALUES ($1, 'payout', $2, 'completed', $3)`,
        [lockedBet.user_id, payoutCents, currentRound.round_id]
      );

      await client.query('COMMIT');

      broadcast('bet:auto_cashed_out', {
        round_id: currentRound.round_id,
        user_id: lockedBet.user_id,
        slot: lockedBet.slot,
        multiplier: cashoutMultiplier,
        payout: payoutCents / 100,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[game] Auto-cashout failed', { betId: bet.id, error: err.message });
    } finally {
      client.release();
    }
  }
}

async function endRound() {
  currentRound.phase = 'ended';

  // Every bet still 'placed' at this point lost. This used to be one bulk
  // UPDATE, but a bonus-funded loss also needs to reduce the user's
  // wagering_required by the bonus portion of the stake - that requires
  // reading each bet's bonus_amount and updating its user individually,
  // so this is now a per-bet loop rather than a single blanket UPDATE.
  const { rows: losingBets } = await query(
    `SELECT * FROM bets WHERE round_id = $1 AND status = 'placed'`,
    [currentRound.round_id]
  );

  for (const bet of losingBets) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`UPDATE bets SET status = 'lost', payout = 0 WHERE id = $1`, [bet.id]);

      if (bet.bonus_amount > 0) {
        // GREATEST(..., 0) so this can never push wagering_required
        // negative even if the stored total is slightly less than the
        // sum of every bonus-funded loss (e.g. due to a manual admin
        // adjustment in between).
        await client.query(
          'UPDATE users SET wagering_required = GREATEST(wagering_required - $1, 0) WHERE id = $2',
          [bet.bonus_amount, bet.user_id]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[game] Failed to settle lost bet', { betId: bet.id, error: err.message });
    } finally {
      client.release();
    }
  }

  await query(`UPDATE game_rounds SET server_seed = $1, ended_at = now() WHERE round_id = $2`, [
    currentRound.server_seed,
    currentRound.round_id,
  ]);

  await require('./operators').settleOperatorLosses(currentRound.round_id);

  broadcast('round:crashed', {
    round_id: currentRound.round_id,
    crash_point: currentRound.crash_point,
    server_seed: currentRound.server_seed,
    server_seed_hash: currentRound.server_seed_hash,
  });

  roundTimer = setTimeout(startBettingPhase, POST_ROUND_MS);
}

function broadcast(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}

function attachSocket(io) {
  ioRef = io;

  io.on('connection', (socket) => {
    if (currentRound) {
      socket.emit(`round:${currentRound.phase}`, {
        round_id: currentRound.round_id,
        server_seed_hash: currentRound.server_seed_hash,
        ...(currentRound.phase === 'flying' ? { multiplier: currentMultiplier() } : {}),
      });
    }
  });

  if (!currentRound) startBettingPhase();
}

/* ==================================================================== */
/*  HTTP ROUTES                                                          */
/* ==================================================================== */

const betValidation = [
  body('amount')
    .isFloat({ gt: 0, max: 1000000 })
    .withMessage('Amount must be a positive number')
    .custom((value) => {
      if (parseFloat(value) < MIN_BET_BIRR) {
        throw new Error(`Minimum bet is ${MIN_BET_BIRR} ETB`);
      }
      return true;
    }),
  body('slot').isInt({ min: 1, max: MAX_SLOTS }).withMessage(`Slot must be 1 or ${MAX_SLOTS}`),
  body('auto_cashout_at')
    .optional({ nullable: true })
    .isFloat({ gt: 1.0, max: 10000 })
    .withMessage('Auto-cashout target must be greater than 1.00x'),
];

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// POST /api/game/bet - place a bet in a given slot (1 or 2) during betting phase
//
// Real balance is spent first; only the shortfall is drawn from
// bonus_balance (a "top-up" of last resort). Each bet remembers how much
// of its stake came from bonus_balance (bets.bonus_amount) so that later,
// when the round settles, the win/loss outcome can be routed back to the
// correct pool - see processAutoCashouts, POST /cashout, and endRound.
router.post('/bet', requireAuth, betValidation, handleValidation, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!currentRound || currentRound.phase !== 'betting') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Betting is closed for this round' });
    }

    const amountCents = Math.round(Number(req.body.amount) * 100);
    const slot = parseInt(req.body.slot, 10);
    const autoCashoutAt = req.body.auto_cashout_at ? Number(req.body.auto_cashout_at) : null;

    const { rows: userRows } = await client.query(
      'SELECT balance, bonus_balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const user = userRows[0];
    const totalAvailable = (user?.balance || 0) + (user?.bonus_balance || 0);
    if (!user || totalAvailable < amountCents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const existing = await client.query('SELECT id FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3', [
      currentRound.round_id,
      req.user.id,
      slot,
    ]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `You already placed a bet in slot ${slot} this round` });
    }

    const fromBalance = Math.min(amountCents, user.balance);
    const fromBonus = amountCents - fromBalance;

    const { rows: updatedRows } = await client.query(
      'UPDATE users SET balance = balance - $1, bonus_balance = bonus_balance - $2 WHERE id = $3 RETURNING balance, bonus_balance',
      [fromBalance, fromBonus, req.user.id]
    );

    await client.query(
      `INSERT INTO bets (round_id, user_id, slot, amount, bonus_amount, auto_cashout_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [currentRound.round_id, req.user.id, slot, amountCents, fromBonus, autoCashoutAt]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, round_id) VALUES ($1, 'bet', $2, 'completed', $3)`,
      [req.user.id, amountCents, currentRound.round_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Bet placed',
      round_id: currentRound.round_id,
      slot,
      balance: updatedRows[0].balance / 100,
      bonus_balance: updatedRows[0].bonus_balance / 100,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/game/cancel-bet - cancel a bet the user placed this round,
// while betting is still open, refunding the balance and removing the
// bet row. Previously the frontend's "Cancel" button only changed local
// UI state and never told the server, so the bet (and the deducted
// balance) silently stayed in place even though the button looked like
// it worked - this route is what actually undoes it.
const cancelBetValidation = [body('slot').isInt({ min: 1, max: MAX_SLOTS }).withMessage(`Slot must be 1 or ${MAX_SLOTS}`)];

router.post('/cancel-bet', requireAuth, cancelBetValidation, handleValidation, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!currentRound || currentRound.phase !== 'betting') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bets can only be cancelled while betting is open' });
    }

    const slot = parseInt(req.body.slot, 10);

    const { rows: betRows } = await client.query(
      'SELECT * FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3 FOR UPDATE',
      [currentRound.round_id, req.user.id, slot]
    );
    const bet = betRows[0];
    if (!bet || bet.status !== 'placed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active bet in that slot to cancel' });
    }

    await client.query('DELETE FROM bets WHERE id = $1', [bet.id]);

    // Refund into the same pools the stake was drawn from - refunding
    // everything into balance would let bonus money escape its wagering
    // lock just by placing then cancelling a bet.
    const refundToBalance = bet.amount - bet.bonus_amount;
    const refundToBonus = bet.bonus_amount;

    const { rows: updatedRows } = await client.query(
      'UPDATE users SET balance = balance + $1, bonus_balance = bonus_balance + $2 WHERE id = $3 RETURNING balance, bonus_balance',
      [refundToBalance, refundToBonus, req.user.id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, round_id, note) VALUES ($1, 'payout', $2, 'completed', $3, 'Bet cancelled')`,
      [req.user.id, bet.amount, currentRound.round_id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Bet cancelled',
      slot,
      balance: updatedRows[0].balance / 100,
      bonus_balance: updatedRows[0].bonus_balance / 100,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/game/cashout - manually cash out a specific slot during flying phase
const cashoutValidation = [body('slot').isInt({ min: 1, max: MAX_SLOTS }).withMessage(`Slot must be 1 or ${MAX_SLOTS}`)];

router.post('/cashout', requireAuth, cashoutValidation, handleValidation, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!currentRound || currentRound.phase !== 'flying') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active round to cash out from' });
    }

    const slot = parseInt(req.body.slot, 10);

    const { rows: betRows } = await client.query(
      'SELECT * FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3 FOR UPDATE',
      [currentRound.round_id, req.user.id, slot]
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

    const payoutCents = Math.round(bet.amount * multiplier);

    // Same split as processAutoCashouts: the bonus-funded fraction of the
    // win stays locked in bonus_balance, the real-money fraction becomes
    // withdrawable balance.
    const bonusFraction = bet.amount > 0 ? bet.bonus_amount / bet.amount : 0;
    const payoutToBonus = Math.round(payoutCents * bonusFraction);
    const payoutToBalance = payoutCents - payoutToBonus;

    await client.query(`UPDATE bets SET status = 'cashed_out', cashed_out_at = $1, payout = $2 WHERE id = $3`, [
      multiplier,
      payoutCents,
      bet.id,
    ]);

    const { rows: updatedRows } = await client.query(
      'UPDATE users SET balance = balance + $1, bonus_balance = bonus_balance + $2 WHERE id = $3 RETURNING balance, bonus_balance',
      [payoutToBalance, payoutToBonus, req.user.id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, round_id) VALUES ($1, 'payout', $2, 'completed', $3)`,
      [req.user.id, payoutCents, currentRound.round_id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Cashed out',
      slot,
      multiplier,
      payout: payoutCents / 100,
      balance: updatedRows[0].balance / 100,
      bonus_balance: updatedRows[0].bonus_balance / 100,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/game/my-bets - the current user's bets for the active round (both slots)
router.get('/my-bets', requireAuth, async (req, res, next) => {
  try {
    if (!currentRound) return res.json({ round_id: null, bets: [] });

    const { rows } = await query('SELECT * FROM bets WHERE round_id = $1 AND user_id = $2 ORDER BY slot', [
      currentRound.round_id,
      req.user.id,
    ]);

    res.json({
      round_id: currentRound.round_id,
      bets: rows.map((b) => ({
        slot: b.slot,
        amount: b.amount / 100,
        status: b.status,
        auto_cashout_at: b.auto_cashout_at ? Number(b.auto_cashout_at) : null,
        cashed_out_at: b.cashed_out_at ? Number(b.cashed_out_at) : null,
        payout: b.payout / 100,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Auto-bet-next-round settings (per slot)                             */
/* ------------------------------------------------------------------ */

const autoBetValidation = [
  param('slot').isInt({ min: 1, max: MAX_SLOTS }),
  body('enabled').isBoolean(),
  body('amount')
    .isFloat({ gt: 0, max: 1000000 })
    .withMessage('Amount must be a positive number')
    .custom((value) => {
      if (parseFloat(value) < MIN_BET_BIRR) {
        throw new Error(`Minimum bet is ${MIN_BET_BIRR} ETB`);
      }
      return true;
    }),
  body('auto_cashout_at')
    .optional({ nullable: true })
    .isFloat({ gt: 1.0, max: 10000 })
    .withMessage('Auto-cashout target must be greater than 1.00x'),
];

// PUT /api/game/auto-bet/:slot - enable/disable and configure auto-bet-next-round for a slot
router.put('/auto-bet/:slot', requireAuth, autoBetValidation, handleValidation, async (req, res, next) => {
  try {
    const slot = parseInt(req.params.slot, 10);
    const amountCents = Math.round(Number(req.body.amount) * 100);
    const autoCashoutAt = req.body.auto_cashout_at ? Number(req.body.auto_cashout_at) : null;

    await query(
      `INSERT INTO auto_bet_settings (user_id, slot, enabled, amount, auto_cashout_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, slot)
       DO UPDATE SET enabled = $3, amount = $4, auto_cashout_at = $5`,
      [req.user.id, slot, req.body.enabled, amountCents, autoCashoutAt]
    );

    res.json({ message: 'Auto-bet settings saved', slot, enabled: req.body.enabled });
  } catch (err) {
    next(err);
  }
});

// GET /api/game/auto-bet - fetch the user's current auto-bet settings for both slots
router.get('/auto-bet', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM auto_bet_settings WHERE user_id = $1 ORDER BY slot', [req.user.id]);
    res.json({
      settings: rows.map((s) => ({
        slot: s.slot,
        enabled: s.enabled,
        amount: s.amount / 100,
        auto_cashout_at: s.auto_cashout_at ? Number(s.auto_cashout_at) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/game/history
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT round_id, crash_point, ended_at FROM game_rounds WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 20`
    );
    res.json({ rounds: rows.map((r) => ({ ...r, crash_point: Number(r.crash_point) })) });
  } catch (err) {
    next(err);
  }
});

// GET /api/game/verify/:round_id
router.get('/verify/:round_id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM game_rounds WHERE round_id = $1', [req.params.round_id]);
    const round = rows[0];
    if (!round || !round.server_seed) {
      return res.status(404).json({ error: 'Round not found or not yet completed' });
    }
    const recomputedHash = sha256(round.server_seed);
    const recomputedCrash = seedToCrashPoint(round.server_seed);
    const storedCrash = Number(round.crash_point);

    res.json({
      round_id: round.round_id,
      server_seed: round.server_seed,
      server_seed_hash: round.server_seed_hash,
      crash_point: storedCrash,
      hash_matches: recomputedHash === round.server_seed_hash,
      crash_point_matches: recomputedCrash === storedCrash,
    });
  } catch (err) {
    next(err);
  }
});

// Exposed so operators.js (the seamless-wallet/partner API route set) can
// bet/cash out against the SAME live round and multiplier clock as local
// users, without duplicating the round state machine.
module.exports = {
  router,
  attachSocket,
  getCurrentRound: () => currentRound,
  currentMultiplier,
  broadcast,
  MAX_SLOTS,
};
