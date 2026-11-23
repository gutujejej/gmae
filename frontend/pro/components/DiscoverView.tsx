'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { SearchIcon } from '@/components/Icons';
import SmartThumb from '@/components/SmartThumb';
import { compact } from '@/lib/format';
import { savePlaylist } from '@/lib/local-store';
import { createClient } from '@/lib/supabase/client';
import type { DiscoverVideo } from '@/lib/types';

const PAGE = 20;
type Sort = 'trending' | 'new';

export default function DiscoverView() {
  const supabase = useMemo(() => createClient(), []);
  const [sort, setSort] = useState<Sort>('trending');
  const [videos, setVideos] = useState<DiscoverVideo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  // Popular hashtags.
  useEffect(() => {
    let alive = true;
    supabase
      .from('hashtags')
      .select('tag')
      .order('uses_count', { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (!alive) return;
        setTags(((data ?? []) as unknown as { tag: string }[]).map((r: { tag: string }) => r.tag));
      });
    return () => { alive = false; };
  }, [supabase]);

  const fetchPage = useCallback(async (offset: number): Promise<DiscoverVideo[] | null> => {
    const res = await supabase.rpc('pro_discover_videos', { p_q: null, p_sort: sort, p_limit: PAGE, p_offset: offset });
    if (res.error) return null;
    return (res.data ?? []) as unknown as DiscoverVideo[];
  }, [supabase, sort]);

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
  }, [fetchPage]);

  const showMore = async () => {
    if (loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    const rows = await fetchPage(videos.length);
    if (gen !== generation.current) { setLoadingMore(false); return; }
    if (rows) {
      setVideos((prev: DiscoverVideo[]) => [...prev, ...rows.filter((r: DiscoverVideo) => !prev.some((p: DiscoverVideo) => p.id === r.id))]);
      setMore(rows.length === PAGE);
    }
    setLoadingMore(false);
  };

  return (
    <div className="page discover">
      <h1>Discover</h1>

      <Link href="/search" className="searchbar searchbar-link" aria-label="Search">
        <SearchIcon size={20} />
        <span>Search videos, people, #tags</span>
      </Link>

      {tags.length > 0 && (
        <div className="chips" aria-label="Popular tags">
          {tags.map((t: string) => (
            <Link key={t} href={`/search?q=${encodeURIComponent(`#${t}`)}`} className="chip-btn">#{t}</Link>
          ))}
        </div>
      )}

      <div className="seg" role="tablist" aria-label="Sort videos">
        <button type="button" role="tab" aria-selected={sort === 'trending'} onClick={() => setSort('trending')}>Trending</button>
        <button type="button" role="tab" aria-selected={sort === 'new'} onClick={() => setSort('new')}>New</button>
      </div>

      {loading && <div className="center-pad"><span className="spinner" aria-label="Loading" /></div>}

      {!loading && failed && <p className="empty">Could not load videos. Check your internet.</p>}

      {!loading && !failed && videos.length === 0 && <p className="empty">No videos yet. Be the first to post one.</p>}

      {!loading && videos.length > 0 && (
        <ul className="dgrid">
          {videos.map((v: DiscoverVideo) => (
            <li key={v.id}>
              <Link
                href={`/v/${v.id}`}
                className="dcard"
                aria-label={v.caption ? `Open video: ${v.caption}` : `Open video by ${v.username}`}
                onClick={() => savePlaylist(videos.map((x: DiscoverVideo) => x.id))}
              >
                <SmartThumb video={v} />
                <span className="dcard-meta">
                  <span className="dcard-cap">{v.caption || `@${v.username}`}</span>
                  <span className="dcard-likes">♥ {compact(v.likes_count)} · @{v.username}</span>
                </span>
              </Link>
            </li>
          ))}
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
