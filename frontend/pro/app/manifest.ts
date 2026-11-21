import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'pro',
    short_name: 'pro',
    description: 'Short videos from people near you.',
    start_url: '/pro/feed',
    scope: '/pro/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0D1224',
    theme_color: '#0D1224',
    icons: [
      { src: '/pro/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pro/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/pro/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
