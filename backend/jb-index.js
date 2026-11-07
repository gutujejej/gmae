// Join & Earn bot platform, attached to the main gmae server (same Railway service, same Supabase).
// Own tables (jb_*), own routes (/jb/*), own bots, own admins (managed from the controller bot).
// The mini app page is frontend/join.html on Vercel (https://<your site>/join/BOT_ID, and /join = controller).
// Needs one extra env var: TOKEN_KEY. Optional: FACTORY_BOT_TOKEN, SUPER_ADMIN_IDS.
const crypto = require('crypto');
const { handleUpdate } = require('./jb-bot');
const { createApi } = require('./jb-tg');
const Api = require('./jb-api');
const Jobs = require('./jb-jobs');
const Ctl = require('./jb-controller');
const createRegistry = require('./jb-registry');
const { appUrl } = require('./jb-util');

const factorySecret = (token) => crypto.createHmac('sha256', process.env.TOKEN_KEY || 'x').update(`factory:${token || ''}`).digest('hex').slice(0, 32);

module.exports = function attachJoinBot(app, db, { publicUrl, frontendUrl }) {
  if (!process.env.TOKEN_KEY) {
    console.warn('[joinbot] TOKEN_KEY is not set, so the Join & Earn platform is OFF. Add TOKEN_KEY on Railway to turn it on.');
    return null;
  }
  if (!frontendUrl || !/^https:\/\//i.test(frontendUrl)) {
    console.warn('[joinbot] FRONTEND_URL is missing or not https, so the mini app buttons cannot be built. Join & Earn is OFF.');
    return null;
  }
  process.env.JB_APP_URL = frontendUrl.replace(/\/+$/, '');
  const base = String(publicUrl).replace(/\/+$/, '');
  const factoryToken = process.env.FACTORY_BOT_TOKEN || '';
  const registry = createRegistry(db, base);
  const track = (p) => p.catch((e) => console.error('[joinbot] update error:', e.message));

  app.get('/jb/health', (req, res) => res.json({ ok: true }));

  // Telegram -> bot (one webhook per bot, protected by that bot's own secret)
  app.post('/jb/hook/:botId', async (req, res) => {
    const ctx = await registry.ctxFor(req.params.botId).catch(() => null);
    if (!ctx || req.get('x-telegram-bot-api-secret-token') !== ctx.bot.secret) return res.status(401).json({ ok: false });
    res.json({ ok: true });                       // answer Telegram first, work afterwards
    track(handleUpdate(ctx, req.body || {}));
  });

  if (factoryToken) {
    const fapi = createApi(factoryToken);
    app.post('/jb/factory/:secret', (req, res) => {
      if (req.params.secret !== factorySecret(factoryToken)) return res.status(401).json({ ok: false });
      res.json({ ok: true });
      track(Ctl.handleFactoryUpdate({ db, registry, publicUrl: base }, fapi, req.body || {}));
    });
    fapi.call('setWebhook', { url: `${base}/jb/factory/${factorySecret(factoryToken)}`, allowed_updates: ['message'] })
      .then(() => console.log('[joinbot] controller bot webhook set'))
      .catch((e) => console.error('[joinbot] controller webhook failed:', e.message));
  } else {
    console.warn('[joinbot] FACTORY_BOT_TOKEN is not set: you will have no controller bot to create systems.');
  }

  Api.mount(app, { db, registry, publicUrl: base, factoryToken });
  Jobs.start(registry, db);
  // The server address can change (new Railway domain). Point every active bot's webhook and menu button at it again on each start.
  setTimeout(async () => {
    try {
      for (const id of await registry.activeBots()) {
        try {
          const ctx = await registry.ctxFor(id);
          if (!ctx) continue;
          await ctx.api.call('setWebhook', { url: `${base}/jb/hook/${id}`, secret_token: ctx.bot.secret, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
          await ctx.api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open', web_app: { url: appUrl(base, id) } } }).catch(() => {});
        } catch (e) { console.error(`[joinbot] webhook refresh failed for bot ${id}:`, e.message); }
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log('[joinbot] bot webhooks refreshed');
    } catch (e) { console.error('[joinbot] webhook refresh failed:', e.message); }
  }, 5000);
  console.log('[joinbot] Join & Earn platform mounted at /jb');
  return registry;
};
