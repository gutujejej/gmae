import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Temporary check page. It is replaced by the real feed in the next step.
export default async function Home() {
  const supabase = await createClient();
  const { count, error } = await supabase.from('videos').select('*', { count: 'exact', head: true });

  return (
    <main style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        <div className="logo">pro<i /></div>
        {error ? (
          <p style={{ marginTop: 16, color: 'var(--coral)' }}>
            Not connected yet: {error.message}
          </p>
        ) : (
          <p style={{ marginTop: 16, color: 'var(--saffron)' }}>
            Connected to the database. Videos so far: {count ?? 0}
          </p>
        )}
      </div>
    </main>
  );
}
