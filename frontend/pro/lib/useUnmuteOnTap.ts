'use client';

import { useEffect } from 'react';

// Browsers only allow sound after the person touches the page. Videos start silent,
// and the first tap anywhere turns the sound on for every video after that.
export function useUnmuteOnTap(setMuted: (muted: boolean) => void) {
  useEffect(() => {
    const on = () => setMuted(false);
    window.addEventListener('pointerup', on, { once: true });
    window.addEventListener('keydown', on, { once: true });
    return () => {
      window.removeEventListener('pointerup', on);
      window.removeEventListener('keydown', on);
    };
  }, [setMuted]);
}
