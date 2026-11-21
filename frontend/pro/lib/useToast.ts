'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// A short message at the bottom of the screen ("Link copied").
export function useToast() {
  const [text, setText] = useState('');
  const timer = useRef<number | null>(null);

  const show = useCallback((message: string) => {
    setText(message);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(''), 2200);
  }, []);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return { text, show };
}
