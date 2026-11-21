'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

type Props = { profileId: string; initialFollowing: boolean; ownId: string | null };

export default function FollowButton({ profileId, initialFollowing, ownId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (!ownId) {
      router.push(`/login?next=${encodeURIComponent(pathname || '/feed')}`);
      return;
    }
    const supabase = createClient();
    const next = !following;
    setBusy(true);
    setFollowing(next);
    const { error } = next
      ? await supabase.from('follows').insert({ follower_id: ownId, following_id: profileId })
      : await supabase.from('follows').delete().eq('follower_id', ownId).eq('following_id', profileId);
    setBusy(false);
    if (error && !(next && error.code === '23505')) setFollowing(!next);
    else router.refresh();                       // updates the follower numbers on the page
  };

  return (
    <button type="button" className={following ? 'btn btn-ghost' : 'btn btn-primary'} onClick={toggle} disabled={busy} aria-pressed={following}>
      {following ? 'Following' : 'Follow'}
    </button>
  );
}
