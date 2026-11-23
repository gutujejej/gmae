'use client';

import Link from 'next/link';
import SmartThumb from '@/components/SmartThumb';
import { compact } from '@/lib/format';
import { savePlaylist } from '@/lib/local-store';

export type GridItem = {
  id: string;
  thumb_path: string | null;
  video_path: string;
  likes_count: number;
  caption: string | null;
};

// Three-across video tiles. Tapping one plays it, and swiping up goes on through the rest of the tiles.
export default function ProfileGrid({ items }: { items: GridItem[] }) {
  return (
    <ul className="pgrid">
      {items.map((v: GridItem) => (
        <li key={v.id}>
          <Link
            href={`/v/${v.id}`}
            aria-label={v.caption ? `Open video: ${v.caption}` : 'Open video'}
            onClick={() => savePlaylist(items.map((x: GridItem) => x.id))}
          >
            <SmartThumb video={v} />
            <span className="grid-likes">♥ {compact(v.likes_count)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
