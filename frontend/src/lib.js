import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * ===========================================================================
 * REST API CLIENT
 * ===========================================================================
 * Every authenticated call sends the raw Telegram initData string as
 * `Authorization: tma <initData>` — the backend re-verifies its signature
 * on every single request. We never send a bare user id; the backend
 * derives identity from the verified initData.
 * ===========================================================================
 */
async function request(path, { method = 'GET', body, initData } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (initData) headers['Authorization'] = `tma ${initData}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  rooms: {
    list: (initData) => request('/api/rooms', { initData }),
    get: (roomId, initData) => request(`/api/rooms/${roomId}`, { initData }),
    create: (payload, initData) => request('/api/rooms', { method: 'POST', body: payload, initData }),
    myCard: (roomId, initData) => request(`/api/rooms/${roomId}/my-card`, { initData }),
  },
  wallet: {
    balance: (initData) => request('/api/wallet/balance', { initData }),
    history: (initData) => request('/api/wallet/history', { initData }),
    deposit: (payload, initData) => request('/api/wallet/deposit', { method: 'POST', body: payload, initData }),
    withdraw: (payload, initData) => request('/api/wallet/withdraw', { method: 'POST', body: payload, initData }),
  },
};

/**
 * ===========================================================================
 * SOCKET.IO CLIENT
 * ===========================================================================
 */
let socket = null;

/** Returns a singleton, authenticated Socket.io connection. */
export function getSocket(initData) {
  if (socket && socket.connected) return socket;

  socket = io(API_BASE, {
    auth: { initData },
    transports: ['websocket'],
    reconnection: true,
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/**
 * ===========================================================================
 * useTelegram HOOK
 * ===========================================================================
 * Wraps window.Telegram.WebApp — the SDK injected by the script tag in
 * index.html. Falls back gracefully in dev/browser contexts where it
 * doesn't exist so you can preview the UI outside Telegram.
 * ===========================================================================
 */
export function useTelegram() {
  const [ready, setReady] = useState(false);
  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;

  useEffect(() => {
    if (tg) {
      tg.ready();
      tg.expand();
      setReady(true);
    } else {
      console.warn('Telegram WebApp SDK not found — running in browser-preview mode.');
      setReady(true);
    }
  }, [tg]);

  const initData = tg?.initData || '';
  const user = tg?.initDataUnsafe?.user || null;

  const haptic = {
    light: () => tg?.HapticFeedback?.impactOccurred('light'),
    medium: () => tg?.HapticFeedback?.impactOccurred('medium'),
    success: () => tg?.HapticFeedback?.notificationOccurred('success'),
    error: () => tg?.HapticFeedback?.notificationOccurred('error'),
  };

  return { tg, ready, initData, user, haptic };
}
