import { createClient } from '@/lib/supabase/client';

const KEY = 'pro_viewed';

// Counts one view per video per browser session (so replays and swiping back do not add up).
export function recordView(videoId: string) {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const seen: string[] = raw ? JSON.parse(raw) : [];
    if (seen.includes(videoId)) return;
    window.sessionStorage.setItem(KEY, JSON.stringify([...seen, videoId].slice(-200)));
  } catch { /* storage blocked: still count it */ }
  createClient().rpc('pro_record_view', { p_video_id: videoId }).then(() => undefined, () => undefined);
}
