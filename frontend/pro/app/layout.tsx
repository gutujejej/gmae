import type { Metadata, Viewport } from 'next';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'pro', template: '%s · pro' },
  description: 'Short videos from people near you.',
  applicationName: 'pro',
  icons: { icon: '/pro/icons/icon-192.png', apple: '/pro/icons/icon-192.png' },
  appleWebApp: { capable: true, title: 'pro', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0D1224',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
