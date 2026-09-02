import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../app-shell.jsx';
import {
  getAllUsers,
  setUserActive,
  adjustUserBalance,
  getPendingTransactions,
  getAllTransactions,
  approveTransaction,
  rejectTransaction,
  getStatsOverview,
  getStatsUsers,
  setGameLogo,
  getGameLogo,
  getAdminSettings,
  setBingoPricing,
  createCoupon,
  getCoupons,
  setCouponActive,
  getOperators,
  createOperator,
  setOperatorActive,
  regenerateOperatorSecret,
  deleteOperator,
  sendBroadcast,
  sendBroadcastPhoto,
} from '../app-shell.jsx';

/* ======================================================================
 *  Formerly components/Navbar.jsx — folded in here since Admin.jsx is
 *  its only user. (Mechanical merge only — no logic changed.)
 * ==================================================================== */

function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="navbar">
      <div className="brand">✈ Aviator</div>
      <div className="links">
        {user && (
          <>
            <Link to="/dashboard">Dashboard</Link>
            {user.role === 'admin' && <Link to="/admin">Admin Panel</Link>}
            <span style={{ color: '#9aa0b4' }}>
              {user.username} · ${Number(user.balance || 0).toFixed(2)}
            </span>
            <button className="btn btn-outline" onClick={handleLogout}>
              Log out
            </button>
          </>
        )}
      </div>
    </nav>
  );
}


function useAsyncList(fetcher, deps) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher();
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

const STAT_ICONS = {
  users: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 19a5.6 5.6 0 0 1 11 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M15.5 5.3a3.2 3.2 0 0 1 0 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M15 12.6c2.4.5 4 1.9 4.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  deposit: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <path d="M12 4v13M6 11l6 6 6-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  withdraw: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <path d="M12 20V7M6 13l6-6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  winnings: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <path d="M8 6h8l-1 5a3 3 0 0 1-6 0L8 6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 14v3M9 20h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  result: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <path d="M4 17l5-5 3 3 7-8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 7h4v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  online: (
    <svg viewBox="0 0 24 24" fill="none" width="17" height="17">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  ),
};

function StatCard({ label, value, tone = 'neutral', icon }) {
  return (
    <div className={`admin-stat-card tone-${tone}`}>
      <span className="admin-stat-icon">{STAT_ICONS[icon]}</span>
      <div className="admin-stat-body">
        <div className="admin-stat-label">{label}</div>
        <div className="admin-stat-value">{value}</div>
      </div>
    </div>
  );
}

function OverviewTab() {
  const { data, loading, error, reload } = useAsyncList(() => getStatsOverview(), []);
  const [logoUrl, setLogoUrl] = useState('');
  const [currentLogo, setCurrentLogo] = useState(null);
  const [logoSaving, setLogoSaving] = useState(false);
  const [logoMessage, setLogoMessage] = useState(null);

  const [settingsLoading, setSettingsLoading] = useState(true);
  const [bingoStakeInput, setBingoStakeInput] = useState('');
  const [bingoCutInput, setBingoCutInput] = useState('');
  const [bingoPricingSaving, setBingoPricingSaving] = useState(false);
  const [bingoPricingMessage, setBingoPricingMessage] = useState(null);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await getAdminSettings();
      setBingoStakeInput(String(res.data.bingo_stake_birr));
      setBingoCutInput(String(res.data.bingo_platform_cut_birr));
    } catch {
      // Non-fatal - fields just stay empty and the admin can still type
      // fresh values in.
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    getGameLogo()
      .then((res) => setCurrentLogo(res.data.url))
      .catch(() => {});
    loadSettings();
  }, [loadSettings]);

  const handleSaveLogo = async (e) => {
    e.preventDefault();
    setLogoMessage(null);
    if (!logoUrl.trim()) return;
    setLogoSaving(true);
    try {
      await setGameLogo(logoUrl.trim());
      setCurrentLogo(logoUrl.trim());
      setLogoUrl('');
      setLogoMessage('Game logo updated.');
    } catch (err) {
      setLogoMessage(err.response?.data?.error || 'Could not update logo');
    } finally {
      setLogoSaving(false);
    }
  };

  const handleSaveBingoPricing = async (e) => {
    e.preventDefault();
    setBingoPricingMessage(null);
    const stake = parseFloat(bingoStakeInput);
    const cut = parseFloat(bingoCutInput);
    if (isNaN(stake) || stake <= 0) {
      setBingoPricingMessage('Enter a positive stake amount');
      return;
    }
    if (isNaN(cut) || cut < 0) {
      setBingoPricingMessage('Enter 0 or a positive platform cut');
      return;
    }
    if (cut >= stake) {
      setBingoPricingMessage('Platform cut must be less than the stake amount');
      return;
    }
    setBingoPricingSaving(true);
    try {
      await setBingoPricing(stake, cut);
      setBingoPricingMessage('Bingo pricing updated. Takes effect starting with the next round.');
    } catch (err) {
      setBingoPricingMessage(err.response?.data?.error || 'Could not update bingo pricing');
    } finally {
      setBingoPricingSaving(false);
    }
  };

  if (loading) return <p className="admin-muted-text">Loading overview...</p>;
  if (error) return <div className="error-text">{error}</div>;

  const platformResult = data.platformResult ?? 0;

  return (
    <div>
      <div className="admin-stats-grid">
        <StatCard label="Total Users" value={data.totalUsers ?? 0} tone="neutral" icon="users" />
        <StatCard
          label="Total Deposited"
          value={`${(data.totalDeposited ?? 0).toFixed(2)} ETB`}
          tone="positive"
          icon="deposit"
        />
        <StatCard
          label="Total Withdrawn"
          value={`${(data.totalWithdrawn ?? 0).toFixed(2)} ETB`}
          tone="negative"
          icon="withdraw"
        />
        <StatCard
          label="Total User Winnings"
          value={`${(data.totalUserWinnings ?? 0).toFixed(2)} ETB`}
          tone="warning"
          icon="winnings"
        />
        <StatCard
          label="Platform Result"
          value={`${platformResult >= 0 ? '+' : ''}${platformResult.toFixed(2)} ETB`}
          tone={platformResult >= 0 ? 'positive' : 'negative'}
          icon="result"
        />
        <StatCard label="Online Now" value={data.onlineUsers ?? 0} tone="neutral" icon="online" />
      </div>
      <button className="btn btn-outline admin-refresh-btn" onClick={reload}>
        Refresh
      </button>

      <div className="admin-section-card">
        <h4 className="admin-section-title">Game Logo</h4>
        <p className="admin-muted-text">
          Set the image URL shown as the Buna Games logo. Upload your image to any image host
          first, then paste the resulting URL here.
        </p>
        {currentLogo && (
          <div className="admin-logo-preview">
            <img src={currentLogo} alt="Current game logo" />
          </div>
        )}
        <form onSubmit={handleSaveLogo} className="admin-inline-form">
          <input
            className="input"
            type="url"
            placeholder="https://example.com/logo.png"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            style={{ flex: 1, minWidth: 200, marginBottom: 0 }}
          />
          <button className="btn btn-primary" type="submit" disabled={logoSaving}>
            {logoSaving ? 'Saving...' : 'Save Logo'}
          </button>
        </form>
        {logoMessage && <p className="admin-muted-text" style={{ marginTop: 8 }}>{logoMessage}</p>}
      </div>

      <div className="admin-section-card">
        <h4 className="admin-section-title">Bingo Pricing</h4>
        <p className="admin-muted-text">
          Stake per cartela and the platform's cut of it. Changes take effect starting with the
          next round that opens - a round already in progress keeps the pricing it started with.
        </p>
        {settingsLoading ? (
          <p className="admin-muted-text">Loading...</p>
        ) : (
          <form onSubmit={handleSaveBingoPricing} className="admin-inline-form" style={{ flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="field-label" style={{ margin: 0 }}>Stake (ETB)</label>
              <input
                className="input"
                type="number"
                min="1"
                step="0.01"
                placeholder="10"
                value={bingoStakeInput}
                onChange={(e) => setBingoStakeInput(e.target.value)}
                style={{ width: 110, marginBottom: 0 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="field-label" style={{ margin: 0 }}>Platform Cut (ETB)</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                placeholder="2"
                value={bingoCutInput}
                onChange={(e) => setBingoCutInput(e.target.value)}
                style={{ width: 110, marginBottom: 0 }}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={bingoPricingSaving} style={{ alignSelf: 'flex-end' }}>
              {bingoPricingSaving ? 'Saving...' : 'Save'}
            </button>
          </form>
        )}
        {bingoPricingMessage && <p className="admin-muted-text" style={{ marginTop: 8 }}>{bingoPricingMessage}</p>}
      </div>

    </div>
  );
}

function BalanceEditForm({ user, onDone, onCancel }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount === 0) {
      setError('Enter a non-zero amount (negative to deduct)');
      return;
    }
    if (!reason.trim()) {
      setError('A reason is required');
      return;
    }
    setSaving(true);
    try {
      await adjustUserBalance(user.id, numericAmount, reason.trim());
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update balance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <input
        className="input"
        type="number"
        step="0.01"
        placeholder="+50 or -50"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={{ width: 110, marginBottom: 0 }}
        autoFocus
      />
      <input
        className="input"
        type="text"
        placeholder="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: 160, marginBottom: 0 }}
      />
      <button className="btn btn-success" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      <button className="btn btn-outline" type="button" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      {error && <div className="error-text" style={{ width: '100%' }}>{error}</div>}
    </form>
  );
}

function UsersTab() {
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const { data, loading, error, reload } = useAsyncList(() => getStatsUsers(1, search), [search]);
  const [editingId, setEditingId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const toggleActive = async (user) => {
    setActionError(null);
    try {
      await setUserActive(user.id, !user.isActive);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to update user');
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearch(searchInput.trim());
  };

  if (loading) return <p className="admin-muted-text">Loading users...</p>;
  if (error) return <div className="error-text">{error}</div>;

  return (
    <div>
      {actionError && <div className="error-text" style={{ marginBottom: 12 }}>{actionError}</div>}

      <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          className="input"
          type="text"
          placeholder="Search by username or name"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ flex: 1, minWidth: 200, marginBottom: 0 }}
        />
        <button className="btn btn-primary" type="submit">
          Search
        </button>
        {search && (
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => {
              setSearchInput('');
              setSearch('');
            }}
          >
            Clear
          </button>
        )}
      </form>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Phone</th>
              <th>Balance</th>
              <th>Total Won</th>
              <th>Status</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data.users || []).length === 0 ? (
              <tr>
                <td colSpan={7} className="admin-muted-text" style={{ textAlign: 'center' }}>
                  No users found.
                </td>
              </tr>
            ) : (
              data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.phone || '—'}</td>
                  <td>{u.balance.toFixed(2)} ETB</td>
                  <td style={{ color: '#4ade80' }}>{u.totalWon.toFixed(2)} ETB</td>
                  <td>
                    <span className={`badge ${u.isActive ? 'badge-approved' : 'badge-rejected'}`}>
                      {u.isActive ? 'active' : 'banned'}
                    </span>
                  </td>
                  <td>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td style={{ minWidth: editingId === u.id ? 320 : undefined }}>
                    {editingId === u.id ? (
                      <BalanceEditForm
                        user={u}
                        onDone={() => {
                          setEditingId(null);
                          reload();
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-outline" onClick={() => toggleActive(u)}>
                          {u.isActive ? 'Ban' : 'Unban'}
                        </button>
                        <button className="btn btn-outline" onClick={() => setEditingId(u.id)}>
                          Edit Balance
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PendingTab() {
  const { data, loading, error, reload } = useAsyncList(() => getPendingTransactions(), []);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  // Replaces window.prompt()/window.confirm() - neither is reliably
  // supported inside Telegram's in-app WebView (prompt() in particular
  // can return null immediately without ever showing the native dialog,
  // which silently skipped every approval). This opens an inline
  // reference/reason input directly in the row instead:
  // { txId, mode: 'approve' | 'reject', value } | null
  const [activeForm, setActiveForm] = useState(null);

  const openApproveForm = (tx) => {
    setActionError(null);
    setActiveForm({ txId: tx.id, mode: 'approve', value: tx.telebirr_reference_submitted || '' });
  };

  const openRejectForm = (tx) => {
    setActionError(null);
    setActiveForm({ txId: tx.id, mode: 'reject', value: '' });
  };

  const submitApprove = async () => {
    if (!activeForm.value.trim()) {
      setActionError('A Telebirr reference is required to approve this transaction.');
      return;
    }
    setBusyId(activeForm.txId);
    try {
      await approveTransaction(activeForm.txId, activeForm.value.trim());
      setActiveForm(null);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Approval failed');
    } finally {
      setBusyId(null);
    }
  };

  const submitReject = async () => {
    setBusyId(activeForm.txId);
    try {
      await rejectTransaction(activeForm.txId, activeForm.value.trim());
      setActiveForm(null);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Rejection failed');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <p className="admin-muted-text">Loading pending requests...</p>;
  if (error) return <div className="error-text">{error}</div>;

  const items = data.transactions || [];

  if (items.length === 0) return <p className="admin-muted-text">No pending requests.</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div className="admin-notice">
        Deposits: verify the Telebirr reference against the real Telebirr business account before
        approving. Withdrawals: send the money via Telebirr <strong>first</strong>, then approve using
        the reference from that transfer as proof.
      </div>
      {actionError && <div className="error-text" style={{ marginBottom: 12 }}>{actionError}</div>}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Telebirr</th>
            <th>Note</th>
            <th>Requested</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <React.Fragment key={t.id}>
              <tr>
                <td>{t.user ? `${t.user.username} (${t.user.phone})` : 'Unknown'}</td>
                <td style={{ textTransform: 'capitalize' }}>{t.type}</td>
                <td>{t.amount.toFixed(2)} ETB</td>
                <td style={{ fontSize: 13 }}>
                  {t.type === 'deposit'
                    ? `Ref: ${t.telebirr_reference_submitted || '—'}`
                    : `To: ${t.telebirr_phone || '—'}`}
                </td>
                <td>{t.note || '—'}</td>
                <td>{new Date(t.created_at).toLocaleString()}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-success"
                    disabled={busyId === t.id}
                    onClick={() => openApproveForm(t)}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={busyId === t.id}
                    onClick={() => openRejectForm(t)}
                  >
                    Reject
                  </button>
                </td>
              </tr>
              {activeForm && activeForm.txId === t.id && (
                <tr>
                  <td colSpan={7} style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {activeForm.mode === 'approve' ? (
                      <div style={{ padding: '10px 4px' }}>
                        <label className="field-label">
                          Telebirr reference {t.type === 'deposit' ? 'you verified' : 'from the transfer you just sent'}
                        </label>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <input
                            className="input"
                            type="text"
                            value={activeForm.value}
                            onChange={(e) => setActiveForm({ ...activeForm, value: e.target.value })}
                            style={{ flex: 1, minWidth: 200, marginBottom: 0 }}
                            autoFocus
                          />
                          <button className="btn btn-success" disabled={busyId === t.id} onClick={submitApprove}>
                            {busyId === t.id ? 'Approving...' : 'Confirm Approve'}
                          </button>
                          <button className="btn btn-outline" onClick={() => setActiveForm(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '10px 4px' }}>
                        <label className="field-label">Reason for rejection (optional)</label>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <input
                            className="input"
                            type="text"
                            value={activeForm.value}
                            onChange={(e) => setActiveForm({ ...activeForm, value: e.target.value })}
                            style={{ flex: 1, minWidth: 200, marginBottom: 0 }}
                            autoFocus
                          />
                          <button className="btn btn-danger" disabled={busyId === t.id} onClick={submitReject}>
                            {busyId === t.id ? 'Rejecting...' : 'Confirm Reject'}
                          </button>
                          <button className="btn btn-outline" onClick={() => setActiveForm(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTab() {
  const { data, loading, error } = useAsyncList(() => getAllTransactions(), []);

  if (loading) return <p className="admin-muted-text">Loading history...</p>;
  if (error) return <div className="error-text">{error}</div>;

  const items = data.transactions || [];

  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Telebirr ref (sent/verified)</th>
            <th>Handled by</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id}>
              <td>{t.user ? t.user.username : 'Unknown'}</td>
              <td style={{ textTransform: 'capitalize' }}>{t.type}</td>
              <td>{t.amount.toFixed(2)} ETB</td>
              <td>
                <span className={`badge badge-${t.status}`}>{t.status}</span>
              </td>
              <td style={{ fontSize: 12 }}>{t.telebirr_reference_admin || '—'}</td>
              <td>{t.approved_by || '—'}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function CreateCouponForm({ onCreated }) {
  const [code, setCode] = useState('');
  const [type, setType] = useState('free');
  const [amount, setAmount] = useState('');
  const [maxClaims, setMaxClaims] = useState('');
  const [depositWindow, setDepositWindow] = useState('week');
  const [minDeposit, setMinDeposit] = useState('');
  const [requireFirstDeposit, setRequireFirstDeposit] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!code.trim()) return setError('Enter a code');
    if (!amount || Number(amount) <= 0) return setError('Enter a valid amount');
    if (!maxClaims || Number(maxClaims) <= 0) return setError('Enter a valid number of claims');
    if (type === 'deposit_gated' && (!minDeposit || Number(minDeposit) <= 0)) {
      return setError('Enter a minimum deposit for a deposit-gated coupon');
    }

    setSaving(true);
    try {
      await createCoupon({
        code: code.trim(),
        type,
        amount: Number(amount),
        maxClaims: Number(maxClaims),
        depositWindow: type === 'deposit_gated' ? depositWindow : undefined,
        minDeposit: type === 'deposit_gated' ? Number(minDeposit) : undefined,
        requireFirstDeposit: type === 'deposit_gated' ? requireFirstDeposit : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setCode('');
      setAmount('');
      setMaxClaims('');
      setMinDeposit('');
      setExpiresAt('');
      setRequireFirstDeposit(false);
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create coupon');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="admin-section-card">
      <h4 className="admin-section-title">Create Coupon</h4>

      <div className="admin-form-row">
        <div>
          <label className="field-label">Code</label>
          <input
            className="input"
            type="text"
            placeholder="e.g. WELCOME50"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ textTransform: 'uppercase' }}
          />
        </div>
        <div>
          <label className="field-label">Amount (ETB)</label>
          <input
            className="input"
            type="number"
            step="0.01"
            placeholder="50"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">Max Claims</label>
          <input
            className="input"
            type="number"
            placeholder="100"
            value={maxClaims}
            onChange={(e) => setMaxClaims(e.target.value)}
          />
        </div>
      </div>

      <label className="field-label">Type</label>
      <div className="admin-type-toggle">
        <button
          type="button"
          className={`admin-type-btn ${type === 'free' ? 'active' : ''}`}
          onClick={() => setType('free')}
        >
          Free (anyone can claim)
        </button>
        <button
          type="button"
          className={`admin-type-btn ${type === 'deposit_gated' ? 'active' : ''}`}
          onClick={() => setType('deposit_gated')}
        >
          Deposit-gated
        </button>
      </div>

      {type === 'deposit_gated' && (
        <div className="admin-form-row" style={{ marginTop: 10 }}>
          <div>
            <label className="field-label">Deposit Window</label>
            <select className="input" value={depositWindow} onChange={(e) => setDepositWindow(e.target.value)}>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="year">This Year</option>
            </select>
          </div>
          <div>
            <label className="field-label">Min Deposit (ETB)</label>
            <input
              className="input"
              type="number"
              step="0.01"
              placeholder="100"
              value={minDeposit}
              onChange={(e) => setMinDeposit(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#cbbda6' }}>
              <input
                type="checkbox"
                checked={requireFirstDeposit}
                onChange={(e) => setRequireFirstDeposit(e.target.checked)}
              />
              First deposit only
            </label>
          </div>
        </div>
      )}

      <label className="field-label">Expires At (optional)</label>
      <input
        className="input"
        type="datetime-local"
        value={expiresAt}
        onChange={(e) => setExpiresAt(e.target.value)}
        style={{ maxWidth: 260 }}
      />

      {error && <div className="error-text">{error}</div>}

      <button className="btn btn-primary" type="submit" disabled={saving} style={{ marginTop: 12 }}>
        {saving ? 'Creating...' : 'Create Coupon'}
      </button>
    </form>
  );
}

function CouponsTab() {
  const { data, loading, error, reload } = useAsyncList(() => getCoupons(), []);
  const [actionError, setActionError] = useState(null);

  const toggleActive = async (coupon) => {
    setActionError(null);
    try {
      await setCouponActive(coupon.id, !coupon.active);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to update coupon');
    }
  };

  return (
    <div>
      <CreateCouponForm onCreated={reload} />

      {actionError && <div className="error-text" style={{ marginTop: 12 }}>{actionError}</div>}

      <h4 className="admin-section-title" style={{ marginTop: 24 }}>Existing Coupons</h4>

      {loading ? (
        <p className="admin-muted-text">Loading coupons...</p>
      ) : error ? (
        <div className="error-text">{error}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Claims</th>
                <th>Conditions</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data.coupons || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="admin-muted-text" style={{ textAlign: 'center' }}>
                    No coupons yet.
                  </td>
                </tr>
              ) : (
                data.coupons.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700 }}>{c.code}</td>
                    <td>{c.type === 'free' ? 'Free' : 'Deposit-gated'}</td>
                    <td>{c.amount.toFixed(2)} ETB</td>
                    <td>
                      {c.claimsUsed} / {c.maxClaims}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {c.type === 'deposit_gated' ? (
                        <>
                          Min {c.minDeposit?.toFixed(2)} ETB, {c.depositWindow}
                          {c.requireFirstDeposit ? ' (first deposit only)' : ''}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <span className={`badge ${c.active ? 'badge-approved' : 'badge-rejected'}`}>
                        {c.active ? 'active' : 'paused'}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-outline" onClick={() => toggleActive(c)}>
                        {c.active ? 'Pause' : 'Release'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Operators (API sharing) - lets an external platform embed the Aviator
// game "seamless wallet" style, like Spribe. Creating an operator here
// generates the api_key/api_secret they use to call POST /api/operator/launch
// server-to-server. The secret is only ever shown once (at creation, or
// right after a regenerate) - after that only the key (safe to display) is
// shown, matching how most provider APIs handle secrets.
// ============================================================================

function NewOperatorSecretBanner({ operatorName, apiKey, apiSecret, onDismiss }) {
  return (
    <div className="admin-section-card" style={{ borderColor: '#4f8ef7' }}>
      <h4 className="admin-section-title">
        {operatorName} - save these credentials now
      </h4>
      <p className="admin-muted-text">
        This is the only time the API secret will be shown. Send both values to the operator
        over a secure channel - if the secret is lost, you'll need to regenerate it.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        <div>
          <label className="field-label">API Key</label>
          <input className="input" readOnly value={apiKey} onFocus={(e) => e.target.select()} />
        </div>
        <div>
          <label className="field-label">API Secret</label>
          <input className="input" readOnly value={apiSecret} onFocus={(e) => e.target.select()} />
        </div>
      </div>
      <button className="btn btn-outline" onClick={onDismiss} style={{ marginTop: 12 }}>
        I've saved these - dismiss
      </button>
    </div>
  );
}

function CreateOperatorForm({ onCreated }) {
  const [name, setName] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [currency, setCurrency] = useState('ETB');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Enter an operator name');
    if (!callbackUrl.trim()) return setError('Enter the operator\'s wallet callback base URL');
    if (!currency.trim()) return setError('Enter a currency code');

    setSaving(true);
    try {
      const res = await createOperator(name.trim(), callbackUrl.trim(), currency.trim());
      setName('');
      setCallbackUrl('');
      setCurrency('ETB');
      onCreated(res.data.operator, res.data.api_secret);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create operator');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="admin-section-card">
      <h4 className="admin-section-title">Add Operator</h4>
      <p className="admin-muted-text">
        Creates an API key/secret the operator uses to call POST /api/operator/launch and to
        receive signed debit/credit callbacks for every bet and payout - seamless wallet, the
        operator keeps the player's real balance on their own database/server; nothing is
        deducted locally for their players.
      </p>

      <div className="admin-form-row">
        <div>
          <label className="field-label">Operator Name</label>
          <input
            className="input"
            type="text"
            placeholder="e.g. PartnerSite"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">Wallet Callback Base URL</label>
          <input
            className="input"
            type="url"
            placeholder="https://partner.example.com/wallet"
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">Currency</label>
          <input
            className="input"
            type="text"
            placeholder="ETB"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={{ maxWidth: 100, textTransform: 'uppercase' }}
          />
        </div>
      </div>

      <p className="admin-muted-text" style={{ fontSize: 12 }}>
        We'll call <code>{'{callback_url}'}/debit</code>, <code>{'{callback_url}'}/credit</code>,
        and <code>{'{callback_url}'}/balance</code> on the operator, each signed with their secret.
      </p>

      {error && <div className="error-text">{error}</div>}

      <button className="btn btn-primary" type="submit" disabled={saving} style={{ marginTop: 12 }}>
        {saving ? 'Creating...' : 'Create Operator'}
      </button>
    </form>
  );
}

function OperatorsTab() {
  const { data, loading, error, reload } = useAsyncList(() => getOperators(), []);
  const [revealed, setRevealed] = useState(null); // { name, apiKey, apiSecret } | null
  const [actionError, setActionError] = useState(null);
  // Replaces window.confirm() for destructive actions - Telegram's
  // in-app WebView does not reliably support native confirm() dialogs
  // (see the two-tap pattern in BroadcastTab/PhotoBroadcastForm above
  // for the same underlying issue), so this renders an inline
  // "are you sure" banner instead: { operator, action: 'regenerate' | 'delete' } | null
  const [pendingConfirm, setPendingConfirm] = useState(null);

  const handleCreated = (operator, apiSecret) => {
    setRevealed({ name: operator.name, apiKey: operator.api_key, apiSecret });
    reload();
  };

  const toggleActive = async (operator) => {
    setActionError(null);
    try {
      await setOperatorActive(operator.id, !operator.is_active);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to update operator');
    }
  };

  const confirmRegenerate = async (operator) => {
    setPendingConfirm(null);
    setActionError(null);
    try {
      const res = await regenerateOperatorSecret(operator.id);
      setRevealed({ name: operator.name, apiKey: operator.api_key, apiSecret: res.data.api_secret });
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to regenerate secret');
    }
  };

  const confirmDelete = async (operator) => {
    setPendingConfirm(null);
    setActionError(null);
    try {
      await deleteOperator(operator.id);
      reload();
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to delete operator');
    }
  };

  return (
    <div>
      {revealed && (
        <NewOperatorSecretBanner
          operatorName={revealed.name}
          apiKey={revealed.apiKey}
          apiSecret={revealed.apiSecret}
          onDismiss={() => setRevealed(null)}
        />
      )}

      <CreateOperatorForm onCreated={handleCreated} />

      {actionError && (
        <div className="admin-section-card">
          <div className="error-text">{actionError}</div>
        </div>
      )}

      {pendingConfirm && (
        <div className="admin-section-card" style={{ borderColor: '#f7b955' }}>
          <p style={{ margin: 0, color: '#f2f2f4' }}>
            {pendingConfirm.action === 'delete'
              ? `Delete ${pendingConfirm.operator.name}? This cannot be undone.`
              : `Regenerate the API secret for ${pendingConfirm.operator.name}? The old secret will stop working immediately.`}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={() =>
                pendingConfirm.action === 'delete'
                  ? confirmDelete(pendingConfirm.operator)
                  : confirmRegenerate(pendingConfirm.operator)
              }
            >
              Yes, {pendingConfirm.action === 'delete' ? 'delete it' : 'regenerate'}
            </button>
            <button className="btn btn-outline" onClick={() => setPendingConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h4 className="admin-section-title" style={{ marginTop: 24 }}>Operators</h4>

      {loading ? (
        <p className="admin-muted-text">Loading operators...</p>
      ) : error ? (
        <div className="error-text">{error}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>API Key</th>
                <th>Callback URL</th>
                <th>Currency</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data.operators || []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="admin-muted-text" style={{ textAlign: 'center' }}>
                    No operators yet.
                  </td>
                </tr>
              ) : (
                data.operators.map((op) => (
                  <tr key={op.id}>
                    <td style={{ fontWeight: 700 }}>{op.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{op.api_key}</td>
                    <td style={{ fontSize: 12 }}>{op.callback_url}</td>
                    <td>{op.currency}</td>
                    <td>
                      <span className={`badge ${op.is_active ? 'badge-approved' : 'badge-rejected'}`}>
                        {op.is_active ? 'active' : 'disabled'}
                      </span>
                    </td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-outline" onClick={() => toggleActive(op)}>
                        {op.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-outline" onClick={() => setPendingConfirm({ operator: op, action: 'regenerate' })}>
                        Regenerate Secret
                      </button>
                      <button className="btn btn-outline" onClick={() => setPendingConfirm({ operator: op, action: 'delete' })}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Broadcast (Telegram) - sends a text message to every user who registered
// through the Telegram bot (i.e. has a telegram_id on file). Backed by
// POST /api/admin/broadcast, which fans the message out via
// telegram-bot.js's broadcastMessage().
// ============================================================================

function PhotoBroadcastForm() {
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // Same two-tap confirm as the text broadcast above, and for the same
  // reason - window.confirm() is unreliable inside Telegram's WebView.
  const [armed, setArmed] = useState(false);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0] || null;
    setImageFile(file);
    setError(null);
    setArmed(false);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
  };

  const handleSend = async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!imageFile) {
      setError('Choose an image to send');
      return;
    }

    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);

    setSending(true);
    try {
      const res = await sendBroadcastPhoto(imageFile, caption.trim());
      setResult(res.data);
      setImageFile(null);
      setCaption('');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      // Clears the native file input's displayed filename, since React
      // can't control a file input's value directly.
      e.target.reset();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send photo broadcast');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSend} className="admin-section-card">
        <h4 className="admin-section-title">Send Photo Broadcast</h4>
        <p className="admin-muted-text">
          Sends an image (with an optional caption) to every user who registered through the
          Telegram bot. The same rules as a text broadcast apply - there's no undo once it's sent.
        </p>

        <input
          className="input"
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          style={{ padding: 10 }}
        />

        {previewUrl && (
          <img
            src={previewUrl}
            alt="Preview"
            style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 10, marginTop: 10, display: 'block' }}
          />
        )}

        <textarea
          className="input"
          rows={3}
          placeholder="Optional caption..."
          value={caption}
          onChange={(e) => {
            setCaption(e.target.value);
            setArmed(false);
          }}
          style={{ resize: 'vertical', fontFamily: 'inherit', marginTop: 10 }}
        />

        {error && <div className="error-text">{error}</div>}

        {armed && !sending && (
          <p style={{ color: '#f7b955', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
            Tap again to confirm - this will message every Telegram user right now.
          </p>
        )}

        <button
          className={`btn ${armed ? 'btn-outline' : 'btn-primary'}`}
          type="submit"
          disabled={sending}
          style={{ marginTop: 12 }}
        >
          {sending ? 'Sending...' : armed ? 'Tap to Confirm Send' : 'Send Photo Broadcast'}
        </button>
      </form>

      {result && (
        <div className="admin-section-card">
          <h4 className="admin-section-title">Last Photo Broadcast Result</h4>
          <p className="admin-muted-text">
            Sent to {result.sent} of {result.total} recipients{result.failed > 0 ? ` (${result.failed} failed)` : ''}.
          </p>
        </div>
      )}
    </div>
  );
}

function BroadcastTab() {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // Two-tap confirm instead of window.confirm(): Telegram's in-app
  // WebView does not reliably support native confirm()/alert() dialogs -
  // on many clients the call returns instantly without ever showing
  // anything, which silently skipped sending altogether (the guard
  // `if (!window.confirm(...)) return;` always took the "cancelled"
  // branch). This renders entirely within the page instead, so it works
  // the same inside Telegram as in a normal browser.
  const [armed, setArmed] = useState(false);

  const handleSend = async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!message.trim()) {
      setError('Enter a message to send');
      return;
    }

    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);

    setSending(true);
    try {
      const res = await sendBroadcast(message.trim());
      setResult(res.data);
      setMessage('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send broadcast');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSend} className="admin-section-card">
        <h4 className="admin-section-title">Send Broadcast</h4>
        <p className="admin-muted-text">
          Sends this message to every user who registered through the Telegram bot. There's no
          undo once it's sent, so double-check the wording first.
        </p>

        <textarea
          className="input"
          rows={5}
          placeholder="Write your announcement here..."
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setArmed(false);
          }}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />

        {error && <div className="error-text">{error}</div>}

        {armed && !sending && (
          <p style={{ color: '#f7b955', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
            Tap again to confirm - this will message every Telegram user right now.
          </p>
        )}

        <button
          className={`btn ${armed ? 'btn-outline' : 'btn-primary'}`}
          type="submit"
          disabled={sending}
          style={{ marginTop: 12 }}
        >
          {sending ? 'Sending...' : armed ? 'Tap to Confirm Send' : 'Send Broadcast'}
        </button>
      </form>

      {result && (
        <div className="admin-section-card">
          <h4 className="admin-section-title">Last Broadcast Result</h4>
          <p className="admin-muted-text">
            Sent to {result.sent} of {result.total} recipients{result.failed > 0 ? ` (${result.failed} failed)` : ''}.
          </p>
        </div>
      )}

      <PhotoBroadcastForm />
    </div>
  );
}

const ADMIN_TABS = [
  {
    id: 'overview',
    label: 'Overview',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <path d="M4 19V10M10 19V5M16 19v-7M22 19H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'pending',
    label: 'Pending Requests',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'users',
    label: 'Users',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3.5 19a5.6 5.6 0 0 1 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M15.5 5.3a3.2 3.2 0 0 1 0 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M15 12.6c2.4.5 4 1.9 4.5 3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'Transaction History',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <rect x="3" y="5" width="18" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'coupons',
    label: 'Coupons',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M10 7v10" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.6 2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'operators',
    label: 'API Sharing',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="7" cy="7" r="1" fill="currentColor" />
        <circle cx="7" cy="17" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
        <path d="M4 11a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 11a5 5 0 0 1 10 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="11" r="1.6" fill="currentColor" />
        <path d="M12 12.5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const navigate = useNavigate();

  return (
    <div>
      <Navbar />
      <div className="container admin-panel">
        <div className="admin-panel-topbar">
          <h2 className="admin-panel-heading">Admin Panel</h2>
          <button className="btn btn-outline admin-back-btn" onClick={() => navigate('/dashboard')}>
            <svg viewBox="0 0 24 24" fill="none" width="15" height="15">
              <path d="M14.5 5L8 12l6.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to User View
          </button>
        </div>

        <div className="admin-panel-card">
          <div className="admin-tabs">
            {ADMIN_TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`admin-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="admin-tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          <div className="admin-tab-panel">
            {tab === 'overview' && <OverviewTab />}
            {tab === 'pending' && <PendingTab />}
            {tab === 'users' && <UsersTab />}
            {tab === 'history' && <HistoryTab />}
            {tab === 'coupons' && <CouponsTab />}
            {tab === 'operators' && <OperatorsTab />}
            {tab === 'broadcast' && <BroadcastTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
