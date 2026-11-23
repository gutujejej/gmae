'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import Avatar from '@/components/Avatar';
import { BackIcon, CheckCheckIcon, CheckIcon, SendIcon } from '@/components/Icons';
import { clockTime, dayLabel } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';
import type { ChatMessage } from '@/lib/types';

type Other = { id: string; username: string; display_name: string; avatar_url: string | null };

const PAGE = 40;
const COLUMNS = 'id, conversation_id, sender_id, body, created_at, read_at';

export default function ChatThread({ me, other }: { me: string; other: Other }) {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const conversationId = useRef<string | null>(null);
  const sending = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastSeenId = useRef<string | null>(null);

  const markRead = useCallback((id: string) => {
    supabase.rpc('pro_mark_read', { p_conversation: id }).then(() => undefined);
  }, [supabase]);

  // Open the chat: find it, load the newest messages, tell the other person you read them.
  useEffect(() => {
    let alive = true;
    (async () => {
      const found = await supabase.rpc('pro_chat_find', { p_other: other.id });
      const id = typeof found.data === 'string' ? found.data : null;
      if (!alive) return;
      conversationId.current = id;
      if (id) {
        const res = await supabase
          .from('pro_messages')
          .select(COLUMNS)
          .eq('conversation_id', id)
          .order('created_at', { ascending: false })
          .limit(PAGE);
        if (!alive) return;
        const rows = ((res.data ?? []) as unknown as ChatMessage[]).slice().reverse();
        setMessages(rows);
        setHasMore(rows.length === PAGE);
        markRead(id);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [supabase, other.id, markRead]);

  // Live: new messages and read ticks.
  useEffect(() => {
    const channel = supabase
      .channel(`chat-${me}-${other.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pro_messages' }, (payload: { new: Record<string, unknown> }) => {
        const row = payload.new as unknown as ChatMessage;
        const mine = row.sender_id === me;
        if (mine ? row.conversation_id !== conversationId.current : row.sender_id !== other.id) return;
        if (!conversationId.current) conversationId.current = row.conversation_id;
        setMessages((prev: ChatMessage[]) => {
          if (prev.some((m: ChatMessage) => m.id === row.id)) return prev;
          const rest = mine ? prev.filter((m: ChatMessage) => !(m.pending && m.body === row.body)) : prev;
          return [...rest, row];
        });
        if (!mine && document.visibilityState === 'visible') markRead(row.conversation_id);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pro_messages' }, (payload: { new: Record<string, unknown> }) => {
        const row = payload.new as unknown as ChatMessage;
        if (row.sender_id !== me || row.conversation_id !== conversationId.current) return;
        setMessages((prev: ChatMessage[]) => prev.map((m: ChatMessage) => (m.id === row.id ? { ...m, read_at: row.read_at } : m)));
      })
      .subscribe();

    // Coming back to the tab counts as reading what arrived meanwhile.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && conversationId.current) markRead(conversationId.current);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, me, other.id, markRead]);

  // Stay at the bottom when a new message arrives (not when older ones are loaded above).
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (lastId && lastId !== lastSeenId.current) {
      bottom.current?.scrollIntoView({ block: 'end', behavior: lastSeenId.current ? 'smooth' : 'auto' });
      lastSeenId.current = lastId;
    }
  }, [lastId]);

  const loadEarlier = async () => {
    const first = messages.find((m: ChatMessage) => !m.pending);
    const id = conversationId.current;
    if (!first || !id) return;
    const res = await supabase
      .from('pro_messages')
      .select(COLUMNS)
      .eq('conversation_id', id)
      .lt('created_at', first.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE);
    const rows = ((res.data ?? []) as unknown as ChatMessage[]).slice().reverse();
    setMessages((prev: ChatMessage[]) => [...rows, ...prev]);
    setHasMore(rows.length === PAGE);
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true;
    setError('');
    setText('');
    if (field.current) field.current.style.height = 'auto';

    const tempId = `tmp-${Date.now()}`;
    const temp: ChatMessage = {
      id: tempId,
      conversation_id: conversationId.current ?? '',
      sender_id: me,
      body,
      created_at: new Date().toISOString(),
      read_at: null,
      pending: true,
    };
    setMessages((prev: ChatMessage[]) => [...prev, temp]);

    const res = await supabase.rpc('pro_send_message', { p_to: other.id, p_body: body });
    sending.current = false;

    if (res.error || !res.data) {
      setMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== tempId));
      setText(body);
      setError(res.error?.message?.includes('slow down') ? 'You are sending too fast. Wait a moment.' : 'Message not sent. Try again.');
      return;
    }
    const row = res.data as unknown as ChatMessage;
    conversationId.current = row.conversation_id;
    setMessages((prev: ChatMessage[]) => {
      const rest = prev.filter((m: ChatMessage) => m.id !== tempId);
      return rest.some((m: ChatMessage) => m.id === row.id) ? rest : [...rest, row];
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Phones: Enter makes a new line (use the send button). Computers: Enter sends, Shift+Enter makes a new line.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      send();
    }
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  let lastDay = '';

  return (
    <div className="chat">
      <header className="chat-head">
        <Link href="/inbox" className="icon-btn" aria-label="Back to inbox"><BackIcon size={24} /></Link>
        <Link href={`/profile/${other.username}`} className="chat-who">
          <Avatar url={other.avatar_url} name={other.display_name || other.username} size={40} />
          <span>
            <b>{other.display_name || other.username}</b>
            <small>@{other.username}</small>
          </span>
        </Link>
      </header>

      <div className="chat-body">
        {loading && <div className="center-pad"><span className="spinner" aria-label="Loading" /></div>}
        {!loading && hasMore && (
          <button type="button" className="btn btn-ghost chat-earlier" onClick={loadEarlier}>Load earlier messages</button>
        )}
        {!loading && messages.length === 0 && (
          <p className="empty">Say hi to @{other.username}. Your messages are private between the two of you.</p>
        )}

        {messages.map((m: ChatMessage) => {
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = m.sender_id === me;
          return (
            <div key={m.id} className="chat-item">
              {showDay && <div className="chat-day"><span>{day}</span></div>}
              <div className={mine ? 'bubble mine' : 'bubble'}>
                <p>{m.body}</p>
                <span className="bubble-meta">
                  <time dateTime={m.created_at}>{m.pending ? '…' : clockTime(m.created_at)}</time>
                  {mine && !m.pending && (m.read_at ? <span className="tick read" aria-label="Read"><CheckCheckIcon size={16} /></span> : <span className="tick" aria-label="Sent"><CheckIcon size={16} /></span>)}
                </span>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      {error && <p className="error chat-error" role="alert">{error}</p>}

      <div className="chat-composer">
        <textarea
          ref={field}
          value={text}
          rows={1}
          maxLength={2000}
          placeholder="Message"
          aria-label="Message"
          onChange={(e) => { setText(e.target.value); grow(e.target); }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="send" onClick={send} disabled={!text.trim()} aria-label="Send message">
          <SendIcon size={22} />
        </button>
      </div>
    </div>
  );
}
