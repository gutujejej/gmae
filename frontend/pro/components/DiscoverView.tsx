'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Avatar from '@/components/Avatar';
import { CloseIcon, SearchIcon } from '@/components/Icons';
import { compact } from '@/lib/format';
import { thumbSrc } from '@/lib/media';
import { createClient } from '@/lib/supabase/client';
import type { DiscoverVideo, PersonRow } from '@/lib/types';

const PAGE = 20;
type Sort = 'trending' | 'new';

export default function DiscoverView() {
  const supabase = useMemo(() => createClient(), []);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('trending');
  const [videos, setVideos] = useState<DiscoverVideo[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  // Wait until the person stops typing before searching.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(input.trim()), 350);
    return () => window.clearTimeout(t);
  }, [input]);

  // Popular hashtags (shown when the search box is empty).
  useEffect(() => {
    let alive = true;
    supabase
      .from('hashtags')
      .select('tag')
      .order('uses_count', { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (!alive) return;
        const rows = (data ?? []) as unknown as { tag: string }[];
        setTags(rows.map((r: { tag: string }) => r.tag));
      });
    return () => { alive = false; };
  }, [supabase]);

  const fetchPage = useCallback(async (offset: number): Promise<DiscoverVideo[] | null> => {
    const res = await supabase.rpc('pro_discover_videos', {
      p_q: q || null,
      p_sort: sort,
      p_limit: PAGE,
      p_offset: offset,
    });
    if (res.error) return null;
    return (res.data ?? []) as unknown as DiscoverVideo[];
  }, [supabase, q, sort]);

  // First page again whenever the search text or the sort changes.
  useEffect(() => {
    const gen = ++generation.current;
    setLoading(true);
    setFailed(false);
    fetchPage(0).then((rows) => {
      if (gen !== generation.current) return;
      if (!rows) {
        setFailed(true);
        setVideos([]);
        setMore(false);
      } else {
        setVideos(rows);
        setMore(rows.length === PAGE);
      }
      setLoading(false);
    });
    if (q) {
      supabase.rpc('pro_search_people', { p_q: q, p_limit: 8 }).then(({ data }) => {
        if (gen === generation.current) setPeople((data ?? []) as unknown as PersonRow[]);
      });
    } else {
      setPeople([]);
    }
  }, [fetchPage, supabase, q]);

  const showMore = async () => {
    if (loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    const rows = await fetchPage(videos.length);
    if (gen !== generation.current) { setLoadingMore(false); return; }
    if (rows) {
      setVideos((prev) => [...prev, ...rows.filter((r: DiscoverVideo) => !prev.some((p: DiscoverVideo) => p.id === r.id))]);
      setMore(rows.length === PAGE);
    }
    setLoadingMore(false);
  };

  return (
    <div className="page discover">
      <h1>Discover</h1>

      <div className="searchbar">
        <SearchIcon size={20} />
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search videos, people, #tags"
          aria-label="Search"
          maxLength={60}
          enterKeyHint="search"
        />
        {input && (
          <button type="button" className="searchbar-clear" onClick={() => setInput('')} aria-label="Clear search">
            <CloseIcon size={18} />
          </button>
        )}
      </div>

      {!q && tags.length > 0 && (
        <div className="chips" aria-label="Popular tags">
          {tags.map((t: string) => (
            <button type="button" key={t} className="chip-btn" onClick={() => setInput(`#${t}`)}>#{t}</button>
          ))}
        </div>
      )}

      {q && people.length > 0 && (
        <section aria-label="People">
          <h2 className="section-title">People</h2>
          <ul className="people-row">
            {people.map((p: PersonRow) => (
              <li key={p.id}>
                <Link href={`/profile/${p.username}`} className="person">
                  <Avatar url={p.avatar_url} name={p.display_name || p.username} size={52} />
                  <b>{p.display_name || p.username}</b>
                  <small>@{p.username}</small>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="seg" role="tablist" aria-label="Sort videos">
        <button type="button" role="tab" aria-selected={sort === 'trending'} onClick={() => setSort('trending')}>Trending</button>
        <button type="button" role="tab" aria-selected={sort === 'new'} onClick={() => setSort('new')}>New</button>
      </div>

      {loading && <div className="center-pad"><span className="spinner" aria-label="Loading" /></div>}

      {!loading && failed && (
        <div className="empty">
          <p>Could not load videos. Check your internet.</p>
        </div>
      )}

      {!loading && !failed && videos.length === 0 && (
        <p className="empty">{q ? `No videos found for “${q}”.` : 'No videos yet. Be the first to post one.'}</p>
      )}

      {!loading && videos.length > 0 && (
        <ul className="dgrid">
          {videos.map((v: DiscoverVideo) => {
            const src = thumbSrc(v);
            return (
              <li key={v.id}>
                <Link href={`/v/${v.id}`} className="dcard" aria-label={v.caption ? `Open video: ${v.caption}` : `Open video by ${v.username}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt="" loading="lazy" /> : <span className="dcard-empty" />}
                  <span className="dcard-meta">
                    <span className="dcard-cap">{v.caption || `@${v.username}`}</span>
                    <span className="dcard-likes">♥ {compact(v.likes_count)} · @{v.username}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && more && (
        <button type="button" className="btn btn-ghost block" onClick={showMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
