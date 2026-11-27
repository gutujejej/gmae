// Lets the registration / first-deposit bonus (bot_users.balance) be played in EVERY game.
//
// Bingo has always done this: when the stake is bigger than the Games wallet, the missing
// amount is moved from the bonus into the wallet just before the bet. This is the same rule,
// shared by Aviator, Keno and Sports, so one bonus works everywhere.
//
// The move is a compare-and-set (only applies if neither balance changed since we read it),
// so two taps at once can never move the same bonus twice. All-or-nothing: if the bonus cannot
// cover the whole shortfall nothing is moved and the game answers "not enough money".
//
// The Games wallet columns game_balance / aviator_balance are kept equal by the database
// trigger (sql/2026-11_unify_wallets_and_logos.sql), so updating aviator_balance is enough.

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// needFromWallet: how much of the stake the wallet itself must hold
// (stake minus anything the game spends from its own bonus first, e.g. the Aviator bonus).
async function coverStake(db, botId, telegramId, needFromWallet) {
  const need = round2(needFromWallet);
  if (!(need > 0)) return { moved: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: u, error } = await db.from('bot_users').select('balance,aviator_balance')
      .eq('bot_id', botId).eq('telegram_id', telegramId).maybeSingle();
    if (error || !u) return { moved: 0 };
    const bonus = round2(u.balance || 0), wallet = round2(u.aviator_balance || 0);
    const shortfall = round2(need - wallet);
    if (shortfall <= 0 || bonus < shortfall) return { moved: 0 };
    const { data: done, error: upErr } = await db.from('bot_users')
      .update({ balance: round2(bonus - shortfall), aviator_balance: round2(wallet + shortfall) })
      .eq('bot_id', botId).eq('telegram_id', telegramId).eq('balance', u.balance).eq('aviator_balance', u.aviator_balance)
      .select('telegram_id');
    if (upErr) return { moved: 0 };
    if (done && done.length) return { moved: shortfall };
    // somebody changed the balance between our read and write: read again
  }
  return { moved: 0 };
}

async function regBonusOf(db, botId, telegramId) {
  const { data } = await db.from('bot_users').select('balance').eq('bot_id', botId).eq('telegram_id', telegramId).maybeSingle();
  return data ? round2(data.balance || 0) : 0;
}

module.exports = { coverStake, regBonusOf };
