// Shrinks a video on the phone before it is uploaded: smaller picture (480p / 720p / 1080p) and a lower bitrate.
// It plays the video once into a canvas and records the canvas with the phone's own video encoder.
// No server and no extra library. It takes about as long as the video itself.
export type Quality = 'saver' | 'balanced' | 'high' | 'original';

const PRESETS = {
  saver: { short: 480, video: 900_000, audio: 64_000 },
  balanced: { short: 720, video: 1_800_000, audio: 96_000 },
  high: { short: 1080, video: 3_500_000, audio: 128_000 },
} as const;

export const QUALITY_OPTIONS: { id: Quality; label: string; hint: string }[] = [
  { id: 'saver', label: 'Data saver', hint: '480p · smallest' },
  { id: 'balanced', label: 'Balanced', hint: '720p · recommended' },
  { id: 'high', label: 'High', hint: '1080p · sharper' },
  { id: 'original', label: 'Original', hint: 'no compression' },
];

// Rough size after compression (the real size depends on the picture).
export function estimateBytes(quality: Quality, seconds: number, originalBytes: number): number {
  if (quality === 'original') return originalBytes;
  const p = PRESETS[quality];
  return Math.min(originalBytes, Math.round((seconds * (p.video + p.audio)) / 8));
}

const FORMATS = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', type: 'video/mp4', ext: 'mp4' },
  { mime: 'video/mp4', type: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', type: 'video/webm', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', type: 'video/webm', ext: 'webm' },
  { mime: 'video/webm', type: 'video/webm', ext: 'webm' },
];

function pickFormat() {
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? null;
}

export function canCompress(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickFormat() !== null
  );
}

export type Compressed = { file: File; width: number; height: number };

// Edits applied while the video is re-recorded (trim, look, caption, sound).
export type FilterId = 'none' | 'vivid' | 'mono' | 'warm' | 'fade' | 'vintage' | 'drama';
export type TextPos = 'top' | 'middle' | 'bottom';
export type EditOptions = { start: number; end: number; filter: FilterId; text: string; textPos: TextPos; muted: boolean };

// br = brightness, co = contrast, sa = saturation, se = sepia (the same four numbers drive the preview and the saved video)
export const FILTERS: { id: FilterId; label: string; br: number; co: number; sa: number; se: number }[] = [
  { id: 'none', label: 'Normal', br: 1, co: 1, sa: 1, se: 0 },
  { id: 'vivid', label: 'Vivid', br: 1.05, co: 1.15, sa: 1.4, se: 0 },
  { id: 'mono', label: 'Mono', br: 1, co: 1.1, sa: 0, se: 0 },
  { id: 'warm', label: 'Warm', br: 1.05, co: 1.05, sa: 1.1, se: 0.25 },
  { id: 'fade', label: 'Fade', br: 1.1, co: 0.85, sa: 0.8, se: 0 },
  { id: 'vintage', label: 'Vintage', br: 0.95, co: 1.1, sa: 0.8, se: 0.45 },
  { id: 'drama', label: 'Drama', br: 0.9, co: 1.35, sa: 1.1, se: 0 },
];

export function filterCss(id: FilterId): string {
  const f = FILTERS.find((x) => x.id === id) ?? FILTERS[0];
  return id === 'none' ? 'none' : `brightness(${f.br}) contrast(${f.co}) saturate(${f.sa}) sepia(${f.se})`;
}

// Some phones (older Safari) cannot filter a canvas; for those the filter is applied pixel by pixel.
function canvasFilterWorks(ctx: CanvasRenderingContext2D): boolean {
  try { ctx.filter = 'grayscale(1)'; const ok = ctx.filter === 'grayscale(1)'; ctx.filter = 'none'; return ok; } catch { return false; }
}

function filterPixels(ctx: CanvasRenderingContext2D, w: number, h: number, id: FilterId) {
  const f = FILTERS.find((x) => x.id === id);
  if (!f) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * f.sa; g = l + (g - l) * f.sa; b = l + (b - l) * f.sa;
    if (f.se > 0) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * f.se; g += (sg - g) * f.se; b += (sb - b) * f.se;
    }
    d[i] = (r * f.br - 128) * f.co + 128;
    d[i + 1] = (g * f.br - 128) * f.co + 128;
    d[i + 2] = (b * f.br - 128) * f.co + 128;
  }
  ctx.putImageData(img, 0, 0);
}

function drawCaption(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, pos: TextPos) {
  const size = Math.round(h * 0.055);
  ctx.font = `800 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size / 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#fff';
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > w * 0.86) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  const lh = size * 1.2;
  const block = lh * lines.length;
  const cy = pos === 'top' ? h * 0.14 + block / 2 : pos === 'middle' ? h / 2 : h * 0.8 - block / 2;
  lines.forEach((ln, i) => {
    const y = cy - block / 2 + lh * (i + 0.5);
    ctx.strokeText(ln, w / 2, y);
    ctx.fillText(ln, w / 2, y);
  });
}

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

// Resolves with the smaller file, or null when it could not be made smaller (then upload the original).
// When `edit` is given the result is returned even if it is not smaller, because the edits must be kept.
// Rejects only when the person cancels.
export function compressVideo(
  file: File,
  quality: Exclude<Quality, 'original'>,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
  edit?: EditOptions,
): Promise<Compressed | null> {
  return new Promise((resolve, reject) => {
    const format = canCompress() ? pickFormat() : null;
    if (!format) { resolve(null); return; }
    const preset = PRESETS[quality];

    const url = URL.createObjectURL(file);
    const video = document.createElement('video') as FrameVideo;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;                       // not muted: the sound is read through WebAudio and never reaches the speaker

    let recorder: MediaRecorder | null = null;
    let audioCtx: AudioContext | null = null;
    let frame = 0;
    let timer = 0;
    let settled = false;
    const chunks: Blob[] = [];

    const onVisibility = () => {
      if (!recorder || recorder.state === 'inactive') return;
      if (document.hidden) {
        video.pause();
        if (recorder.state === 'recording') recorder.pause();
      } else {
        if (recorder.state === 'paused') recorder.resume();
        video.play().catch(() => undefined);
      }
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      signal.removeEventListener('abort', onAbort);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      audioCtx?.close().catch(() => undefined);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    function onAbort() {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
      finish(() => reject(new Error('Cancelled.')));
    }
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);

    video.onerror = () => finish(() => resolve(null));
    video.onloadedmetadata = async () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const duration = video.duration;
      if (!vw || !vh || !Number.isFinite(duration) || duration <= 0) { finish(() => resolve(null)); return; }

      const scale = Math.min(1, preset.short / Math.min(vw, vh));
      const w = Math.max(2, Math.round((vw * scale) / 2) * 2);
      const h = Math.max(2, Math.round((vh * scale) / 2) * 2);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { finish(() => resolve(null)); return; }

      const stream = canvas.captureStream(30);
      try {
        if (edit?.muted) { video.muted = true; throw new Error('muted'); }
        audioCtx = new AudioContext();
        await audioCtx.resume();
        const source = audioCtx.createMediaElementSource(video);
        const sink = audioCtx.createMediaStreamDestination();
        source.connect(sink);
        sink.stream.getAudioTracks().forEach((track: MediaStreamTrack) => stream.addTrack(track));
      } catch { /* no sound track: the picture is still compressed */ }

      try {
        recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: preset.video, audioBitsPerSecond: preset.audio });
      } catch {
        finish(() => resolve(null));
        return;
      }
      recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = () => finish(() => resolve(null));
      recorder.onstop = () => finish(() => {
        const blob = new Blob(chunks, { type: format.type });
        if (blob.size === 0 || (!edit && blob.size >= file.size)) { resolve(null); return; }      // not smaller: keep the original
        const name = `${file.name.replace(/\.[^.]+$/, '') || 'video'}.${format.ext}`;
        resolve({ file: new File([blob], name, { type: format.type }), width: w, height: h });
      });

      const start = edit ? Math.max(0, Math.min(edit.start, duration - 0.5)) : 0;
      const end = edit ? Math.min(duration, Math.max(edit.end, start + 0.5)) : duration;
      const look: FilterId = edit?.filter ?? 'none';
      const liveFilter = look !== 'none' && canvasFilterWorks(ctx);
      const paint = () => {
        ctx.filter = liveFilter ? filterCss(look) : 'none';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
        if (look !== 'none' && !liveFilter) filterPixels(ctx, w, h, look);
        if (edit?.text.trim()) drawCaption(ctx, w, h, edit.text.trim(), edit.textPos);
      };
      let stopping = false;
      const stopSoon = () => {
        if (stopping) return;
        stopping = true;
        video.pause();
        try { paint(); } catch { /* ignore */ }
        window.setTimeout(() => {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        }, 300);
      };
      const draw = () => {
        if (settled || stopping) return;
        try { paint(); } catch { /* frame not ready yet */ }
        if (video.currentTime >= end - 0.03) { stopSoon(); return; }
        onProgress(Math.min(99, Math.round(((video.currentTime - start) / (end - start)) * 100)));
        next();
      };
      const next = () => {
        if (settled) return;
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(draw);
        else frame = requestAnimationFrame(draw);
      };

      video.onended = stopSoon;

      document.addEventListener('visibilitychange', onVisibility);
      timer = window.setTimeout(() => {
        try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
        finish(() => resolve(null));
      }, (end - start) * 3000 + 20000);

      if (start > 0.05) {                                    // jump to the trim start before recording
        await new Promise<void>((done) => {
          const t = window.setTimeout(done, 4000);
          video.onseeked = () => { window.clearTimeout(t); done(); };
          video.currentTime = start;
        });
        video.onseeked = null;
      }

      recorder.start(1000);
      try {
        await video.play();
      } catch {
        try { recorder.stop(); } catch { /* ignore */ }
        finish(() => resolve(null));
        return;
      }
      next();
    };
  });
}
