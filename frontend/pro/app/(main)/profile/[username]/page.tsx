import Link from 'next/link';
import { notFound } from 'next/navigation';
import Avatar from '@/components/Avatar';
import FollowButton from '@/components/FollowButton';
import { BookmarkIcon, EditIcon, GridIcon, HeartIcon, InboxIcon, PlusIcon } from '@/components/Icons';
import LogoutButton from '@/components/LogoutButton';
import ProfileGrid, { type GridItem } from '@/components/ProfileGrid';
import { compact } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

type Params = {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ tab?: string }>;
};

const TILE_COLUMNS = 'id, thumb_path, video_path, likes_count, views_count, caption';

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return { title: `@${username}` };
}

export default async function ProfilePage({ params, searchParams }: Params) {
  const { username } = await params;
  const { tab: tabParam } = await searchParams;
  let handle = username;
  try { handle = decodeURIComponent(username); } catch { /* keep the raw text */ }
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, bio, followers_count, following_count, videos_count')
    .eq('username', handle.toLowerCase())
    .maybeSingle();
  if (!profile) notFound();

  const { data: { user } } = await supabase.auth.getUser();
  const isOwn = user?.id === profile.id;
  // Liked and Saved are private: only the owner sees those tabs.
  const tab: 'videos' | 'liked' | 'saved' = isOwn && (tabParam === 'liked' || tabParam === 'saved') ? tabParam : 'videos';

  // Total likes this person's videos received.
  const { data: likeRows } = await supabase
    .from('videos')
    .select('likes_count, views_count')
    .eq('author_id', profile.id)
    .eq('status', 'published')
    .limit(1000);
  const totalLikes = ((likeRows ?? []) as { likes_count: number; views_count: number }[]).reduce((sum: number, r: { likes_count: number }) => sum + (r.likes_count || 0), 0);
  const totalViews = ((likeRows ?? []) as { likes_count: number; views_count: number }[]).reduce((sum: number, r: { views_count: number }) => sum + (r.views_count || 0), 0);

  let items: GridItem[] = [];
  if (tab === 'videos') {
    const { data } = await supabase
      .from('videos')
      .select(TILE_COLUMNS)
      .eq('author_id', profile.id)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(60);
    items = (data ?? []) as unknown as GridItem[];
  } else {
    const { data: rows } = await supabase
      .from(tab === 'liked' ? 'likes' : 'saves')
      .select('video_id, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(60);
    const ids = ((rows ?? []) as { video_id: string }[]).map((r: { video_id: string }) => r.video_id);
    if (ids.length > 0) {
      const { data } = await supabase.from('videos').select(TILE_COLUMNS).in('id', ids).eq('status', 'published');
      const byId = new Map(((data ?? []) as unknown as GridItem[]).map((v: GridItem) => [v.id, v] as const));
      items = ids.map((id: string) => byId.get(id)).filter((v: GridItem | undefined): v is GridItem => !!v);
    }
  }

  let following = false;
  if (user && !isOwn) {
    const { data } = await supabase.from('follows').select('follower_id').eq('follower_id', user.id).eq('following_id', profile.id).maybeSingle();
    following = !!data;
  }

  const name = profile.display_name || profile.username;
  const base = `/profile/${profile.username}`;
  const empty = tab === 'videos'
    ? (isOwn ? 'You have not posted yet. Tap + to post your first video.' : 'No videos yet.')
    : tab === 'liked' ? 'Videos you like will show here.' : 'Videos you save will show here.';

  return (
    <div className="page profile pf">
      <div className="pf-top">
        {isOwn ? (
          <Link href="/profile/edit" className="icon-btn" aria-label="Edit profile"><EditIcon size={24} /></Link>
        ) : (
          <span aria-hidden="true" />
        )}
        {isOwn ? (
          <LogoutButton />
        ) : (
          <Link href={`/inbox/${profile.username}`} className="icon-btn" aria-label="Send a message"><InboxIcon size={24} /></Link>
        )}
      </div>

      <header className="pf-head">
        <div className="pf-id">
          <h1>{name}</h1>
          <p className="handle">@{profile.username}</p>
          <ul className="pf-stats">
            <li><b>{compact(profile.following_count)}</b><span>Following</span></li>
            <li><b>{compact(profile.followers_count)}</b><span>{profile.followers_count === 1 ? 'Follower' : 'Followers'}</span></li>
            <li><b>{compact(totalLikes)}</b><span>Likes</span></li>
            <li><b>{compact(totalViews)}</b><span>Views</span></li>
          </ul>
        </div>
        <div className="pf-avatar">
          <Avatar url={profile.avatar_url} name={name} size={96} />
          {isOwn && (
            <Link href="/profile/edit" className="pf-plus" aria-label="Change profile photo"><PlusIcon size={18} /></Link>
          )}
        </div>
      </header>

      {profile.bio ? <p className="pf-bio">{profile.bio}</p> : null}

      {!isOwn && (
        <div className="pf-actions">
          <FollowButton profileId={profile.id} initialFollowing={following} ownId={user?.id ?? null} />
          <Link href={`/inbox/${profile.username}`} className="btn btn-ghost">Message</Link>
        </div>
      )}

      <nav className="pf-tabs" aria-label="Profile sections">
        <Link href={base} className={tab === 'videos' ? 'on' : ''} aria-label="Videos" aria-current={tab === 'videos' ? 'page' : undefined}><GridIcon size={24} /></Link>
        {isOwn && (
          <>
            <Link href={`${base}?tab=liked`} className={tab === 'liked' ? 'on' : ''} aria-label="Liked videos" aria-current={tab === 'liked' ? 'page' : undefined}><HeartIcon size={24} /></Link>
            <Link href={`${base}?tab=saved`} className={tab === 'saved' ? 'on' : ''} aria-label="Saved videos" aria-current={tab === 'saved' ? 'page' : undefined}><BookmarkIcon size={24} /></Link>
          </>
        )}
      </nav>

      {items.length > 0 ? <ProfileGrid items={items} /> : <p className="empty">{empty}</p>}
    </div>
  );
}
