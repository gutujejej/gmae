/* ====================================================================== */
/*  wallet-dashboard.jsx                                                  */
/*  Merged from: pages/Dashboard.jsx + pages/Deposit.jsx +                */
/*  pages/WalletPage.jsx + components/Wallet.jsx +                        */
/*  components/CashbackCard.jsx. (Mechanical merge only — no logic        */
/*  changed. components/ChannelGate.jsx was dropped — dead code, never    */
/*  imported anywhere in the app. pages/Deposit.jsx is ALSO dead code     */
/*  (not wired into any route — the Wallet component's deposit wizard     */
/*  below is what's actually used) but is kept here, unrouted, as         */
/*  requested; its own TransactionPages.css import was dropped since      */
/*  that stylesheet isn't part of this merge.)                            */
/* ====================================================================== */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  redeemCoupon,
  requestDeposit,
  requestWithdraw,
  getMyTransactions,
  getBalance,
  getCashbackStatus,
  claimCashback,
} from '../app-shell.jsx';
import { useAuth } from '../app-shell.jsx';

/* ======================================================================
 *  SECTION 1 — formerly components/CashbackCard.jsx
 * ==================================================================== */

// Formats a seconds count as HH:MM:SS for the countdown display.
function formatHMS(totalSeconds) {
  const clamped = Math.max(Math.floor(totalSeconds), 0);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return {
    h: String(h).padStart(2, '0'),
    m: String(m).padStart(2, '0'),
    s: String(s).padStart(2, '0'),
  };
}

const REASON_MESSAGES = {
  not_eligible_withdrawn: 'make deposit get 20% Cashback.',
  balance_not_zero: "Cashback unlocks once today's balance has been fully lost.",
  no_deposit_today: 'Make a deposit today to become eligible for cashback.',
  cooldown: null, // shown via the countdown instead
};

function CashbackCard({ onClaimed }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const tickRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await getCashbackStatus();
      setStatus(res.data);
      setSecondsLeft(res.data.seconds_until_next_claim || 0);
    } catch {
      // Non-fatal - the card just won't render actionable info this pass.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Local countdown ticker; re-syncs with the server once it hits zero so
  // eligibility (which depends on today's deposits/balance, not just time)
  // gets re-checked rather than trusting the clock alone.
  useEffect(() => {
    clearInterval(tickRef.current);
    if (secondsLeft <= 0) return undefined;
    tickRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          loadStatus();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [secondsLeft > 0, loadStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClaim = async () => {
    if (claiming || !status?.eligible) return;
    setClaiming(true);
    setError(null);
    setMessage(null);
    try {
      const res = await claimCashback();
      setMessage(res.data.message);
      onClaimed?.(res.data.transaction);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not claim cashback right now.');
      await loadStatus();
    } finally {
      setClaiming(false);
    }
  };

  if (loading) return null;
  if (!status) return null;

  const onCooldown = secondsLeft > 0;
  const { h, m, s } = formatHMS(secondsLeft);

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 18,
        padding: '20px 20px 22px',
        marginBottom: 14,
        background:
          'radial-gradient(140% 100% at 100% 0%, rgba(56,131,255,0.55), transparent 55%), linear-gradient(160deg, #0f2a63 0%, #123a86 45%, #1450c4 100%)',
        boxShadow: '0 10px 30px rgba(20,80,196,0.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.14)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
            <path
              d="M12 3a9 9 0 1 0 9 9"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path d="M17 3v5h-5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="4.2" stroke="#fff" strokeWidth="1.6" />
            <path d="M12 10v4M10.6 11h2.8M10.6 13h2.8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
        <span style={{ fontSize: 20, fontWeight: 800, color: '#fff' }}>Daily Cashback</span>
      </div>

      {onCooldown ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            {[
              { v: h, label: 'HRS' },
              { v: m, label: 'MIN' },
              { v: s, label: 'SEC' },
            ].map((block, i) => (
              <React.Fragment key={block.label}>
                <div
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: 12,
                    padding: '10px 0',
                  }}
                >
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{block.v}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginTop: 4, letterSpacing: 1 }}>
                    {block.label}
                  </div>
                </div>
                {i < 2 && (
                  <span style={{ alignSelf: 'center', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>:</span>
                )}
              </React.Fragment>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 12.5, color: 'rgba(255,255,255,0.75)' }}>
            Your next cashback becomes available when this timer ends.
          </p>
        </>
      ) : (
        <>
          {status.eligible ? (
            <>
              <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
                You lost <strong>ETB {status.deposited_today.toFixed(2)}</strong> deposited today. Claim{' '}
                <strong>ETB {status.cashback_amount.toFixed(2)}</strong> back now.
              </p>
              <button
                type="button"
                onClick={handleClaim}
                disabled={claiming}
                style={{
                  width: '100%',
                  border: 'none',
                  borderRadius: 12,
                  padding: '13px 0',
                  fontSize: 15,
                  fontWeight: 800,
                  color: '#0f2a63',
                  background: claiming ? 'rgba(255,255,255,0.6)' : '#ffffff',
                  cursor: claiming ? 'default' : 'pointer',
                }}
              >
                {claiming ? 'Claiming...' : `Claim ETB ${status.cashback_amount.toFixed(2)} Cashback`}
              </button>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
              {REASON_MESSAGES[status.reason] || 'Cashback is not available right now.'}
            </p>
          )}
        </>
      )}

      {message && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: '#c8f7d4', fontWeight: 600 }}>{message}</div>
      )}
      {error && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: '#ffb4b4', fontWeight: 600 }}>{error}</div>
      )}
    </div>
  );
}

/* ======================================================================
 *  SECTION 2 — formerly components/Wallet.jsx
 *  Balance panel, deposit wizard, withdraw form, and transaction history.
 *  This is the deposit/withdraw flow actually used by the live app (via
 *  the /wallet route below) - pages/Deposit.jsx in Section 4 is a
 *  separate, unrouted, older standalone page kept only because it was
 *  asked to be preserved.
 * ==================================================================== */

const MIN_DEPOSIT = 40;
const MIN_WITHDRAW = 200;
const WAGERING_MULTIPLIER = 100;

const PAYMENT_METHODS = [
  {
    id: 'telebirr',
    label: 'Telebirr',
    logo: 'https://www.ethiotelecom.et/wp-content/uploads/2025/10/telebirr-logo-01.png',
  },
  {
    id: 'cbebirr',
    label: 'CBE Birr',
    logo: 'https://ethiopianlogos.com/logos/cbe_birr_normal/cbe_birr_normal.png',
  },
];

// Agents accept deposits on behalf of the platform; each has one account
// per payment method. Currently only one agent is active.
const AGENTS = [
  {
    id: 'gutu',
    name: 'Gutu',
    accounts: { telebirr: '0992000962', cbebirr: '0992000962' },
  },
];

const DEPOSIT_WINDOW_SECONDS = 15 * 60;

function formatCountdown(totalSeconds) {
  const clamped = Math.max(totalSeconds, 0);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function PaymentMethodGrid({ selected, onSelect }) {
  return (
    <div className="pm-grid">
      {PAYMENT_METHODS.map((m) => (
        <button
          type="button"
          key={m.id}
          className={`pm-card ${selected === m.id ? 'active' : ''}`}
          onClick={() => onSelect(m.id)}
        >
          <span className="pm-card-logo">
            <img src={m.logo} alt={m.label} />
          </span>
          <span className="pm-card-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}

// Step 1 — amount + payment method
function DepositAmountStep({ amount, setAmount, method, setMethod, onContinue }) {
  const [error, setError] = useState(null);

  const handleContinue = (e) => {
    e.preventDefault();
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      setError('Enter a valid amount');
      return;
    }
    if (numericAmount < MIN_DEPOSIT) {
      setError(`Minimum deposit is ${MIN_DEPOSIT} ETB`);
      return;
    }
    if (!method) {
      setError('Select a payment method');
      return;
    }
    setError(null);
    onContinue();
  };

  return (
    <form onSubmit={handleContinue}>
      <div className="amount-field">
        <span className="amount-field-currency">ETB</span>
        <input
          className="amount-field-input"
          type="number"
          step="0.01"
          min={MIN_DEPOSIT}
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </div>
      <p className="field-hint">Minimum deposit is {MIN_DEPOSIT} ETB</p>

      <div className="section-label-row">
        <span className="section-label">Select Payment Method</span>
        <span className="section-label-count">{PAYMENT_METHODS.length} Available</span>
      </div>
      <PaymentMethodGrid selected={method} onSelect={setMethod} />

      {error && <div className="error-text">{error}</div>}
      <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: 8 }}>
        Continue
      </button>
    </form>
  );
}

// Step 2 — instructions to pay the agent's account, with a countdown
function DepositInstructionsStep({ amount, method, agent, onCompleted }) {
  const [secondsLeft, setSecondsLeft] = useState(DEPOSIT_WINDOW_SECONDS);
  const [copied, setCopied] = useState(false);
  const methodMeta = PAYMENT_METHODS.find((m) => m.id === method);
  const accountNumber = agent.accounts[method];

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleCopy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this value:', value);
    }
  };

  return (
    <div className="deposit-instructions">
      <p className="field-hint">Please follow the steps below to complete your deposit.</p>

      <div className="countdown-box">
        <span className="countdown-label">COMPLETE PAYMENT BEFORE</span>
        <span className="countdown-value">{formatCountdown(secondsLeft)} remaining</span>
      </div>

      <div className="instruction-step">
        <span className="instruction-step-num">1</span>
        <span className="instruction-step-title">Transfer Exact Amount</span>
      </div>
      <div className="amount-display-row">
        <div>
          <span className="field-hint" style={{ margin: 0 }}>TOTAL AMOUNT</span>
          <div className="amount-display-value">ETB {amount}</div>
        </div>
        <button type="button" className="icon-btn" onClick={() => handleCopy(amount)} aria-label="Copy amount">
          ⧉
        </button>
      </div>

      <div className="instruction-step">
        <span className="instruction-step-num">2</span>
        <span className="instruction-step-title">Recipient Information</span>
      </div>
      <div className="recipient-info-block">
        <div className="recipient-info-row">
          <span className="recipient-info-label">Bank Name</span>
          <span className="recipient-info-value">{methodMeta?.label?.toUpperCase()}</span>
        </div>
        <div className="recipient-info-row">
          <span className="recipient-info-label">Account Name</span>
          <span className="recipient-info-value">{agent.name.toUpperCase()}</span>
        </div>
        <div className="recipient-info-row">
          <span className="recipient-info-label">Account Number</span>
          <span className="recipient-info-value">
            {accountNumber}
            <button type="button" className="btn btn-outline copy-inline-btn" onClick={() => handleCopy(accountNumber)}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </span>
        </div>
      </div>

      <div className="instruction-step">
        <span className="instruction-step-num">3</span>
        <span className="instruction-step-title">Submit Proof</span>
      </div>
      <p className="field-hint">
        After completing the transfer, tap below to enter your transaction reference or upload your receipt.
      </p>

      <button className="btn btn-primary" type="button" onClick={onCompleted} style={{ width: '100%' }}>
        I Have Completed Payment
      </button>
    </div>
  );
}

// Step 4 — submit reference number / receipt for admin verification
function CompleteOrderStep({ amount, reference, setReference, note, setNote, error, submitting, onSubmit, onCancel }) {
  return (
    <form onSubmit={onSubmit} className="complete-order">
      <span className="chip chip-amount">ETB {amount}</span>

      <div className="notice-box">
        <span>Add reference number or upload receipt</span>
      </div>

      <label className="field-label">Reference Number</label>
      <input
        className="input"
        type="text"
        placeholder="Enter transaction reference"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        autoFocus
      />

      <label className="field-label">Note (optional)</label>
      <input
        className="input"
        type="text"
        placeholder="Add a note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={submitting} style={{ flex: 1 }}>
          Cancel
        </button>
        <button className="btn btn-primary" type="submit" disabled={submitting} style={{ flex: 1 }}>
          {submitting ? 'Submitting...' : 'Confirm Update'}
        </button>
      </div>
    </form>
  );
}

// Orchestrates the 4-step deposit flow.
// Centered modal overlay that dims the wallet page behind it - matches
// the popup-per-step pattern used for the deposit flow.
function DepositModal({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="deposit-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="deposit-modal-card">
        <div className="deposit-modal-header">
          <h4 className="deposit-modal-title">{title}</h4>
          <button type="button" className="deposit-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="deposit-modal-body">{children}</div>
      </div>
    </div>
  );
}

function DepositWizard({ onSubmitted, onClose }) {
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('telebirr');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Only one agent is currently active, so it's selected automatically -
  // there's nothing for the user to choose.
  const agent = AGENTS[0];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!reference.trim()) {
      setError('Enter the transaction reference for your payment');
      return;
    }
    setSubmitting(true);
    try {
      await requestDeposit(parseFloat(amount), reference.trim(), note);
      setStep(1);
      setAmount('');
      setReference('');
      setNote('');
      onSubmitted('Deposit request submitted. An admin will verify your payment shortly.');
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepTitles = {
    1: 'Deposit Amount',
    2: 'Deposit Instructions',
    3: 'Complete Order',
  };

  return (
    <DepositModal title={stepTitles[step]} onClose={onClose}>
      {step === 1 && (
        <DepositAmountStep
          amount={amount}
          setAmount={setAmount}
          method={method}
          setMethod={setMethod}
          onContinue={() => setStep(2)}
        />
      )}
      {step === 2 && agent && (
        <DepositInstructionsStep
          amount={amount}
          method={method}
          agent={agent}
          onCompleted={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <CompleteOrderStep
          amount={amount}
          reference={reference}
          setReference={setReference}
          note={note}
          setNote={setNote}
          error={error}
          submitting={submitting}
          onSubmit={handleSubmit}
          onCancel={() => setStep(2)}
        />
      )}
    </DepositModal>
  );
}

function WithdrawForm({ onSubmitted }) {
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      setError('Enter a valid amount');
      return;
    }
    if (numericAmount < MIN_WITHDRAW) {
      setError(`Minimum withdrawal is ${MIN_WITHDRAW} ETB`);
      return;
    }
    if (!phone.trim()) {
      setError('Enter the Telebirr phone number to receive your withdrawal');
      return;
    }

    setSubmitting(true);
    try {
      await requestWithdraw(numericAmount, phone.trim(), note);
      setAmount('');
      setPhone('');
      setNote('');
      onSubmitted('Withdrawal request submitted. An admin will send the funds shortly.');
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="amount-field">
        <span className="amount-field-currency">ETB</span>
        <input
          className="amount-field-input"
          type="number"
          step="0.01"
          min={MIN_WITHDRAW}
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <p className="field-hint">Minimum withdrawal is {MIN_WITHDRAW} ETB</p>

      <label className="field-label">Telebirr Phone Number</label>
      <input
        className="input"
        type="text"
        placeholder="Phone number to receive funds"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />

      <label className="field-label">Note (optional)</label>
      <input
        className="input"
        type="text"
        placeholder="Add a note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {error && <div className="error-text">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={submitting} style={{ width: '100%' }}>
        {submitting ? 'Submitting...' : 'Withdraw Request'}
      </button>
    </form>
  );
}

function WalletCard() {
  const { user, updateBalance } = useAuth();
  const [tab, setTab] = useState('deposit');
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [message, setMessage] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loadingTx, setLoadingTx] = useState(true);

  const [displayBalance, setDisplayBalance] = useState(user?.balance ?? 0);
  const [balanceUpdating, setBalanceUpdating] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const balanceRef = useRef(displayBalance);

  const refreshBalance = useCallback(async () => {
    try {
      const res = await getBalance();
      const fresh = res.data.balance;
      if (fresh !== balanceRef.current) {
        setBalanceUpdating(true);
        setDisplayBalance(fresh);
        balanceRef.current = fresh;
        updateBalance(fresh);
        setTimeout(() => setBalanceUpdating(false), 350);
      }
    } catch {
      // Non-fatal - keep showing the last known value.
    }
  }, [updateBalance]);

  const handleManualRefresh = useCallback(async () => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    await refreshBalance();
    // Keep the spin visible briefly even on very fast responses, so the
    // action reads as having actually happened.
    setTimeout(() => setManualRefreshing(false), 500);
  }, [manualRefreshing, refreshBalance]);

  const loadTransactions = useCallback(async () => {
    setLoadingTx(true);
    try {
      const res = await getMyTransactions();
      setTransactions(res.data.transactions);
    } catch {
      // Non-fatal.
    } finally {
      setLoadingTx(false);
    }
  }, []);

  useEffect(() => {
    refreshBalance();
    loadTransactions();
    const interval = setInterval(refreshBalance, 10000);
    return () => clearInterval(interval);
  }, [refreshBalance, loadTransactions]);

  const handleSubmitted = (successMessage) => {
    setMessage(successMessage);
    loadTransactions();
    refreshBalance();
  };

  const switchTab = (next) => {
    if (next === 'deposit') {
      setDepositModalOpen(true);
      return;
    }
    setTab(next);
    setMessage(null);
  };

  const pendingCount = transactions.filter((t) => t.status === 'pending').length;

  // Never assume a bonus - only show what the backend actually reports.
  // If bonus_balance is missing or zero, this is 0, not a hardcoded
  // fallback figure - showing fake numbers when a field is momentarily
  // missing from the user object is exactly the bug that shipped before.
  //
  // Wrapped in Number(...) as well as ?? 0: the wagering fields have at
  // times arrived as a string (not just null/undefined) depending on
  // which code path last wrote the cached user object to localStorage,
  // and ?? alone does not coerce a string to a number - calling
  // .toFixed() directly on a string throws "X.toFixed is not a
  // function" and blanked the whole page with no visible error before
  // the error boundary was added. Number(...) guarantees a number here
  // no matter what type the field came in as.
  const bonusBalance = Number(user?.bonus_balance ?? 0);
  const wageringTarget = Number(user?.wagering_target_total ?? 0);
  const wageringRemaining = Number(user?.wagering_required ?? 0);
  // Progress is derived (total - remaining), never a separately-invented
  // number - there is no "wagering_progress" field anywhere in the
  // backend, so reading one directly always silently returned 0.
  const wageringProgress = Math.max(wageringTarget - wageringRemaining, 0);
  const wageringPercent = wageringTarget > 0 ? Math.min((wageringProgress / wageringTarget) * 100, 100) : 100;
  const wageringComplete = wageringRemaining <= 0;

  return (
    <div className="card wallet-card">
      <div className="wallet-scroll-header">
        <h3 className="wallet-title">My Wallet</h3>

        <div className="balance-panel">
          <div className="balance-panel-header">
            <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
              <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <path d="M3 10h18" stroke="currentColor" strokeWidth="1.6" />
              <path d="M15 14h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Total Balance</span>
            <button
              type="button"
              className={`balance-refresh-btn ${manualRefreshing ? 'spinning' : ''}`}
              onClick={handleManualRefresh}
              aria-label="Refresh balance"
              disabled={manualRefreshing}
            >
              <svg viewBox="0 0 24 24" fill="none" width="14" height="14">
                <path
                  d="M20 11A8 8 0 1 0 18.5 16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path d="M20 5v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className={`balance-panel-value ${balanceUpdating ? 'balance-pulse' : ''}`}>
            <span className="balance-currency">ETB</span>
            {Number(displayBalance || 0).toFixed(2)}
          </div>
          <div className="balance-sub-grid">
            <div className="balance-sub-card">
              <span className="balance-sub-label balance-sub-label-safe">
                <svg viewBox="0 0 24 24" fill="none" width="13" height="13">
                  <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
                WITHDRAWABLE
              </span>
              <span className="balance-sub-value balance-sub-value-safe">
                ETB {Number(displayBalance || 0).toFixed(2)}
              </span>
            </div>
            <div className="balance-sub-card">
              <span className="balance-sub-label balance-sub-label-locked">BONUS/LOCKED</span>
              <span className="balance-sub-value balance-sub-value-locked">
                ETB {Number(bonusBalance || 0).toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <div className="wallet-tabs">
          <button
            type="button"
            className={`wallet-tab ${tab === 'deposit' ? 'active' : ''}`}
            onClick={() => switchTab('deposit')}
          >
            ↙ Deposit
          </button>
          <button
            type="button"
            className={`wallet-tab ${tab === 'withdraw' ? 'active' : ''}`}
            onClick={() => switchTab('withdraw')}
          >
            ↗ Withdraw
          </button>
        </div>
      </div>

      <div className="wallet-scroll-body">
        {message && <div className="success-text" style={{ marginTop: 12 }}>{message}</div>}

        {!wageringComplete && (
          <div className="bonus-banner">
            <span className="bonus-banner-icon">
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <rect x="3" y="8" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <rect x="4" y="12" width="16" height="9" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 8v13" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 8c-1.2-2.6-2.8-4-4.2-4A2.2 2.2 0 0 0 5.6 6.2c0 1 .8 1.8 2 1.8H12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M12 8c1.2-2.6 2.8-4 4.2-4a2.2 2.2 0 0 1 2.2 2.2c0 1-.8 1.8-2 1.8H12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="bonus-banner-text">
              You received a <strong>{Number(bonusBalance || 0).toFixed(0)} ETB</strong> registration bonus. Wager{' '}
              <strong>{WAGERING_MULTIPLIER}x</strong> the bonus (ETB {wageringTarget.toFixed(0)}) to unlock it for withdrawal.
            </span>
          </div>
        )}

        {tab === 'withdraw' && !wageringComplete && (
          <div className="wagering-block">
            <div className="wagering-block-header">
              <span className="wagering-block-title">WAGERING PROGRESS</span>
              <span className="wagering-block-fraction">
                ETB {wageringProgress.toFixed(0)} / {wageringTarget.toFixed(0)}
              </span>
            </div>
            <div className="wagering-progress-track">
              <div className="wagering-progress-fill" style={{ width: `${wageringPercent}%` }} />
            </div>
            <p className="wagering-block-hint">
              ETB {wageringRemaining.toFixed(0)} more in wagering needed before your bonus balance becomes withdrawable.
            </p>
          </div>
        )}

        <div className="wallet-panel-body">
          <WithdrawForm onSubmitted={handleSubmitted} />
        </div>

        <div className="wallet-history-header">
          <h4 className="wallet-history-title">History</h4>
          {pendingCount > 0 && <span className="chip chip-pending">{pendingCount} PENDING</span>}
        </div>

        {loadingTx ? (
          <p className="field-hint">Loading...</p>
        ) : transactions.length === 0 ? (
          <p className="field-hint">No transactions yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <td style={{ textTransform: 'capitalize' }}>{t.type}</td>
                    <td>{t.amount.toFixed(2)} ETB</td>
                    <td>
                      <span className={`badge badge-${t.status}`}>{t.status}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {t.type === 'deposit' && t.telebirr_reference_submitted && (
                        <div>Ref: {t.telebirr_reference_submitted}</div>
                      )}
                      {t.type === 'withdraw' && t.telebirr_phone && <div>To: {t.telebirr_phone}</div>}
                      {t.telebirr_reference_admin && <div style={{ color: '#9aa0b4' }}>Sent ref: {t.telebirr_reference_admin}</div>}
                    </td>
                    <td>{new Date(t.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {depositModalOpen && (
        <DepositWizard onSubmitted={handleSubmitted} onClose={() => setDepositModalOpen(false)} />
      )}
    </div>
  );
}

/* ======================================================================
 *  SECTION 3 — formerly pages/WalletPage.jsx
 *  Standalone page for the bottom-nav "Wallet" tab.
 * ==================================================================== */

export function WalletPage() {
  return (
    <div className="container" style={{ paddingBottom: 90 }}>
      <WalletCard />
    </div>
  );
}

/* ======================================================================
 *  SECTION 4 — formerly pages/Deposit.jsx
 *  NOTE: this page is NOT wired into any route (it wasn't in the
 *  original App.jsx either) - the deposit wizard inside WalletCard
 *  above is what the live app actually uses. Kept here unrouted, as
 *  requested, in case it's wanted later.
 * ==================================================================== */

export function Deposit() {
  const { user, updateBalance } = useAuth();
  const navigate = useNavigate();
  const [amount, setAmount] = useState('');
  const [telebirrRef, setTelebirrRef] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [loadingTx, setLoadingTx] = useState(true);

  const loadTransactions = useCallback(async () => {
    setLoadingTx(true);
    try {
      const res = await getMyTransactions();
      setTransactions(res.data.transactions.filter(t => t.type === 'deposit'));
    } catch (err) {
      // Non-fatal
    } finally {
      setLoadingTx(false);
    }
  }, []);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);
    setError(null);

    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      setError('Enter a valid amount greater than 0');
      return;
    }

    if (!telebirrRef.trim()) {
      setError('Enter the Telebirr transaction reference for your payment');
      return;
    }

    setSubmitting(true);
    try {
      await requestDeposit(numericAmount, telebirrRef.trim(), note);
      setMessage('Deposit request submitted successfully. An admin will verify your payment shortly.');
      setAmount('');
      setTelebirrRef('');
      setNote('');
      loadTransactions();
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="transaction-page">
      <div className="transaction-header">
        <button className="back-btn" onClick={() => navigate('/dashboard')}>
          Back
        </button>
        <h1>Deposit Funds</h1>
        <div style={{ width: '40px' }}></div>
      </div>

      <div className="transaction-container">
        <div className="transaction-card">
          <div className="card-header">
            <h2>Add Funds to Your Account</h2>
            <p>please wait</p>
          </div>

          <form onSubmit={handleSubmit} className="transaction-form">
            <div className="form-group">
              <label>Amount (ETB)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Enter amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Telebirr Transaction Reference</label>
              <input
                type="text"
                placeholder="Enter transaction reference (required)"
                value={telebirrRef}
                onChange={(e) => setTelebirrRef(e.target.value)}
                required
              />
              <small>This is the reference number from your Telebirr payment</small>
            </div>

            <div className="form-group">
              <label>Note (Optional)</label>
              <textarea
                placeholder="Add any additional notes"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows="3"
              />
            </div>

            {error && <div className="alert alert-error">{error}</div>}
            {message && <div className="alert alert-success">{message}</div>}

            <button 
              type="submit" 
              disabled={submitting}
              className="submit-btn"
            >
              {submitting ? 'Submitting...' : 'Request Deposit'}
            </button>
          </form>

          <div className="info-box">
            <h3>How to Deposit</h3>
            <ol>
              <li>operator telebirr: 0992000962</li>
              <li>operator telebirr name: Gutu</li>
              <li>Send payment to the operator's Telebirr account</li>
              <li>Copy the transaction reference from your Telebirr receipt</li>
              <li>Paste it in the form above</li>
              <li>An admin will verify and credit your account</li>
            </ol>
          </div>
        </div>

        {/* Recent Deposits */}
        <div className="recent-transactions">
          <h3>Recent Deposits</h3>
          {loadingTx ? (
            <p>Loading...</p>
          ) : transactions.length === 0 ? (
            <p className="no-data">No deposits yet</p>
          ) : (
            <div className="tx-list">
              {transactions.map((t) => (
                <div key={t.id} className="tx-item">
                  <div className="tx-info">
                    <div className="tx-amount">{(t.amount).toFixed(2)} ETB</div>
                    <div className="tx-date">{new Date(t.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className={`tx-status status-${t.status}`}>
                    {t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 5 — formerly pages/Dashboard.jsx
 *  Landing page after login (the "Games" tab).
 * ==================================================================== */

function RedeemCouponModal({ onClose, onRedeemed }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError('Enter a coupon code');
      return;
    }
    setSubmitting(true);
    try {
      const res = await redeemCoupon(code.trim());
      setSuccess(res.data);
      onRedeemed(res.data.balance);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not redeem this coupon');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="deposit-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="deposit-modal-card">
        <div className="deposit-modal-header">
          <h4 className="deposit-modal-title">Redeem Coupon</h4>
          <button type="button" className="deposit-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="deposit-modal-body">
          {success ? (
            <div>
              <div className="admin-notice" style={{ color: '#4ade80', background: 'rgba(74,222,128,0.1)', borderColor: 'rgba(74,222,128,0.3)' }}>
                {success.amount.toFixed(2)} ETB has been added to your balance.
              </div>
              <button className="btn btn-primary" type="button" onClick={onClose} style={{ width: '100%' }}>
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <label className="field-label">Coupon Code</label>
              <input
                className="input"
                type="text"
                placeholder="e.g. WELCOME50"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={{ textTransform: 'uppercase' }}
                autoFocus
              />
              {error && <div className="error-text">{error}</div>}
              <button className="btn btn-primary" type="submit" disabled={submitting} style={{ width: '100%', marginTop: 8 }}>
                {submitting ? 'Redeeming...' : 'Redeem'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user, updateBalance } = useAuth();
  const [couponModalOpen, setCouponModalOpen] = useState(false);

  return (
    <div className="container" style={{ paddingBottom: 90 }}>
      <CashbackCard />

      <button
        type="button"
        className="profile-referral-banner"
        onClick={() => setCouponModalOpen(true)}
        style={{
          width: '100%',
          marginTop: 0,
          marginBottom: 14,
          borderRadius: 16,
        }}
      >
        <span className="profile-referral-banner-icon">
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
            <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M10 7v10" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.6 2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="profile-referral-banner-text">
          <strong>Redeem Coupon</strong>
          <span>Enter a code to add funds to your balance</span>
        </span>
        <span className="profile-referral-banner-arrow">›</span>
      </button>

      <div
        className="card"
        onClick={() => navigate('/dashboard/aviator')}
        style={{
          cursor: 'pointer',
          padding: 0,
          overflow: 'hidden',
          position: 'relative',
          minHeight: 220,
          borderRadius: 18,
          display: 'flex',
          alignItems: 'flex-end',
          border: '1px solid rgba(255,59,78,0.25)',
          boxShadow: '0 12px 28px rgba(255,59,78,0.15)',
          backgroundImage:
            'linear-gradient(180deg, rgba(15,17,23,0) 35%, rgba(15,17,23,0.92) 100%), radial-gradient(130% 100% at 10% 0%, rgba(255,59,78,0.32), transparent 62%), radial-gradient(90% 70% at 90% 100%, rgba(255,185,48,0.14), transparent 60%)',
          backgroundColor: '#121016',
          transition: 'transform 0.15s ease',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            fontSize: 28,
            fontWeight: 800,
            color: '#ff3b4e',
            letterSpacing: '-0.5px',
            textShadow: '0 0 18px rgba(255,59,78,0.45)',
          }}
        >
          Aviator
        </div>
        <div
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: '#ffb930',
            background: 'rgba(0,0,0,0.4)',
            padding: '4px 10px',
            borderRadius: 999,
          }}
        >
          Live
        </div>
        <div style={{ padding: 20, width: '100%' }}>
          <div style={{ fontSize: 14, color: '#e8e8ea', fontWeight: 600, marginBottom: 4 }}>
            Watch it climb. Cash out before it crashes.
          </div>
          <div style={{ fontSize: 12, color: '#9aa0b4' }}>Tap to play</div>
        </div>
      </div>

      <div
        className="card"
        onClick={() => navigate('/dashboard/bingo')}
        style={{
          cursor: 'pointer',
          padding: 0,
          overflow: 'hidden',
          position: 'relative',
          minHeight: 220,
          marginTop: 14,
          borderRadius: 18,
          display: 'flex',
          alignItems: 'flex-end',
          border: '1px solid rgba(74,222,128,0.25)',
          boxShadow: '0 12px 28px rgba(74,222,128,0.15)',
          backgroundImage:
            'linear-gradient(180deg, rgba(15,17,23,0) 35%, rgba(15,17,23,0.92) 100%), radial-gradient(130% 100% at 10% 0%, rgba(74,222,128,0.30), transparent 62%), radial-gradient(90% 70% at 90% 100%, rgba(247,185,85,0.14), transparent 60%)',
          backgroundColor: '#101613',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            fontSize: 28,
            fontWeight: 800,
            color: '#4ade80',
            letterSpacing: '-0.5px',
            textShadow: '0 0 18px rgba(74,222,128,0.45)',
          }}
        >
          Bingo
        </div>
        <div style={{ padding: 20, width: '100%' }}>
          <div style={{ fontSize: 14, color: '#e8e8ea', fontWeight: 600, marginBottom: 4 }}>
            Pick a cartela. Mark a line. Win the pot.
          </div>
          <div style={{ fontSize: 12, color: '#9aa0b4' }}>Tap to play</div>
        </div>
      </div>

      {couponModalOpen && (
        <RedeemCouponModal
          onClose={() => setCouponModalOpen(false)}
          onRedeemed={(newBalance) => updateBalance(newBalance)}
        />
      )}
    </div>
  );
}
