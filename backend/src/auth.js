const crypto = require('crypto');
const { supabase } = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * ===========================================================================
 * TELEGRAM AUTH — verification + middleware
 * ===========================================================================
 * When a Mini App opens, Telegram gives the frontend a signed string
 * (`initData`) containing the user's info, signed with an HMAC derived
 * from your bot token. The backend MUST verify that signature before
 * trusting anything in it (user id, name, etc).
 *
 * NEVER trust a user id sent as a plain field in a request body — always
 * derive identity from a freshly-verified initData string.
 *
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * ===========================================================================
 */

/**
 * @param {string} initData - the raw initData query string from the client
 * @param {string} botToken - your Telegram bot token
 * @param {number} maxAgeSeconds - reject initData older than this (replay protection)
 * @returns {{ valid: boolean, user: object|null, error: string|null }}
 */
function verifyInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== 'string') {
    return { valid: false, user: null, error: 'Missing initData' };
  }
  if (!botToken) {
    throw new Error('BOT_TOKEN is required to verify initData');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    return { valid: false, user: null, error: 'initData missing hash' };
  }
  params.delete('hash');

  // Build the data-check-string: all fields except hash, sorted
  // alphabetically, joined as "key=value" with newlines.
  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  // secret_key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

  // computed_hash = HMAC-SHA256(secret_key, data_check_string)
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    return { valid: false, user: null, error: 'Invalid signature' };
  }

  // Replay protection: reject old initData
  const authDate = Number(params.get('auth_date'));
  if (authDate) {
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds > maxAgeSeconds) {
      return { valid: false, user: null, error: 'initData expired' };
    }
  }

  let user = null;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      return { valid: false, user: null, error: 'Malformed user field' };
    }
  }

  return { valid: true, user, error: null };
}

/**
 * Express middleware: verifies the Telegram initData sent in the
 * `Authorization: tma <initData>` header, resolves (or creates) the
 * corresponding user row, and attaches it as `req.user`.
 *
 * This is the single choke point for identity in the whole backend —
 * every protected route trusts req.user.id because it came from here,
 * never from a client-supplied field.
 */
async function requireTelegramAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const initData = authHeader.startsWith('tma ') ? authHeader.slice(4) : null;

    if (!initData) {
      return res.status(401).json({ error: 'Missing Telegram authorization' });
    }

    const { valid, user: tgUser, error } = verifyInitData(initData, BOT_TOKEN);
    if (!valid) {
      return res.status(401).json({ error: `Invalid Telegram auth: ${error}` });
    }
    if (!tgUser || !tgUser.id) {
      return res.status(401).json({ error: 'No user in initData' });
    }

    // Upsert the user so first-time visitors get a row automatically.
    const { data: user, error: dbError } = await supabase
      .from('users')
      .upsert(
        {
          telegram_id: tgUser.id,
          username: tgUser.username || null,
          first_name: tgUser.first_name || null,
          last_name: tgUser.last_name || null,
          language_code: tgUser.language_code || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      )
      .select()
      .single();

    if (dbError) throw dbError;

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account suspended', reason: user.ban_reason });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Admin-only route guard. Checked via an `x-admin-telegram-id` header
 * rather than requireTelegramAuth, since admins may use a separate
 * admin panel rather than the player-facing Mini App.
 */
async function requireAdmin(req, res, next) {
  try {
    const telegramId = req.headers['x-admin-telegram-id'];
    if (!telegramId) {
      return res.status(401).json({ error: 'Missing admin identity' });
    }

    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (error) throw error;
    if (!admin) {
      return res.status(403).json({ error: 'Not an admin' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

function requireOwner(req, res, next) {
  if (!req.admin || req.admin.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

module.exports = { verifyInitData, requireTelegramAuth, requireAdmin, requireOwner };
