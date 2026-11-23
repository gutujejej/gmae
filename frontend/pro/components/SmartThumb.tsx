'use client';

import { useState } from 'react';
import { thumbSrc, videoSrc } from '@/lib/media';

type Props = { video: { video_path: string; thumb_path: string | null }; className?: string };

// The video's thumbnail. If the picture is missing or almost black (older uploads grabbed a black first frame),
// it shows a frame taken from the video itself instead.
export default function SmartThumb({ video, className }: Props) {
  const [useFrame, setUseFrame] = useState(!video.thumb_path);

  const check = (img: HTMLImageElement) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (sum / (data.length / 4) < 14) setUseFrame(true);
    } catch { /* a picture the browser may not measure: keep it */ }
  };

  if (useFrame) {
    return <video className={className} src={`${videoSrc(video)}#t=1`} preload="metadata" muted playsInline />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={thumbSrc(video)}
      alt=""
      loading="lazy"
      crossOrigin="anonymous"
      onLoad={(e) => check(e.currentTarget)}
      onError={() => setUseFrame(true)}
    />
  );
}
