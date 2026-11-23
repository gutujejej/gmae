'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Avatar from '@/components/Avatar';
import { BackIcon, CloseIcon, HeartIcon, SearchIcon } from '@/components/Icons';
import SmartThumb from '@/components/SmartThumb';
import { compact } from '@/lib/format';
import { addRecent, clearRecent, getRecent, getWatched, removeRecent, savePlaylist } from '@/lib/local-store';
import { createClient } from '@/lib/supabase/client';
import type { DiscoverVideo, PersonRow } from '@/lib/types';

const PAGE = 20;
type Tab = 'top' | 'videos' | 'users';
type Chip = 'all' | 'unwatched' | 'watched' | 'recent';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const pickRandom = (all: string[]) => [...all].sort(() => Math.random() - 0.5).slice(0, 10);

export default function SearchView() {
  const router = useRouter();
  const params = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const [input, setInput] = useState(q);

  useEffect(() => {
    setInput(q);
  }, [q]);

  const go = (text: string) => {
    const t = text.trim();
    if (!t) return;
    addRecent(t);
    router.push(`/search?q=${encodeURIComponent(t)}`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(input);
  };
  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push('/discover');
  };

  return (
    <div className="page search">
      <form className="search-head" onSubmit={submit}>
        <button type="button" className="icon-btn" onClick={back} aria-label="Back"><BackIcon size={24} /></button>
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
            autoFocus={!q}
          />
          {input && (
            <button type="button" className="searchbar-clear" onClick={() => setInput('')} aria-label="Clear search">
              <CloseIcon size={18} />
            </button>
          )}
        </div>
        <button type="submit" className="search-go">Search</button>
      </form>

      {q ? <Results q={q} /> : <Suggestions input={input} onPick={go} />}
    </div>
  );
}

/* ---------------- before searching: recent, popular topics, live suggestions ---------------- */

function Suggestions({ input, onPick }: { input: string; onPick: (text: string) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [recent, setRecent] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [shown, setShown] = useState<string[]>([]);
  const [liveTags, setLiveTags] = useState<string[]>([]);
  const [livePeople, setLivePeople] = useState<PersonRow[]>([]);
  const typed = input.trim();

  useEffect(() => {
    setRecent(getRecent());
  }, []);

  useEffect(() => {
    let alive = true;
    supabase
      .from('hashtags')
      .select('tag')
      .order('uses_count', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!alive) return;
        const tags = ((data ?? []) as unknown as { tag: string }[]).map((r: { tag: string }) => r.tag);
        setAllTags(tags);
        setShown(pickRandom(tags));
      });
    return () => { alive = false; };
  }, [supabase]);

  // Suggestions that follow what is being typed.
  useEffect(() => {
    let alive = true;
    if (!typed) {
      setLiveTags([]);
      setLivePeople([]);
      return;
    }
    const t = window.setTimeout(() => {
      const prefix = typed.replace(/^#/, '').replace(/[%_\\]/g, '');
      if (prefix) {
        supabase.from('hashtags').select('tag').ilike('tag', `${prefix}%`).order('uses_count', { ascending: false }).limit(5)
          .then(({ data }) => {
            if (alive) setLiveTags(((data ?? []) as unknown as { tag: string }[]).map((r: { tag: string }) => r.tag));
          });
      }
      supabase.rpc('pro_search_people', { p_q: typed, p_limit: 4 }).then(({ data }) => {
        if (alive) setLivePeople((data ?? []) as unknown as PersonRow[]);
      });
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [supabase, typed]);

  if (typed) {
    return (
      <ul className="suggest-list">
        <li><button type="button" className="suggest-row" onClick={() => onPick(typed)}><SearchIcon size={18} /><span>Search “{typed}”</span></button></li>
        {liveTags.map((t: string) => (
          <li key={t}><button type="button" className="suggest-row" onClick={() => onPick(`#${t}`)}><SearchIcon size={18} /><span>#{t}</span></button></li>
        ))}
        {livePeople.map((p: PersonRow) => (
          <li key={p.id}>
            <Link href={`/profile/${p.username}`} className="suggest-row">
              <Avatar url={p.avatar_url} name={p.display_name || p.username} size={28} />
              <span>{p.display_name || p.username} <small>@{p.username}</small></span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="suggest">
      {recent.length > 0 && (
        <section>
          <div className="suggest-head">
            <h2>Recent searches</h2>
            <button type="button" className="link-btn" onClick={() => { clearRecent(); setRecent([]); }}>Clear all</button>
          </div>
          <ul className="suggest-list">
            {recent.map((r: string) => (
              <li key={r} className="suggest-recent">
                <button type="button" className="suggest-row" onClick={() => onPick(r)}><SearchIcon size={18} /><span>{r}</span></button>
                <button type="button" className="searchbar-clear" aria-label={`Remove ${r}`} onClick={() => { removeRecent(r); setRecent(getRecent()); }}><CloseIcon size={16} /></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="suggest-head">
          <h2>You may like</h2>
          {allTags.length > 10 && (
            <button type="button" className="link-btn" onClick={() => setShown(pickRandom(allTags))}>Refresh</button>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="empty">Topics will show here once people post with #hashtags.</p>
        ) : (
          <ul className="topics">
            {shown.map((t: string) => (
              <li key={t}><button type="button" onClick={() => onPick(`#${t}`)}>#{t}</button></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------------- after searching: Top / Videos / Users + filters + results ---------------- */

function Results({ q }: { q: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<Tab>('top');
  const [chip, setChip] = useState<Chip>('all');
  const [videos, setVideos] = useState<DiscoverVideo[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const sort = chip === 'recent' ? 'new' : 'trending';

  useEffect(() => {
    setTab('top');
    setChip('all');
  }, [q]);

  useEffect(() => {
    setWatched(getWatched());
  }, [q]);

  useEffect(() => {
    let alive = true;
    supabase.rpc('pro_search_people', { p_q: q, p_limit: 20 }).then(({ data }) => {
      if (alive) setPeople((data ?? []) as unknown as PersonRow[]);
    });
    return () => { alive = false; };
  }, [supabase, q]);

  const fetchPage = useCallback(async (offset: number): Promise<DiscoverVideo[] | null> => {
    const res = await supabase.rpc('pro_discover_videos', { p_q: q, p_sort: sort, p_limit: PAGE, p_offset: offset });
    if (res.error) return null;
    return (res.data ?? []) as unknown as DiscoverVideo[];
  }, [supabase, q, sort]);

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

  const shown = videos.filter((v: DiscoverVideo) => {
    if (chip === 'unwatched') return !watched.has(v.id);
    if (chip === 'watched') return watched.has(v.id);
    return true;
  });

  const chips: { id: Chip; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unwatched', label: 'Unwatched' },
    { id: 'watched', label: 'Watched' },
    { id: 'recent', label: 'Recently uploaded' },
  ];

  return (
    <div className="results">
      <div className="tabline" role="tablist" aria-label="Search results">
        {(['top', 'videos', 'users'] as Tab[]).map((t: Tab) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'top' ? 'Top' : t === 'videos' ? 'Videos' : 'Users'}
          </button>
        ))}
      </div>

      {tab !== 'users' && (
        <div className="fchips" aria-label="Filter videos">
          {chips.map((c: { id: Chip; label: string }) => (
            <button key={c.id} type="button" className={chip === c.id ? 'fchip on' : 'fchip'} onClick={() => setChip(c.id)}>{c.label}</button>
          ))}
        </div>
      )}

      {tab === 'users' && (
        <>
          {people.length === 0 && <p className="empty">No people found for “{q}”.</p>}
          <ul className="chat-list">
            {people.map((p: PersonRow) => (
              <li key={p.id}>
                <Link href={`/profile/${p.username}`} className="chat-row">
                  <Avatar url={p.avatar_url} name={p.display_name || p.username} size={52} />
                  <span className="chat-main">
                    <b className="chat-name">{p.display_name || p.username}</b>
                    <span className="chat-preview">@{p.username} · {compact(p.followers_count)} followers</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'top' && people.length > 0 && (
        <ul className="people-row">
          {people.slice(0, 6).map((p: PersonRow) => (
            <li key={p.id}>
              <Link href={`/profile/${p.username}`} className="person">
                <Avatar url={p.avatar_url} name={p.display_name || p.username} size={52} />
                <b>{p.display_name || p.username}</b>
                <small>@{p.username}</small>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {tab !== 'users' && (
        <>
          {loading && <div className="center-pad"><span className="spinner" aria-label="Loading" /></div>}
          {!loading && failed && <p className="empty">Could not search. Check your internet.</p>}
          {!loading && !failed && shown.length === 0 && (
            <p className="empty">
              {videos.length > 0 && chip !== 'all' ? 'Nothing here with this filter. Try All.' : `No videos found for “${q}”.`}
            </p>
          )}
          {!loading && shown.length > 0 && (
            <ul className="rgrid">
              {shown.map((v: DiscoverVideo) => (
                <li key={v.id}>
                  <Link href={`/v/${v.id}`} className="rcard" onClick={() => savePlaylist(shown.map((x: DiscoverVideo) => x.id))}>
                    <span className="rcard-media"><SmartThumb video={v} /></span>
                    <span className="rcard-cap">{v.caption || `Video by @${v.username}`}</span>
                    <span className="rcard-foot">
                      <span className="rcard-by">
                        <Avatar url={v.avatar_url} name={v.display_name || v.username} size={24} />
                        <span><b>{v.display_name || v.username}</b><small>{shortDate(v.created_at)}</small></span>
                      </span>
                      <span className="rcard-likes"><HeartIcon size={15} />{compact(v.likes_count)}</span>
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
        </>
      )}
    </div>
  );
}
