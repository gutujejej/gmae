'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { uploadWithProgress } from '@/lib/upload';
import { readVideoMeta, type VideoMeta } from '@/lib/video-meta';
import { useSession } from '@/lib/useSession';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SECONDS = 60;
const TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

// Phones sometimes leave the type empty, so fall back to the file ending.
function mimeOf(file: File): string | null {
  if (TYPES.includes(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  return null;
}

export default function UploadForm() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { user, ready } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const abort = useRef<(() => void) | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';                         // lets the same file be chosen again
    setError('');
    setFile(null);
    setMeta(null);
    setPreview(null);
    if (!picked) return;
    if (!mimeOf(picked)) { setError('Choose an mp4, mov or webm video.'); return; }
    if (picked.size > MAX_BYTES) { setError(`That video is ${(picked.size / 1048576).toFixed(1)} MB. The limit is 50 MB.`); return; }
    setChecking(true);
    try {
      const m = await readVideoMeta(picked);
      if (m.duration > MAX_SECONDS + 0.5) { setError(`That video is ${Math.round(m.duration)} seconds. The limit is 60 seconds.`); return; }
      setFile(picked);
      setMeta(m);
      setPreview(URL.createObjectURL(picked));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This video cannot be read.');
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (!file || !meta || !user) return;
    setBusy(true);
    setError('');
    setProgress(0);
    const uploaded: { bucket: 'videos' | 'thumbnails'; path: string }[] = [];
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Please log in again.');
      const mime = mimeOf(file)!;
      const ext = mime === 'video/webm' ? 'webm' : mime === 'video/quicktime' ? 'mov' : 'mp4';
      const id = crypto.randomUUID();

      let thumbPath: string | null = null;
      if (meta.thumb) {
        thumbPath = `${user.id}/${id}.jpg`;
        await uploadWithProgress({ bucket: 'thumbnails', path: thumbPath, file: meta.thumb, contentType: 'image/jpeg', token: session.access_token }).promise;
        uploaded.push({ bucket: 'thumbnails', path: thumbPath });
      }

      const videoPath = `${user.id}/${id}.${ext}`;
      const up = uploadWithProgress({ bucket: 'videos', path: videoPath, file, contentType: mime, token: session.access_token, onProgress: setProgress });
      abort.current = up.abort;
      await up.promise;
      abort.current = null;
      uploaded.push({ bucket: 'videos', path: videoPath });

      const { error: insertError } = await supabase.from('videos').insert({
        author_id: user.id,
        caption: caption.trim(),
        video_path: videoPath,
        thumb_path: thumbPath,
        duration_seconds: Math.round(meta.duration * 100) / 100,
        size_bytes: file.size,
        width: meta.width || null,
        height: meta.height || null,
      });
      if (insertError) throw new Error('Could not save your video. Try again.');
      router.push('/feed');
      router.refresh();
    } catch (err) {
      for (const u of uploaded) await supabase.storage.from(u.bucket).remove([u.path]);   // do not leave half uploads behind
      setError(err instanceof Error ? err.message : 'The upload failed.');
      setProgress(null);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  if (ready && !user) return <p className="form-note">Log in to upload a video.</p>;

  return (
    <div className="form">
      <h1>New video</h1>

      {!file && (
        <div className="pick">
          <label className="btn btn-primary">
            Choose a video
            <input type="file" accept="video/mp4,video/quicktime,video/webm,video/*" hidden onChange={onPick} disabled={busy || checking} />
          </label>
          <label className="btn btn-ghost">
            Record a video
            <input type="file" accept="video/*" capture="user" hidden onChange={onPick} disabled={busy || checking} />
          </label>
          <p className="hint">Up to 60 seconds and 50 MB. mp4, mov or webm.</p>
        </div>
      )}
      {checking && <p className="hint" role="status">Checking your video…</p>}

      {file && meta && preview && (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video className="preview" src={preview} controls playsInline muted />
          <p className="hint">{Math.round(meta.duration)} seconds · {(file.size / 1048576).toFixed(1)} MB</p>
          <label className="field">
            <span>Caption</span>
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} rows={3} placeholder="Say something. Add #hashtags" disabled={busy} />
            <small>{caption.length}/300</small>
          </label>
        </>
      )}

      {progress !== null && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Upload progress">
          <span style={{ width: `${progress}%` }} />
          <b>{progress}%</b>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {file && (
        <div className="row">
          {busy
            ? <button type="button" className="btn btn-ghost" onClick={() => abort.current?.()}>Cancel</button>
            : <button type="button" className="btn btn-ghost" onClick={() => { setFile(null); setMeta(null); setPreview(null); setProgress(null); }}>Change video</button>}
          <button type="button" className="btn btn-saffron" onClick={submit} disabled={busy}>{busy ? 'Uploading…' : 'Post'}</button>
        </div>
      )}
    </div>
  );
}
