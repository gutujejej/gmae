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

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

// Resolves with the smaller file, or null when it could not be made smaller (then upload the original).
// Rejects only when the person cancels.
export function compressVideo(
  file: File,
  quality: Exclude<Quality, 'original'>,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
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
        if (blob.size === 0 || blob.size >= file.size) { resolve(null); return; }      // not smaller: keep the original
        const name = `${file.name.replace(/\.[^.]+$/, '') || 'video'}.${format.ext}`;
        resolve({ file: new File([blob], name, { type: format.type }), width: w, height: h });
      });

      const draw = () => {
        if (settled) return;
        try { ctx.drawImage(video, 0, 0, w, h); } catch { /* frame not ready yet */ }
        onProgress(Math.min(99, Math.round((video.currentTime / duration) * 100)));
        next();
      };
      const next = () => {
        if (settled) return;
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(draw);
        else frame = requestAnimationFrame(draw);
      };

      video.onended = () => {
        try { ctx.drawImage(video, 0, 0, w, h); } catch { /* ignore */ }
        window.setTimeout(() => {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        }, 300);
      };

      document.addEventListener('visibilitychange', onVisibility);
      timer = window.setTimeout(() => {
        try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
        finish(() => resolve(null));
      }, duration * 3000 + 20000);

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
