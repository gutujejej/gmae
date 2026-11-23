'use client';

import { useRef, useState } from 'react';
import { FILTERS, filterCss, type EditOptions, type TextPos } from '@/lib/compress';

type Tab = 'trim' | 'look' | 'text' | 'sound';

const TABS: { id: Tab; label: string }[] = [
  { id: 'trim', label: 'Trim' },
  { id: 'look', label: 'Look' },
  { id: 'text', label: 'Text' },
  { id: 'sound', label: 'Sound' },
];

const POSITIONS: { id: TextPos; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'middle', label: 'Middle' },
  { id: 'bottom', label: 'Bottom' },
];

const MIN_CLIP = 1;                                  // seconds left after trimming

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Preview + editing tools shown after a video is chosen. It only changes the `value` it is given;
// the real trimming, look and text are applied when the video is compressed (lib/compress.ts).
export default function VideoEditor({ src, duration, value, onChange, disabled }: {
  src: string;
  duration: number;
  value: EditOptions;
  onChange: (next: EditOptions) => void;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('trim');
  const player = useRef<HTMLVideoElement>(null);
  const min = Math.min(MIN_CLIP, duration);
  const left = (value.start / duration) * 100;
  const right = (value.end / duration) * 100;

  const setStart = (v: number) => {
    const start = Math.min(v, value.end - min);
    onChange({ ...value, start });
    if (player.current) player.current.currentTime = start;
  };
  const setEnd = (v: number) => {
    const end = Math.max(v, value.start + min);
    onChange({ ...value, end });
    if (player.current) player.current.currentTime = Math.max(value.start, end - 0.5);
  };

  // keep the preview playing only inside the part that will be kept
  const onTime = () => {
    const v = player.current;
    if (!v) return;
    if (v.currentTime >= value.end - 0.05 || v.currentTime < value.start - 0.3) v.currentTime = value.start;
  };

  return (
    <div className="editor">
      <div className="stage">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={player} src={src} controls playsInline muted loop style={{ filter: filterCss(value.filter) }} onTimeUpdate={onTime} />
        {value.text.trim() && (
          <div className="stage-text" aria-hidden="true">
            <span className={`pos-${value.textPos}`}>{value.text}</span>
          </div>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Edit tools">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab on' : 'tab'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'trim' && (
        <div className="panel">
          <div className="trim">
            <div className="trim-track" />
            <div className="trim-range" style={{ left: `${left}%`, right: `${100 - right}%` }} />
            <input type="range" min={0} max={duration} step={0.1} value={value.start} disabled={disabled} aria-label="Start" onChange={(e) => setStart(Number(e.target.value))} />
            <input type="range" min={0} max={duration} step={0.1} value={value.end} disabled={disabled} aria-label="End" onChange={(e) => setEnd(Number(e.target.value))} />
          </div>
          <p className="hint trim-info">{clock(value.start)} – {clock(value.end)} · {Math.round(value.end - value.start)}s</p>
        </div>
      )}

      {tab === 'look' && (
        <div className="panel looks" role="radiogroup" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={value.filter === f.id} className={value.filter === f.id ? 'look on' : 'look'} disabled={disabled} onClick={() => onChange({ ...value, filter: f.id })}>
              <span className="swatch" style={{ filter: filterCss(f.id) }} />
              <small>{f.label}</small>
            </button>
          ))}
        </div>
      )}

      {tab === 'text' && (
        <div className="panel">
          <label className="field">
            <span>Text on video</span>
            <input value={value.text} maxLength={60} disabled={disabled} placeholder="Type something…" onChange={(e) => onChange({ ...value, text: e.target.value })} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Text position">
            {POSITIONS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={value.textPos === p.id} className={value.textPos === p.id ? 'segopt on' : 'segopt'} disabled={disabled} onClick={() => onChange({ ...value, textPos: p.id })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'sound' && (
        <div className="panel">
          <button type="button" role="switch" aria-checked={!value.muted} className={value.muted ? 'switch' : 'switch on'} disabled={disabled} onClick={() => onChange({ ...value, muted: !value.muted })}>
            <span>Original sound</span>
            <i />
          </button>
        </div>
      )}
    </div>
  );
}
