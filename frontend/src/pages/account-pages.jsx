/* ====================================================================== */
/*  account-pages.jsx                                                     */
/*  Merged from: pages/Login.jsx + pages/Profile.jsx + pages/Referral.jsx */
/*  + pages/Support.jsx. (Mechanical merge only — no logic changed.)      */
/* ====================================================================== */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReferralStats } from '../app-shell.jsx';
import { useAuth } from '../app-shell.jsx';

/* ======================================================================
 *  SECTION 1 — formerly pages/Login.jsx
 * ==================================================================== */

export function Login() {
  const botUsername = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || '';

  // The website is Telegram-only now (see TelegramOnlyGate in
  // app-shell.jsx) - a person only ever lands on this page after
  // logging out from inside the Mini App. There is nothing useful a
  // username/password form can do here anymore: the Mini App itself
  // can't read the user's Telegram identity on its own, only the bot's
  // /start flow can re-issue a login token (see telegram-bot.js's
  // sendPlayButton) - so this just re-opens the bot chat instead of
  // showing a form that can no longer lead anywhere.
  const openBot = () => {
    if (window.Telegram?.WebApp?.openTelegramLink && botUsername) {
      window.Telegram.WebApp.openTelegramLink(`https://t.me/${botUsername}`);
    } else if (botUsername) {
      window.open(`https://t.me/${botUsername}`, '_blank');
    }
  };

  return (
    <div className="container" style={{ maxWidth: 420, marginTop: '15vh' }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <h2 style={{ marginTop: 0 }}>Buna Games</h2>
        <p style={{ color: '#9aa0b4' }}>
          You've been logged out. Tap below to log back in through Telegram.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 10 }}
          onClick={openBot}
        >
          Login with Telegram
        </button>
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

          {(() => {
            // Same fields, same math, as the wagering block on the Wallet
            // page (see wallet-dashboard.jsx) - Number(...) guards against
            // .toFixed() ever crashing on a missing field, same reasoning
            // as that page's earlier fix.
            const bonusBalance = Number(user?.bonus_balance ?? 0);
            const wageringTarget = Number(user?.wagering_target_total ?? 0);
            const wageringRemaining = Number(user?.wagering_required ?? 0);
            const wageringProgress = Math.max(wageringTarget - wageringRemaining, 0);
            const wageringPercent = wageringTarget > 0 ? Math.min((wageringProgress / wageringTarget) * 100, 100) : 100;
            const wageringComplete = wageringRemaining <= 0;

            if (wageringComplete || bonusBalance <= 0) return null;

            return (
              <div className="wagering-block" style={{ marginTop: 16 }}>
                <div className="wagering-block-header">
                  <span className="wagering-block-title">COUPON WAGERING PROGRESS</span>
                  <span className="wagering-block-fraction">
                    ETB {wageringProgress.toFixed(0)} / {wageringTarget.toFixed(0)}
                  </span>
                </div>
                <div className="wagering-progress-track">
                  <div className="wagering-progress-fill" style={{ width: `${wageringPercent}%` }} />
                </div>
                <p className="wagering-block-hint">
                  ETB {wageringRemaining.toFixed(0)} more in wagering needed before your {bonusBalance.toFixed(0)} ETB
                  coupon balance becomes withdrawable.
                </p>
              </div>
            );
          })()}

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
