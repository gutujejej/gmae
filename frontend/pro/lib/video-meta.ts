// Reads a chosen video in the browser: length, size in pixels and a thumbnail.
// The thumbnail is chosen by looking at several frames and keeping the brightest, most detailed one
// (the first frame is often black or blurry).
export type VideoMeta = { duration: number; width: number; height: number; thumb: Blob | null };

function waitFor(video: HTMLVideoElement, event: 'loadedmetadata' | 'seeked', ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener('error', bad);
    };
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('video error')); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('video timeout')); }, ms);
    video.addEventListener(event, ok);
    video.addEventListener('error', bad);
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  const done = waitFor(video, 'seeked', 6000);
  video.currentTime = time;
  return done;
}

// 0 (useless: black or white or flat) .. 1 (bright and full of detail)
function scoreFrame(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    const n = data.length / 4;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    let score = 0.5 * Math.min(mean, 130) / 130 + 0.5 * Math.min(sd, 60) / 60;
    if (mean < 20) score *= 0.1;          // nearly black
    if (mean > 238) score *= 0.4;         // nearly white
    return score;
  } catch {
    return 0;
  }
}

async function bestFrame(video: HTMLVideoElement, duration: number): Promise<Blob | null> {
  const vw = video.videoWidth || 480;
  const vh = video.videoHeight || 480;
  const small = document.createElement('canvas');
  small.width = 48;
  small.height = Math.max(1, Math.round((48 * vh) / vw));
  const sctx = small.getContext('2d', { willReadFrequently: true });

  let bestTime = Math.min(0.1, duration / 2);
  if (sctx) {
    let best = -1;
    for (const fraction of [0.05, 0.15, 0.3, 0.45, 0.6, 0.8]) {
      const t = Math.min(Math.max(duration * fraction, 0.1), Math.max(duration - 0.1, 0.05));
      try { await seek(video, t); } catch { continue; }
      sctx.drawImage(video, 0, 0, small.width, small.height);
      const score = scoreFrame(sctx, small.width, small.height);
      if (score > best) { best = score; bestTime = t; }
    }
  }

  try { await seek(video, bestTime); } catch { /* keep the frame we are on */ }
  try {
    const scale = Math.min(1, 480 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82));
  } catch {
    return null;
  }
}

export async function readVideoMeta(file: File): Promise<VideoMeta> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitFor(video, 'loadedmetadata', 15000);
    let duration = video.duration;
    if (!Number.isFinite(duration)) {                  // some webm recordings only learn their length at the end
      await seek(video, 1e6);
      duration = video.duration;
    }
    if (!Number.isFinite(duration) || !(duration > 0)) throw new Error('no length');
    const width = video.videoWidth;
    const height = video.videoHeight;
    const thumb = await bestFrame(video, duration);
    return { duration, width, height, thumb };
  } catch {
    throw new Error('This video cannot be read. Try another file.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Shrinks a picture (profile photo) to a small square-ish JPEG so it loads fast on slow data.
export function resizeImage(file: File, maxSide = 256): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);                    // centre square crop
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const size = Math.min(maxSide, side);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return reject(new Error('Could not read this picture.')); }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        blob ? resolve(blob) : reject(new Error('Could not read this picture.'));
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this picture.')); };
    img.src = url;
  });
}
