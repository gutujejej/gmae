'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import CommentsSheet from '@/components/CommentsSheet';
import { SearchIcon } from '@/components/Icons';
import Logo from '@/components/Logo';
import Toast from '@/components/Toast';
import VideoCard from '@/components/VideoCard';
import { createClient } from '@/lib/supabase/client';
import { useSession } from '@/lib/useSession';
import { useToast } from '@/lib/useToast';
import { useUnmuteOnTap } from '@/lib/useUnmuteOnTap';
import { useVideoActions } from '@/lib/useVideoActions';
import type { FeedVideo } from '@/lib/types';

type Tab = 'for_you' | 'following';
type Cursor = { score: number; id: string } | { created_at: string; id: string } | null;

const PAGE = 8;

function cursorOf(tab: Tab, rows: FeedVideo[]): Cursor {
  const last = rows[rows.length - 1];
  if (!last) return null;
  return tab === 'for_you' ? { score: last.score, id: last.id } : { created_at: last.created_at, id: last.id };
}

export default function Feed() {
  const supabase = useMemo(() => createClient(), []);
  const { user, ready } = useSession();
  const userId = user?.id ?? null;
  const { text: toastText, show: toast } = useToast();

  const [tab, setTab] = useState<Tab>('for_you');
  const [items, setItems] = useState<FeedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  useUnmuteOnTap(setMuted);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const scroller = useRef<HTMLDivElement>(null);
  const cursor = useRef<Cursor>(null);
  const busy = useRef(false);
  const generation = useRef(0);        // bumps when the tab changes, so late answers from the old tab are ignored

  const fetchPage = useCallback(async (which: Tab, after: Cursor): Promise<FeedVideo[] | null> => {
    const res = which === 'for_you'
      ? await supabase.rpc('feed_for_you', {
          p_limit: PAGE,
          p_after_score: after && 'score' in after ? after.score : null,
          p_after_id: after ? after.id : null,
        })
      : await supabase.rpc('feed_following', {
          p_limit: PAGE,
          p_after_created: after && 'created_at' in after ? after.created_at : null,
          p_after_id: after ? after.id : null,
        });
    if (res.error) return null;
    return (res.data ?? []) as FeedVideo[];
  }, [supabase]);

  // First page, again whenever the tab or the signed-in user changes.
  useEffect(() => {
    if (!ready) return;
    const gen = ++generation.current;
    setItems([]);
    setActive(0);
    setDone(false);
    setFailed(false);
    setCommentsFor(null);
    cursor.current = null;
    if (tab === 'following' && !userId) {
      setLoading(false);
      setDone(true);
      return;
    }
    setLoading(true);
    busy.current = true;
    fetchPage(tab, null).then((rows) => {
      if (gen !== generation.current) return;
      busy.current = false;
      setLoading(false);
      if (!rows) { setFailed(true); setDone(true); return; }
      setItems(rows);
      cursor.current = cursorOf(tab, rows);
      if (rows.length < PAGE) setDone(true);
    });
  }, [tab, ready, userId, fetchPage, reload]);

  // Next page (infinite scroll).
  const loadMore = useCallback(async () => {
    if (busy.current || done || !cursor.current) return;
    busy.current = true;
    setLoading(true);
    const gen = generation.current;
    const rows = await fetchPage(tab, cursor.current);
    if (gen !== generation.current) return;
    busy.current = false;
    setLoading(false);
    if (!rows) { toast('Could not load more videos.'); return; }
    setItems((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))]);   // scores drift, so skip repeats
    if (rows.length) cursor.current = cursorOf(tab, rows);
    if (rows.length < PAGE) setDone(true);
  }, [done, fetchPage, tab, toast]);

  useEffect(() => {
    if (items.length > 0 && active >= items.length - 3) loadMore();
  }, [active, items.length, loadMore]);

  // Which card is on screen.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          setActive(Number((entry.target as HTMLElement).dataset.idx));
        }
      }
    }, { root, threshold: [0.6] });
    root.querySelectorAll('[data-idx]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items.length, tab]);

  const patch = useCallback((id: string, change: Partial<FeedVideo>) => {
    setItems((prev) => prev.map((v) => (v.id === id ? { ...v, ...change } : v)));
  }, []);
  const setFollow = useCallback((authorId: string, following: boolean) => {
    setItems((prev) => prev.map((v) => (v.author_id === authorId ? { ...v, following } : v)));
  }, []);
  const actions = useVideoActions({ userId, patch, setFollow, toast });

  const commentVideo = items.find((v) => v.id === commentsFor) ?? null;
  const showSkeleton = loading && items.length === 0;
  const empty = !loading && items.length === 0;

  return (
    <div className="feed-root">
      <div className="topbar">
        <Link href="/feed" className="topbar-logo" aria-label="Pro home"><Logo size={24} /></Link>
        <div className="tabs" role="tablist" aria-label="Feed">
          <button type="button" role="tab" aria-selected={tab === 'following'} className="tab" onClick={() => setTab('following')}>Following</button>
          <button type="button" role="tab" aria-selected={tab === 'for_you'} className="tab" onClick={() => setTab('for_you')}>For you</button>
        </div>
        <Link href="/search" className="topbar-search" aria-label="Search"><SearchIcon size={26} /></Link>
      </div>

      {items.length > 0 && (
        <div className="feed" ref={scroller}>
          {items.map((video, i) => (
            <div className="slot" key={video.id} data-idx={i}>
              <VideoCard
                video={video}
                active={i === active}
                shouldLoad={i === active || i === active + 1}
                muted={muted}
                ownId={userId}
                actions={actions}
                onOpenComments={(v) => setCommentsFor(v.id)}
              />
            </div>
          ))}
          {loading && <div className="slot more"><span className="spinner" aria-label="Loading more" /></div>}
        </div>
      )}

      {showSkeleton && <div className="feed-empty"><span className="spinner" aria-label="Loading" /></div>}

      {empty && failed && (
        <div className="feed-empty">
          <p>Could not load videos. Check your internet.</p>
          <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      )}
      {empty && !failed && tab === 'following' && !userId && (
        <div className="feed-empty">
          <p>Log in to see videos from people you follow.</p>
          <Link href="/login?next=/feed" className="btn btn-primary">Log in</Link>
        </div>
      )}
      {empty && !failed && tab === 'following' && userId && (
        <div className="feed-empty">
          <p>Follow people to see their videos here.</p>
          <button type="button" className="btn btn-ghost" onClick={() => setTab('for_you')}>Browse For you</button>
        </div>
      )}
      {empty && !failed && tab === 'for_you' && (
        <div className="feed-empty">
          <p>No videos yet. Be the first to post one.</p>
          <Link href="/upload" className="btn btn-saffron">Upload a video</Link>
        </div>
      )}

      {commentVideo && (
        <CommentsSheet
          video={commentVideo}
          userId={userId}
          onClose={() => setCommentsFor(null)}
          onCount={(change) => patch(commentVideo.id, { comments_count: Math.max(0, commentVideo.comments_count + change) })}
          needLogin={actions.needLogin}
        />
      )}
      <Toast text={toastText} />
    </div>
  );
}
