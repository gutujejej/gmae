// Bingo game engine, wallet, deposit & withdrawal routes.
// Mounted from server.js — see bottom of this file for `module.exports`.
//
// Design notes:
// - Rounds and ball-calling live entirely on the server (setInterval per
//   active round). Clients only ever read state and submit "I have bingo" —
//   the server independently re-checks the claim against its own called
//   list before paying out, so a modified client can't fake a win.
// - Each bot has at most one OPEN round per stake at a time (waiting or
//   playing); new joiners land in the open one, or a fresh one is created.

const crypto = require('crypto');

const COLS = { B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75] };
const COL_KEYS = ['B', 'I', 'N', 'G', 'O'];
const JOIN_WINDOW_MS = 20_000;   // how long a room stays "waiting" for players
const CALL_INTERVAL_MS = 4_000;  // gap between ball calls once playing
const MAX_CARDS = 100;           // card picker size (1..100)

function shuffledRange(min, max) {
  const arr = [];
  for (let i = min; i <= max; i++) arr.push(i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deterministic card for a given card_no so every player who picks the same
// number in the SAME round would (in principle) get the same card, but each
// round reshuffles, so cards differ round to round.
function generateCardNumbers() {
  const cols = COL_KEYS.map((k) => shuffledRange(COLS[k][0], COLS[k][1]).slice(0, 5));
  const flat = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      flat.push(r === 2 && c === 2 ? 0 : cols[c][r]); // center = FREE = 0
    }
  }
  return flat;
}

function checkWin(numbers, marked) {
  const at = (r, c) => marked[r * 5 + c];
  for (let r = 0; r < 5; r++) if ([0, 1, 2, 3, 4].every((c) => at(r, c))) return true;
  for (let c = 0; c < 5; c++) if ([0, 1, 2, 3, 4].every((r) => at(r, c))) return true;
  if ([0, 1, 2, 3, 4].every((i) => at(i, i))) return true;
  if ([0, 1, 2, 3, 4].every((i) => at(i, 4 - i))) return true;
  return false;
}

function colOf(n) {
  for (const k of COL_KEYS) if (n >= COLS[k][0] && n <= COLS[k][1]) return k;
  return null;
}

module.exports = function attachBingo(app, db, { requireAdmin, miniAuth, mainMenuFor, sendMessage }) {
  // ---- in-memory round timers, keyed by round id ----
  const timers = new Map(); // roundId -> intervalHandle

  function stopTimer(roundId) {
    const h = timers.get(roundId);
    if (h) { clearInterval(h); timers.delete(roundId); }
  }

  async function getOpenRound(botId, stake) {
    const { data, error } = await db.from('bingo_rounds')
      .select('*').eq('bot_id', botId).eq('stake', stake)
      .in('status', ['waiting', 'playing']).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createRound(botId, stake) {
    const { data, error } = await db.from('bingo_rounds')
      .insert({ bot_id: botId, stake, status: 'waiting' }).select().single();
    if (error) throw error;
    scheduleStart(data.id);
    return data;
  }

  function scheduleStart(roundId) {
    setTimeout(() => startRound(roundId).catch(console.error), JOIN_WINDOW_MS);
  }

  async function startRound(roundId) {
    const { data: round } = await db.from('bingo_rounds').select('*').eq('id', roundId).maybeSingle();
    if (!round || round.status !== 'waiting') return;

    const { count } = await db.from('bingo_cards')
      .select('id', { count: 'exact', head: true }).eq('round_id', roundId);

    if (!count) {
      // nobody joined — just close it quietly, no money moved
      await db.from('bingo_rounds').update({ status: 'finished', finished_at: new Date().toISOString() }).eq('id', roundId);
      return;
    }

    await db.from('bingo_rounds').update({ status: 'playing', started_at: new Date().toISOString() }).eq('id', roundId);

    const bag = shuffledRange(1, 75);
    let idx = 0;

    const handle = setInterval(async () => {
      try {
        const { data: r } = await db.from('bingo_rounds').select('*').eq('id', roundId).maybeSingle();
        if (!r || r.status !== 'playing') { stopTimer(roundId); return; }

        if (idx >= bag.length) { stopTimer(roundId); return; } // ran out of balls, nobody won (rare)
        const n = bag[idx++];
        const called = [...r.called_numbers, n];
        await db.from('bingo_rounds').update({ called_numbers: called }).eq('id', roundId);

        // auto-mark this number on every card in the round
        const { data: cards } = await db.from('bingo_cards').select('*').eq('round_id', roundId);
        for (const card of cards) {
          const pos = card.numbers.indexOf(n);
          if (pos === -1) continue;
          const marked = [...card.marked];
          marked[pos] = true;
          await db.from('bingo_cards').update({ marked }).eq('id', card.id);
        }
      } catch (err) {
        console.error('bingo call tick error:', err);
      }
    }, CALL_INTERVAL_MS);

    timers.set(roundId, handle);
  }

  // Ends a round after a winner is confirmed: pays out, marks finished.
  async function finishRound(round, winnerTelegramId, winAmount) {
    stopTimer(round.id);
    await db.from('bingo_rounds').update({
      status: 'finished', winner_telegram_id: winnerTelegramId, finished_at: new Date().toISOString(),
    }).eq('id', round.id);
    await db.rpc('bingo_payout', { p_bot_id: round.bot_id, p_telegram_id: winnerTelegramId, p_amount: winAmount });
  }

  /* ================================================================ */
  /* Mini App API — bingo                                              */
  /* ================================================================ */

  // Current state for the game screen: room info, my card (if joined), called numbers.
  app.get('/api/mini/:botId/bingo/state', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const bot = a.entry.row;
      const stake = Number(req.query.stake) || (bot.bingo_stakes && bot.bingo_stakes[0]) || 10;

      const { data: user } = await db.from('bot_users').select('game_balance')
        .eq('bot_id', bot.id).eq('telegram_id', a.user.id).maybeSingle();

      let round = await getOpenRound(bot.id, stake);
      let myCard = null;
      if (round) {
        const { data } = await db.from('bingo_cards').select('*')
          .eq('round_id', round.id).eq('telegram_id', a.user.id).maybeSingle();
        myCard = data || null;
      }

      const { count: playerCount } = round
        ? await db.from('bingo_cards').select('id', { count: 'exact', head: true }).eq('round_id', round.id)
        : { count: 0 };

      const { count: soldCount } = round
        ? await db.from('bingo_cards').select('id', { count: 'exact', head: true }).eq('round_id', round.id)
        : { count: 0 };

      res.set('Cache-Control', 'no-store');
      res.json({
        name: bot.bingo_name || 'Bingo',
        stakes: bot.bingo_stakes || [10, 20, 50, 100],
        stake,
        balance: Number((user && user.game_balance) || 0),
        round: round ? {
          id: round.id,
          status: round.status,
          calledNumbers: round.called_numbers,
          players: playerCount || 0,
          sold: soldCount || 0,
          pool: Number(round.stake) * (playerCount || 0),
          winnerTelegramId: round.winner_telegram_id || null,
        } : null,
        myCard: myCard ? {
          cardNo: myCard.card_no,
          numbers: myCard.numbers,
          marked: myCard.marked,
          won: myCard.won,
        } : null,
        maxCards: MAX_CARDS,
      });
    } catch (err) {
      console.error('bingo state error:', err);
      res.status(500).json({ error: 'Could not load bingo. Please try again.' });
    }
  });

  // Which card numbers are already taken in the currently open round for a stake.
  app.get('/api/mini/:botId/bingo/taken-cards', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const stake = Number(req.query.stake) || 10;
      const round = await getOpenRound(a.entry.row.id, stake);
      if (!round) return res.json({ taken: [] });
      const { data } = await db.from('bingo_cards').select('card_no').eq('round_id', round.id);
      res.set('Cache-Control', 'no-store');
      res.json({ taken: (data || []).map((c) => c.card_no) });
    } catch (err) {
      console.error('bingo taken-cards error:', err);
      res.status(500).json({ error: 'Could not load. Please try again.' });
    }
  });

  // Join a round with a chosen card number. Debits game_balance atomically.
  app.post('/api/mini/:botId/bingo/join', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const bot = a.entry.row;
      const stake = Number((req.body || {}).stake);
      const cardNo = Number((req.body || {}).cardNo);
      if (!stake || !cardNo || cardNo < 1 || cardNo > MAX_CARDS) {
        return res.status(400).json({ error: 'Invalid stake or card number.' });
      }
      if (bot.bingo_enabled === false) return res.status(403).json({ error: 'Bingo is currently unavailable.' });

      let round = await getOpenRound(bot.id, stake);
      if (!round) round = await createRound(bot.id, stake);
      if (round.status !== 'waiting') {
        return res.status(409).json({ error: 'This round already started. Please wait for the next one.' });
      }

      const { data: existing } = await db.from('bingo_cards')
        .select('id').eq('round_id', round.id).eq('telegram_id', a.user.id).maybeSingle();
      if (existing) return res.status(409).json({ error: 'You already joined this round.' });

      const { data: taken } = await db.from('bingo_cards')
        .select('id').eq('round_id', round.id).eq('card_no', cardNo).maybeSingle();
      if (taken) return res.status(409).json({ error: 'That card was just taken. Pick another.' });

      const { data: joinResult, error: joinErr } = await db.rpc('bingo_join', {
        p_bot_id: bot.id, p_telegram_id: a.user.id, p_amount: stake,
      });
      if (joinErr) throw joinErr;
      const jr = Array.isArray(joinResult) ? joinResult[0] : joinResult;
      if (!jr.ok) return res.status(402).json({ error: 'Insufficient balance. Please deposit first.' });

      const numbers = generateCardNumbers();
      const marked = numbers.map((n) => n === 0); // FREE cell pre-marked
      const { error: cardErr } = await db.from('bingo_cards').insert({
        round_id: round.id, telegram_id: a.user.id, card_no: cardNo, numbers, marked,
      });
      if (cardErr) {
        // roll back the debit if the card insert failed (e.g. race on card_no)
        await db.rpc('bingo_payout', { p_bot_id: bot.id, p_telegram_id: a.user.id, p_amount: stake });
        throw cardErr;
      }

      res.json({ ok: true, roundId: round.id, joinsInSeconds: JOIN_WINDOW_MS / 1000, newBalance: jr.new_balance });
    } catch (err) {
      console.error('bingo join error:', err);
      res.status(500).json({ error: 'Could not join. Please try again.' });
    }
  });

  // Claim BINGO. Server independently verifies the win against its own
  // called-numbers list before paying out — never trusts the client's claim.
  app.post('/api/mini/:botId/bingo/claim', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const bot = a.entry.row;
      const roundId = Number((req.body || {}).roundId);
      const { data: round } = await db.from('bingo_rounds').select('*').eq('id', roundId).maybeSingle();
      if (!round || round.bot_id !== bot.id) return res.status(404).json({ error: 'Round not found.' });
      if (round.status !== 'playing') return res.status(409).json({ error: 'This round is not active.' });

      const { data: card } = await db.from('bingo_cards').select('*')
        .eq('round_id', roundId).eq('telegram_id', a.user.id).maybeSingle();
      if (!card) return res.status(404).json({ error: 'You do not have a card in this round.' });
      if (card.won) return res.status(409).json({ error: 'Already claimed.' });

      // Re-derive "marked" strictly from the server's own called list —
      // never trust card.marked in case of any client/server drift.
      const calledSet = new Set(round.called_numbers);
      const serverMarked = card.numbers.map((n) => n === 0 || calledSet.has(n));
      if (!checkWin(card.numbers, serverMarked)) {
        return res.status(400).json({ error: 'No valid line yet.' });
      }

      // First valid claim wins the whole pool for this round.
      const { count: playerCount } = await db.from('bingo_cards')
        .select('id', { count: 'exact', head: true }).eq('round_id', roundId);
      const pool = Number(round.stake) * (playerCount || 0);
      const payoutPct = Number(bot.bingo_payout_pct || 80) / 100;
      const winAmount = Math.floor(pool * payoutPct);

      await db.from('bingo_cards').update({ won: true }).eq('id', card.id);
      await finishRound(round, a.user.id, winAmount);

      res.json({ ok: true, winAmount });
    } catch (err) {
      console.error('bingo claim error:', err);
      res.status(500).json({ error: 'Could not process claim. Please try again.' });
    }
  });

  /* ================================================================ */
  /* Mini App API — wallet: deposit / withdraw                         */
  /* ================================================================ */

  app.get('/api/mini/:botId/wallet', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const bot = a.entry.row;
      const { data: user } = await db.from('bot_users')
        .select('game_balance,lifetime_deposit,balance').eq('bot_id', bot.id).eq('telegram_id', a.user.id).maybeSingle();
      res.set('Cache-Control', 'no-store');
      res.json({
        gameBalance: Number((user && user.game_balance) || 0),
        bonusBalance: Number((user && user.balance) || 0),
        lifetimeDeposit: Number((user && user.lifetime_deposit) || 0),
        withdrawMinDeposit: Number(bot.withdraw_min_deposit || 100),
        canWithdraw: Number((user && user.lifetime_deposit) || 0) >= Number(bot.withdraw_min_deposit || 100),
        depositPhone: bot.deposit_phone || '0930008319',
      });
    } catch (err) {
      console.error('wallet state error:', err);
      res.status(500).json({ error: 'Could not load wallet.' });
    }
  });

  // Move bonus balance into the game wallet (bonus money is playable per spec).
  app.post('/api/mini/:botId/wallet/use-bonus', async (req, res) => {
    const a = miniAuth(req, res); if (!a) return;
    try {
      const bot = a.entry.row;
      const amount = Number((req.body || {}).amount);
      if (!(amount > 0)) return res.status(400).json({ error: 'Invalid amount.' });

      const { data: user } = await db.from('bot_users').select('balance,game_balance')
        .eq('bot_id', bot.id).eq('telegram_id', a.user.id).maybeSingle();
      if (!user || Number(user.balance) < amount) {
        return res.status(402).json({ error: 'Insufficient bonus balance.' });
      }
      const { error } = await db.from('bot_users').update({
        balance: Number(user.balance) - amount,
        game_balance: Number(user.game_balance) + amount,
      }).eq('bot_id', bot.id).eq('telegram_id', a.user.id);
      if (error) throw error;

      res.json({ ok: true });
    } catch (err) {
      console.error('use-bonus error:', err);
      res.status(500).json({ error: 'Could not transfer. Please try again.' });
    }
  });

  return { checkWin, generateCardNumbers, colOf };
};
