import { notFound } from 'next/navigation';
import ChatThread from '@/components/ChatThread';
import { createClient } from '@/lib/supabase/server';

type Params = { params: Promise<{ username: string }> };

export default async function ChatPage({ params }: Params) {
  const { username } = await params;
  let handle = username;
  try { handle = decodeURIComponent(username); } catch { /* keep the raw text */ }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound(); // the middleware already sends signed-out visitors to the login page

  const { data: other } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .eq('username', handle.toLowerCase())
    .maybeSingle();
  if (!other || other.id === user.id) notFound();

  return (
    <ChatThread
      me={user.id}
      other={{ id: other.id, username: other.username, display_name: other.display_name, avatar_url: other.avatar_url }}
    />
  );
}
