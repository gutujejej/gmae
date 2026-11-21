'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeNext } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';

function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return 'Wrong email or password.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'This email already has an account. Log in instead.';
  if (m.includes('email not confirmed')) return 'Confirm your email first, then log in.';
  if (m.includes('password')) return 'Use a password with at least 8 characters.';
  if (m.includes('rate limit')) return 'Too many tries. Wait a few minutes and try again.';
  return 'Something went wrong. Try again.';
}

export function LoginForm() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) { setError(friendly(err.message)); return; }
    router.push(next);
    router.refresh();
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>Welcome back</h1>
      <label className="field">
        <span>Email</span>
        <input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      <p className="form-note">New here? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></p>
    </form>
  );
}

export function SignupForm() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    const name = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(name)) { setError('Username: 3 to 24 letters, numbers or underscores.'); return; }
    if (password.length < 8) { setError('Use a password with at least 8 characters.'); return; }
    setBusy(true);
    const { data: taken } = await supabase.from('profiles').select('id').eq('username', name).maybeSingle();
    if (taken) { setBusy(false); setError('That username is taken. Try another.'); return; }
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { username: name, display_name: displayName.trim() }, emailRedirectTo: `${window.location.origin}/pro/login` },
    });
    setBusy(false);
    if (err) { setError(friendly(err.message)); return; }
    if (data.session) { router.push(next); router.refresh(); return; }
    setInfo('Check your email to confirm your account, then log in.');
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>Create your account</h1>
      <label className="field">
        <span>Username</span>
        <input autoComplete="username" autoCapitalize="none" required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="yourname" />
      </label>
      <label className="field">
        <span>Display name (optional)</span>
        <input autoComplete="name" maxLength={50} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {info && <p className="info" role="status">{info}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Sign up'}</button>
      <p className="form-note">Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in</Link></p>
    </form>
  );
}
