// Reads a chosen video in the browser: length, size in pixels and a thumbnail from the first frame.
export type VideoMeta = { duration: number; width: number; height: number; thumb: Blob | null };

export function readVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    let duration = 0;
    let phase: 'probe' | 'frame' = 'frame';
    let finished = false;
    const end = (fn: () => void) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      fn();
    };
    const fail = () => end(() => reject(new Error('This video cannot be read. Try another file.')));
    const timer = window.setTimeout(fail, 15000);

    const grabFrame = () => {
      try {
        const scale = Math.min(1, 480 / (video.videoWidth || 480));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return end(() => resolve({ duration, width: video.videoWidth, height: video.videoHeight, thumb: null }));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => end(() => resolve({ duration, width: video.videoWidth, height: video.videoHeight, thumb: blob })), 'image/jpeg', 0.8);
      } catch {
        end(() => resolve({ duration, width: video.videoWidth, height: video.videoHeight, thumb: null }));
      }
    };

    video.onerror = fail;
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) {
        duration = video.duration;
        if (!(duration > 0)) return fail();
        phase = 'frame';
        video.currentTime = Math.min(0.1, duration / 2);                // a frame just after the start always has pixels
      } else {
        phase = 'probe';                                                // some webm recordings only learn their length at the end
        video.currentTime = 1e6;
      }
    };
    video.onseeked = () => {
      if (phase === 'probe') {
        duration = Number.isFinite(video.duration) ? video.duration : 0;
        if (!(duration > 0)) return fail();
        phase = 'frame';
        video.currentTime = Math.min(0.1, duration / 2);
        return;
      }
      grabFrame();
    };
  });
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
