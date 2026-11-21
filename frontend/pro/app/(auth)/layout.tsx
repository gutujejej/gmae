import Link from 'next/link';
import Logo from '@/components/Logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <Link href="/feed" className="auth-logo" aria-label="Back to the feed"><Logo size={48} /></Link>
      {children}
    </main>
  );
}
