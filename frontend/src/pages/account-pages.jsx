/* ====================================================================== */
/*  account-pages.jsx                                                     */
/*  Merged from: pages/Login.jsx + pages/Profile.jsx + pages/Referral.jsx */
/*  + pages/Support.jsx. (Mechanical merge only — no logic changed.)      */
/* ====================================================================== */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginUser, registerUser, getReferralStats } from '../app-shell.jsx';
import { useAuth } from '../app-shell.jsx';

/* ======================================================================
 *  SECTION 1 — formerly pages/Login.jsx
 * ==================================================================== */

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  // Referral code, if this link was opened as /login?ref=CODE. Detected
  // once on mount; kept as editable state so the person can also type
  // one in by hand (or fix it) if they weren't referred via a link.
  const detectedReferralCode = new URLSearchParams(window.location.search).get('ref') || '';

  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [referralCode, setReferralCode] = useState(detectedReferralCode);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg(null);

    if (mode === 'register' && password !== confirmPassword) {
      setErrorMsg('Passwords do not match');
      return;
    }

    if (mode === 'register' && phoneDigits.trim().length !== 9) {
      setErrorMsg('Enter a valid 9-digit phone number (e.g. 912345678)');
      return;
    }

    setSubmitting(true);
    try {
      const fullPhone = `+251${phoneDigits.trim()}`;
      const res =
        mode === 'login'
          ? await loginUser(username.trim(), password)
          : await registerUser(username.trim(), fullPhone, password, referralCode.trim() || null);

      login(res.data.user, res.data.token);
      navigate('/dashboard');
    } catch (err) {
      if (err.response) {
        // Server responded with an error status - show its message.
        setErrorMsg(err.response.data?.error || `Server error (${err.response.status})`);
      } else if (err.request) {
        // Request was sent but no response came back at all - this means
        // the browser couldn't reach the backend (wrong URL, CORS block,
        // backend down, network issue). Show the URL we tried so it's
        // possible to tell what's misconfigured without devtools.
        setErrorMsg(
          `Could not reach the server at ${err.config?.baseURL || 'unknown URL'}. Check your connection or try again.`
        );
      } else {
        setErrorMsg(`Unexpected error: ${err.message}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container" style={{ maxWidth: 420, marginTop: '15vh' }}>
      <div className="card">
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>Buna Games</h2>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button
            type="button"
            className={`btn ${mode === 'login' ? 'btn-primary' : ''}`}
            style={{ flex: 1 }}
            onClick={() => {
              setMode('login');
              setErrorMsg(null);
            }}
          >
            Log In
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? 'btn-primary' : ''}`}
            style={{ flex: 1 }}
            onClick={() => {
              setMode('register');
              setErrorMsg(null);
            }}
          >
            Sign Up
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 14, color: '#9aa0b4' }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={30}
              className="input"
              style={{ width: '100%' }}
              autoComplete="username"
            />
          </div>

          {mode === 'register' && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 14, color: '#9aa0b4' }}>
                Phone Number
              </label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  border: '1px solid #2a2f45',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    padding: '0 12px',
                    height: 42,
                    display: 'flex',
                    alignItems: 'center',
                    background: '#1c2036',
                    color: '#9aa0b4',
                    fontSize: 14,
                    borderRight: '1px solid #2a2f45',
                  }}
                >
                  +251
                </span>
                <input
                  type="tel"
                  value={phoneDigits}
                  onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 9))}
                  required
                  placeholder="912345678"
                  inputMode="numeric"
                  className="input"
                  style={{ width: '100%', border: 'none', borderRadius: 0 }}
                  autoComplete="tel-national"
                />
              </div>
            </div>
          )}

          <div style={{ marginBottom: mode === 'register' ? 14 : 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 14, color: '#9aa0b4' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="input"
              style={{ width: '100%' }}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {mode === 'register' && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 14, color: '#9aa0b4' }}>
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                className="input"
                style={{ width: '100%' }}
                autoComplete="new-password"
              />
            </div>
          )}

          {mode === 'register' && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 14, color: '#9aa0b4' }}>
                Referral Code <span style={{ color: '#5b6178' }}>(optional)</span>
              </label>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value)}
                placeholder="Enter a friend's referral code"
                className="input"
                style={{ width: '100%' }}
                autoComplete="off"
              />
              {detectedReferralCode && referralCode === detectedReferralCode && (
                <p style={{ fontSize: 12.5, color: '#4ade80', marginTop: 6, marginBottom: 0 }}>
                  Referral code detected from your link
                </p>
              )}
            </div>
          )}

          {errorMsg && (
            <div className="error-text" style={{ marginBottom: 14 }}>
              {errorMsg}
            </div>
          )}

          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={submitting}>
            {submitting ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 2 — formerly pages/Profile.jsx
 * ==================================================================== */

function initials(name) {
  if (!name) return '?';
  return name.trim().charAt(0).toUpperCase();
}

export function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const displayName = user?.username || 'Player';

  return (
    <div className="container" style={{ paddingBottom: 90 }}>
      <div className="card wallet-card profile-card">
        <div className="wallet-scroll-header">
          <h3 className="wallet-title">Profile</h3>
        </div>

        <div className="wallet-scroll-body">
          <div className="profile-identity-card">
            <span className="profile-avatar">{initials(displayName)}</span>
            <div className="profile-identity-text">
              <strong>{displayName}</strong>
              <span className="field-hint" style={{ margin: 0 }}>
                {user?.username}
                {user?.phone ? ` • ${user.phone}` : ''}
              </span>
            </div>
          </div>

          <div className="balance-panel">
            <div className="balance-panel-header">
              <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
                <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3 10h18" stroke="currentColor" strokeWidth="1.6" />
                <path d="M15 14h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span>Account Balance</span>
            </div>
            <div className="balance-panel-value">
              <span className="balance-currency">ETB</span>
              {Number(user?.balance || 0).toFixed(2)}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate('/wallet')}
              style={{ width: '100%', marginTop: 14 }}
            >
              Open Wallet
            </button>
          </div>

          <button
            type="button"
            className="profile-referral-banner"
            onClick={() => navigate('/referral')}
          >
            <span className="profile-referral-banner-icon">
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <rect x="3" y="8" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <rect x="4" y="12" width="16" height="9" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 8v13" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 8c-1.2-2.6-2.8-4-4.2-4A2.2 2.2 0 0 0 5.6 6.2c0 1 .8 1.8 2 1.8H12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M12 8c1.2-2.6 2.8-4 4.2-4a2.2 2.2 0 0 1 2.2 2.2c0 1-.8 1.8-2 1.8H12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="profile-referral-banner-text">
              <strong>Invite Friends & Earn</strong>
              <span>Share your link and earn commission on every referral</span>
            </span>
            <span className="profile-referral-banner-arrow">›</span>
          </button>

          {user?.role === 'admin' && (
            <button
              className="btn btn-outline"
              onClick={() => navigate('/admin')}
              style={{ marginTop: 12, width: '100%' }}
            >
              Switch to Admin Panel
            </button>
          )}

          <button className="btn btn-outline" onClick={handleLogout} style={{ marginTop: 10, width: '100%' }}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 3 — formerly pages/Referral.jsx
 * ==================================================================== */

const HOW_IT_WORKS = [
  {
    title: 'Share your link',
    body: 'Send your referral link to friends. Anyone who opens it and joins is linked to you.',
  },
  {
    title: 'They deposit',
    body: "When someone you referred makes their first deposit, it's recorded against your account.",
  },
  {
    title: 'You earn commission',
    body: 'You automatically receive a commission on their first deposit, credited straight to your balance.',
  },
];

export function Referral() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ referred_count: 0, total_commission: 0, total_ggr: 0 });
  const [loadingStats, setLoadingStats] = useState(true);

  // Detects whether this page is running inside the Telegram Mini App
  // (opened via the bot's Play button) versus a normal browser tab. The
  // telegram-web-app.js script is loaded globally in index.html; it sets
  // window.Telegram.WebApp only when actually opened from Telegram.
  const isTelegramMiniApp =
    typeof window !== 'undefined' && !!window.Telegram?.WebApp?.initData;

  // A user who arrived through the bot shares the bot's own deep-link
  // (t.me/<bot>?start=ref_CODE) instead of the website link - Telegram
  // deep-links open the recipient straight into the SAME bot/Mini App
  // flow with the referral code attached as the /start payload, rather
  // than sending them to a browser tab. VITE_TELEGRAM_BOT_USERNAME is
  // the bot's @username (no leading @), set at build time.
  const botUsername = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || '';

  const referralLink = user?.referral_code
    ? isTelegramMiniApp && botUsername
      ? `https://t.me/${botUsername}?start=ref_${user.referral_code}`
      : `${window.location.origin}/login?ref=${user.referral_code}`
    : null;

  // Display-only: shows a friendlier branded label instead of the raw
  // Vercel/Telegram URL. Purely cosmetic - copy/share below still use the
  // real referralLink above, not this string.
  const referralDisplayLink = user?.referral_code
    ? isTelegramMiniApp && botUsername
      ? `t.me/${botUsername}?start=ref_${user.referral_code}`
      : `bunagames.com/referral?ref=${user.referral_code}`
    : null;

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const res = await getReferralStats();
      setStats(res.data);
    } catch {
      // Non-fatal - keep showing the last known values.
    } finally {
      setLoadingStats(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleCopy = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy your referral link:', referralLink);
    }
  };

  const handleShare = async () => {
    if (!referralLink) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Buna Games', url: referralLink });
        return;
      } catch {
        // User cancelled the share sheet, or it's unavailable - fall
        // through to copying the link instead.
      }
    }
    handleCopy();
  };

  return (
    <div className="container" style={{ paddingBottom: 90 }}>
      <div className="card wallet-card">
        <div className="wallet-scroll-header">
          <h3 className="wallet-title">Referral Program</h3>
        </div>

        <div className="wallet-scroll-body">
          <div className="profile-identity-card">
            <span className="profile-avatar">
              {(user?.username || '?').trim().charAt(0).toUpperCase()}
            </span>
            <div className="profile-identity-text">
              <strong>{user?.username}</strong>
            </div>
          </div>

          <div className="balance-sub-grid" style={{ marginBottom: 16 }}>
            <div className="balance-sub-card">
              <span className="balance-sub-label">
                <svg viewBox="0 0 24 24" fill="none" width="13" height="13">
                  <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M17 19v-1.5a3.5 3.5 0 0 0-2.5-3.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M14.5 5.1a3 3 0 0 1 0 5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                REFERRED USERS
              </span>
              <span className="balance-sub-value" style={{ color: '#f4f0ea' }}>
                {loadingStats ? '—' : stats.referred_count}
              </span>
            </div>
            <div className="balance-sub-card">
              <span className="balance-sub-label balance-sub-label-safe">
                <svg viewBox="0 0 24 24" fill="none" width="13" height="13">
                  <rect x="3" y="8" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="4" y="12" width="16" height="9" rx="1" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 8v13" stroke="currentColor" strokeWidth="1.6" />
                </svg>
                COMMISSION (ETB)
              </span>
              <span className="balance-sub-value balance-sub-value-safe">
                {loadingStats ? '—' : stats.total_commission.toFixed(2)}
              </span>
            </div>
            <div className="balance-sub-card">
              <span className="balance-sub-label balance-sub-label-safe">
                <svg viewBox="0 0 24 24" fill="none" width="13" height="13">
                  <path d="M4 17l5-5 3 3 7-8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 7h4v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                GGR AMOUNT
              </span>
              <span className="balance-sub-value balance-sub-value-safe">
                ETB {loadingStats ? '—' : stats.total_ggr.toFixed(2)}
              </span>
            </div>
          </div>

          <label className="field-label">Your Referral Link</label>
          {referralLink ? (
            <>
              <div className="referral-link-row">
                <span className="referral-link-text">{referralDisplayLink}</span>
                <button type="button" className="icon-btn" onClick={handleCopy} aria-label="Copy referral link">
                  {copied ? (
                    <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                      <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                      <rect x="9" y="9" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M5 15V5a1 1 0 0 1 1-1h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </div>

              <button type="button" className="btn btn-primary referral-share-btn" onClick={handleShare}>
                <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <circle cx="18" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="18" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8.2 10.8L15.8 6.2M8.2 13.2l7.6 4.6" stroke="currentColor" strokeWidth="1.6" />
                </svg>
                Share with Friends
              </button>
            </>
          ) : (
            <p className="field-hint">Your referral link is being set up. Please check back shortly.</p>
          )}

          <div className="section-label-row" style={{ marginTop: 24 }}>
            <span className="section-label">How Referrals Work</span>
          </div>

          <div className="how-it-works-list">
            {HOW_IT_WORKS.map((step, i) => (
              <div className="how-it-works-item" key={step.title}>
                <span className="how-it-works-num">{i + 1}</span>
                <div>
                  <strong className="how-it-works-title">{step.title}</strong>
                  <p className="field-hint" style={{ margin: '2px 0 0' }}>{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ======================================================================
 *  SECTION 4 — formerly pages/Support.jsx
 * ==================================================================== */

export function Support() {
  return (
    <div className="container" style={{ paddingBottom: 90 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Support</h2>
        <p style={{ color: '#9aa0b4' }}>
          Need help with a deposit, withdrawal, or something else? Reach out and we'll get back to you.
        </p>
        <a
          className="btn btn-primary"
          href="https://t.me/Buna_support"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', textDecoration: 'none', marginTop: 10 }}
        >
          Contact Support on Telegram
        </a>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Join our community</h2>
        <p style={{ color: '#9aa0b4' }}>
          Follow announcements and chat with other players.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <a
            className="btn btn-outline"
            href="https://t.me/buna_gam"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', textDecoration: 'none' }}
          >
            Buna Games Channel
          </a>
          <a
            className="btn btn-outline"
            href="https://t.me/bunagames_meber"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', textDecoration: 'none' }}
          >
            Buna Games Group
          </a>
        </div>
      </div>
    </div>
  );
}
