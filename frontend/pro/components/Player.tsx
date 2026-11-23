'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CommentsSheet from '@/components/CommentsSheet';
import { BackIcon, SearchIcon } from '@/components/Icons';
import Toast from '@/components/Toast';
import VideoCard from '@/components/VideoCard';
import { readPlaylist } from '@/lib/local-store';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/lib/useToast';
import { useUnmuteOnTap } from '@/lib/useUnmuteOnTap';
import { useVideoActions } from '@/lib/useVideoActions';
import type { FeedVideo } from '@/lib/types';

const CHUNK = 6;

// Full-screen player for one video. After it, swiping up goes through the list you came from
// (search results or the Discover grid), or through "For you" when you opened a shared link.
export default function Player({ initial, userId }: { initial: FeedVideo; userId: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { text: toastText, show: toast } = useToast();
  const [items, setItems] = useState<FeedVideo[]>([initial]);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useUnmuteOnTap(setMuted);

  const scroller = useRef<HTMLDivElement>(null);
  const queue = useRef<string[]>([]);                                   // ids still to show, in order
  const cursor = useRef<{ score: number; id: string } | null>(null);    // "For you" position, used after the list ends
  const busy = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    const ids = readPlaylist();
    const at = ids.indexOf(initial.id);
    queue.current = at >= 0 ? ids.slice(at + 1) : [];
  }, [initial.id]);

  const loadMore = useCallback(async () => {
    if (busy.current || done.current) return;
    busy.current = true;
    let rows: FeedVideo[] = [];
    if (queue.current.length > 0) {
      const ids = queue.current.slice(0, CHUNK);
      queue.current = queue.current.slice(CHUNK);
      const res = await supabase.rpc('pro_videos_by_ids', { p_ids: ids });
      rows = res.error ? [] : ((res.data ?? []) as unknown as FeedVideo[]);
    } else {
      const c = cursor.current;
      const res = await supabase.rpc('feed_for_you', {
        p_limit: 8,
        p_after_score: c ? c.score : null,
        p_after_id: c ? c.id : null,
      });
      rows = res.error ? [] : ((res.data ?? []) as unknown as FeedVideo[]);
      if (rows.length > 0) cursor.current = { score: rows[rows.length - 1].score, id: rows[rows.length - 1].id };
      else done.current = true;
    }
    busy.current = false;
    if (rows.length > 0) {
      setItems((prev: FeedVideo[]) => [...prev, ...rows.filter((r: FeedVideo) => !prev.some((p: FeedVideo) => p.id === r.id))]);
    }
    if (!done.current) setTick((t: number) => t + 1);     // look again: this round may have added nothing new
  }, [supabase]);

  useEffect(() => {
    if (active >= items.length - 3) loadMore();
  }, [active, items.length, loadMore, tick]);

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
    root.querySelectorAll('[data-idx]').forEach((node: Element) => observer.observe(node));
    return () => observer.disconnect();
  }, [items.length]);

  const patch = useCallback((id: string, change: Partial<FeedVideo>) => {
    setItems((prev: FeedVideo[]) => prev.map((v: FeedVideo) => (v.id === id ? { ...v, ...change } : v)));
  }, []);
  const setFollow = useCallback((authorId: string, following: boolean) => {
    setItems((prev: FeedVideo[]) => prev.map((v: FeedVideo) => (v.author_id === authorId ? { ...v, following } : v)));
  }, []);
  const actions = useVideoActions({ userId, patch, setFollow, toast });

  const commentVideo = items.find((v: FeedVideo) => v.id === commentsFor) ?? null;

  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push('/feed');
  };

  return (
    <div className="feed-root">
      <div className="topbar">
        <button type="button" className="topbar-back" onClick={back} aria-label="Back"><BackIcon size={28} /></button>
        <span aria-hidden="true" />
        <Link href="/search" className="topbar-search" aria-label="Search"><SearchIcon size={26} /></Link>
      </div>

      <div className="feed" ref={scroller}>
        {items.map((video: FeedVideo, i: number) => (
          <div className="slot" key={video.id} data-idx={i}>
            <VideoCard
              video={video}
              active={i === active}
              shouldLoad={i === active || i === active + 1}
              muted={muted}
              ownId={userId}
              actions={actions}
              onOpenComments={(v: FeedVideo) => setCommentsFor(v.id)}
            />
          </div>
        ))}
      </div>

      {commentVideo && (
        <CommentsSheet
          video={commentVideo}
          userId={userId}
          onClose={() => setCommentsFor(null)}
          onCount={(change: number) => patch(commentVideo.id, { comments_count: Math.max(0, commentVideo.comments_count + change) })}
          needLogin={actions.needLogin}
        />
      )}
      <Toast text={toastText} />
    </div>
  );
}
