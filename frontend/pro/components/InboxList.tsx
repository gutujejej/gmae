'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Avatar from '@/components/Avatar';
import { CloseIcon, EditIcon, SearchIcon } from '@/components/Icons';
import { chatTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';
import { useSession } from '@/lib/useSession';
import type { InboxRow, PersonRow } from '@/lib/types';

type Filter = 'all' | 'unread';

export default function InboxList() {
  const supabase = useMemo(() => createClient(), []);
  const { user } = useSession();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [newChat, setNewChat] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await supabase.rpc('pro_inbox_list', { p_limit: 100 });
    if (res.error) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setFailed(false);
    setRows((res.data ?? []) as unknown as InboxRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    // New messages and read ticks arrive live: reload the list (a little delayed, so bursts count once).
    const channel = supabase
      .channel('inbox-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pro_messages' }, () => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(load, 300);
      })
      .subscribe();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [supabase, load]);

  const unreadChats = rows.filter((r: InboxRow) => r.unread_count > 0).length;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r: InboxRow) => {
    if (filter === 'unread' && r.unread_count === 0) return false;
    if (!needle) return true;
    return (
      r.username.toLowerCase().includes(needle) ||
      r.display_name.toLowerCase().includes(needle) ||
      r.last_message_preview.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="page inbox">
      <h1>Inbox</h1>

      <div className="searchbar">
        <SearchIcon size={20} />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          maxLength={60}
        />
        {q && (
          <button type="button" className="searchbar-clear" onClick={() => setQ('')} aria-label="Clear search">
            <CloseIcon size={18} />
          </button>
        )}
      </div>

      <div className="seg" role="tablist" aria-label="Filter chats">
        <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>
          All {rows.length > 0 && <span className="count">{rows.length}</span>}
        </button>
        <button type="button" role="tab" aria-selected={filter === 'unread'} onClick={() => setFilter('unread')}>
          Unread {unreadChats > 0 && <span className="count hot">{unreadChats}</span>}
        </button>
      </div>

      {loading && <div className="center-pad"><span className="spinner" aria-label="Loading" /></div>}

      {!loading && failed && (
        <div className="empty">
          <p>Could not load your chats.</p>
          <button type="button" className="btn btn-ghost" onClick={load}>Try again</button>
        </div>
      )}

      {!loading && !failed && rows.length === 0 && (
        <div className="empty">
          <p>No messages yet. Tap the pencil to start a chat, or open someone’s profile and press Message.</p>
        </div>
      )}

      {!loading && !failed && rows.length > 0 && shown.length === 0 && (
        <p className="empty">{filter === 'unread' && !needle ? 'You are all caught up.' : 'No chats found.'}</p>
      )}

      <ul className="chat-list">
        {shown.map((r: InboxRow) => {
          const mine = r.last_sender_id !== null && r.last_sender_id === user?.id;
          return (
            <li key={r.conversation_id}>
              <Link href={`/inbox/${r.username}`} className={r.unread_count > 0 ? 'chat-row unread' : 'chat-row'}>
                <Avatar url={r.avatar_url} name={r.display_name || r.username} size={54} />
                <span className="chat-main">
                  <span className="chat-top">
                    <b className="chat-name">{r.display_name || r.username}</b>
                    <time className="chat-time" dateTime={r.last_message_at}>{chatTime(r.last_message_at)}</time>
                  </span>
                  <span className="chat-bottom">
                    <span className="chat-preview">{mine ? <em>You: </em> : null}{r.last_message_preview}</span>
                    {r.unread_count > 0 && <span className="badge" aria-label={`${r.unread_count} unread`}>{r.unread_count > 99 ? '99+' : r.unread_count}</span>}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <button type="button" className="fab" onClick={() => setNewChat(true)} aria-label="New message">
        <EditIcon size={24} />
      </button>

      {newChat && <NewChatSheet onClose={() => setNewChat(false)} ownId={user?.id ?? null} />}
    </div>
  );
}

function NewChatSheet({ onClose, ownId }: { onClose: () => void; ownId: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const [text, setText] = useState('');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      supabase.rpc('pro_search_people', { p_q: text.trim() || null, p_limit: 20 }).then(({ data }) => {
        if (!alive) return;
        setPeople((data ?? []) as unknown as PersonRow[]);
        setLoading(false);
      });
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [supabase, text]);

  const list = people.filter((p: PersonRow) => p.id !== ownId);

  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New message" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>New message</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon size={22} /></button>
        </header>
        <div className="sheet-search">
          <div className="searchbar">
            <SearchIcon size={20} />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search people"
              aria-label="Search people"
              maxLength={40}
              autoFocus
            />
          </div>
        </div>
        <div className="sheet-list">
          {loading && <p className="empty">Loading…</p>}
          {!loading && list.length === 0 && <p className="empty">No people found.</p>}
          {list.map((p: PersonRow) => (
            <Link key={p.id} href={`/inbox/${p.username}`} className="chat-row" onClick={onClose}>
              <Avatar url={p.avatar_url} name={p.display_name || p.username} size={44} />
              <span className="chat-main">
                <b className="chat-name">{p.display_name || p.username}</b>
                <span className="chat-preview">@{p.username}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
