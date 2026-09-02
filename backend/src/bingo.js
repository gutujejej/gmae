/* ====================================================================== */
/*  bingo.js                                                               */
/*  75-ball Bingo: fixed 45s join window, then numbers are called one at a */
/*  time until someone completes a line (row, column, or diagonal) on a    */
/*  card they hold. Winner(s) split the pot - stake_amount minus the       */
/*  platform's per-cartela cut, times how many cartelas joined that round -*/
/*  evenly if more than one player completes a line on the same call.      */
/*                                                                          */
/*  Mirrors game.js's architecture: module-level currentRound state, a      */
/*  broadcast() helper over a shared Socket.IO instance, DB writes for      */
/*  round history. Runs as its own independent round clock alongside       */
/*  Aviator's - the two games share nothing except users.balance.          */
/* ====================================================================== */

const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { query, pool } = require('./core');
const { requireAuth } = require('./users');

const router = express.Router();

const JOIN_PHASE_MS = 45000; // 45s window to pick cartelas before the round locks
const CALL_INTERVAL_MS = 3500; // time between each number being called
const POST_ROUND_MS = 6000; // pause after a round ends before the next join window opens
const MAX_CARDS_PER_PLAYER = 2;
const TOTAL_BALLS = 75;

let currentRound = null; // { round_id, status, stakeCents, cutCents, calledNumbers: [], joinDeadline }
let ioRef = null;
let roundTimer = null;

/* ==================================================================== */
/*  Settings - stake/cut amount, admin-configurable                      */
/* ==================================================================== */

async function getBingoPricing() {
  const { rows } = await query(
    `SELECT key, value FROM platform_settings WHERE key IN ('bingo_stake_birr', 'bingo_platform_cut_birr')`
  );
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const stakeBirr = parseFloat(settings.bingo_stake_birr ?? '10');
  const cutBirr = parseFloat(settings.bingo_platform_cut_birr ?? '2');
  return { stakeCents: Math.round(stakeBirr * 100), cutCents: Math.round(cutBirr * 100) };
}

function generateRoundId() {
  return `BNG-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ==================================================================== */
/*  Win detection                                                        */
/*  Cards are stored as a flat 25-element row-major array (see             */
/*  generate-bingo-cartelas.js); index 12 (center) is always the FREE      */
/*  space and counts as automatically marked.                              */
/* ==================================================================== */

const LINES = [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

function hasWinningLine(cardNumbers, calledSet) {
  return LINES.some((line) => line.every((idx) => cardNumbers[idx] === null || calledSet.has(cardNumbers[idx])));
}

/* ==================================================================== */
/*  Round state machine                                                  */
/* ==================================================================== */

async function startJoinPhase() {
  const { stakeCents, cutCents } = await getBingoPricing();
  const round_id = generateRoundId();
  const joinDeadline = Date.now() + JOIN_PHASE_MS;

  currentRound = {
    round_id,
    status: 'waiting',
    stakeCents,
    cutCents,
    calledNumbers: [],
    joinDeadline,
  };

  await query(
    `INSERT INTO bingo_rounds (round_id, status, stake_amount_cents, platform_cut_cents, started_at)
     VALUES ($1, 'waiting', $2, $3, now())`,
    [round_id, stakeCents, cutCents]
  );

  broadcast('bingo:waiting', {
    round_id,
    stake_amount: stakeCents / 100,
    join_seconds: JOIN_PHASE_MS / 1000,
  });

  roundTimer = setTimeout(checkJoinPhaseEnd, JOIN_PHASE_MS);
}

async function checkJoinPhaseEnd() {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM bingo_entries WHERE round_id = $1', [
    currentRound.round_id,
  ]);
  const playerCount = rows[0].count;

  if (playerCount === 0) {
    await query(`UPDATE bingo_rounds SET status = 'finished', ended_at = now() WHERE round_id = $1`, [
      currentRound.round_id,
    ]);
    broadcast('bingo:restarted', { round_id: currentRound.round_id, reason: 'no_players' });
    startJoinPhase();
    return;
  }

  await startPlayingPhase();
}

async function startPlayingPhase() {
  currentRound.status = 'playing';
  await query(`UPDATE bingo_rounds SET status = 'playing' WHERE round_id = $1`, [currentRound.round_id]);

  const { rows: entryRows } = await query(`SELECT COUNT(*)::int AS count FROM bingo_entries WHERE round_id = $1`, [
    currentRound.round_id,
  ]);
  broadcast('bingo:playing', { round_id: currentRound.round_id, cartelas_in_play: entryRows[0].count });

  roundTimer = setTimeout(callNextNumber, CALL_INTERVAL_MS);
}

async function callNextNumber() {
  if (!currentRound || currentRound.status !== 'playing') return;

  const remaining = [];
  for (let n = 1; n <= TOTAL_BALLS; n++) {
    if (!currentRound.calledNumbers.includes(n)) remaining.push(n);
  }

  if (remaining.length === 0) {
    await endRound([], []);
    return;
  }

  const nextNumber = remaining[Math.floor(Math.random() * remaining.length)];
  currentRound.calledNumbers.push(nextNumber);

  await query(`UPDATE bingo_rounds SET called_numbers = $1 WHERE round_id = $2`, [
    JSON.stringify(currentRound.calledNumbers),
    currentRound.round_id,
  ]);

  broadcast('bingo:number_called', {
    round_id: currentRound.round_id,
    number: nextNumber,
    called_numbers: currentRound.calledNumbers,
  });

  const winners = await findWinners();
  if (winners.length > 0) {
    await endRound(
      winners.map((w) => w.user_id),
      winners.map((w) => w.card_number)
    );
    return;
  }

  roundTimer = setTimeout(callNextNumber, CALL_INTERVAL_MS);
}

async function findWinners() {
  const { rows: entries } = await query(
    `SELECT be.user_id, be.card_number, bc.numbers
     FROM bingo_entries be
     JOIN bingo_cartelas bc ON bc.card_number = be.card_number
     WHERE be.round_id = $1`,
    [currentRound.round_id]
  );

  const calledSet = new Set(currentRound.calledNumbers);
  const winners = [];
  for (const entry of entries) {
    if (hasWinningLine(entry.numbers, calledSet)) {
      winners.push({ user_id: entry.user_id, card_number: entry.card_number });
    }
  }
  return winners;
}

async function endRound(winnerUserIds, winningCardNumbers) {
  clearTimeout(roundTimer);
  currentRound.status = 'finished';

  const { rows: entryRows } = await query('SELECT COUNT(*)::int AS count FROM bingo_entries WHERE round_id = $1', [
    currentRound.round_id,
  ]);
  const totalCartelas = entryRows[0].count;
  const potCents = (currentRound.stakeCents - currentRound.cutCents) * totalCartelas;
  const winnerCount = winnerUserIds.length;
  const payoutEachCents = winnerCount > 0 ? Math.floor(potCents / winnerCount) : 0;

  if (winnerCount > 0) {
    const distinctWinnerIds = [...new Set(winnerUserIds)];
    for (const userId of distinctWinnerIds) {
      await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payoutEachCents, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, status, round_id, note) VALUES ($1, 'payout', $2, 'completed', $3, 'Bingo win')`,
        [userId, payoutEachCents, currentRound.round_id]
      );
    }
  }

  await query(
    `UPDATE bingo_rounds
     SET status = 'finished', winner_user_ids = $1, winning_card_numbers = $2, payout_each_cents = $3, ended_at = now()
     WHERE round_id = $4`,
    [JSON.stringify(winnerUserIds), JSON.stringify(winningCardNumbers), payoutEachCents, currentRound.round_id]
  );

  let winnerDetails = [];
  if (winnerUserIds.length > 0) {
    const { rows: userRows } = await query(`SELECT id, username FROM users WHERE id = ANY($1::int[])`, [
      winnerUserIds,
    ]);
    const usernameById = Object.fromEntries(userRows.map((u) => [u.id, u.username]));
    winnerDetails = winnerUserIds.map((userId, i) => ({
      user_id: userId,
      username: usernameById[userId] || 'Player',
      card_number: winningCardNumbers[i],
    }));
  }

  broadcast('bingo:round_ended', {
    round_id: currentRound.round_id,
    winners: winnerDetails,
    payout_each: payoutEachCents / 100,
    total_cartelas: totalCartelas,
    called_numbers: currentRound.calledNumbers,
  });

  roundTimer = setTimeout(startJoinPhase, POST_ROUND_MS);
}

function broadcast(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}

function attachBingoSocket(io) {
  ioRef = io;

  io.on('connection', (socket) => {
    if (currentRound) {
      socket.emit(`bingo:${currentRound.status}`, {
        round_id: currentRound.round_id,
        called_numbers: currentRound.calledNumbers,
      });
    }
  });

  if (!currentRound) startJoinPhase();
}

/* ==================================================================== */
/*  HTTP routes                                                          */
/* ==================================================================== */

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

router.get('/state', requireAuth, async (req, res) => {
  if (!currentRound) return res.json({ round: null });

  const { rows: myEntries } = await query(
    `SELECT be.card_number, bc.numbers
     FROM bingo_entries be
     JOIN bingo_cartelas bc ON bc.card_number = be.card_number
     WHERE be.round_id = $1 AND be.user_id = $2`,
    [currentRound.round_id, req.user.id]
  );

  const { rows: playerCountRows } = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS players, COUNT(*)::int AS cartelas FROM bingo_entries WHERE round_id = $1`,
    [currentRound.round_id]
  );

  res.json({
    round_id: currentRound.round_id,
    status: currentRound.status,
    stake_amount: currentRound.stakeCents / 100,
    called_numbers: currentRound.calledNumbers,
    join_deadline: currentRound.status === 'waiting' ? currentRound.joinDeadline : null,
    my_cartelas: myEntries.map((e) => ({ card_number: e.card_number, numbers: e.numbers })),
    players: playerCountRows[0].players,
    cartelas_in_play: playerCountRows[0].cartelas,
  });
});

router.get('/cartelas', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT card_number, numbers FROM bingo_cartelas ORDER BY card_number ASC');
    res.json({ cartelas: rows });
  } catch (err) {
    next(err);
  }
});

const joinValidation = [body('card_number').isInt({ min: 1 }).withMessage('Invalid card number')];

router.post('/join', requireAuth, joinValidation, handleValidation, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!currentRound || currentRound.status !== 'waiting') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Joining is closed for this round' });
    }

    const cardNumber = parseInt(req.body.card_number, 10);

    const { rows: cardRows } = await client.query('SELECT card_number FROM bingo_cartelas WHERE card_number = $1', [
      cardNumber,
    ]);
    if (cardRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That cartela does not exist' });
    }

    const { rows: myEntries } = await client.query(
      'SELECT id FROM bingo_entries WHERE round_id = $1 AND user_id = $2',
      [currentRound.round_id, req.user.id]
    );
    if (myEntries.length >= MAX_CARDS_PER_PLAYER) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `You can only join with up to ${MAX_CARDS_PER_PLAYER} cartelas per round` });
    }

    const { rows: userRows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [
      req.user.id,
    ]);
    if (!userRows[0] || userRows[0].balance < currentRound.stakeCents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    let insertResult;
    try {
      insertResult = await client.query(
        'INSERT INTO bingo_entries (round_id, user_id, card_number) VALUES ($1, $2, $3) RETURNING id',
        [currentRound.round_id, req.user.id, cardNumber]
      );
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That cartela was just taken by another player - pick a different one' });
      }
      throw err;
    }

    const { rows: updatedRows } = await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2 RETURNING balance',
      [currentRound.stakeCents, req.user.id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, round_id, note) VALUES ($1, 'bet', $2, 'completed', $3, 'Bingo stake')`,
      [req.user.id, currentRound.stakeCents, currentRound.round_id]
    );

    await client.query('COMMIT');

    const { rows: cardData } = await query('SELECT numbers FROM bingo_cartelas WHERE card_number = $1', [
      cardNumber,
    ]);

    broadcast('bingo:player_joined', { round_id: currentRound.round_id, card_number: cardNumber });

    res.status(201).json({
      message: 'Joined',
      card_number: cardNumber,
      numbers: cardData[0].numbers,
      balance: updatedRows[0].balance / 100,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT round_id, winner_user_ids, winning_card_numbers, payout_each_cents, ended_at
       FROM bingo_rounds WHERE status = 'finished' ORDER BY ended_at DESC LIMIT 20`
    );
    res.json({
      rounds: rows.map((r) => ({
        round_id: r.round_id,
        winner_count: (r.winner_user_ids || []).length,
        payout_each: (r.payout_each_cents || 0) / 100,
        ended_at: r.ended_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, attachBingoSocket };
