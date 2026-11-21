'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import CommentsSheet from '@/components/CommentsSheet';
import Toast from '@/components/Toast';
import VideoCard from '@/components/VideoCard';
import { useToast } from '@/lib/useToast';
import { useVideoActions } from '@/lib/useVideoActions';
import type { FeedVideo } from '@/lib/types';

// One video on its own page (the page a shared link opens).
export default function SingleVideo({ initial, userId }: { initial: FeedVideo; userId: string | null }) {
  const [video, setVideo] = useState(initial);
  const [muted, setMuted] = useState(true);
  const [comments, setComments] = useState(false);
  const { text, show } = useToast();

  const patch = useCallback((_id: string, change: Partial<FeedVideo>) => setVideo((v) => ({ ...v, ...change })), []);
  const setFollow = useCallback((_authorId: string, following: boolean) => setVideo((v) => ({ ...v, following })), []);
  const actions = useVideoActions({ userId, patch, setFollow, toast: show });

  return (
    <div className="single">
      <Link href="/feed" className="back">← Feed</Link>
      <VideoCard
        video={video}
        active
        shouldLoad
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        ownId={userId}
        actions={actions}
        onOpenComments={() => setComments(true)}
      />
      {comments && (
        <CommentsSheet
          video={video}
          userId={userId}
          onClose={() => setComments(false)}
          onCount={(change) => patch(video.id, { comments_count: Math.max(0, video.comments_count + change) })}
          needLogin={actions.needLogin}
        />
      )}
      <Toast text={text} />
    </div>
  );
}
