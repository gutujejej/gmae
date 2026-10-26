// Loads a bot (decrypts its token once, caches it briefly) and builds the context used everywhere.
const { createApi } = require('./jb-tg');
const { decrypt } = require('./jb-crypto');
const { merge } = require('./jb-settings');

module.exports = function createRegistry(db, publicUrl) {
  const cache = new Map();            // botId -> { exp, ctx }
  const TTL = 20 * 1000;
  async function ctxFor(botId) {
    const c = cache.get(Number(botId));
    if (c && c.exp > Date.now()) return c.ctx;
    const r = await db.from('jb_bots').select('*').eq('id', Number(botId)).maybeSingle();
    if (!r.data) return null;
    const bot = r.data;
    const ctx = { db, bot, S: merge(bot.settings), api: createApi(decrypt(bot.token_enc)), publicUrl };
    cache.set(Number(botId), { exp: Date.now() + TTL, ctx });
    return ctx;
  }
  const invalidate = (botId) => { if (botId == null) cache.clear(); else cache.delete(Number(botId)); };
  async function activeBots() { const r = await db.from('jb_bots').select('id').eq('status', 'active'); return (r.data || []).map((b) => b.id); }
  return { ctxFor, invalidate, activeBots };
};
