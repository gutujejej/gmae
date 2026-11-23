'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, FlagIcon, TrashIcon } from '@/components/Icons';
import { createClient } from '@/lib/supabase/client';
import type { FeedVideo } from '@/lib/types';

const REASONS = [
  'Spam or scam',
  'Nudity or sexual content',
  'Violence or dangerous acts',
  'Hate or harassment',
  'Stolen or copyrighted content',
  'Something else',
];

type Step = 'menu' | 'confirm' | 'report' | 'thanks';

// "…" menu of a video: the owner can delete it, everyone else can report it.
export default function VideoMenu({ video, ownId, onClose, onDeleted, needLogin }: {
  video: FeedVideo;
  ownId: string | null;
  onClose: () => void;
  onDeleted?: (video: FeedVideo) => void;
  needLogin: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const isOwn = ownId === video.author_id;
  const [step, setStep] = useState<Step>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    if (!ownId) return;
    setBusy(true);
    setError('');
    // .select() returns the deleted row, so "nothing was deleted" (not allowed) is not mistaken for success
    const { data, error: e } = await supabase.from('videos').delete().eq('id', video.id).eq('author_id', ownId).select('id');
    if (e || !data || data.length === 0) {
      setError('Could not delete this video. Try again.');
      setBusy(false);
      return;
    }
    await supabase.storage.from('videos').remove([video.video_path]);                         // free the storage too
    if (video.thumb_path) await supabase.storage.from('thumbnails').remove([video.thumb_path]);
    onDeleted?.(video);
    onClose();
  };

  const report = async (reason: string) => {
    if (!ownId) { onClose(); needLogin(); return; }
    setBusy(true);
    setError('');
    const { error: e } = await supabase.from('reports').insert({ reporter_id: ownId, target_type: 'video', target_id: video.id, reason });
    setBusy(false);
    if (e) { setError('Could not send your report. Try again.'); return; }
    setStep('thanks');
  };

  return createPortal(
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet menu" role="dialog" aria-modal="true" aria-label="Video options" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <span>{step === 'report' ? 'Why are you reporting this?' : step === 'confirm' ? 'Delete video?' : step === 'thanks' ? 'Thank you' : 'Options'}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon size={22} /></button>
        </header>

        <div className="menu-body">
          {step === 'menu' && (isOwn
            ? (
              <button type="button" className="menu-item danger" onClick={() => setStep('confirm')}>
                <TrashIcon size={22} /> Delete video
              </button>
            )
            : (
              <button type="button" className="menu-item" onClick={() => (ownId ? setStep('report') : (onClose(), needLogin()))}>
                <FlagIcon size={22} /> Report
              </button>
            ))}

          {step === 'confirm' && (
            <>
              <p className="hint">This removes the video, its likes and comments for good. It cannot be undone.</p>
              <div className="row">
                <button type="button" className="btn btn-ghost" onClick={() => setStep('menu')} disabled={busy}>Keep it</button>
                <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
              </div>
            </>
          )}

          {step === 'report' && REASONS.map((r) => (
            <button key={r} type="button" className="menu-item" onClick={() => report(r)} disabled={busy}>{r}</button>
          ))}

          {step === 'thanks' && (
            <>
              <p className="hint">Your report was sent. We will review this video.</p>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Done</button>
            </>
          )}

          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
