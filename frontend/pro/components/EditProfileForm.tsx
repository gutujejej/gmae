'use client';

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from '@/components/Avatar';
import { publicUrl } from '@/lib/media';
import { createClient } from '@/lib/supabase/client';
import { uploadWithProgress } from '@/lib/upload';
import { useSession } from '@/lib/useSession';
import { resizeImage } from '@/lib/video-meta';

export default function EditProfileForm() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { user, ready } = useSession();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    supabase.from('profiles').select('username, display_name, bio, avatar_url').eq('id', user.id).maybeSingle().then(({ data }) => {
      if (!alive || !data) return;
      setUsername(data.username);
      setDisplayName(data.display_name);
      setBio(data.bio);
      setAvatarUrl(data.avatar_url);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [supabase, user]);

  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

  const onAvatar = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Choose a picture (jpg, png or webp).'); return; }
    setError('');
    setAvatarFile(f);
    setAvatarPreview(URL.createObjectURL(f));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError('');
    const name = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(name)) { setError('Username: 3 to 24 letters, numbers or underscores.'); return; }
    setBusy(true);
    try {
      let url = avatarUrl;
      if (avatarFile) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Please log in again.');
        const blob = await resizeImage(avatarFile, 256);
        const path = `${user.id}/avatar-${Date.now()}.jpg`;
        await uploadWithProgress({ bucket: 'avatars', path, file: blob, contentType: 'image/jpeg', token: session.access_token }).promise;
        url = publicUrl('avatars', path);
      }
      const { error: err } = await supabase.from('profiles')
        .update({ username: name, display_name: displayName.trim(), bio: bio.trim(), avatar_url: url })
        .eq('id', user.id);
      if (err) throw new Error(err.code === '23505' ? 'That username is taken. Try another.' : 'Could not save your profile. Try again.');
      router.push(`/profile/${name}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  };

  if (ready && !user) return <p className="form-note">Log in to edit your profile.</p>;
  if (!loaded) return <p className="hint">Loading…</p>;

  return (
    <form className="form" onSubmit={save}>
      <h1>Edit profile</h1>
      <div className="avatar-edit">
        <Avatar url={avatarPreview ?? avatarUrl} name={displayName || username} size={88} />
        <label className="btn btn-ghost">
          Change photo
          <input type="file" accept="image/*" hidden onChange={onAvatar} />
        </label>
      </div>
      <label className="field">
        <span>Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" maxLength={24} required />
      </label>
      <label className="field">
        <span>Display name</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={50} />
      </label>
      <label className="field">
        <span>Bio</span>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} rows={3} />
        <small>{bio.length}/200</small>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
