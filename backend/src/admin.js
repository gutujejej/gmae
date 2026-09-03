/* ====================================================================== */
/*  admin.js                                                              */
/*  Merged from: admin.js + referral.js + coupons.js + cashback.js +      */
/*  settings.js. (Mechanical merge only — no logic changed. Each former   */
/*  file gets its own router below, mounted at its own original path in  */
/*  server.js, so URLs and behavior are unchanged.)                       */
/* ====================================================================== */

const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { query, pool, logger, queryOldDb, oldPool } = require('./core');
const { requireAuth, requireAdmin, pushBalanceUpdate, getOnlineUserCount } = require('./users');

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

/* ======================================================================
 *  SECTION 1 — formerly admin.js
 *  Mount at /api/admin. Every route requires JWT + admin role.
 * ==================================================================== */

const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

// Every route in this file requires a valid JWT AND the admin role.
adminRouter.use(requireAuth, requireAdmin);

/* ------------------------------------------------------------------ */
/*  Users                                                               */
/* ------------------------------------------------------------------ */

// GET /api/admin/users - list all users
adminRouter.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    const offset = (page - 1) * limit;

    const [usersRes, countRes] = await Promise.all([
      query(
        `SELECT id, username, phone, role, balance, is_active, created_at
         FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query('SELECT COUNT(*)::int AS count FROM users'),
    ]);

    const total = countRes.rows[0].count;

    res.json({
      users: usersRes.rows.map((u) => ({
        id: u.id,
        username: u.username,
        phone: u.phone,
        role: u.role,
        balance: u.balance / 100,
        isActive: u.is_active,
        created_at: u.created_at,
      })),
      page,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/status - activate/deactivate (ban/unban) a user account
adminRouter.patch(
  '/users/:id/status',
  [param('id').isInt().withMessage('Invalid id'), body('isActive').isBoolean()],
  handleValidation,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'UPDATE users SET is_active = $1 WHERE id = $2 RETURNING id, username, is_active',
        [req.body.isActive, req.params.id]
      );
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });

      logger.info('Admin updated user status', {
        admin: req.user.username,
        target: user.username,
        isActive: user.is_active,
      });

      res.json({ message: 'User status updated', user: { id: user.id, isActive: user.is_active } });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/admin/users/:id/balance - manually adjust a user's balance
//
// `amount` is signed: positive credits the user, negative debits them.
// A `reason` is required so every manual adjustment is auditable - it's
// stored as a completed 'payout' transaction (credit) or the debit
// equivalent, same as every other balance-affecting transaction in this
// app, so it shows up in transaction history and stats rather than being
// an invisible, unlogged database write. Row-locked the same way
// transaction approval is, so two admins adjusting the same user at once
// can't race each other.
adminRouter.patch(
  '/users/:id/balance',
  [
    param('id').isInt().withMessage('Invalid id'),
    body('amount')
      .isFloat({ min: -1000000, max: 1000000 })
      .withMessage('Amount must be a number between -1,000,000 and 1,000,000')
      .custom((value) => parseFloat(value) !== 0)
      .withMessage('Amount cannot be zero'),
    body('reason').isString().trim().isLength({ min: 1, max: 300 }).withMessage('A reason is required'),
  ],
  handleValidation,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
        req.params.id,
      ]);
      const user = userRows[0];
      if (!user) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const amountCents = Math.round(parseFloat(req.body.amount) * 100);
      const isCredit = amountCents > 0;

      if (!isCredit && user.balance + amountCents < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Adjustment would make the balance negative' });
      }

      const { rows: updatedRows } = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [amountCents, user.id]
      );

      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status, note, approved_by)
         VALUES ($1, 'payout', $2, 'completed', $3, $4)`,
        [
          user.id,
          Math.abs(amountCents),
          `Manual ${isCredit ? 'credit' : 'debit'} by admin: ${req.body.reason.trim()}`,
          req.user.id,
        ]
      );

      await client.query('COMMIT');

      logger.info('Admin manually adjusted user balance', {
        admin: req.user.username,
        target: user.username,
        amount: amountCents / 100,
        reason: req.body.reason.trim(),
      });

      res.json({
        message: 'Balance updated',
        user: { id: user.id, balance: updatedRows[0].balance / 100 },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Transactions - pending queues + approve/reject                      */
/* ------------------------------------------------------------------ */

// GET /api/admin/transactions/pending?type=deposit|withdraw
adminRouter.get('/transactions/pending', async (req, res, next) => {
  try {
    let sql = `
      SELECT t.*, u.username, u.phone
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.status = 'pending'
    `;
    const params = [];

    if (req.query.type && ['deposit', 'withdraw'].includes(req.query.type)) {
      params.push(req.query.type);
      sql += ` AND t.type = $${params.length}`;
    } else {
      sql += ` AND t.type IN ('deposit', 'withdraw')`;
    }
    sql += ' ORDER BY t.created_at ASC';

    const { rows } = await query(sql, params);

    res.json({
      transactions: rows.map((t) => ({
        id: t.id,
        user: { id: t.user_id, username: t.username, phone: t.phone },
        type: t.type,
        amount: t.amount / 100,
        status: t.status,
        note: t.note,
        telebirr_reference_submitted: t.telebirr_reference_submitted,
        telebirr_phone: t.telebirr_phone,
        created_at: t.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/transactions - full history, all users, with optional filters
adminRouter.get('/transactions', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`t.type = $${params.length}`);
    }
    if (req.query.userId) {
      params.push(req.query.userId);
      conditions.push(`t.user_id = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT t.*, u.username AS user_username, a.username AS approved_by_username
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN users a ON a.id = t.approved_by
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `SELECT COUNT(*)::int AS count FROM transactions t ${whereClause}`;

    const [itemsRes, countRes] = await Promise.all([
      query(listSql, listParams),
      query(countSql, params),
    ]);

    const total = countRes.rows[0].count;

    res.json({
      transactions: itemsRes.rows.map((t) => ({
        id: t.id,
        user: t.user_id ? { id: t.user_id, username: t.user_username } : null,
        type: t.type,
        amount: t.amount / 100,
        status: t.status,
        approved_by: t.approved_by_username || null,
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

// POST /api/admin/transactions/:id/approve
//
// For deposits: approving means the admin has checked the submitted
// Telebirr reference against the real Telebirr business account and
// confirmed the money actually arrived. The user's balance is credited,
// and if this is the user's first-ever approved deposit and they were
// referred by someone, that referrer earns a one-time commission (see
// the referral block below) - all inside the same DB transaction, so
// either everything succeeds together or none of it does.
//
// For withdrawals: approving means the admin has ALREADY sent the money to
// the user's Telebirr phone number and is now recording proof of that
// transfer (their own Telebirr reference) before the balance is debited.
adminRouter.post(
  '/transactions/:id/approve',
  [
    param('id').isInt().withMessage('Invalid id'),
    body('telebirr_reference').optional().trim().isLength({ max: 100 }).withMessage('Reference is too long'),
  ],
  handleValidation,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: txRows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [
        req.params.id,
      ]);
      const tx = txRows[0];
      if (!tx) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Transaction not found' });
      }
      if (tx.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Transaction is not pending' });
      }

      const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [tx.user_id]);
      const user = userRows[0];
      if (!user) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Associated user not found' });
      }

      const providedRef = (req.body.telebirr_reference || '').trim();
      if (!providedRef) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error:
            tx.type === 'deposit'
              ? 'Enter the Telebirr reference you verified in the business account before approving'
              : 'Enter the Telebirr reference for the transfer you sent before approving',
        });
      }

      // Hoisted so it's visible below, after the deposit/withdraw branch
      // closes - tracks whether a referral commission was paid to a
      // different user in this same approval, so we know to push a
      // balance update to them too, not just the depositor.
      let referrerIdToNotify = null;

      if (tx.type === 'deposit') {
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.amount, user.id]);

        // ------------------------------------------------------------
        // Referral commission: 5% (or whatever's configured) of a
        // referred user's FIRST-EVER approved deposit, paid to whoever
        // referred them. Guarded by referral_commission_paid so it can
        // never fire twice for the same referred user.
        // ------------------------------------------------------------
        const { rows: depositorRows } = await client.query(
          'SELECT referred_by, referral_commission_paid FROM users WHERE id = $1',
          [user.id]
        );
        const depositor = depositorRows[0];

        if (depositor?.referred_by && !depositor.referral_commission_paid) {
          const { rows: priorDepositsRows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM transactions
             WHERE user_id = $1 AND type = 'deposit' AND status = 'approved' AND id != $2`,
            [user.id, tx.id]
          );
          const isFirstDeposit = priorDepositsRows[0].count === 0;

          if (isFirstDeposit) {
            const { rows: settingRows } = await client.query(
              `SELECT value FROM platform_settings WHERE key = 'referral_commission_percent'`
            );
            const commissionPercent = parseFloat(settingRows[0]?.value || '5');
            const commissionCents = Math.round(tx.amount * (commissionPercent / 100));

            if (commissionCents > 0) {
              await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [
                commissionCents,
                depositor.referred_by,
              ]);
              await client.query(
                `INSERT INTO transactions (user_id, type, amount, status, note)
                 VALUES ($1, 'payout', $2, 'completed', $3)`,
                [depositor.referred_by, commissionCents, `Referral commission (${commissionPercent}%)`]
              );
              await client.query('UPDATE users SET referral_commission_paid = TRUE WHERE id = $1', [user.id]);
              referrerIdToNotify = depositor.referred_by;
            }
          }
        }
      } else if (tx.type === 'withdraw') {
        if (user.balance < tx.amount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'User no longer has sufficient balance for this withdrawal' });
        }
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [tx.amount, user.id]);
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Only deposit/withdraw transactions can be approved here' });
      }

      const { rows: updatedTxRows } = await client.query(
        `UPDATE transactions
         SET status = 'approved', approved_by = $1, telebirr_reference_admin = $2
         WHERE id = $3 RETURNING *`,
        [req.user.id, providedRef, tx.id]
      );

      const { rows: finalUserRows } = await client.query('SELECT balance FROM users WHERE id = $1', [user.id]);

      await client.query('COMMIT');

      // Push the fresh balance straight to this user's wallet page over
      // the socket - they see it the moment it's approved, not up to 10s
      // later on the next poll. Best-effort: if their socket isn't
      // connected right now, the existing poll still picks it up.
      pushBalanceUpdate(user.id);
      if (referrerIdToNotify) {
        // The referrer's balance may also have just changed (commission
        // payout above) - push their wallet too, not just the depositor's.
        pushBalanceUpdate(referrerIdToNotify);
      }

      logger.info('Admin approved transaction', {
        admin: req.user.username,
        txId: tx.id,
        type: tx.type,
        amount: tx.amount / 100,
        user: user.username,
        telebirr_reference_admin: providedRef,
      });

      res.json({
        message: 'Transaction approved',
        transaction: updatedTxRows[0],
        newBalance: finalUserRows[0].balance / 100,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// POST /api/admin/transactions/:id/reject
adminRouter.post(
  '/transactions/:id/reject',
  [param('id').isInt().withMessage('Invalid id'), body('reason').optional().isString().isLength({ max: 500 })],
  handleValidation,
  async (req, res, next) => {
    try {
      const { rows: txRows } = await query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
      const tx = txRows[0];
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });
      if (tx.status !== 'pending') return res.status(400).json({ error: 'Transaction is not pending' });

      const newNote = req.body.reason
        ? `${tx.note ? tx.note + ' | ' : ''}Rejected: ${req.body.reason}`
        : tx.note;

      const { rows } = await query(
        `UPDATE transactions SET status = 'rejected', approved_by = $1, note = $2 WHERE id = $3 RETURNING *`,
        [req.user.id, newNote, tx.id]
      );

      logger.info('Admin rejected transaction', {
        admin: req.user.username,
        txId: tx.id,
        type: tx.type,
        reason: req.body.reason || null,
      });

      res.json({ message: 'Transaction rejected', transaction: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/*  Platform settings - game logo                                       */
/* ------------------------------------------------------------------ */

// PUT /api/admin/settings/game-logo
// Admin sets the URL of an already-hosted image to use as the Buna Games
// logo shown to players. This does NOT handle file upload itself -
// it just stores a URL string. Upload your image to any static host
// (Supabase Storage, Cloudinary, imgur, etc.) first, then paste the
// resulting URL here.
adminRouter.put(
  '/settings/game-logo',
  [body('url').isURL().withMessage('A valid image URL is required')],
  handleValidation,
  async (req, res, next) => {
    try {
      await query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ('game_logo_url', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [req.body.url]
      );

      logger.info('Admin updated game logo', { admin: req.user.username, url: req.body.url });

      res.json({ message: 'Game logo updated', url: req.body.url });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/admin/settings
// Returns every adjustable platform setting the admin panel exposes, with
// sensible defaults filled in for any key that's never been explicitly
// set yet.
adminRouter.get('/settings', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM platform_settings
       WHERE key IN ('referral_commission_percent', 'game_logo_url', 'bingo_stake_birr', 'bingo_platform_cut_birr')`
    );
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    res.json({
      referral_commission_percent: parseFloat(settings.referral_commission_percent ?? '5'),
      game_logo_url: settings.game_logo_url || null,
      bingo_stake_birr: parseFloat(settings.bingo_stake_birr ?? '10'),
      bingo_platform_cut_birr: parseFloat(settings.bingo_platform_cut_birr ?? '2'),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/settings/bingo-pricing
// Adjusts the per-cartela stake and the platform's cut of it. bingo.js
// reads both of these fresh from platform_settings at the start of every
// new round (see getBingoPricing() there), so a change here takes effect
// starting with the NEXT round that opens - it does not alter a round
// that's already in progress or already finished.
adminRouter.put(
  '/settings/bingo-pricing',
  [
    body('stake_amount').isFloat({ min: 1, max: 10000 }).withMessage('Stake amount must be a positive number'),
    body('platform_cut')
      .isFloat({ min: 0, max: 10000 })
      .withMessage('Platform cut must be 0 or a positive number')
      .custom((value, { req }) => {
        if (parseFloat(value) >= parseFloat(req.body.stake_amount)) {
          throw new Error('Platform cut must be less than the stake amount');
        }
        return true;
      }),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const stakeAmount = parseFloat(req.body.stake_amount);
      const platformCut = parseFloat(req.body.platform_cut);

      await query(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('bingo_stake_birr', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [String(stakeAmount)]
      );
      await query(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('bingo_platform_cut_birr', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [String(platformCut)]
      );

      logger.info('Admin updated bingo pricing', { admin: req.user.username, stakeAmount, platformCut });

      res.json({
        message: 'Bingo pricing updated. Takes effect starting with the next round.',
        bingo_stake_birr: stakeAmount,
        bingo_platform_cut_birr: platformCut,
      });
    } catch (err) {
      next(err);
    }
  }
);


// GET /api/admin/stats/overview
// Real aggregate numbers for the admin dashboard: total registered users,
// total deposited (approved deposits only), total withdrawn (approved
// withdrawals only), total amount users have won (sum of all 'payout'
// transactions), and total platform result (net of all bets minus all
// payouts - positive means the house is ahead, negative means users are
// net winners overall).
adminRouter.get('/stats/overview', async (req, res, next) => {
  try {
    const [usersRes, depositsRes, withdrawalsRes, betsRes, payoutsRes] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM users'),
      query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM transactions WHERE type = 'deposit' AND status = 'approved'`),
      query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM transactions WHERE type = 'withdraw' AND status = 'approved'`),
      query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM transactions WHERE type = 'bet' AND status = 'completed'`),
      query(`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM transactions WHERE type = 'payout' AND status = 'completed'`),
    ]);

    const totalBets = betsRes.rows[0].total;
    const totalPayouts = payoutsRes.rows[0].total;

    res.json({
      totalUsers: usersRes.rows[0].count,
      totalDeposited: Number(depositsRes.rows[0].total) / 100,
      totalWithdrawn: Number(withdrawalsRes.rows[0].total) / 100,
      totalUserWinnings: Number(totalPayouts) / 100,
      platformResult: (Number(totalBets) - Number(totalPayouts)) / 100,
      onlineUsers: getOnlineUserCount(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats/users
// Per-user list with registration info and their own total winnings
// (sum of their 'payout' transactions). Optional `search` matches
// against username (case-insensitive, partial).
adminRouter.get('/stats/users', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const params = [];
    let searchClause = '';
    if (search) {
      params.push(`%${search}%`);
      searchClause = `WHERE u.username ILIKE $${params.length} OR u.phone ILIKE $${params.length}`;
    }

    const listParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT
         u.id,
         u.username,
         u.phone,
         u.balance,
         u.is_active,
         u.created_at,
         COALESCE(w.total_won, 0) AS total_won
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(amount) AS total_won
         FROM transactions
         WHERE type = 'payout' AND status = 'completed'
         GROUP BY user_id
       ) w ON w.user_id = u.id
       ${searchClause}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS count FROM users u ${searchClause}`,
      params
    );

    res.json({
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        phone: u.phone,
        balance: u.balance / 100,
        totalWon: Number(u.total_won) / 100,
        isActive: u.is_active,
        created_at: u.created_at,
      })),
      page,
      totalPages: Math.ceil(countRows[0].count / limit),
      total: countRows[0].count,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Telegram broadcast                                                  */
/*  Sends a text message (or an image with optional caption) to every   */
/*  user who registered via the Telegram bot (i.e. has a telegram_id on */
/*  file). Actual sending happens in telegram-bot.js - these routes     */
/*  just gather recipients and report back how many it went to.        */
/* ------------------------------------------------------------------ */

// Shared by both the text and photo broadcast routes below - gathers
// every telegram_id to send to, merging in the OLD database's users
// too during the migration-transition window (see OLD_DATABASE_URL).
async function gatherBroadcastTelegramIds() {
  const { rows } = await query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND is_active = TRUE');
  const telegramIds = new Set(rows.map((r) => String(r.telegram_id)));

  if (oldPool) {
    try {
      const oldResult = await queryOldDb('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND is_active = TRUE');
      for (const r of oldResult.rows) telegramIds.add(String(r.telegram_id));
    } catch (err) {
      logger.warn('[admin] Could not read OLD database for broadcast - continuing with new-DB users only', { error: err.message });
    }
  }

  return Array.from(telegramIds);
}

const broadcastValidation = [
  body('message').isString().trim().isLength({ min: 1, max: 4000 }).withMessage('Message is required (max 4000 characters)'),
];

// POST /api/admin/broadcast
adminRouter.post('/broadcast', broadcastValidation, handleValidation, async (req, res, next) => {
  try {
    const telegramIdList = await gatherBroadcastTelegramIds();

    if (telegramIdList.length === 0) {
      return res.json({ message: 'No Telegram users to send to yet.', sent: 0, failed: 0, total: 0 });
    }

    // Lazy require avoids a hard dependency at module-load time if the
    // bot isn't configured (e.g. TELEGRAM_BOT_TOKEN missing in this env) -
    // broadcastMessage() itself handles that case and returns a clear error.
    const { broadcastMessage } = require('./telegram-bot');
    const result = await broadcastMessage(telegramIdList, req.body.message.trim());

    logger.info('Admin sent Telegram broadcast', {
      admin: req.user.username,
      total: telegramIdList.length,
      sent: result.sent,
      failed: result.failed,
    });

    res.json({ message: 'Broadcast sent', ...result, total: telegramIdList.length });
  } catch (err) {
    next(err);
  }
});

// In-memory storage only - the uploaded image is held as a buffer for
// the lifetime of this one request and never written to disk. Railway's
// filesystem is ephemeral (wiped on every redeploy/restart), and since
// the image only needs to reach Telegram once per broadcast (see
// broadcastPhoto's file_id reuse in telegram-bot.js), there's no reason
// to persist it anywhere on our own side at all.
const broadcastImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Telegram's own photo upload limit is 10MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// POST /api/admin/broadcast-photo
// multipart/form-data: "image" file field, optional "caption" text field.
adminRouter.post('/broadcast-photo', (req, res, next) => {
  broadcastImageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Image upload failed' });
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'An image file is required' });
    }
    const caption = (req.body.caption || '').trim().slice(0, 1024) || null; // Telegram's own caption length limit

    const telegramIdList = await gatherBroadcastTelegramIds();

    if (telegramIdList.length === 0) {
      return res.json({ message: 'No Telegram users to send to yet.', sent: 0, failed: 0, total: 0 });
    }

    const { broadcastPhoto } = require('./telegram-bot');
    const result = await broadcastPhoto(telegramIdList, req.file.buffer, req.file.originalname, caption);

    logger.info('Admin sent Telegram photo broadcast', {
      admin: req.user.username,
      total: telegramIdList.length,
      sent: result.sent,
      failed: result.failed,
      hasCaption: !!caption,
    });

    res.json({ message: 'Photo broadcast sent', ...result, total: telegramIdList.length });
  } catch (err) {
    next(err);
  }
});

/* ======================================================================
 *  SECTION 2 — formerly referral.js
 *  Mount at /api/referral.
 * ==================================================================== */

const referralRouter = express.Router();

// Percentage of a referred user's total wagered amount that shows up as
// this referrer's "GGR Amount". Deliberately not sent to the client in
// any form - only the already-multiplied ETB figure is returned, so the
// rate itself never appears in a response payload or on screen.
const GGR_SHARE_PERCENT = 5;

/* ------------------------------------------------------------------ */
/*  GET /api/referral/stats                                            */
/*                                                                       */
/*  Returns the current user's referral link ingredients plus stats     */
/*  for the profile/referral pages:                                     */
/*    - referred_count: how many users signed up with referred_by       */
/*      pointing at this user (regardless of whether they've deposited  */
/*      yet).                                                           */
/*    - total_commission: sum of every 'payout' transaction this user   */
/*      has received whose note starts with 'Referral commission' -     */
/*      i.e. the actual commission payouts credited by admin.js's       */
/*      deposit-approval flow, not a computed/estimated figure.         */
/*    - total_ggr: GGR_SHARE_PERCENT of the total amount WAGERED (sum    */
/*      of 'bet' transactions) by every user this person referred. The   */
/*      raw wagered total and the percentage itself are intentionally   */
/*      never returned - only this already-reduced figure is.           */
/* ------------------------------------------------------------------ */
referralRouter.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const [countRes, commissionRes, wageredRes] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1', [req.user.id]),
      query(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
         WHERE user_id = $1 AND type = 'payout' AND status = 'completed' AND note LIKE 'Referral commission%'`,
        [req.user.id]
      ),
      query(
        `SELECT COALESCE(SUM(t.amount), 0)::bigint AS total
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         WHERE u.referred_by = $1 AND t.type = 'bet' AND t.status = 'completed'`,
        [req.user.id]
      ),
    ]);

    const totalWageredCents = Number(wageredRes.rows[0].total);
    const ggrCents = Math.round(totalWageredCents * (GGR_SHARE_PERCENT / 100));

    res.json({
      referred_count: countRes.rows[0].count,
      total_commission: Number(commissionRes.rows[0].total) / 100,
      total_ggr: ggrCents / 100,
      referral_code: req.user.referral_code || null,
    });
  } catch (err) {
    next(err);
  }
});

/* ======================================================================
 *  SECTION 3 — formerly coupons.js
 *  Mount at /api/coupons.
 * ==================================================================== */

const couponsRouter = express.Router();

const WINDOW_TO_INTERVAL = {
  today: "date_trunc('day', now())",
  week: "now() - interval '7 days'",
  month: "now() - interval '30 days'",
  year: "now() - interval '365 days'",
};

/* ==================================================================== */
/*  Admin: create / list / manage coupons                                */
/* ==================================================================== */

const createCouponValidation = [
  body('code').isString().trim().isLength({ min: 3, max: 40 }).withMessage('Code must be 3-40 characters'),
  body('type').isIn(['free', 'deposit_gated']).withMessage('Type must be free or deposit_gated'),
  body('amount').isFloat({ gt: 0, max: 1000000 }).withMessage('Amount must be a positive number'),
  body('maxClaims').isInt({ gt: 0, max: 1000000 }).withMessage('Max claims must be a positive whole number'),
  body('depositWindow')
    .if(body('type').equals('deposit_gated'))
    .isIn(['today', 'week', 'month', 'year'])
    .withMessage('Deposit window is required for deposit-gated coupons'),
  body('minDeposit')
    .if(body('type').equals('deposit_gated'))
    .isFloat({ gt: 0, max: 1000000 })
    .withMessage('Minimum deposit is required for deposit-gated coupons'),
  body('requireFirstDeposit').optional().isBoolean(),
  body('expiresAt').optional({ nullable: true }).isISO8601().withMessage('Expiry must be a valid date'),
];

// POST /api/coupons/admin - create a new coupon
couponsRouter.post('/admin', requireAuth, requireAdmin, createCouponValidation, handleValidation, async (req, res, next) => {
  try {
    const code = req.body.code.trim().toUpperCase();
    const amountCents = Math.round(Number(req.body.amount) * 100);
    const minDepositCents = req.body.minDeposit ? Math.round(Number(req.body.minDeposit) * 100) : null;

    const { rows } = await query(
      `INSERT INTO coupons
         (code, type, amount_cents, max_claims, deposit_window, min_deposit_cents, require_first_deposit, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        code,
        req.body.type,
        amountCents,
        req.body.maxClaims,
        req.body.type === 'deposit_gated' ? req.body.depositWindow : null,
        minDepositCents,
        Boolean(req.body.requireFirstDeposit),
        req.body.expiresAt || null,
        req.user.id,
      ]
    );

    logger.info('Admin created coupon', { admin: req.user.username, code });

    res.status(201).json({ message: 'Coupon created', coupon: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A coupon with that code already exists' });
    }
    next(err);
  }
});

// GET /api/coupons/admin - list all coupons with their redemption counts
couponsRouter.get('/admin', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, COUNT(r.id)::int AS claims_used
       FROM coupons c
       LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );

    res.json({
      coupons: rows.map((c) => ({
        id: c.id,
        code: c.code,
        type: c.type,
        amount: c.amount_cents / 100,
        maxClaims: c.max_claims,
        claimsUsed: c.claims_used,
        depositWindow: c.deposit_window,
        minDeposit: c.min_deposit_cents ? c.min_deposit_cents / 100 : null,
        requireFirstDeposit: c.require_first_deposit,
        active: c.active,
        expiresAt: c.expires_at,
        createdAt: c.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/coupons/admin/:id/active - pause/release a coupon
couponsRouter.patch(
  '/admin/:id/active',
  requireAuth,
  requireAdmin,
  [param('id').isInt().withMessage('Invalid id'), body('active').isBoolean()],
  handleValidation,
  async (req, res, next) => {
    try {
      const { rows } = await query('UPDATE coupons SET active = $1 WHERE id = $2 RETURNING id, code, active', [
        req.body.active,
        req.params.id,
      ]);
      if (!rows[0]) return res.status(404).json({ error: 'Coupon not found' });

      logger.info('Admin toggled coupon', { admin: req.user.username, code: rows[0].code, active: rows[0].active });

      res.json({ message: 'Coupon updated', coupon: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/* ==================================================================== */
/*  User: redeem a coupon                                                */
/* ==================================================================== */

// POST /api/coupons/redeem
couponsRouter.post(
  '/redeem',
  requireAuth,
  [body('code').isString().trim().isLength({ min: 1, max: 40 }).withMessage('Enter a coupon code')],
  handleValidation,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const code = req.body.code.trim().toUpperCase();

      const { rows: couponRows } = await client.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code]);
      const coupon = couponRows[0];
      if (!coupon) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invalid coupon code' });
      }
      if (!coupon.active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This coupon is no longer active' });
      }
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This coupon has expired' });
      }

      const { rows: claimCountRows } = await client.query(
        'SELECT COUNT(*)::int AS count FROM coupon_redemptions WHERE coupon_id = $1',
        [coupon.id]
      );
      if (claimCountRows[0].count >= coupon.max_claims) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This coupon has reached its claim limit' });
      }

      const { rows: alreadyClaimedRows } = await client.query(
        'SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2',
        [coupon.id, req.user.id]
      );
      if (alreadyClaimedRows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "You've already claimed this coupon" });
      }

      if (coupon.type === 'deposit_gated') {
        const sinceExpr = WINDOW_TO_INTERVAL[coupon.deposit_window];

        if (coupon.require_first_deposit) {
          // Must be the user's first-ever approved deposit, AND that
          // specific deposit must itself satisfy the window + minimum.
          const { rows: firstDepositRows } = await client.query(
            `SELECT * FROM transactions
             WHERE user_id = $1 AND type = 'deposit' AND status = 'approved'
             ORDER BY created_at ASC LIMIT 1`,
            [req.user.id]
          );
          const firstDeposit = firstDepositRows[0];

          let qualifies = false;
          if (firstDeposit) {
            const checkParams = [firstDeposit.id];
            let checkClause = `id = $1 AND created_at >= ${sinceExpr}`;
            if (coupon.min_deposit_cents) {
              checkParams.push(coupon.min_deposit_cents);
              checkClause += ` AND amount >= $${checkParams.length}`;
            }
            const { rows: checkRows } = await client.query(
              `SELECT 1 FROM transactions WHERE ${checkClause}`,
              checkParams
            );
            qualifies = checkRows.length > 0;
          }

          if (!qualifies) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: "This coupon requires a qualifying first deposit that you don't have yet",
            });
          }
        } else {
          const params = [req.user.id];
          let clause = `user_id = $1 AND type = 'deposit' AND status = 'approved' AND created_at >= ${sinceExpr}`;
          if (coupon.min_deposit_cents) {
            params.push(coupon.min_deposit_cents);
            clause += ` AND amount >= $${params.length}`;
          }
          const { rows: qualifyingDepositRows } = await client.query(
            `SELECT 1 FROM transactions WHERE ${clause} LIMIT 1`,
            params
          );
          if (qualifyingDepositRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: "This coupon requires a qualifying deposit that you don't have yet",
            });
          }
        }
      }

      await client.query('INSERT INTO coupon_redemptions (coupon_id, user_id, amount_cents) VALUES ($1, $2, $3)', [
        coupon.id,
        req.user.id,
        coupon.amount_cents,
      ]);

      // Coupon money goes into bonus_balance (the "coupon wallet"), not
      // balance directly - it's locked behind a 100x wagering requirement
      // before it can be withdrawn, and (per design) can never fund a
      // Bingo bet at all, only Aviator, and only once deposit money runs
      // out. See game.js's bet route for how the two pools are drawn from
      // in order, and how a coupon-funded bet's wagering counts down.
      const WAGERING_MULTIPLIER = 100;
      const wageringRequiredCents = coupon.amount_cents * WAGERING_MULTIPLIER;

      const { rows: updatedUserRows } = await client.query(
        `UPDATE users
         SET bonus_balance = bonus_balance + $1,
             wagering_required = wagering_required + $2,
             wagering_target_total = wagering_target_total + $2
         WHERE id = $3
         RETURNING balance, bonus_balance`,
        [coupon.amount_cents, wageringRequiredCents, req.user.id]
      );

      await client.query(
        `INSERT INTO transactions (user_id, type, amount, status, note) VALUES ($1, 'payout', $2, 'completed', $3)`,
        [req.user.id, coupon.amount_cents, `Coupon redeemed: ${coupon.code} (locked - wagering required)`]
      );

      await client.query('COMMIT');

      logger.info('User redeemed coupon', {
        user: req.user.username,
        code: coupon.code,
        amount: coupon.amount_cents / 100,
      });

      res.json({
        message: 'Coupon redeemed',
        amount: coupon.amount_cents / 100,
        balance: updatedUserRows[0].balance / 100,
        bonus_balance: updatedUserRows[0].bonus_balance / 100,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

/* ======================================================================
 *  SECTION 4 — formerly cashback.js
 *  Mount at /api/cashback.
 * ==================================================================== */

const rateLimit = require('express-rate-limit');
const cashbackRouter = express.Router();

/* ------------------------------------------------------------------ */
/*  Daily Cashback                                                      */
/*                                                                       */
/*  Rule: once per rolling 24h, a user may claim cashback equal to 10%   */
/*  of the deposits they made TODAY (last 24h), but only if:            */
/*    1. Their current balance is 0 (i.e. they've lost everything they  */
/*       had) - no partial cashback for a partial loss.                 */
/*    2. They have NEVER submitted a withdrawal request, in ANY status  */
/*       (pending/approved/rejected). A single withdraw attempt, ever,  */
/*       permanently disqualifies the account from cashback - this is   */
/*       intentional and irreversible.                                  */
/*    3. They haven't already claimed cashback in the last 24h.         */
/*                                                                        */
/*  Cashback is credited straight to `balance` (not bonus_balance) and  */
/*  recorded as a 'payout' transaction with a distinguishing note, the   */
/*  same pattern referral.js uses to total up commission payouts.       */
/* ------------------------------------------------------------------ */

const CASHBACK_PERCENT = 10;
const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CASHBACK_NOTE = 'Daily cashback';

const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

// Ever attempted a withdrawal, in any status. This is a permanent,
// irreversible disqualifier by design (see comment above) - not scoped to
// "approved" only.
async function hasEverWithdrawn(userId) {
  const { rows } = await query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'withdraw' LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

// Sum of approved deposits in the last 24h (i.e. "today's" deposits).
async function todaysApprovedDepositCents(userId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total
     FROM transactions
     WHERE user_id = $1 AND type = 'deposit' AND status = 'approved'
       AND created_at >= NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return Number(rows[0].total);
}

// Most recent cashback payout, if any, to enforce the 24h cooldown between
// claims.
async function lastCashbackClaimAt(userId) {
  const { rows } = await query(
    `SELECT created_at FROM transactions
     WHERE user_id = $1 AND type = 'payout' AND note = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, CASHBACK_NOTE]
  );
  return rows[0]?.created_at || null;
}

// Shared eligibility computation used by both /status and /claim, so the
// number the user sees on the button and what /claim actually pays out
// can never drift apart.
async function computeEligibility(userId, balanceCents) {
  const [everWithdrawn, depositCents, lastClaimAt] = await Promise.all([
    hasEverWithdrawn(userId),
    todaysApprovedDepositCents(userId),
    lastCashbackClaimAt(userId),
  ]);

  const now = Date.now();
  const cooldownEndsAt = lastClaimAt ? new Date(lastClaimAt).getTime() + CLAIM_COOLDOWN_MS : 0;
  const onCooldown = cooldownEndsAt > now;
  const secondsUntilNextClaim = onCooldown ? Math.ceil((cooldownEndsAt - now) / 1000) : 0;

  const hasLostEverything = balanceCents === 0;
  const cashbackCents = Math.round(depositCents * (CASHBACK_PERCENT / 100));

  const eligible =
    !everWithdrawn && hasLostEverything && depositCents > 0 && cashbackCents > 0 && !onCooldown;

  let reason = null;
  if (everWithdrawn) reason = 'not_eligible_withdrawn';
  else if (!hasLostEverything) reason = 'balance_not_zero';
  else if (depositCents <= 0) reason = 'no_deposit_today';
  else if (onCooldown) reason = 'cooldown';

  return {
    eligible,
    reason,
    cashback_amount: cashbackCents / 100,
    deposited_today: depositCents / 100,
    seconds_until_next_claim: secondsUntilNextClaim,
  };
}

// GET /api/cashback/status
cashbackRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const result = await computeEligibility(req.user.id, req.user.balance);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cashback/claim
cashbackRouter.post('/claim', requireAuth, claimLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock this user's row so a double-tap (or two requests racing) can't
    // both pass the eligibility check before either has committed - the
    // same guard pattern auth.js uses for the one-time signup bonus.
    const { rows: lockedRows } = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const lockedBalanceCents = lockedRows[0]?.balance ?? 0;

    const everWithdrawn = await hasEverWithdrawn(req.user.id);
    if (everWithdrawn) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cashback is not available on this account' });
    }

    if (lockedBalanceCents !== 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cashback is only available when your balance has been fully lost' });
    }

    const { rows: depRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
       FROM transactions
       WHERE user_id = $1 AND type = 'deposit' AND status = 'approved'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [req.user.id]
    );
    const depositCents = Number(depRows[0].total);

    const { rows: lastClaimRows } = await client.query(
      `SELECT created_at FROM transactions
       WHERE user_id = $1 AND type = 'payout' AND note = $2
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, CASHBACK_NOTE]
    );
    const lastClaimAt = lastClaimRows[0]?.created_at || null;
    if (lastClaimAt && Date.now() - new Date(lastClaimAt).getTime() < CLAIM_COOLDOWN_MS) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You can claim cashback again in 24 hours' });
    }

    const cashbackCents = Math.round(depositCents * (CASHBACK_PERCENT / 100));
    if (cashbackCents <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No losses to claim cashback on today' });
    }

    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [cashbackCents, req.user.id]);
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, note)
       VALUES ($1, 'payout', $2, 'completed', $3)
       RETURNING *`,
      [req.user.id, cashbackCents, CASHBACK_NOTE]
    );

    await client.query('COMMIT');

    pushBalanceUpdate(req.user.id);

    res.json({
      message: `${(cashbackCents / 100).toFixed(2)} ETB cashback credited to your balance.`,
      cashback_amount: cashbackCents / 100,
      transaction: txRows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/* ======================================================================
 *  SECTION 5 — formerly settings.js
 *  Public (no auth) settings endpoints. Mount at /api/settings.
 *  NOTE: this router was defined in the original codebase but never
 *  mounted in server.js — it's included here, unchanged, and now wired
 *  up in server.js so GET /api/settings/game-logo is actually reachable.
 * ==================================================================== */

const publicSettingsRouter = express.Router();

// GET /api/settings/game-logo - public, no auth required, so the game
// screen can display the current logo for any visitor/player.
publicSettingsRouter.get('/game-logo', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT value FROM platform_settings WHERE key = 'game_logo_url'`);
    res.json({ url: rows[0]?.value || null });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  adminRouter,
  referralRouter,
  couponsRouter,
  cashbackRouter,
  publicSettingsRouter,
};
