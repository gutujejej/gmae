-- =====================================================================
-- PRO / step 0 of 2 : protect the OLD tables. Run this FIRST, once.
-- Supabase SQL editor -> New query -> paste -> Run.
--
-- Why: the old gmae system and Pro share ONE database. Pro's browser code uses Supabase's public key,
-- so before Pro goes live we make sure that key cannot read or change any old table
-- or run any old SQL function (money, bonuses, balances...).
-- The old backend uses the service_role key, which ignores these rules, so the old app keeps working as before.
-- (This assumes no old web page talks to Supabase directly. The old pages only call your Railway server.)
-- =====================================================================

-- 1) Row level security on every table in "public" that does not have it yet.
--    With no policies this means: nobody except service_role can touch them.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and not rowsecurity loop
    execute format('alter table public.%I enable row level security', r.tablename);
    raise notice 'row level security enabled on %', r.tablename;
  end loop;
end $$;

-- 2) The public key gets no direct access to the tables or sequences that exist today.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 3) ...and cannot call any SQL function that exists today (functions are callable by default).
revoke execute on all functions in schema public from public, anon, authenticated;

-- Check: every row below must say  rls_on = true
select tablename, rowsecurity as rls_on from pg_tables where schemaname = 'public' order by tablename;
