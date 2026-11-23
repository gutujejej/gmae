'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import Avatar from '@/components/Avatar';
import { BookmarkIcon, CommentIcon, HeartIcon, LinkIcon, PlayIcon, PlusIcon } from '@/components/Icons';
import { compact } from '@/lib/format';
import { markWatched } from '@/lib/local-store';
import { thumbSrc, videoSrc } from '@/lib/media';
import type { useVideoActions } from '@/lib/useVideoActions';
import type { FeedVideo } from '@/lib/types';

type Props = {
  video: FeedVideo;
  active: boolean;        // the card on screen: it plays
  shouldLoad: boolean;    // only the current and the next card download video (saves data)
  muted: boolean;
  onToggleMute?: () => void;
  ownId: string | null;
  actions: ReturnType<typeof useVideoActions>;
  onOpenComments: (video: FeedVideo) => void;
};

type Heart = { id: number; x: number; y: number };

// Caption with #hashtags highlighted.
function Caption({ text }: { text: string }) {
  const parts = text.split(/(#[^\s#]+)/g);
  return (
    <p className="caption">
      {parts.map((part, i) =>
        part.startsWith('#') ? (
          <span key={i} className="tag">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

export default function VideoCard({ video, active, shouldLoad, muted, ownId, actions, onOpenComments }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<number | null>(null);
  const heartId = useRef(0);
  const [paused, setPaused] = useState(false);
  const [hearts, setHearts] = useState<Heart[]>([]);

  // Play the card on screen, pause and rewind the others.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active && shouldLoad) {
      el.muted = muted;
      const attempt = el.play();
      if (attempt) attempt.catch(() => setPaused(true));      // the browser may block autoplay until the first tap
    } else {
      el.pause();
      if (!active) {
        setPaused(false);                                     // forget a pause from an earlier visit
        try { el.currentTime = 0; } catch { /* not loaded yet */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, shouldLoad]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  // Remember what was watched (for the Watched / Unwatched search filters).
  useEffect(() => {
    if (active) markWatched(video.id);
  }, [active, video.id]);

  useEffect(() => () => {
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
  }, []);

  const togglePlay = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else { el.pause(); setPaused(true); }                     // only a pause by the user shows the play icon
  };

  const burst = (x: number, y: number) => {
    const id = ++heartId.current;
    setHearts((h) => [...h, { id, x, y }]);
    window.setTimeout(() => setHearts((h) => h.filter((item) => item.id !== id)), 900);
  };

  // One tap pauses or plays, two quick taps like.
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
      lastTap.current = 0;
      const rect = e.currentTarget.getBoundingClientRect();
      burst(e.clientX - rect.left, e.clientY - rect.top);
      actions.doubleTapLike(video);
      return;
    }
    lastTap.current = now;
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      togglePlay();
    }, 300);
  };

  const landscape = !!video.width && !!video.height && video.width > video.height;
  const isOwn = ownId === video.author_id;

  return (
    <section className="card" aria-label={`Video by ${video.username}`}>
      <video
        ref={ref}
        className={landscape ? 'media contain' : 'media'}
        src={shouldLoad ? videoSrc(video) : undefined}
        poster={thumbSrc(video)}
        preload={shouldLoad ? 'auto' : 'none'}
        loop
        muted
        playsInline
        onPlay={() => setPaused(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (bar.current && el.duration) bar.current.style.transform = `scaleX(${el.currentTime / el.duration})`;
        }}
      />
      <div className="shade" aria-hidden="true" />

      <div className="stage" onClick={onStageClick} role="button" tabIndex={-1} aria-label={paused ? 'Play video' : 'Pause video'}>
        {active && paused && (
          <span className="flash"><PlayIcon size={34} /></span>
        )}
        {hearts.map((h) => (
          <span key={h.id} className="burst" style={{ left: h.x, top: h.y }}><HeartIcon size={96} filled /></span>
        ))}
      </div>

      <div className="rail">
        <div className="rail-author">
          <Link href={`/profile/${video.username}`} className="rail-avatar" aria-label={`Open @${video.username}`}>
            <Avatar url={video.avatar_url} name={video.display_name || video.username} size={50} />
          </Link>
          {!isOwn && !video.following && (
            <button type="button" className="follow-plus" onClick={() => actions.follow(video)} aria-label={`Follow @${video.username}`}>
              <PlusIcon size={14} />
            </button>
          )}
        </div>
        <button type="button" className={video.liked ? 'act on' : 'act'} onClick={() => actions.like(video)} aria-pressed={video.liked} aria-label="Like">
          <HeartIcon filled={video.liked} />
          <span>{compact(video.likes_count)}</span>
        </button>
        <button type="button" className="act" onClick={() => onOpenComments(video)} aria-label="Comments">
          <CommentIcon />
          <span>{compact(video.comments_count)}</span>
        </button>
        <button type="button" className={video.saved ? 'act saved' : 'act'} onClick={() => actions.save(video)} aria-pressed={video.saved} aria-label="Save">
          <BookmarkIcon filled={video.saved} />
          <span>{compact(video.saves_count)}</span>
        </button>
        <button type="button" className="act" onClick={() => actions.share(video)} aria-label="Copy link">
          <LinkIcon />
          <span>Share</span>
        </button>
      </div>

      <div className="card-info">
        <div className="author">
          <Link href={`/profile/${video.username}`} className="author-link">
            <b>@{video.username}</b>
          </Link>
          {video.series_part ? <span className="chip">Part {video.series_part}</span> : null}
        </div>
        {video.caption ? <Caption text={video.caption} /> : null}
      </div>

      <span className="bar" aria-hidden="true"><span ref={bar} /></span>
    </section>
  );
}
