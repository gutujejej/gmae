'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useSession } from '@/lib/useSession';
import { HomeIcon, PlusIcon, UserIcon } from '@/components/Icons';

export default function BottomNav() {
  const pathname = usePathname() || '';
  const { user } = useSession();
  const [username, setUsername] = useState<string | null>(null);

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

  const profileHref = user ? (username ? `/profile/${username}` : '/profile/edit') : '/login';
  const onFeed = pathname === '/feed' || pathname.startsWith('/v/');
  const onProfile = pathname.startsWith('/profile') || pathname === '/login' || pathname === '/signup';

  return (
    <nav className="nav" aria-label="Main">
      <Link href="/feed" className={onFeed ? 'nav-item on' : 'nav-item'} aria-current={onFeed ? 'page' : undefined}>
        <HomeIcon size={24} />
        <span>Home</span>
      </Link>
      <Link href="/upload" className="nav-plus" aria-label="Upload a video">
        <span><PlusIcon size={20} /></span>
      </Link>
      <Link href={profileHref} className={onProfile ? 'nav-item on' : 'nav-item'} aria-current={onProfile ? 'page' : undefined}>
        <UserIcon size={24} />
        <span>{user ? 'Profile' : 'Log in'}</span>
      </Link>
    </nav>
  );
}
