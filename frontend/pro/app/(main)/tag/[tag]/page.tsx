import Link from 'next/link';
import ProfileGrid, { type GridItem } from '@/components/ProfileGrid';
import { BackIcon } from '@/components/Icons';
import { compact } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

type Params = { params: Promise<{ tag: string }> };

const TILE_COLUMNS = 'id, thumb_path, video_path, likes_count, views_count, caption';

function cleanTag(raw: string): string {
  let t = raw;
  try { t = decodeURIComponent(raw); } catch { /* keep the raw text */ }
  return t.replace(/^#/, '').toLowerCase();
}

export async function generateMetadata({ params }: Params) {
  const { tag } = await params;
  return { title: `#${cleanTag(tag)}` };
}

// Every video that uses one hashtag (the page a tapped #hashtag opens).
export default async function TagPage({ params }: Params) {
  const { tag: raw } = await params;
  const tag = cleanTag(raw);
  const supabase = await createClient();

  // Plain queries, one after the other (same style as the video page).
  const { data: row } = await supabase.from('hashtags').select('id, tag').eq('tag', tag).maybeSingle();

  let items: GridItem[] = [];
  if (row) {
    const { data: links } = await supabase.from('video_hashtags').select('video_id').eq('hashtag_id', row.id).limit(200);
    const ids = ((links ?? []) as { video_id: string }[]).map((l: { video_id: string }) => l.video_id);
    if (ids.length > 0) {
      const { data } = await supabase
        .from('videos')
        .select(TILE_COLUMNS)
        .in('id', ids)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(60);
      items = (data ?? []) as unknown as GridItem[];
    }
  }

  const views = items.reduce((sum: number, v: GridItem) => sum + (v.views_count || 0), 0);

  return (
    <div className="page">
      <Link href="/search" className="icon-btn" aria-label="Back"><BackIcon size={26} /></Link>
      <header className="tag-head">
        <h1>#{tag}</h1>
        <p className="hint">{items.length === 1 ? '1 video' : `${compact(items.length)} videos`}{items.length > 0 ? ` · ${compact(views)} views` : ''}</p>
      </header>
      {items.length > 0 ? <ProfileGrid items={items} /> : <p className="empty">No videos with this hashtag yet.</p>}
    </div>
  );
}
