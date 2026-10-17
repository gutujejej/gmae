// Who is using each bot's Mini App right now. In memory (one backend instance).
// A player counts as "online" if the app made a signed request in the last few minutes.
const seen = new Map(); // botId -> Map(telegramId -> lastSeenMs)
const WINDOW_MS = 3 * 60 * 1000;

function touch(botId, tg) {
  let m = seen.get(botId);
  if (!m) { m = new Map(); seen.set(botId, m); }
  m.set(tg, Date.now());
}
function online(botId, windowMs = WINDOW_MS) {
  const m = seen.get(botId); if (!m) return 0;
  const cut = Date.now() - windowMs; let n = 0;
  for (const [tg, t] of m) { if (t >= cut) n++; else if (t < Date.now() - 30 * 60 * 1000) m.delete(tg); }
  return n;
}
module.exports = { touch, online };
