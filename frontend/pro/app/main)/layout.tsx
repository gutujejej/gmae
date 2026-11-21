import BottomNav from '@/components/BottomNav';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <main className="content">{children}</main>
      <BottomNav />
    </div>
  );
}
