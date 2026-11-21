// Turns a file path in storage into a URL. Every place that needs a video address goes through here,
// so Cloudflare Stream or Mux can replace Supabase Storage later by changing only this file.
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;

export type Bucket = 'videos' | 'thumbnails' | 'avatars';

export function publicUrl(bucket: Bucket, path: string): string {
  const safe = path.split('/').map(encodeURIComponent).join('/');
  return `${BASE}/storage/v1/object/public/${bucket}/${safe}`;
}

// Later: switch on the video's provider ('cloudflare' | 'mux') and return an HLS address instead.
export function videoSrc(v: { video_path: string }): string {
  return publicUrl('videos', v.video_path);
}

export function thumbSrc(v: { thumb_path: string | null }): string | undefined {
  return v.thumb_path ? publicUrl('thumbnails', v.thumb_path) : undefined;
}
