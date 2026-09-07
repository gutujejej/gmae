const { supabase, ledger } = require('./db');
const { verifyInitData } = require('./auth');

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * ===========================================================================
 * BINGO ENGINE — pure logic, zero I/O, fully deterministic given its inputs
 * ===========================================================================
 * Card layout (standard 75-ball / US bingo), flat array of 25, row-major:
 *   Column B: 1–15   Column I: 16–30   Column N: 31–45 (center=FREE)
 *   Column G: 46–60  Column O: 61–75
 *   index 12 (center) is always 0, representing FREE.
 * ===========================================================================
 */

const COLUMN_RANGES = [
  [1, 15],   // B
  [16, 30],  // I
  [31, 45],  // N
  [46, 60],  // G
  [61, 75],  // O
];

const FREE_SPACE_INDEX = 12;
const CARD_SIZE = 25;
const NUMBERS_PER_COLUMN = 5;
const TOTAL_BALLS = 75;

/** Fisher-Yates shuffle. Accepts an injectable RNG for testability. */
function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function range(start, end) {
  const out = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
}

/** Generates one valid, randomized 75-ball bingo card (flat 25-array, center=0/FREE). */
function generateCard(rng = Math.random) {
  const card = new Array(CARD_SIZE).fill(0);

  COLUMN_RANGES.forEach(([lo, hi], col) => {
    const needed = col === 2 ? NUMBERS_PER_COLUMN - 1 : NUMBERS_PER_COLUMN; // center col skips the FREE slot
    const pool = shuffle(range(lo, hi), rng).slice(0, needed);
    let poolIdx = 0;
    for (let row = 0; row < NUMBERS_PER_COLUMN; row++) {
      const idx = row * 5 + col;
      if (idx === FREE_SPACE_INDEX) {
        card[idx] = 0;
        continue;
      }
      card[idx] = pool[poolIdx++];
    }
  });

  return card;
}

/** Creates a shuffled draw sequence of all 75 balls for a room. */
function createDrawSequence(rng = Math.random) {
  return shuffle(range(1, TOTAL_BALLS), rng);
}

/** Winning patterns, expressed as arrays of card indices (0-based, 5x5 grid). */
const PATTERNS = {
  line: (() => {
    const lines = [];
    for (let r = 0; r < 5; r++) lines.push(Array.from({ length: 5 }, (_, c) => r * 5 + c)); // rows
    for (let c = 0; c < 5; c++) lines.push(Array.from({ length: 5 }, (_, r) => r * 5 + c)); // columns
    lines.push([0, 6, 12, 18, 24]); // diagonal
    lines.push([4, 8, 12, 16, 20]); // diagonal
    return lines;
  })(),
  four_corners: [[0, 4, 20, 24]],
  full_house: [Array.from({ length: 25 }, (_, i) => i)],
};

/** Checks whether a card satisfies a pattern given the numbers drawn so far. FREE always counts as marked. */
function checkPattern(card, drawnSet, patternName) {
  const candidateLines = PATTERNS[patternName];
  if (!candidateLines) return { valid: false, matchedIndices: null };

  for (const indices of candidateLines) {
    const allMarked = indices.every((idx) => {
      const val = card[idx];
      return val === 0 || drawnSet.has(val);
    });
    if (allMarked) return { valid: true, matchedIndices: indices };
  }
  return { valid: false, matchedIndices: null };
}

/** Validates a win claim against the room's draw history. Server-authoritative — never trust client state. */
function validateWinClaim(card, drawnNumbers, patternName = 'line') {
  return checkPattern(card, new Set(drawnNumbers), patternName);
}

/**
 * ===========================================================================
 * ROOM MANAGER — live, in-memory state for active bingo rooms
 * ===========================================================================
 * The server is fully authoritative: clients never generate cards, never
 * draw numbers, and never decide whether a "Bingo!" is valid. Every draw
 * and every valid win is persisted to Postgres as it happens, so a
 * restart or dispute can be resolved from the DB alone.
 *
 * One process holds one room's live state. If you horizontally scale the
 * backend, a room must be pinned to one instance, or the draw loop needs
 * to move to a dedicated single-writer worker. For a first version, a
 * single Railway instance is the simplest correct option.
 * ===========================================================================
 */
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function roomKey(roomId) {
  return `room:${roomId}`;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, object>} roomId -> live state */
    this.rooms = new Map();
  }

  async createRoom({ stake, maxPlayers = 100, houseFeepct = 10, drawIntervalMs = 4000, createdBy = null }) {
    const code = generateRoomCode();

    const { data: room, error } = await supabase
      .from('rooms')
      .insert({
        code,
        stake,
        max_players: maxPlayers,
        house_fee_pct: houseFeepct,
        draw_interval_ms: drawIntervalMs,
        created_by: createdBy,
        status: 'waiting',
      })
      .select()
      .single();

    if (error) throw error;

    this.rooms.set(room.id, {
      room,
      players: new Map(), // userId -> { card, marked, playerRowId }
      drawSequence: [],
      drawnNumbers: [],
      drawTimer: null,
      status: 'waiting',
    });

    return room;
  }

  getLiveRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /** Adds a player to a waiting room: debits stake, generates their card, persists room_players. */
  async joinRoom({ roomId, userId }) {
    const live = this.rooms.get(roomId);
    if (!live) throw new AppError('Room not found', 404);
    if (live.status !== 'waiting') throw new AppError('Room already started', 409);
    if (live.players.size >= live.room.max_players) throw new AppError('Room is full', 409);
    if (live.players.has(userId)) throw new AppError('Already joined this room', 409);

    const stake = Number(live.room.stake);

    if (stake > 0) {
      const sufficient = await ledger.hasSufficientBalance(userId, stake);
      if (!sufficient) throw new AppError('Insufficient balance', 402);
    }

    const card = generateCard();

    if (stake > 0) {
      await ledger.debitRoomStake({ userId, amount: stake, roomId });
    }

    const { data: playerRow, error } = await supabase
      .from('room_players')
      .insert({ room_id: roomId, user_id: userId, card, marked: [], stake_paid: stake, status: 'active' })
      .select()
      .single();

    if (error) {
      if (stake > 0) await ledger.refundRoomStake({ userId, amount: stake, roomId });
      throw error;
    }

    live.players.set(userId, { card, marked: new Set(), playerRowId: playerRow.id });
    this.broadcastRoomState(roomId);

    return { card, playerCount: live.players.size };
  }

  /** Starts the draw loop for a room. */
  async startRoom(roomId) {
    const live = this.rooms.get(roomId);
    if (!live) throw new AppError('Room not found', 404);
    if (live.status !== 'waiting') throw new AppError('Room already started', 409);
    if (live.players.size < 1) throw new AppError('Need at least 1 player to start', 400);

    live.status = 'active';
    live.drawSequence = createDrawSequence();
    live.drawnNumbers = [];

    await supabase.from('rooms').update({ status: 'active', started_at: new Date().toISOString() }).eq('id', roomId);

    this.io.to(roomKey(roomId)).emit('room:started', { roomId });
    this._scheduleNextDraw(roomId);
  }

  _scheduleNextDraw(roomId) {
    const live = this.rooms.get(roomId);
    if (!live || live.status !== 'active') return;
    live.drawTimer = setTimeout(() => this._drawNext(roomId), live.room.draw_interval_ms);
  }

  async _drawNext(roomId) {
    const live = this.rooms.get(roomId);
    if (!live || live.status !== 'active') return;

    if (live.drawnNumbers.length >= live.drawSequence.length) {
      await this._cancelRoom(roomId, 'No winner — all balls drawn');
      return;
    }

    const number = live.drawSequence[live.drawnNumbers.length];
    const sequence = live.drawnNumbers.length + 1;
    live.drawnNumbers.push(number);

    // Persist BEFORE broadcasting — the DB record is the authoritative audit trail.
    await supabase.from('draws').insert({ room_id: roomId, number, sequence });

    this.io.to(roomKey(roomId)).emit('room:draw', { roomId, number, sequence, drawnNumbers: live.drawnNumbers });
    this._scheduleNextDraw(roomId);
  }

  /** Handles a "Bingo!" claim — validated server-side against actual draw history, never client state. */
  async claimWin({ roomId, userId, pattern = 'line' }) {
    const live = this.rooms.get(roomId);
    if (!live) throw new AppError('Room not found', 404);
    if (live.status !== 'active') throw new AppError('Room is not active', 409);

    const player = live.players.get(userId);
    if (!player) throw new AppError('Not a player in this room', 403);

    const { valid, matchedIndices } = validateWinClaim(player.card, live.drawnNumbers, pattern);

    await supabase.from('win_claims').insert({
      room_id: roomId,
      user_id: userId,
      claimed_pattern: pattern,
      is_valid: valid,
      rejection_reason: valid ? null : 'Pattern not satisfied by current draws',
    });

    if (!valid) throw new AppError('Invalid claim — pattern not satisfied', 400);

    live.status = 'completed';
    if (live.drawTimer) clearTimeout(live.drawTimer);

    const pot = Number(live.room.stake) * live.players.size;
    const houseFee = pot * (Number(live.room.house_fee_pct) / 100);
    const payout = pot - houseFee;

    if (payout > 0) {
      await ledger.creditRoomPayout({ userId, amount: payout, roomId });
    }

    await supabase
      .from('rooms')
      .update({ status: 'completed', ended_at: new Date().toISOString(), winner_user_id: userId, winning_pattern: pattern })
      .eq('id', roomId);

    await supabase.from('room_players').update({ status: 'won' }).eq('room_id', roomId).eq('user_id', userId);

    this.io.to(roomKey(roomId)).emit('room:won', { roomId, winnerId: userId, pattern, matchedIndices, payout });
    this.rooms.delete(roomId);

    return { payout, matchedIndices };
  }

  /** Voids a room and refunds every player's stake. */
  async _cancelRoom(roomId, reason) {
    const live = this.rooms.get(roomId);
    if (!live) return;

    if (live.drawTimer) clearTimeout(live.drawTimer);

    const stake = Number(live.room.stake);
    if (stake > 0) {
      for (const userId of live.players.keys()) {
        await ledger.refundRoomStake({ userId, amount: stake, roomId });
      }
    }

    await supabase.from('rooms').update({ status: 'cancelled', ended_at: new Date().toISOString() }).eq('id', roomId);
    this.io.to(roomKey(roomId)).emit('room:cancelled', { roomId, reason });
    this.rooms.delete(roomId);
  }

  broadcastRoomState(roomId) {
    const live = this.rooms.get(roomId);
    if (!live) return;
    this.io.to(roomKey(roomId)).emit('room:state', {
      roomId,
      status: live.status,
      playerCount: live.players.size,
      maxPlayers: live.room.max_players,
      stake: live.room.stake,
    });
  }
}

/**
 * ===========================================================================
 * SOCKET.IO WIRING
 * ===========================================================================
 * Authenticates each connecting socket via the same Telegram initData
 * verification used for HTTP, then registers event handlers that delegate
 * to the shared RoomManager instance.
 * ===========================================================================
 */
function registerSocketHandlers(io, roomManager) {
  io.use(async (socket, next) => {
    try {
      const initData = socket.handshake.auth?.initData;
      const { valid, user: tgUser, error } = verifyInitData(initData, BOT_TOKEN);
      if (!valid) return next(new Error(`Unauthorized: ${error}`));

      const { data: user, error: dbError } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', tgUser.id)
        .maybeSingle();

      if (dbError) throw dbError;
      if (!user) return next(new Error('User not found — call REST API first to register'));
      if (user.is_banned) return next(new Error('Account suspended'));

      socket.data.userId = user.id;
      socket.data.telegramId = user.telegram_id;
      next();
    } catch (err) {
      console.error('Socket auth error:', err);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    socket.on('room:join', async ({ roomId }, callback) => {
      try {
        const result = await roomManager.joinRoom({ roomId, userId });
        socket.join(roomKey(roomId));
        callback?.({ ok: true, ...result });
      } catch (err) {
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on('room:start', async ({ roomId }, callback) => {
      try {
        await roomManager.startRoom(roomId);
        callback?.({ ok: true });
      } catch (err) {
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on('room:claim', async ({ roomId, pattern }, callback) => {
      try {
        const result = await roomManager.claimWin({ roomId, userId, pattern });
        callback?.({ ok: true, ...result });
      } catch (err) {
        callback?.({ ok: false, error: err.message });
      }
    });

    socket.on('disconnect', () => {
      // A disconnect does not remove the player or refund their stake.
      // Cards persist through reconnects — frontend re-fetches state.
    });
  });
}

module.exports = {
  generateCard,
  createDrawSequence,
  validateWinClaim,
  PATTERNS,
  TOTAL_BALLS,
  FREE_SPACE_INDEX,
  COLUMN_RANGES,
  RoomManager,
  AppError,
  roomKey,
  registerSocketHandlers,
};
