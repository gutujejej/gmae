import { notFound } from 'next/navigation';
import SingleVideo from '@/components/SingleVideo';
import { thumbSrc } from '@/lib/media';
import { createClient } from '@/lib/supabase/server';
import type { FeedVideo } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, author_id, caption, video_path, thumb_path, duration_seconds, width, height, series_id, series_part, likes_count, comments_count, saves_count, created_at, author:profiles(username, display_name, avatar_url)';

type Author = { username: string; display_name: string; avatar_url: string | null };

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  if (!ID.test(id)) return { title: 'Video' };
  const supabase = await createClient();
  const { data } = await supabase.from('videos').select('caption, thumb_path, author:profiles(username)').eq('id', id).maybeSingle();
  if (!data) return { title: 'Video' };
  const author = (Array.isArray(data.author) ? data.author[0] : data.author) as { username: string } | null;
  const image = thumbSrc(data);
  return {
    title: author ? `@${author.username}` : 'Video',
    description: data.caption || 'Watch on pro',
    openGraph: { title: author ? `@${author.username} on pro` : 'pro', description: data.caption || 'Watch on pro', images: image ? [image] : [] },
  };
}

export default async function VideoPage({ params }: Params) {
  const { id } = await params;
  if (!ID.test(id)) notFound();
  const supabase = await createClient();

  const { data: v } = await supabase.from('videos').select(COLUMNS).eq('id', id).maybeSingle();
  if (!v) notFound();
  const author = (Array.isArray(v.author) ? v.author[0] : v.author) as Author | null;
  if (!author) notFound();

  const { data: { user } } = await supabase.auth.getUser();
  let liked = false;
  let saved = false;
  let following = false;
  if (user) {
    const [l, s, f] = await Promise.all([
      supabase.from('likes').select('video_id').eq('user_id', user.id).eq('video_id', id).maybeSingle(),
      supabase.from('saves').select('video_id').eq('user_id', user.id).eq('video_id', id).maybeSingle(),
      supabase.from('follows').select('follower_id').eq('follower_id', user.id).eq('following_id', v.author_id).maybeSingle(),
    ]);
    liked = !!l.data;
    saved = !!s.data;
    following = !!f.data;
  }

  const video: FeedVideo = {
    id: v.id,
    author_id: v.author_id,
    caption: v.caption,
    video_path: v.video_path,
    thumb_path: v.thumb_path,
    duration_seconds: v.duration_seconds,
    width: v.width,
    height: v.height,
    series_id: v.series_id,
    series_part: v.series_part,
    likes_count: v.likes_count,
    comments_count: v.comments_count,
    saves_count: v.saves_count,
    created_at: v.created_at,
    username: author.username,
    display_name: author.display_name,
    avatar_url: author.avatar_url,
    liked,
    saved,
    following,
    score: 0,
  };

  return <SingleVideo initial={video} userId={user?.id ?? null} />;
}
