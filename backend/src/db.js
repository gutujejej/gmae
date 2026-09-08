const { PrismaClient } = require('@prisma/client');

/**
 * ===========================================================================
 * PRISMA CLIENT
 * ===========================================================================
 * Connects via DATABASE_URL, same as your other project. Uses Prisma's
 * connection pooling — if DATABASE_URL points at Supabase's pooler (port
 * 6543, pgbouncer), that's the correct URL to use here as-is.
 * ===========================================================================
 */
const prisma = new PrismaClient();

/**
 * ===========================================================================
 * WALLET LEDGER
 * ===========================================================================
 * RULE: This is the ONLY module that should ever write to LedgerEntry.
 * Every other part of the codebase that needs to move money calls one of
 * these functions — never call prisma.ledgerEntry.create directly
 * elsewhere. That keeps every money movement auditable through one code
 * path.
 *
 * Balance is always derived (SUM of ledgerEntry.amount), never stored as
 * a mutable column on User, so there's no "balance" field to accidentally
 * desync from reality.
 * ===========================================================================
 */

/** Returns the current balance for a user, derived from the ledger. */
async function getBalance(userId) {
  const result = await prisma.ledgerEntry.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return Number(result._sum.amount || 0);
}

/** Credits a user after an admin-approved deposit. */
async function creditDeposit({ userId, amount, transactionId, note }) {
  if (amount <= 0) throw new Error('Deposit amount must be positive');
  return prisma.ledgerEntry.create({
    data: { userId, amount, entryType: 'deposit', transactionId, note: note || 'Deposit approved' },
  });
}

/**
 * Debits a user for an admin-approved withdrawal.
 * Caller MUST verify sufficient balance before calling this — this
 * function does not re-check.
 */
async function debitWithdrawal({ userId, amount, transactionId, note }) {
  if (amount <= 0) throw new Error('Withdrawal amount must be positive');
  return prisma.ledgerEntry.create({
    data: { userId, amount: -Math.abs(amount), entryType: 'withdrawal', transactionId, note: note || 'Withdrawal approved' },
  });
}

/** Reverses a rejected withdrawal (returns funds to the user). */
async function reverseWithdrawal({ userId, amount, transactionId, note }) {
  return prisma.ledgerEntry.create({
    data: {
      userId,
      amount: Math.abs(amount),
      entryType: 'withdrawal_reversal',
      transactionId,
      note: note || 'Withdrawal rejected — funds returned',
    },
  });
}

/** Debits a user's stake when they join a paid room. */
async function debitRoomStake({ userId, amount, roomId }) {
  if (amount <= 0) throw new Error('Stake amount must be positive');
  return prisma.ledgerEntry.create({
    data: { userId, amount: -Math.abs(amount), entryType: 'room_stake', roomId, note: 'Room entry stake' },
  });
}

/** Credits the winner of a room with the pot (after house fee deduction). */
async function creditRoomPayout({ userId, amount, roomId }) {
  if (amount <= 0) throw new Error('Payout amount must be positive');
  return prisma.ledgerEntry.create({
    data: { userId, amount, entryType: 'room_payout', roomId, note: 'Room win payout' },
  });
}

/** Refunds all players if a room is cancelled/voided before completion. */
async function refundRoomStake({ userId, amount, roomId }) {
  return prisma.ledgerEntry.create({
    data: { userId, amount: Math.abs(amount), entryType: 'room_refund', roomId, note: 'Room cancelled — stake refunded' },
  });
}

/** Manual admin balance correction. Always requires a note and admin id. */
async function adjustBalance({ userId, amount, note, adminId }) {
  if (!note) throw new Error('Adjustment requires a note for audit purposes');
  if (!adminId) throw new Error('Adjustment requires the admin making the change');
  return prisma.ledgerEntry.create({
    data: { userId, amount, entryType: 'adjustment', note, createdById: adminId },
  });
}

async function hasSufficientBalance(userId, amount) {
  const balance = await getBalance(userId);
  return balance >= amount;
}

module.exports = {
  prisma,
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
