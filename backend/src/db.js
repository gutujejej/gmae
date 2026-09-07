const { createClient } = require('@supabase/supabase-js');

/**
 * ===========================================================================
 * SUPABASE CLIENT
 * ===========================================================================
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. ' +
    'Set these in your .env file (see .env.example).'
  );
}

// Server-side client using the service role key — bypasses RLS.
// Safe only because this runs on the trusted backend (Railway), never
// in the browser/Mini App. The frontend never gets this key.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

/**
 * ===========================================================================
 * WALLET LEDGER
 * ===========================================================================
 * RULE: This is the ONLY module that should ever write to `ledger_entries`.
 * Every other part of the codebase that needs to move money calls one of
 * these functions — never insert into ledger_entries directly elsewhere.
 * That keeps every money movement auditable through one code path.
 *
 * Balance is always derived (SUM of ledger_entries.amount), never stored
 * as a mutable column, so there's no "balance" field to desync from
 * reality.
 * ===========================================================================
 */

/** Returns the current balance for a user, derived from the ledger. */
async function getBalance(userId) {
  const { data, error } = await supabase
    .from('user_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data ? Number(data.balance) : 0;
}

/** Internal: inserts a single ledger row. Use the named ops below instead of calling this directly. */
async function _insertEntry(entry) {
  const { data, error } = await supabase
    .from('ledger_entries')
    .insert(entry)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Credits a user after an admin-approved deposit. */
async function creditDeposit({ userId, amount, transactionId, note }) {
  if (amount <= 0) throw new Error('Deposit amount must be positive');
  return _insertEntry({
    user_id: userId,
    amount,
    entry_type: 'deposit',
    transaction_id: transactionId,
    note: note || 'Deposit approved',
  });
}

/**
 * Debits a user for an admin-approved withdrawal. Caller MUST verify
 * sufficient balance before calling this (see hasSufficientBalance).
 */
async function debitWithdrawal({ userId, amount, transactionId, note }) {
  if (amount <= 0) throw new Error('Withdrawal amount must be positive');
  return _insertEntry({
    user_id: userId,
    amount: -Math.abs(amount),
    entry_type: 'withdrawal',
    transaction_id: transactionId,
    note: note || 'Withdrawal approved',
  });
}

/** Reverses a rejected withdrawal (returns funds to the user). */
async function reverseWithdrawal({ userId, amount, transactionId, note }) {
  return _insertEntry({
    user_id: userId,
    amount: Math.abs(amount),
    entry_type: 'withdrawal_reversal',
    transaction_id: transactionId,
    note: note || 'Withdrawal rejected — funds returned',
  });
}

/** Debits a user's stake when they join a paid room. */
async function debitRoomStake({ userId, amount, roomId }) {
  if (amount <= 0) throw new Error('Stake amount must be positive');
  return _insertEntry({
    user_id: userId,
    amount: -Math.abs(amount),
    entry_type: 'room_stake',
    room_id: roomId,
    note: 'Room entry stake',
  });
}

/** Credits the winner of a room with the pot (after house fee deduction). */
async function creditRoomPayout({ userId, amount, roomId }) {
  if (amount <= 0) throw new Error('Payout amount must be positive');
  return _insertEntry({
    user_id: userId,
    amount,
    entry_type: 'room_payout',
    room_id: roomId,
    note: 'Room win payout',
  });
}

/** Refunds all players if a room is cancelled/voided before completion. */
async function refundRoomStake({ userId, amount, roomId }) {
  return _insertEntry({
    user_id: userId,
    amount: Math.abs(amount),
    entry_type: 'room_refund',
    room_id: roomId,
    note: 'Room cancelled — stake refunded',
  });
}

/** Manual admin balance correction. Always requires a note and admin id. */
async function adjustBalance({ userId, amount, note, adminId }) {
  if (!note) throw new Error('Adjustment requires a note for audit purposes');
  if (!adminId) throw new Error('Adjustment requires the admin making the change');
  return _insertEntry({
    user_id: userId,
    amount,
    entry_type: 'adjustment',
    note,
    created_by: adminId,
  });
}

async function hasSufficientBalance(userId, amount) {
  const balance = await getBalance(userId);
  return balance >= amount;
}

module.exports = {
  supabase,
  ledger: {
    getBalance,
    creditDeposit,
    debitWithdrawal,
    reverseWithdrawal,
    debitRoomStake,
    creditRoomPayout,
    refundRoomStake,
    adjustBalance,
    hasSufficientBalance,
  },
};
