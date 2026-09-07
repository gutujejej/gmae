const express = require('express');
const { supabase, ledger } = require('./db');
const { requireTelegramAuth, requireAdmin, requireOwner } = require('./auth');

/**
 * ===========================================================================
 * ROOMS ROUTES — listing, creation, room state, own card
 * (live join/start/claim actions happen over Socket.io, see gameEngine.js)
 * ===========================================================================
 */
function createRoomsRouter(roomManager) {
  const router = express.Router();

  router.get('/', requireTelegramAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('rooms')
      .select('id, code, stake, currency, max_players, status, created_at')
      .eq('status', 'waiting')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });

    const enriched = data.map((room) => {
      const live = roomManager.getLiveRoom(room.id);
      return { ...room, playerCount: live ? live.players.size : 0 };
    });

    res.json({ rooms: enriched });
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
        createdBy: req.user.id,
      });

      res.status(201).json({ room });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.get('/:roomId', requireTelegramAuth, async (req, res) => {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', req.params.roomId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const live = roomManager.getLiveRoom(room.id);
    res.json({ room, playerCount: live ? live.players.size : 0, drawnNumbers: live ? live.drawnNumbers : [] });
  });

  router.get('/:roomId/my-card', requireTelegramAuth, async (req, res) => {
    const { data: playerRow, error } = await supabase
      .from('room_players')
      .select('card, marked, status')
      .eq('room_id', req.params.roomId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!playerRow) return res.status(404).json({ error: 'You have not joined this room' });

    res.json(playerRow);
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
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data });
});

walletRouter.post('/deposit', requireTelegramAuth, async (req, res) => {
  try {
    const { amount, provider, providerReference, proofUrl } = req.body;
    const { data: settings } = await supabase.from('app_settings').select('min_deposit').single();

    if (!amount || amount < Number(settings?.min_deposit || 0)) {
      return res.status(400).json({ error: `Minimum deposit is ${settings?.min_deposit ?? 0}` });
    }

    const { data: tx, error } = await supabase
      .from('transactions')
      .insert({
        user_id: req.user.id,
        type: 'deposit',
        amount,
        provider,
        provider_reference: providerReference,
        proof_url: proofUrl,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
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
    const { data: settings } = await supabase.from('app_settings').select('min_withdrawal').single();

    if (!amount || amount < Number(settings?.min_withdrawal || 0)) {
      return res.status(400).json({ error: `Minimum withdrawal is ${settings?.min_withdrawal ?? 0}` });
    }

    const sufficient = await ledger.hasSufficientBalance(req.user.id, amount);
    if (!sufficient) return res.status(402).json({ error: 'Insufficient balance' });

    const { data: tx, error } = await supabase
      .from('transactions')
      .insert({ user_id: req.user.id, type: 'withdrawal', amount, provider, provider_reference: providerReference, status: 'pending' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ===========================================================================
 * ADMIN ROUTES — transaction approval, user management, settings
 * Two-tier: 'owner' (full access) and 'sub_admin' (view-only on approvals)
 * ===========================================================================
 */
const adminRouter = express.Router();

adminRouter.get('/transactions', requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const { data, error } = await supabase
    .from('transactions')
    .select('*, users!inner(telegram_id, username, first_name)')
    .eq('status', status)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ transactions: data });
});

adminRouter.post('/transactions/:id/approve', requireAdmin, requireOwner, async (req, res) => {
  try {
    const { data: tx, error: fetchError } = await supabase.from('transactions').select('*').eq('id', req.params.id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(409).json({ error: `Transaction already ${tx.status}` });

    if (tx.type === 'deposit') {
      await ledger.creditDeposit({ userId: tx.user_id, amount: tx.amount, transactionId: tx.id });
    } else if (tx.type === 'withdrawal') {
      const sufficient = await ledger.hasSufficientBalance(tx.user_id, tx.amount);
      if (!sufficient) return res.status(402).json({ error: 'User no longer has sufficient balance' });
      await ledger.debitWithdrawal({ userId: tx.user_id, amount: tx.amount, transactionId: tx.id });
    }

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({ status: 'approved', reviewed_by: req.admin.id, reviewed_at: new Date().toISOString() })
      .eq('id', tx.id)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ transaction: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/transactions/:id/reject', requireAdmin, requireOwner, async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: tx, error: fetchError } = await supabase.from('transactions').select('*').eq('id', req.params.id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(409).json({ error: `Transaction already ${tx.status}` });

    // No ledger entry needed: deposits credit only on approval, and
    // withdrawals debit only on approval, so rejecting either needs no
    // reversal — nothing was ever moved yet.

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({ status: 'rejected', reviewed_by: req.admin.id, reviewed_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', tx.id)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ transaction: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('users').select('*, user_balances(balance)').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});

adminRouter.post('/users/:id/ban', requireAdmin, requireOwner, async (req, res) => {
  const { reason } = req.body;
  const { data, error } = await supabase.from('users').update({ is_banned: true, ban_reason: reason || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

adminRouter.post('/users/:id/unban', requireAdmin, requireOwner, async (req, res) => {
  const { data, error } = await supabase.from('users').update({ is_banned: false, ban_reason: null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
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
  const { data, error } = await supabase.from('admins').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ admins: data });
});

adminRouter.post('/admins', requireAdmin, requireOwner, async (req, res) => {
  const { telegramId, role } = req.body;
  if (!telegramId || !['owner', 'sub_admin'].includes(role)) {
    return res.status(400).json({ error: 'telegramId and valid role are required' });
  }
  const { data, error } = await supabase.from('admins').insert({ telegram_id: telegramId, role }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ admin: data });
});

adminRouter.delete('/admins/:id', requireAdmin, requireOwner, async (req, res) => {
  const { error } = await supabase.from('admins').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

adminRouter.get('/settings', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('app_settings').select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ settings: data });
});

adminRouter.patch('/settings', requireAdmin, requireOwner, async (req, res) => {
  const allowedFields = ['min_deposit', 'min_withdrawal', 'withdrawal_fee_pct', 'default_house_fee_pct', 'maintenance_mode'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  const { data, error } = await supabase.from('app_settings').update(updates).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ settings: data });
});

module.exports = { createRoomsRouter, walletRouter, adminRouter };
