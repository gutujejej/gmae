'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useSession } from '@/lib/useSession';
import { HomeIcon, InboxIcon, PlusIcon, SearchIcon, UserIcon } from '@/components/Icons';

export default function BottomNav() {
  const pathname = usePathname() || '';
  const { user } = useSession();
  const [username, setUsername] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) {
      setUsername(null);
      return;
    }
    let alive = true;
    createClient()
      .from('profiles')
      .select('username')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setUsername(data?.username ?? null);
      });
    return () => {
      alive = false;
    };
  }, [user]);

  // Red badge on Inbox: unread messages, live.
  useEffect(() => {
    if (!user) {
      setUnread(0);
      return;
    }
    const supabase = createClient();
    let alive = true;
    const load = () => {
      supabase.rpc('pro_unread_total').then(({ data }) => {
        if (alive) setUnread(typeof data === 'number' ? data : 0);
      });
    };
    load();
    const channel = supabase
      .channel('nav-unread')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pro_messages' }, () => load())
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [user, pathname]);

  // Inside a chat the bottom bar gets out of the way (like Telegram).
  if (pathname.startsWith('/inbox/')) return null;

  const profileHref = user ? (username ? `/profile/${username}` : '/profile/edit') : '/login';
  const onFeed = pathname === '/feed' || pathname.startsWith('/v/');
  const onDiscover = pathname.startsWith('/discover');
  const onInbox = pathname.startsWith('/inbox');
  const onProfile = pathname.startsWith('/profile') || pathname === '/login' || pathname === '/signup';

  return (
    <nav className="nav" aria-label="Main">
      <Link href="/feed" className={onFeed ? 'nav-item on' : 'nav-item'} aria-current={onFeed ? 'page' : undefined}>
        <HomeIcon size={24} />
        <span>Home</span>
      </Link>
      <Link href="/discover" className={onDiscover ? 'nav-item on' : 'nav-item'} aria-current={onDiscover ? 'page' : undefined}>
        <SearchIcon size={24} />
        <span>Discover</span>
      </Link>
      <Link href="/upload" className="nav-plus" aria-label="Upload a video">
        <span><PlusIcon size={20} /></span>
      </Link>
      <Link href={user ? '/inbox' : '/login?next=/inbox'} className={onInbox ? 'nav-item on' : 'nav-item'} aria-current={onInbox ? 'page' : undefined}>
        <span className="nav-icon">
          <InboxIcon size={24} />
          {unread > 0 && <i className="nav-badge" aria-label={`${unread} unread messages`}>{unread > 99 ? '99+' : unread}</i>}
        </span>
        <span>Inbox</span>
      </Link>
      <Link href={profileHref} className={onProfile ? 'nav-item on' : 'nav-item'} aria-current={onProfile ? 'page' : undefined}>
        <UserIcon size={24} />
        <span>{user ? 'Me' : 'Log in'}</span>
      </Link>
    </nav>
  );
}
