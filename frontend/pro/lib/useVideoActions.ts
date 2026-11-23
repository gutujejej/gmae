'use client';

import { useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { FeedVideo } from '@/lib/types';

type Options = {
  userId: string | null;
  patch: (videoId: string, change: Partial<FeedVideo>) => void;      // change one card
  setFollow: (authorId: string, following: boolean) => void;          // follow state is shared by all cards of an author
  toast: (message: string) => void;
};

// like / save / follow / share, with instant (optimistic) updates that are undone if the server says no.
export function useVideoActions({ userId, patch, setFollow, toast }: Options) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const pathname = usePathname();

  const needLogin = () => router.push(`/login?next=${encodeURIComponent(pathname || '/feed')}`);

  const like = async (v: FeedVideo) => {
    if (!userId) return needLogin();
    const next = !v.liked;
    patch(v.id, { liked: next, likes_count: Math.max(0, v.likes_count + (next ? 1 : -1)) });
    const { error } = next
      ? await supabase.from('likes').insert({ user_id: userId, video_id: v.id })
      : await supabase.from('likes').delete().eq('user_id', userId).eq('video_id', v.id);
    if (error && !(next && error.code === '23505')) {                  // 23505 = already liked, fine
      patch(v.id, { liked: v.liked, likes_count: v.likes_count });
      toast('Could not save your like. Try again.');
    }
  };

  // Double tap: only ever adds a like, it never removes one.
  const doubleTapLike = async (v: FeedVideo) => {
    if (!userId) return needLogin();
    if (!v.liked) await like(v);
  };

  const save = async (v: FeedVideo) => {
    if (!userId) return needLogin();
    const next = !v.saved;
    patch(v.id, { saved: next, saves_count: Math.max(0, v.saves_count + (next ? 1 : -1)) });
    const { error } = next
      ? await supabase.from('saves').insert({ user_id: userId, video_id: v.id })
      : await supabase.from('saves').delete().eq('user_id', userId).eq('video_id', v.id);
    if (error && !(next && error.code === '23505')) {
      patch(v.id, { saved: v.saved, saves_count: v.saves_count });
      toast('Could not save this video. Try again.');
    } else {
      toast(next ? 'Saved' : 'Removed from saved');
    }
  };

  const follow = async (v: FeedVideo) => {
    if (!userId) return needLogin();
    if (userId === v.author_id) return;
    const next = !v.following;
    setFollow(v.author_id, next);
    const { error } = next
      ? await supabase.from('follows').insert({ follower_id: userId, following_id: v.author_id })
      : await supabase.from('follows').delete().eq('follower_id', userId).eq('following_id', v.author_id);
    if (error && !(next && error.code === '23505')) {
      setFollow(v.author_id, v.following);
      toast('Could not update follow. Try again.');
    }
  };

  const share = async (v: FeedVideo) => {
    const url = `${window.location.origin}/pro/v/${v.id}`;
    if (typeof navigator.share === 'function') {                      // phones: the normal share sheet
      try { await navigator.share({ title: `@${v.username} on pro`, text: v.caption || undefined, url }); return; }
      catch (err) { if (err instanceof DOMException && err.name === 'AbortError') return; }   // closed by the person: done
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const area = document.createElement('textarea');                // older browsers
      area.value = url;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Link copied');
  };

  return { like, doubleTapLike, save, follow, share, needLogin };
}
