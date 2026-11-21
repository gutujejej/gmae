import Link from 'next/link';
import { notFound } from 'next/navigation';
import Avatar from '@/components/Avatar';
import FollowButton from '@/components/FollowButton';
import LogoutButton from '@/components/LogoutButton';
import { compact } from '@/lib/format';
import { thumbSrc } from '@/lib/media';
import { createClient } from '@/lib/supabase/server';

type Params = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Params) {
  const { username } = await params;
  return { title: `@${username}` };
}

export default async function ProfilePage({ params }: Params) {
  const { username } = await params;
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

  const { data: videos } = await supabase
    .from('videos')
    .select('id, thumb_path, likes_count, caption')
    .eq('author_id', profile.id)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(60);

  let following = false;
  if (user && !isOwn) {
    const { data } = await supabase.from('follows').select('follower_id').eq('follower_id', user.id).eq('following_id', profile.id).maybeSingle();
    following = !!data;
  }

  return (
    <div className="page profile">
      <header className="profile-head">
        <Avatar url={profile.avatar_url} name={profile.display_name || profile.username} size={96} />
        <h1>{profile.display_name || profile.username}</h1>
        <p className="handle">@{profile.username}</p>
        <ul className="stats">
          <li><b>{compact(profile.following_count)}</b> following</li>
          <li><b>{compact(profile.followers_count)}</b> followers</li>
          <li><b>{compact(profile.videos_count)}</b> videos</li>
        </ul>
        {profile.bio ? <p className="bio">{profile.bio}</p> : null}
        <div className="row">
          {isOwn ? (
            <>
              <Link href="/profile/edit" className="btn btn-ghost">Edit profile</Link>
              <LogoutButton />
            </>
          ) : (
            <FollowButton profileId={profile.id} initialFollowing={following} ownId={user?.id ?? null} />
          )}
        </div>
      </header>

      {videos && videos.length > 0 ? (
        <ul className="grid">
          {videos.map((v) => {
            const src = thumbSrc(v);
            return (
              <li key={v.id}>
                <Link href={`/v/${v.id}`} aria-label={v.caption ? `Open video: ${v.caption}` : 'Open video'}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt="" loading="lazy" /> : <span className="grid-empty" />}
                  <span className="grid-likes">♥ {compact(v.likes_count)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty">{isOwn ? 'You have not posted yet.' : 'No videos yet.'}</p>
      )}
    </div>
  );
}
