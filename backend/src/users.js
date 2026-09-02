/* ====================================================================== */
/*  users.js                                                              */
/*  Merged from: auth.js + wallet.js + wallet_socket.js                   */
/*  (Mechanical merge only — no logic changed. Kept in three clearly      */
/*  marked sections below so each original file's code stays traceable.) */
/* ====================================================================== */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { query, pool, logger } = require('./core');

const router = express.Router();

/* ======================================================================
 *  SECTION 1 — formerly auth.js
 *  Registration, login, JWT + auth/admin middleware, signup bonus,
 *  referral linking.
 * ==================================================================== */

const BCRYPT_ROUNDS = 12;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

async function generateUniqueReferralCode(queryFn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    const { rows } = await queryFn('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  // Extremely unlikely to ever reach here, but fail safe with a
  // timestamp-based fallback that's guaranteed unique.
  return `t${Date.now().toString(36)}`;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await query(
      'SELECT id, username, phone, role, balance, bonus_balance, wagering_required, wagering_target_total, is_active, referral_code, telegram_id FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    phone: user.phone || null,
    role: user.role,
    balance: user.balance / 100,
    bonus_balance: (user.bonus_balance || 0) / 100,
    wagering_required: (user.wagering_required || 0) / 100,
    wagering_target_total: (user.wagering_target_total || 0) / 100,
    referral_code: user.referral_code || null,
    // Only present for accounts that registered through the Telegram bot -
    // the frontend uses this to decide whether the channel/group join
    // gate applies at all (web-only signups are never gated).
    telegram_id: user.telegram_id || null,
  };
}

// Generates the new user's own referral code, then (if they signed up via
// someone else's referral link) links them to that referrer and pays the
// referrer a flat one-time bonus immediately. Referral tracking never
// blocks signup — any failure here is logged and swallowed, not surfaced
// as an error.
const REFERRAL_JOIN_BONUS_BIRR = 10;

async function setupReferral(user, referralCodeUsed) {
  try {
    const referralCode = await generateUniqueReferralCode(query);
    await query('UPDATE users SET referral_code = $1 WHERE id = $2', [referralCode, user.id]);
    user.referral_code = referralCode;

    if (referralCodeUsed && typeof referralCodeUsed === 'string') {
      const { rows: referrerRows } = await query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referralCodeUsed.trim()]
      );

      if (referrerRows.length > 0 && referrerRows[0].id !== user.id) {
        const referrerId = referrerRows[0].id;
        await query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, user.id]);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows: selfRows } = await client.query(
            'SELECT referral_join_bonus_paid FROM users WHERE id = $1 FOR UPDATE',
            [user.id]
          );
          if (!selfRows[0]?.referral_join_bonus_paid) {
            const bonusCents = Math.round(REFERRAL_JOIN_BONUS_BIRR * 100);
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [
              bonusCents,
              referrerId,
            ]);
            await client.query(
              `INSERT INTO transactions (user_id, type, amount, status, note) VALUES ($1, 'payout', $2, 'completed', $3)`,
              [referrerId, bonusCents, 'Referral join bonus']
            );
            await client.query('UPDATE users SET referral_join_bonus_paid = TRUE WHERE id = $1', [user.id]);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error('[auth] Failed to pay referral join bonus', { referrerId, error: err.message });
        } finally {
          client.release();
        }
      }
    }
  } catch (err) {
    logger.error('[auth] Referral setup failed', { userId: user.id, error: err.message });
  }
}

const registerValidation = [
  body('username')
    .isString()
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be 3-30 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isString()
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+251\d{9}$/)
    .withMessage('Enter a valid Ethiopian phone number (e.g. +251912345678)'),
];

const loginValidation = [
  body('username').isString().trim().notEmpty().withMessage('Username is required'),
  body('password').isString().notEmpty().withMessage('Password is required'),
];

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
}

// POST /api/auth/register
router.post('/register', authLimiter, (req, res, next) => {
  logger.info('[DIAGNOSTIC] /api/auth/register hit', { origin: req.headers.origin, method: req.method });
  next();
}, registerValidation, handleValidation, async (req, res, next) => {
  try {
    const username = req.body.username.trim();
    const phone = req.body.phone.trim();
    const { password, referral_code: referralCodeUsed } = req.body;

    const { rows: existing } = await query(
      'SELECT id, username, phone FROM users WHERE username = $1 OR phone = $2',
      [username, phone]
    );
    if (existing.some((u) => u.username === username)) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    if (existing.some((u) => u.phone === phone)) {
      return res.status(409).json({ error: 'That phone number is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const insertRes = await query(
      `INSERT INTO users (username, phone, password_hash, role, balance)
       VALUES ($1, $2, $3, 'user', 0)
       RETURNING *`,
      [username, phone, passwordHash]
    );
    const user = insertRes.rows[0];

    await setupReferral(user, referralCodeUsed);

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/telegram-register
// Called by your Telegram bot server (not by end users directly) after
// someone taps "Share Phone Number" in the bot. Auto-creates an account -
// no username/password typed by the person at all - or logs an existing
// Telegram user back in if they've registered before.
//
// Verified with an HMAC-SHA256 signature over the raw request body, using
// TELEGRAM_BOT_SHARED_SECRET as the key (set this to the same value in
// both this backend's env vars and your bot server's env vars - it is
// NOT your bot token itself, generate a separate random secret for this).
// This proves the request actually came from your bot server and wasn't
// forged by a random caller who guessed this endpoint's URL.
const telegramRegisterValidation = [
  body('telegram_id').isInt({ min: 1 }).withMessage('telegram_id is required'),
  body('first_name').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('phone')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 20 }),
  body('referral_code').optional({ nullable: true }).isString().trim(),
];

function verifyTelegramSignature(req, res, next) {
  const secret = process.env.TELEGRAM_BOT_SHARED_SECRET;
  if (!secret) {
    logger.error('[telegram-register] TELEGRAM_BOT_SHARED_SECRET is not set - refusing all requests');
    return res.status(503).json({ error: 'Telegram registration is not configured' });
  }

  const signature = req.headers['x-telegram-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');

  // Constant-time comparison - a plain === here would let an attacker
  // guess the correct signature one byte at a time via response-time
  // differences (a timing attack).
  const expectedBuf = Buffer.from(expected, 'hex');
  const givenBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== givenBuf.length || !crypto.timingSafeEqual(expectedBuf, givenBuf)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

router.post(
  '/telegram-register',
  authLimiter,
  verifyTelegramSignature,
  telegramRegisterValidation,
  handleValidation,
  async (req, res, next) => {
    try {
      const telegramId = parseInt(req.body.telegram_id, 10);
      const firstName = (req.body.first_name || '').trim();
      const phone = req.body.phone ? req.body.phone.trim() : null;
      const referralCodeUsed = req.body.referral_code || null;

      // Returning Telegram user - log them straight in, no re-registration.
      const { rows: existingRows } = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
      if (existingRows.length > 0) {
        const existingUser = existingRows[0];
        if (!existingUser.is_active) {
          return res.status(403).json({ error: 'This account has been deactivated' });
        }
        const token = signToken(existingUser);
        return res.json({ token, user: publicUser(existingUser), isNewUser: false });
      }

      // New Telegram user - a phone number is required to create the
      // account (users.phone is NOT NULL/UNIQUE). Returned as a clean,
      // recognizable error rather than letting the INSERT below fail on
      // a null-constraint violation - the bot's handleStart uses this
      // exact code to decide whether to prompt for phone-share at all,
      // so an EXISTING user can skip straight to login with no phone
      // needed, while a genuinely new one is asked for it.
      if (!phone) {
        return res.status(422).json({ error: 'phone_required' });
      }

      // New Telegram user - generate a username since none was typed in.
      // Retries on collision rather than trusting a single guess is unique.
      let username = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `tg_${firstName ? firstName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) : ''}${crypto.randomBytes(3).toString('hex')}`;
        const { rows } = await query('SELECT id FROM users WHERE username = $1', [candidate]);
        if (rows.length === 0) {
          username = candidate;
          break;
        }
      }
      if (!username) {
        return res.status(500).json({ error: 'Could not generate a unique username, please try again' });
      }

      const insertRes = await query(
        `INSERT INTO users (username, phone, password_hash, role, balance, telegram_id, signup_source)
         VALUES ($1, $2, NULL, 'user', 0, $3, 'telegram')
         RETURNING *`,
        [username, phone, telegramId]
      );
      const user = insertRes.rows[0];

      await setupReferral(user, referralCodeUsed);

      const token = signToken(user);
      res.status(201).json({ token, user: publicUser(user), isNewUser: true });
    } catch (err) {
      if (err.code === '23505') {
        // Unique violation (telegram_id or phone race) - treat as
        // "already registered" rather than a generic 500.
        return res.status(409).json({ error: 'This Telegram account is already registered' });
      }
      next(err);
    }
  }
);


router.post('/login', authLimiter, loginValidation, handleValidation, async (req, res, next) => {
  try {
    const username = req.body.username.trim();
    const { password } = req.body;

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// GET /api/telegram/membership-status
// Used by the frontend's join-gate. Only meaningful for accounts that
// registered through the bot (have a telegram_id) - web-only accounts
// always report both as joined so they're never gated, since there's no
// Telegram identity to check membership for in the first place.
router.get('/telegram/membership-status', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.telegram_id) {
      return res.json({ applies: false, channel_joined: true, group_joined: true });
    }

    // Lazy require avoids a hard dependency at module-load time if the
    // bot isn't configured in this environment.
    const { checkRequiredMembership } = require('./telegram-bot');
    const status = await checkRequiredMembership(req.user.telegram_id);

    res.json({ applies: true, ...status });
  } catch (err) {
    next(err);
  }
});

/* ======================================================================
 *  SECTION 2 — formerly wallet.js
 *  Deposit/withdraw requests (manual Telebirr workflow) + transaction
 *  history. Mounted separately at /api/wallet in server.js.
 * ==================================================================== */

const walletRouter = express.Router();

const financialLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many financial requests. Please try again later.' },
});

const MIN_DEPOSIT_BIRR = 40;
const MIN_WITHDRAW_BIRR = 200;

// Deposits: user must supply the Telebirr transaction reference they paid
// with, so the admin can cross-check it against the actual Telebirr
// business account before crediting the balance.
const depositValidation = [
  body('amount')
    .isFloat({ gt: 0, max: 1000000 })
    .withMessage('Amount must be a positive number')
    .custom((value) => {
      if (parseFloat(value) < MIN_DEPOSIT_BIRR) {
        throw new Error(`Minimum deposit is ${MIN_DEPOSIT_BIRR} ETB`);
      }
      return true;
    }),
  body('telebirr_reference')
    .trim()
    .notEmpty()
    .withMessage('Telebirr transaction reference is required')
    .isLength({ max: 100 })
    .withMessage('Reference is too long'),
];

// Withdrawals: user must supply the Telebirr phone number funds should be
// sent to.
const withdrawValidation = [
  body('amount')
    .isFloat({ gt: 0, max: 1000000 })
    .withMessage('Amount must be a positive number')
    .custom((value) => {
      if (parseFloat(value) < MIN_WITHDRAW_BIRR) {
        throw new Error(`Minimum withdrawal is ${MIN_WITHDRAW_BIRR} ETB`);
      }
      return true;
    }),
  body('telebirr_phone')
    .trim()
    .notEmpty()
    .withMessage('Telebirr phone number is required')
    .matches(/^\+?\d{9,15}$/)
    .withMessage('Enter a valid Telebirr phone number (digits only, optional leading +)'),
];

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

// GET /api/wallet/balance
walletRouter.get('/balance', requireAuth, async (req, res) => {
  res.json({
    balance: req.user.balance / 100,
    bonus_balance: (req.user.bonus_balance || 0) / 100,
    wagering_required: (req.user.wagering_required || 0) / 100,
    wagering_target_total: (req.user.wagering_target_total || 0) / 100,
  });
});

// POST /api/wallet/deposit  -> creates a PENDING deposit request for admin review
walletRouter.post('/deposit', requireAuth, financialLimiter, depositValidation, handleValidation, async (req, res, next) => {
  try {
    const amountCents = toCents(req.body.amount);
    const reference = req.body.telebirr_reference.trim();

    const duplicate = await query(
      `SELECT id FROM transactions
       WHERE type = 'deposit' AND telebirr_reference_submitted = $1 AND status IN ('pending', 'approved')`,
      [reference]
    );
    if (duplicate.rows.length > 0) {
      return res.status(409).json({ error: 'This Telebirr reference has already been submitted' });
    }

    const { rows } = await query(
      `INSERT INTO transactions (user_id, type, amount, status, note, telebirr_reference_submitted)
       VALUES ($1, 'deposit', $2, 'pending', $3, $4)
       RETURNING *`,
      [req.user.id, amountCents, (req.body.note || '').slice(0, 500), reference]
    );

    res.status(201).json({
      message: 'Deposit request submitted. An admin will verify your Telebirr payment and approve it shortly.',
      transaction: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/withdraw -> creates a PENDING withdrawal request for admin review
// Balance is NOT deducted until an admin approves (after actually sending the
// funds). We check the user currently has sufficient balance to cover it.
//
// Withdrawal is blocked while the user has an outstanding wagering
// requirement. Nothing currently grants a wagering requirement (the
// signup bonus that used to set it has been removed), so this check is
// effectively always satisfied for every user going forward - kept in
// place rather than removed in case a future bonus/promo needs the same
// wagering-lock mechanism again.
walletRouter.post('/withdraw', requireAuth, financialLimiter, withdrawValidation, handleValidation, async (req, res, next) => {
  try {
    const amountCents = toCents(req.body.amount);

    const { rows: userRows } = await query(
      'SELECT balance, wagering_required FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!userRows[0]) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    if (userRows[0].wagering_required > 0) {
      return res.status(400).json({
        error: `You still need to wager ${(userRows[0].wagering_required / 100).toFixed(2)} ETB before you can withdraw`,
      });
    }
    if (userRows[0].balance < amountCents) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const { rows } = await query(
      `INSERT INTO transactions (user_id, type, amount, status, note, telebirr_phone)
       VALUES ($1, 'withdraw', $2, 'pending', $3, $4)
       RETURNING *`,
      [req.user.id, amountCents, (req.body.note || '').slice(0, 500), req.body.telebirr_phone.trim()]
    );

    res.status(201).json({
      message: 'Withdrawal request submitted. An admin will send the funds via Telebirr and approve it shortly.',
      transaction: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallet/transactions -> the current user's own transaction history
walletRouter.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const offset = (page - 1) * limit;

    const [itemsRes, countRes] = await Promise.all([
      query(
        `SELECT * FROM transactions WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      ),
      query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id = $1', [req.user.id]),
    ]);

    const total = countRes.rows[0].count;

    res.json({
      transactions: itemsRes.rows.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount / 100,
        status: t.status,
        note: t.note,
        telebirr_reference_submitted: t.telebirr_reference_submitted,
        telebirr_phone: t.telebirr_phone,
        telebirr_reference_admin: t.telebirr_reference_admin,
        created_at: t.created_at,
      })),
      page,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (err) {
    next(err);
  }
});

/* ======================================================================
 *  SECTION 3 — formerly wallet_socket.js
 *  Realtime balance push over Socket.IO + live online user count.
 *
 *  Every place balance/bonus_balance changes today already re-queries
 *  the fresh value after commit (admin approve, game.js bet/cashout,
 *  cashback.js claim). pushBalanceUpdate(userId) can be called right
 *  after any of those commits to push the new numbers straight to that
 *  user's wallet page - no polling wait. It does not change what any of
 *  those routes compute; it only adds a notification on top.
 *
 *  The frontend's getSocket() (api.js) sends the user's JWT in the
 *  connection handshake (auth: { token }) for every socket it opens -
 *  this module reads that same token to identify the connecting user and
 *  place them in a private room ("user:<id>") that only their own
 *  socket(s) are in, so a balance push is never broadcast to everyone.
 *
 *  The same authenticated connections are used to track who's "online" -
 *  meaning currently holding at least one open, authenticated socket,
 *  live and real-time, not a last-seen timestamp. One user can have
 *  multiple tabs/devices open at once, so we track distinct user IDs
 *  with at least one live socket, not a raw socket count - closing one
 *  tab doesn't mark them offline if another is still connected.
 * ==================================================================== */

const onlineUserSockets = new Map(); // userId -> Set<socketId>

let ioRef = null;

function attachWalletSocket(io) {
  ioRef = io;

  io.on('connection', (socket) => {
    try {
      const token = socket.handshake?.auth?.token;
      if (!token || typeof token !== 'string') return;
      const payload = verifyToken(token);
      socket.data.userId = payload.sub;
      socket.join(`user:${payload.sub}`);

      if (!onlineUserSockets.has(payload.sub)) {
        onlineUserSockets.set(payload.sub, new Set());
      }
      onlineUserSockets.get(payload.sub).add(socket.id);

      socket.on('disconnect', () => {
        const sockets = onlineUserSockets.get(payload.sub);
        if (!sockets) return;
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUserSockets.delete(payload.sub);
      });
    } catch {
      // Invalid/expired token - the socket just won't receive pushes and
      // isn't counted as online; the wallet page still has its normal
      // poll as a fallback for balance updates.
    }
  });
}

// Number of distinct users currently holding at least one live,
// authenticated socket connection right now.
function getOnlineUserCount() {
  return onlineUserSockets.size;
}

// Fetches the latest balance fields for a user and pushes them to that
// user's private room. Safe to call from anywhere after a balance-changing
// commit - if the socket server isn't attached yet or the user has no
// open socket, this is a no-op.
async function pushBalanceUpdate(userId) {
  if (!ioRef || !userId) return;
  try {
    const { rows } = await query(
      'SELECT balance, bonus_balance, wagering_required, wagering_target_total FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    if (!user) return;

    ioRef.to(`user:${userId}`).emit('wallet:balance_updated', {
      balance: user.balance / 100,
      bonus_balance: (user.bonus_balance || 0) / 100,
      wagering_required: (user.wagering_required || 0) / 100,
      wagering_target_total: (user.wagering_target_total || 0) / 100,
    });
  } catch (err) {
    console.error('[wallet] Failed to push balance update', { userId, error: err.message });
  }
}

/* ------------------------------------------------------------------ */
/*  Exports                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  router,             // mount at /api/auth
  walletRouter,       // mount at /api/wallet
  requireAuth,
  requireAdmin,
  signToken,
  verifyToken,
  attachWalletSocket,
  pushBalanceUpdate,
  getOnlineUserCount,
};
