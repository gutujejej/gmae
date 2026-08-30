/* ====================================================================== */
/*  app-shell.jsx                                                         */
/*  Merged from: main.jsx + App.jsx + Layout.jsx + components/BottomNav.jsx */
/*  + api.js. (Mechanical merge only — no logic changed.)                 */
/* ====================================================================== */

import React, { createContext, useContext, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { io } from 'socket.io-client';
import './index.css';

import { Login, Profile, Referral, Support } from './pages/account-pages.jsx';
import Dashboard, { WalletPage } from './pages/wallet-dashboard.jsx';
import Aviator from './pages/aviator.jsx';
import Admin from './pages/Admin.jsx';
import AviatorEmbed from './pages/aviator-embed.jsx';

/* ======================================================================
 *  SECTION 1 — formerly api.js
 *  Axios instance, socket helper, and every backend API call.
 * ==================================================================== */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

const api = axios.create({ baseURL: API_URL });

// Attach the stored JWT to every outgoing request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// If the server says our token is invalid/expired, clear it so the app
// redirects back to the login screen instead of looping on 401s.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response && err.response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    return Promise.reject(err);
  }
);

export function getSocket() {
  const token = localStorage.getItem('token');
  return io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket'],
  });
}

/* ---------------------------- Auth ---------------------------- */
export const registerUser = (username, phone, password, referralCode = null) =>
  api.post('/auth/register', { username, phone, password, referral_code: referralCode });
export const loginUser = (username, password) => api.post('/auth/login', { username, password });
export const getMe = () => api.get('/auth/me');

/* --------------------------- Wallet ---------------------------- */
export const getBalance = () => api.get('/wallet/balance');
export const requestDeposit = (amount, telebirr_reference, note) =>
  api.post('/wallet/deposit', { amount, telebirr_reference, note });
export const requestWithdraw = (amount, telebirr_phone, note) =>
  api.post('/wallet/withdraw', { amount, telebirr_phone, note });
export const getMyTransactions = (page = 1) => api.get(`/wallet/transactions?page=${page}`);

/* --------------------------- Referral ---------------------------- */
export const getReferralStats = () => api.get('/referral/stats');

/* --------------------------- Cashback ------------------------------ */
export const getCashbackStatus = () => api.get('/cashback/status');
export const claimCashback = () => api.post('/cashback/claim');

/* ---------------------------- Game ------------------------------ */
export const placeBet = (amount, slot = 1, autoCashoutAt = null) =>
  api.post('/game/bet', { amount, slot, auto_cashout_at: autoCashoutAt });
export const cashOut = (slot = 1) => api.post('/game/cashout', { slot });
export const getRoundHistory = () => api.get('/game/history');
export const getMyBets = () => api.get('/game/my-bets');
export const getAutoBetSettings = () => api.get('/game/auto-bet');
export const setAutoBetSettings = (slot, enabled, amount, autoCashoutAt) =>
  api.put(`/game/auto-bet/${slot}`, { enabled, amount, auto_cashout_at: autoCashoutAt });
export const verifyRound = (roundId) => api.get(`/game/verify/${roundId}`);

/* --------------------------- Settings (public) ------------------- */
export const getGameLogo = () => api.get('/settings/game-logo');

/* --------------------------- Admin: users ------------------------ */
export const getAllUsers = (page = 1) => api.get(`/admin/users?page=${page}`);
export const setUserActive = (id, isActive) => api.patch(`/admin/users/${id}/status`, { isActive });

/* --------------------------- Admin: transactions ------------------ */
export const getPendingTransactions = (type) =>
  api.get(`/admin/transactions/pending${type ? `?type=${type}` : ''}`);
export const getAllTransactions = (page = 1, filters = {}) => {
  const params = new URLSearchParams({ page, ...filters }).toString();
  return api.get(`/admin/transactions?${params}`);
};
export const approveTransaction = (id, telebirr_reference) =>
  api.post(`/admin/transactions/${id}/approve`, { telebirr_reference });
export const rejectTransaction = (id, reason) => api.post(`/admin/transactions/${id}/reject`, { reason });

/* --------------------------- Admin: stats & logo ------------------- */
export const getStatsOverview = () => api.get('/admin/stats/overview');
export const getStatsUsers = (page = 1, search = '') => {
  const params = new URLSearchParams({ page });
  if (search) params.set('search', search);
  return api.get(`/admin/stats/users?${params.toString()}`);
};
export const setGameLogo = (url) => api.put('/admin/settings/game-logo', { url });
export const getAdminSettings = () => api.get('/admin/settings');
export const setSignupBonus = (amount) => api.put('/admin/settings/signup-bonus', { amount });
export const adjustUserBalance = (id, amount, reason) =>
  api.patch(`/admin/users/${id}/balance`, { amount, reason });

/* --------------------------- Coupons ------------------------------- */
export const redeemCoupon = (code) => api.post('/coupons/redeem', { code });

// Admin coupon management
export const createCoupon = (payload) => api.post('/coupons/admin', payload);
export const getCoupons = () => api.get('/coupons/admin');
export const setCouponActive = (id, active) => api.patch(`/coupons/admin/${id}/active`, { active });

/* --------------------------- Admin: operators (API sharing) ------- */
export const getOperators = () => api.get('/admin/operators');
export const createOperator = (name, callbackUrl, currency) =>
  api.post('/admin/operators', { name, callback_url: callbackUrl, currency });
export const setOperatorActive = (id, isActive) => api.patch(`/admin/operators/${id}/status`, { isActive });
export const regenerateOperatorSecret = (id) => api.post(`/admin/operators/${id}/regenerate-secret`);
export const deleteOperator = (id) => api.delete(`/admin/operators/${id}`);

/* --------------------------- Operator embed (seamless play) ------- */
export const startOperatorSession = (launchToken) =>
  axios.post(`${API_URL}/operator/session/start`, { launch_token: launchToken });

export function createOperatorApiClient(sessionToken) {
  const client = axios.create({ baseURL: API_URL });
  client.interceptors.request.use((config) => {
    if (sessionToken) config.headers.Authorization = `Bearer ${sessionToken}`;
    return config;
  });
  return client;
}

export function getOperatorSocket(sessionToken) {
  return io(SOCKET_URL, {
    auth: { token: sessionToken },
    transports: ['websocket'],
  });
}

export { api };

/* ======================================================================
 *  SECTION 2 — formerly components/BottomNav.jsx
 *  Persistent bottom navigation bar shown on every authenticated page.
 * ==================================================================== */

function GamesIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 7h10a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4h-1.5l-1.5 2h-4l-1.5-2H7a4 4 0 0 1-4-4v-2a4 4 0 0 1 4-4Z"
        stroke={active ? '#ff3b4e' : '#7a7a85'}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9 11v2M8 12h2" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="10.5" r="0.9" fill={active ? '#ff3b4e' : '#7a7a85'} />
      <circle cx="17.6" cy="12.3" r="0.9" fill={active ? '#ff3b4e' : '#7a7a85'} />
    </svg>
  );
}

function WalletIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6" width="18" height="13" rx="2.5" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <path d="M3 10h18" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <path d="M7 6V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <circle cx="16.5" cy="14.5" r="1.1" fill={active ? '#ff3b4e' : '#7a7a85'} />
    </svg>
  );
}

function SupportIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 13a8 8 0 0 1 16 0"
        stroke={active ? '#ff3b4e' : '#7a7a85'}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <rect x="3" y="13" width="4" height="6" rx="1.5" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <path
        d="M7 19v1a3 3 0 0 0 3 3h2"
        stroke={active ? '#ff3b4e' : '#7a7a85'}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProfileIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.5" stroke={active ? '#ff3b4e' : '#7a7a85'} strokeWidth="1.8" />
      <path
        d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"
        stroke={active ? '#ff3b4e' : '#7a7a85'}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const TABS = [
  { key: 'games', label: 'Games', path: '/dashboard', Icon: GamesIcon },
  { key: 'wallet', label: 'Wallet', path: '/wallet', Icon: WalletIcon },
  { key: 'support', label: 'Support', path: '/support', Icon: SupportIcon },
  { key: 'profile', label: 'Profile', path: '/profile', Icon: ProfileIcon },
];

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path) => {
    if (path === '/dashboard') {
      return location.pathname === '/dashboard' || location.pathname.startsWith('/dashboard/');
    }
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <nav className="bottom-nav">
      {TABS.map(({ key, label, path, Icon }) => {
        const active = isActive(path);
        return (
          <button
            key={key}
            className={`bottom-nav-item ${active ? 'active' : ''}`}
            onClick={() => navigate(path)}
          >
            <span className="bottom-nav-icon">
              <Icon active={active} />
            </span>
            <span className="bottom-nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* ======================================================================
 *  SECTION 3 — formerly Layout.jsx
 *  Wraps any authenticated page's content with the persistent bottom nav.
 * ==================================================================== */

export function Layout({ children }) {
  return (
    <div style={{ minHeight: '100vh' }}>
      {children}
      <BottomNav />
    </div>
  );
}

/* ======================================================================
 *  SECTION 4 — formerly App.jsx
 *  Auth context/provider, route guards, and the route table.
 * ==================================================================== */

export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });

  const login = (userData, token) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  const updateBalance = (balance) => {
    setUser((prev) => {
      const next = { ...prev, balance };
      localStorage.setItem('user', JSON.stringify(next));
      return next;
    });
  };

  const updateUser = (patch) => {
    setUser((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem('user', JSON.stringify(next));
      return next;
    });
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, updateBalance, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

// Catches any render/lifecycle error in whatever it wraps and shows the
// actual error message on screen instead of leaving a blank/black page -
// this is what was missing when the wallet page went blank with no way
// to see why on a phone with no dev tools. Wrapping every ProtectedRoute
// (not just Wallet) means any future crash anywhere shows up the same
// way instead of silently blanking the screen again.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] caught render error', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: '#ff6b6b', fontFamily: 'monospace', whiteSpace: 'pre-wrap', fontSize: 13 }}>
          <p style={{ color: '#f2f2f4', fontWeight: 700, marginBottom: 10 }}>
            Something broke on this page.
          </p>
          <p>{this.state.error.message}</p>
          <button
            className="btn btn-outline"
            style={{ marginTop: 16 }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children, adminOnly = false, withNav = true }) {
  const { user } = useAuth();
  const location = useLocation();

  // Preserve the query string (e.g. ?ref=CODE from a referral link) across
  // this redirect - otherwise Login.jsx never sees it and referral signups
  // never get linked to a referrer.
  if (!user) return <Navigate to={`/login${location.search}`} replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />;

  const wrapped = <ErrorBoundary>{children}</ErrorBoundary>;
  return withNav ? <Layout>{wrapped}</Layout> : wrapped;
}

// Redirects "/" to "/dashboard" while preserving any query string, so a
// referral link opened at the site root (e.g. "/?ref=CODE") still has
// ?ref=CODE attached once ProtectedRoute bounces the user on to /login.
function RootRedirect() {
  const location = useLocation();
  return <Navigate to={`/dashboard${location.search}`} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/embed/aviator" element={<AviatorEmbed />} />

          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard/aviator"
            element={
              <ProtectedRoute withNav={false}>
                <Aviator />
              </ProtectedRoute>
            }
          />
          <Route
            path="/wallet"
            element={
              <ProtectedRoute>
                <WalletPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/support"
            element={
              <ProtectedRoute>
                <Support />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/referral"
            element={
              <ProtectedRoute>
                <Referral />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminOnly withNav={false}>
                <Admin />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

/* ======================================================================
 *  SECTION 5 — formerly main.jsx
 *  React root render entry point.
 * ==================================================================== */

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
