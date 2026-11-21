'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Avatar from '@/components/Avatar';
import { CloseIcon } from '@/components/Icons';
import { timeAgo } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';
import type { CommentRow, FeedVideo } from '@/lib/types';

const PAGE = 30;
const SELECT = 'id, body, created_at, author_id, author:profiles(username, display_name, avatar_url)';

type Props = {
  video: FeedVideo;
  userId: string | null;
  onClose: () => void;
  onCount: (change: number) => void;     // +1 / -1 so the number on the card stays right
  needLogin: () => void;
};

export default function CommentsSheet({ video, userId, onClose, onCount, needLogin }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  // First page of top-level comments, newest first (replies come in a later phase).
  useEffect(() => {
    let alive = true;
    supabase
      .from('comments')
      .select(SELECT)
      .eq('video_id', video.id)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(PAGE)
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError('Could not load comments.');
        const rows = (data ?? []) as unknown as CommentRow[];
        setItems(rows);
        setMore(rows.length === PAGE);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [supabase, video.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoading(true);
    const { data } = await supabase
      .from('comments')
      .select(SELECT)
      .eq('video_id', video.id)
      .is('parent_id', null)
      .lt('created_at', last.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE);
    const rows = (data ?? []) as unknown as CommentRow[];
    setItems((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))]);
    setMore(rows.length === PAGE);
    setLoading(false);
  };

  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return needLogin();
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    setError('');
    const { data, error: err } = await supabase
      .from('comments')
      .insert({ video_id: video.id, author_id: userId, body })
      .select(SELECT)
      .single();
    setPosting(false);
    if (err || !data) { setError('Could not post your comment. Try again.'); return; }
    setItems((prev) => [data as unknown as CommentRow, ...prev]);
    setText('');
    onCount(1);
  };

  const remove = async (c: CommentRow) => {
    const { error: err } = await supabase.from('comments').delete().eq('id', c.id);
    if (err) { setError('Could not delete this comment.'); return; }
    setItems((prev) => prev.filter((p) => p.id !== c.id));
    onCount(-1);
  };

  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Comments" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{video.comments_count} comments</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close comments"><CloseIcon size={22} /></button>
        </header>

        <div className="sheet-list">
          {items.map((c) => (
            <article key={c.id} className="comment">
              <Avatar url={c.author?.avatar_url ?? null} name={c.author?.display_name || c.author?.username || '?'} size={34} />
              <div className="comment-body">
                <p><b>@{c.author?.username ?? 'user'}</b> <small>{timeAgo(c.created_at)}</small></p>
                <p>{c.body}</p>
              </div>
              {(c.author_id === userId || video.author_id === userId) && (
                <button type="button" className="link-btn" onClick={() => remove(c)} aria-label="Delete comment">Delete</button>
              )}
            </article>
          ))}
          {!loading && items.length === 0 && <p className="empty">No comments yet. Be the first.</p>}
          {loading && <p className="empty">Loading…</p>}
          {more && !loading && <button type="button" className="btn btn-ghost" onClick={loadMore}>Show more</button>}
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        <form className="sheet-form" onSubmit={post}>
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => { if (!userId) needLogin(); }}
            maxLength={500}
            placeholder={userId ? 'Add a comment' : 'Log in to comment'}
            aria-label="Write a comment"
          />
          <button type="submit" className="btn btn-primary" disabled={posting || !text.trim()}>Post</button>
        </form>
      </div>
    </div>
  );
}
