const express = require('express');
const { prisma, ledger } = require('./db');
const { requireTelegramAuth, requireAdmin, requireOwner, verifyPassword, signAdminToken } = require('./auth');

/**
 * ===========================================================================
 * ROOMS ROUTES — listing, creation, room state, own card
 * (live join/start/claim actions happen over Socket.io, see gameEngine.js)
 * ===========================================================================
 */
function createRoomsRouter(roomManager) {
  const router = express.Router();

  router.get('/', requireTelegramAuth, async (req, res) => {
    try {
      const rooms = await prisma.room.findMany({
        where: { status: 'waiting' },
        select: { id: true, code: true, stake: true, currency: true, maxPlayers: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const enriched = rooms.map((room) => {
        const live = roomManager.getLiveRoom(room.id);
        return { ...room, playerCount: live ? live.players.size : 0 };
      });

      res.json({ rooms: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', requireTelegramAuth, async (req, res) => {
    try {
      const { stake, maxPlayers, drawIntervalMs } = req.body;
      if (typeof stake !== 'number' || stake < 0) {
        return res.status(400).json({ error: 'stake must be a non-negative number' });
      }

      const room = await roomManager.createRoom({
        stake,
        maxPlayers: maxPlayers || 100,
        drawIntervalMs: drawIntervalMs || 4000,
        createdById: req.user.id,
      });

      res.status(201).json({ room });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.get('/:roomId', requireTelegramAuth, async (req, res) => {
    try {
      const room = await prisma.room.findUnique({ where: { id: req.params.roomId } });
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const live = roomManager.getLiveRoom(room.id);
      res.json({ room, playerCount: live ? live.players.size : 0, drawnNumbers: live ? live.drawnNumbers : [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:roomId/my-card', requireTelegramAuth, async (req, res) => {
    try {
      const playerRow = await prisma.roomPlayer.findUnique({
        where: { roomId_userId: { roomId: req.params.roomId, userId: req.user.id } },
        select: { card: true, marked: true, status: true },
      });

      if (!playerRow) return res.status(404).json({ error: 'You have not joined this room' });
      res.json(playerRow);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * ===========================================================================
 * WALLET ROUTES — balance, history, deposit/withdrawal requests
 * ===========================================================================
 */
const walletRouter = express.Router();

walletRouter.get('/balance', requireTelegramAuth, async (req, res) => {
  try {
    const balance = await ledger.getBalance(req.user.id);
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

walletRouter.get('/history', requireTelegramAuth, async (req, res) => {
  try {
    const entries = await prisma.ledgerEntry.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

walletRouter.post('/deposit', requireTelegramAuth, async (req, res) => {
  try {
    const { amount, provider, providerReference, proofUrl } = req.body;
    const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });

    if (!amount || amount < Number(settings?.minDeposit || 0)) {
      return res.status(400).json({ error: `Minimum deposit is ${settings?.minDeposit ?? 0}` });
    }

    const tx = await prisma.transaction.create({
      data: {
        userId: req.user.id,
        type: 'deposit',
        amount,
        provider,
        providerReference,
        proofUrl,
        status: 'pending',
      },
    });

    res.status(201).json({ transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Balance is checked at request time AND re-checked at approval time
// (see admin routes below) since it can change between the two.
walletRouter.post('/withdraw', requireTelegramAuth, async (req, res) => {
  try {
    const { amount, provider, providerReference } = req.body;
    const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });

    if (!amount || amount < Number(settings?.minWithdrawal || 0)) {
      return res.status(400).json({ error: `Minimum withdrawal is ${settings?.minWithdrawal ?? 0}` });
    }

    const sufficient = await ledger.hasSufficientBalance(req.user.id, amount);
    if (!sufficient) return res.status(402).json({ error: 'Insufficient balance' });

    const tx = await prisma.transaction.create({
      data: { userId: req.user.id, type: 'withdrawal', amount, provider, providerReference, status: 'pending' },
    });

    res.status(201).json({ transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ===========================================================================
 * ADMIN ROUTES — login (JWT), transaction approval, user management, settings
 * Two-tier: 'owner' (full access) and 'sub_admin' (view-only on approvals)
 * ===========================================================================
 */
const adminRouter = express.Router();

// Public: admin login. Everything else on this router requires the token this returns.
adminRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await verifyPassword(password, admin.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signAdminToken(admin);
    res.json({ token, admin: { id: admin.id, email: admin.email, username: admin.username, role: admin.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const transactions = await prisma.transaction.findMany({
      where: { status },
      include: { user: { select: { telegramId: true, username: true, firstName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/transactions/:id/approve', requireAdmin, requireOwner, async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(409).json({ error: `Transaction already ${tx.status}` });

    if (tx.type === 'deposit') {
      await ledger.creditDeposit({ userId: tx.userId, amount: tx.amount, transactionId: tx.id });
    } else if (tx.type === 'withdrawal') {
      const sufficient = await ledger.hasSufficientBalance(tx.userId, Number(tx.amount));
      if (!sufficient) return res.status(402).json({ error: 'User no longer has sufficient balance' });
      await ledger.debitWithdrawal({ userId: tx.userId, amount: tx.amount, transactionId: tx.id });
    }

    const updated = await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: 'approved', reviewedById: req.admin.id, reviewedAt: new Date() },
    });

    res.json({ transaction: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/transactions/:id/reject', requireAdmin, requireOwner, async (req, res) => {
  try {
    const { reason } = req.body;
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(409).json({ error: `Transaction already ${tx.status}` });

    // No ledger entry needed: deposits credit only on approval, and
    // withdrawals debit only on approval, so rejecting either needs no
    // reversal — nothing was ever moved yet.

    const updated = await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: 'rejected', reviewedById: req.admin.id, reviewedAt: new Date(), rejectionReason: reason || null },
    });

    res.json({ transaction: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // Balances are derived, so fetch them alongside rather than storing on User.
    const withBalances = await Promise.all(
      users.map(async (u) => ({ ...u, balance: await ledger.getBalance(u.id) }))
    );
    res.json({ users: withBalances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/users/:id/ban', requireAdmin, requireOwner, async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: true, banReason: reason || null },
    });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/users/:id/unban', requireAdmin, requireOwner, async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: false, banReason: null },
    });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/users/:id/adjust-balance', requireAdmin, requireOwner, async (req, res) => {
  try {
    const { amount, note } = req.body;
    if (!amount || !note) return res.status(400).json({ error: 'amount and note are required' });
    const entry = await ledger.adjustBalance({ userId: req.params.id, amount, note, adminId: req.admin.id });
    res.json({ entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/admins', requireAdmin, requireOwner, async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({ select: { id: true, email: true, username: true, role: true, createdAt: true } });
    res.json({ admins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete('/admins/:id', requireAdmin, requireOwner, async (req, res) => {
  try {
    await prisma.admin.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.patch('/settings', requireAdmin, requireOwner, async (req, res) => {
  try {
    const allowedFields = ['minDeposit', 'minWithdrawal', 'withdrawalFeePct', 'defaultHouseFeePct', 'maintenanceMode'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    const settings = await prisma.appSettings.update({ where: { id: 1 }, data: updates });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { createRoomsRouter, walletRouter, adminRouter };
