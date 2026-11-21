'use client';

import { useEffect } from 'react';

// Registers the small offline helper (production only).
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/pro/sw.js', { scope: '/pro/' }).catch(() => {});
  }, []);
  return null;
}
