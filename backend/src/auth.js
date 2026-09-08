const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

/**
 * ===========================================================================
 * PLAYER AUTH — Telegram initData verification (unchanged design)
 * ===========================================================================
 * When a Mini App opens, Telegram gives the frontend a signed string
 * (`initData`) containing the user's info, signed with an HMAC derived
 * from your bot token. The backend MUST verify that signature before
 * trusting anything in it (user id, name, etc).
 *
 * Players never log in with a password — this is the only auth path for
 * them. Admins use JWT/password instead (see below); the two systems
 * never mix.
 *
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * ===========================================================================
 */
function verifyInitData(initData, botToken = BOT_TOKEN, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== 'string') {
    return { valid: false, user: null, error: 'Missing initData' };
  }
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to verify initData');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, user: null, error: 'initData missing hash' };
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return { valid: false, user: null, error: 'Invalid signature' };
  }

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
 * corresponding player row, and attaches it as `req.user`.
 */
async function requireTelegramAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const initData = authHeader.startsWith('tma ') ? authHeader.slice(4) : null;

    if (!initData) return res.status(401).json({ error: 'Missing Telegram authorization' });

    const { valid, user: tgUser, error } = verifyInitData(initData);
    if (!valid) return res.status(401).json({ error: `Invalid Telegram auth: ${error}` });
    if (!tgUser || !tgUser.id) return res.status(401).json({ error: 'No user in initData' });

    const telegramId = BigInt(tgUser.id);

    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        username: tgUser.username || null,
        firstName: tgUser.first_name || null,
        lastName: tgUser.last_name || null,
        languageCode: tgUser.language_code || null,
      },
      create: {
        telegramId,
        username: tgUser.username || null,
        firstName: tgUser.first_name || null,
        lastName: tgUser.last_name || null,
        languageCode: tgUser.language_code || null,
      },
    });

    if (user.isBanned) {
      return res.status(403).json({ error: 'Account suspended', reason: user.banReason });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * ===========================================================================
 * ADMIN AUTH — JWT + password login, matching your existing project
 * ===========================================================================
 * Completely separate identity system from players. An Admin has a
 * username/email/password, logs in via POST /api/admin/login, and gets a
 * JWT to send as `Authorization: Bearer <token>` on subsequent requests.
 * ===========================================================================
 */

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signAdminToken(admin) {
  return jwt.sign({ adminId: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Express middleware: verifies the JWT in `Authorization: Bearer <token>` and attaches `req.admin`. */
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing admin token' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const admin = await prisma.admin.findUnique({ where: { id: payload.adminId } });
    if (!admin) return res.status(403).json({ error: 'Admin not found' });

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

/**
 * Creates the seed admin from SEED_ADMIN_* env vars if no admin exists
 * yet. Call this once at server startup — matches the SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD / SEED_ADMIN_USERNAME pattern from your other
 * project.
 */
async function ensureSeedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const username = process.env.SEED_ADMIN_USERNAME;

  if (!email || !password || !username) {
    console.warn('SEED_ADMIN_EMAIL/PASSWORD/USERNAME not fully set — skipping seed admin creation.');
    return;
  }

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) return;

  const passwordHash = await hashPassword(password);
  await prisma.admin.create({
    data: { email, username, passwordHash, role: 'owner' },
  });
  console.log(`Seed admin created: ${email}`);
}

module.exports = {
  verifyInitData,
  requireTelegramAuth,
  hashPassword,
  verifyPassword,
  signAdminToken,
  requireAdmin,
  requireOwner,
  ensureSeedAdmin,
};
