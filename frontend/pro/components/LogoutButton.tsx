'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LogoutButton() {
  const router = useRouter();
  const logout = async () => {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  };
  return <button type="button" className="btn btn-ghost" onClick={logout}>Log out</button>;
}
