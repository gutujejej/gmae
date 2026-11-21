-- =====================================================================
-- PRO / step 1 of 2 : tables, security rules (RLS), triggers, feed functions, storage.
-- Run AFTER 00_protect_existing.sql. Safe to run again.
-- =====================================================================

-- 0) Stop if one of these names is already used by something that is not Pro.
do $$
declare clash text;
begin
  select string_agg(c.relname, ', ') into clash
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    and c.relname in ('profiles', 'videos', 'likes', 'comments', 'saves', 'follows', 'hashtags', 'video_hashtags', 'reports', 'series')
    and coalesce(obj_description(c.oid, 'pg_class'), '') <> 'pro-app';
  if clash is not null then
    raise exception 'These names are already used in this database: %. Nothing was changed. Tell me and I will rename the Pro tables.', clash;
  end if;
end $$;

-- =====================================================================
-- 1) TABLES
-- =====================================================================
create table if not exists public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  username         text not null,
  display_name     text not null default '',
  avatar_url       text,
  bio              text not null default '',
  followers_count  integer not null default 0,
  following_count  integer not null default 0,
  videos_count     integer not null default 0,
  role             text not null default 'user',
  is_banned        boolean not null default false,
  created_at       timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,24}$'),
  constraint profiles_display_name_len check (char_length(display_name) <= 50),
  constraint profiles_bio_len check (char_length(bio) <= 200),
  constraint profiles_role_check check (role in ('user', 'moderator', 'admin'))
);
create unique index if not exists profiles_username_key on public.profiles (username);

create table if not exists public.series (                 -- Phase 2 (schema ready)
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 80),
  description  text not null default '' check (char_length(description) <= 300),
  created_at   timestamptz not null default now()
);
create index if not exists series_owner_idx on public.series (owner_id, created_at desc);

create table if not exists public.videos (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references public.profiles (id) on delete cascade,
  caption           text not null default '' check (char_length(caption) <= 300),
  video_path        text not null,                        -- file path inside the "videos" bucket (provider-neutral key)
  thumb_path        text,                                 -- file path inside the "thumbnails" bucket
  provider          text not null default 'supabase' check (provider in ('supabase', 'cloudflare', 'mux')),
  provider_ref      text,                                 -- id at Cloudflare Stream / Mux later
  duration_seconds  numeric(6, 2) check (duration_seconds is null or (duration_seconds > 0 and duration_seconds <= 60.5)),
  size_bytes        bigint check (size_bytes is null or (size_bytes > 0 and size_bytes <= 52428800)),
  width             integer check (width is null or width > 0),
  height            integer check (height is null or height > 0),
  status            text not null default 'published' check (status in ('processing', 'published', 'hidden', 'removed')),
  series_id         uuid references public.series (id) on delete set null,   -- Phase 2
  series_part       integer check (series_part is null or series_part > 0),  -- Phase 2
  likes_count       integer not null default 0,
  comments_count    integer not null default 0,
  saves_count       integer not null default 0,
  views_count       integer not null default 0,           -- Phase 2
  created_at        timestamptz not null default now()
);
create index if not exists videos_created_at_idx on public.videos (created_at desc, id desc);
create index if not exists videos_author_idx     on public.videos (author_id, created_at desc);
create index if not exists videos_series_idx     on public.videos (series_id, series_part) where series_id is not null;

create table if not exists public.hashtags (
  id          bigint generated always as identity primary key,
  tag         text not null unique check (tag ~ '^[[:alnum:]_]{1,30}$'),
  uses_count  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.video_hashtags (
  video_id    uuid   not null references public.videos (id) on delete cascade,
  hashtag_id  bigint not null references public.hashtags (id) on delete cascade,
  primary key (video_id, hashtag_id)
);
create index if not exists video_hashtags_tag_idx on public.video_hashtags (hashtag_id, video_id);

create table if not exists public.likes (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  video_id    uuid not null references public.videos (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index if not exists likes_video_idx on public.likes (video_id);
create index if not exists likes_user_idx  on public.likes (user_id, created_at desc);

create table if not exists public.saves (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  video_id    uuid not null references public.videos (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index if not exists saves_user_idx  on public.saves (user_id, created_at desc);
create index if not exists saves_video_idx on public.saves (video_id);

create table if not exists public.follows (
  follower_id   uuid not null references public.profiles (id) on delete cascade,
  following_id  uuid not null references public.profiles (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (follower_id, following_id),                 -- this is also the (follower_id, following_id) index
  constraint follows_not_self check (follower_id <> following_id)
);
create index if not exists follows_following_idx on public.follows (following_id, follower_id);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  video_id    uuid not null references public.videos (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  parent_id   uuid references public.comments (id) on delete cascade,   -- Phase 2: threaded replies
  body        text not null check (char_length(body) between 1 and 500),
  is_removed  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists comments_video_idx  on public.comments (video_id, created_at desc);
create index if not exists comments_parent_idx on public.comments (parent_id) where parent_id is not null;
create index if not exists comments_author_idx on public.comments (author_id);

create table if not exists public.reports (                 -- Phase 2 moderation (schema ready)
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  target_type  text not null check (target_type in ('video', 'comment', 'profile')),
  target_id    uuid not null,
  reason       text not null check (char_length(reason) between 1 and 300),
  status       text not null default 'open' check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  handled_by   uuid references public.profiles (id) on delete set null,
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);

-- =====================================================================
-- 2) HELPER FUNCTIONS
-- =====================================================================
create or replace function public.pro_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('moderator', 'admin') and not is_banned);
$$;

create or replace function public.pro_is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_banned from public.profiles where id = auth.uid()), false);
$$;

-- =====================================================================
-- 3) TRIGGERS
-- =====================================================================
-- 3a) A profile row is created automatically when someone signs up.
create or replace function public.pro_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  wanted text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  shown  text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 50);
  final_name text;
begin
  if wanted ~ '^[a-z0-9_]{3,24}$' and not exists (select 1 from public.profiles where username = wanted) then
    final_name := wanted;
  else
    loop
      final_name := 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
      exit when not exists (select 1 from public.profiles where username = final_name);
    end loop;
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, final_name, coalesce(nullif(shown, ''), final_name));
  return new;
end $$;

drop trigger if exists pro_on_auth_user_created on auth.users;
create trigger pro_on_auth_user_created after insert on auth.users
  for each row execute function public.pro_handle_new_user();

-- 3b) Counters (nobody can write them from the app, only these triggers)
create or replace function public.pro_likes_counter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.videos set likes_count = likes_count + 1 where id = new.video_id;
  else update public.videos set likes_count = greatest(likes_count - 1, 0) where id = old.video_id; end if;
  return null;
end $$;
drop trigger if exists pro_likes_counter on public.likes;
create trigger pro_likes_counter after insert or delete on public.likes for each row execute function public.pro_likes_counter();

create or replace function public.pro_saves_counter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.videos set saves_count = saves_count + 1 where id = new.video_id;
  else update public.videos set saves_count = greatest(saves_count - 1, 0) where id = old.video_id; end if;
  return null;
end $$;
drop trigger if exists pro_saves_counter on public.saves;
create trigger pro_saves_counter after insert or delete on public.saves for each row execute function public.pro_saves_counter();

create or replace function public.pro_comments_counter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.videos set comments_count = comments_count + 1 where id = new.video_id;
  else update public.videos set comments_count = greatest(comments_count - 1, 0) where id = old.video_id; end if;
  return null;
end $$;
drop trigger if exists pro_comments_counter on public.comments;
create trigger pro_comments_counter after insert or delete on public.comments for each row execute function public.pro_comments_counter();

create or replace function public.pro_follows_counter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set following_count = following_count + 1 where id = new.follower_id;
    update public.profiles set followers_count = followers_count + 1 where id = new.following_id;
  else
    update public.profiles set following_count = greatest(following_count - 1, 0) where id = old.follower_id;
    update public.profiles set followers_count = greatest(followers_count - 1, 0) where id = old.following_id;
  end if;
  return null;
end $$;
drop trigger if exists pro_follows_counter on public.follows;
create trigger pro_follows_counter after insert or delete on public.follows for each row execute function public.pro_follows_counter();

create or replace function public.pro_videos_counter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.profiles set videos_count = videos_count + 1 where id = new.author_id;
  else update public.profiles set videos_count = greatest(videos_count - 1, 0) where id = old.author_id; end if;
  return null;
end $$;
drop trigger if exists pro_videos_counter on public.videos;
create trigger pro_videos_counter after insert or delete on public.videos for each row execute function public.pro_videos_counter();

-- 3c) Hashtags are read from the caption automatically (up to 10 per video).
create or replace function public.pro_video_hashtags() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text; tid bigint;
begin
  for t in select distinct lower((regexp_matches(new.caption, '#([[:alnum:]_]{1,30})', 'g'))[1]) limit 10 loop
    insert into public.hashtags (tag, uses_count) values (t, 1)
      on conflict (tag) do update set uses_count = public.hashtags.uses_count + 1
      returning id into tid;
    insert into public.video_hashtags (video_id, hashtag_id) values (new.id, tid) on conflict do nothing;
  end loop;
  return null;
end $$;
drop trigger if exists pro_video_hashtags on public.videos;
create trigger pro_video_hashtags after insert on public.videos for each row execute function public.pro_video_hashtags();

-- 3d) A reply must belong to the same video as its parent comment (Phase 2 replies).
create or replace function public.pro_comment_parent_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null and not exists (select 1 from public.comments c where c.id = new.parent_id and c.video_id = new.video_id) then
    raise exception 'The reply must be on the same video as the comment it answers';
  end if;
  return new;
end $$;
drop trigger if exists pro_comment_parent_check on public.comments;
create trigger pro_comment_parent_check before insert on public.comments for each row execute function public.pro_comment_parent_check();

-- =====================================================================
-- 4) FEED FUNCTIONS (cursor pagination, one call returns everything the feed card needs)
-- =====================================================================
-- Ranking for "For you": likes and comments help, age hurts (recent + popular wins).
create or replace function public.video_score(p_likes integer, p_comments integer, p_created timestamptz)
returns double precision language sql stable as $$
  select ((p_likes * 1.0 + p_comments * 2.0 + 1.0) /
          power(greatest(extract(epoch from (now() - p_created)) / 3600.0, 0) + 2.0, 1.5))::double precision;
$$;

-- For you: cursor = (score, id) of the last card you received.
create or replace function public.feed_for_you(
  p_limit integer default 8, p_after_score double precision default null, p_after_id uuid default null)
returns table (
  id uuid, author_id uuid, caption text, video_path text, thumb_path text, duration_seconds numeric, width integer, height integer,
  series_id uuid, series_part integer, likes_count integer, comments_count integer, saves_count integer, created_at timestamptz,
  username text, display_name text, avatar_url text, liked boolean, saved boolean, following boolean, score double precision)
language sql stable set search_path = public as $$
  with ranked as (
    select v.id as vid, public.video_score(v.likes_count, v.comments_count, v.created_at) as sc
    from public.videos v join public.profiles p on p.id = v.author_id
    where v.status = 'published' and not p.is_banned
  ),
  page as (
    select r.vid, r.sc from ranked r
    where p_after_score is null or (r.sc, r.vid) < (p_after_score, p_after_id)
    order by r.sc desc, r.vid desc
    limit least(greatest(p_limit, 1), 30)
  )
  select v.id, v.author_id, v.caption, v.video_path, v.thumb_path, v.duration_seconds, v.width, v.height,
         v.series_id, v.series_part, v.likes_count, v.comments_count, v.saves_count, v.created_at,
         p.username, p.display_name, p.avatar_url,
         exists (select 1 from public.likes l where l.video_id = v.id and l.user_id = (select auth.uid())),
         exists (select 1 from public.saves s where s.video_id = v.id and s.user_id = (select auth.uid())),
         exists (select 1 from public.follows f where f.follower_id = (select auth.uid()) and f.following_id = v.author_id),
         pg.sc
  from page pg join public.videos v on v.id = pg.vid join public.profiles p on p.id = v.author_id
  order by pg.sc desc, v.id desc;
$$;

-- Following: newest first from people you follow. cursor = (created_at, id) of the last card.
create or replace function public.feed_following(
  p_limit integer default 8, p_after_created timestamptz default null, p_after_id uuid default null)
returns table (
  id uuid, author_id uuid, caption text, video_path text, thumb_path text, duration_seconds numeric, width integer, height integer,
  series_id uuid, series_part integer, likes_count integer, comments_count integer, saves_count integer, created_at timestamptz,
  username text, display_name text, avatar_url text, liked boolean, saved boolean, following boolean, score double precision)
language sql stable set search_path = public as $$
  with page as (
    select v.id as vid, v.created_at as ca
    from public.videos v join public.profiles p on p.id = v.author_id
    where (select auth.uid()) is not null and v.status = 'published' and not p.is_banned
      and exists (select 1 from public.follows f where f.follower_id = (select auth.uid()) and f.following_id = v.author_id)
      and (p_after_created is null or (v.created_at, v.id) < (p_after_created, p_after_id))
    order by v.created_at desc, v.id desc
    limit least(greatest(p_limit, 1), 30)
  )
  select v.id, v.author_id, v.caption, v.video_path, v.thumb_path, v.duration_seconds, v.width, v.height,
         v.series_id, v.series_part, v.likes_count, v.comments_count, v.saves_count, v.created_at,
         p.username, p.display_name, p.avatar_url,
         exists (select 1 from public.likes l where l.video_id = v.id and l.user_id = (select auth.uid())),
         exists (select 1 from public.saves s where s.video_id = v.id and s.user_id = (select auth.uid())),
         true,
         0::double precision
  from page pg join public.videos v on v.id = pg.vid join public.profiles p on p.id = v.author_id
  order by pg.ca desc, v.id desc;
$$;

-- =====================================================================
-- 5) ROW LEVEL SECURITY + PRIVILEGES (everyone reads public things, people write only their own rows)
-- =====================================================================
alter table public.profiles       enable row level security;
alter table public.series         enable row level security;
alter table public.videos         enable row level security;
alter table public.hashtags       enable row level security;
alter table public.video_hashtags enable row level security;
alter table public.likes          enable row level security;
alter table public.saves          enable row level security;
alter table public.follows        enable row level security;
alter table public.comments       enable row level security;
alter table public.reports        enable row level security;

revoke all on public.profiles, public.series, public.videos, public.hashtags, public.video_hashtags,
              public.likes, public.saves, public.follows, public.comments, public.reports from anon, authenticated;

-- profiles: public read; a person edits only their own display fields (never role, ban or counters)
grant select on public.profiles to anon, authenticated;
grant update (username, display_name, avatar_url, bio) on public.profiles to authenticated;
drop policy if exists pro_profiles_read on public.profiles;
create policy pro_profiles_read on public.profiles for select using (true);
drop policy if exists pro_profiles_update_own on public.profiles;
create policy pro_profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- series
grant select on public.series to anon, authenticated;
grant insert (owner_id, title, description) on public.series to authenticated;
grant update (title, description) on public.series to authenticated;
grant delete on public.series to authenticated;
drop policy if exists pro_series_read on public.series;
create policy pro_series_read on public.series for select using (true);
drop policy if exists pro_series_insert on public.series;
create policy pro_series_insert on public.series for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists pro_series_update on public.series;
create policy pro_series_update on public.series for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists pro_series_delete on public.series;
create policy pro_series_delete on public.series for delete to authenticated using (owner_id = (select auth.uid()));

-- videos
grant select on public.videos to anon, authenticated;
grant insert (author_id, caption, video_path, thumb_path, provider, provider_ref, duration_seconds, size_bytes, width, height, series_id, series_part)
  on public.videos to authenticated;
grant update (caption, series_id, series_part) on public.videos to authenticated;
grant delete on public.videos to authenticated;
drop policy if exists pro_videos_read on public.videos;
create policy pro_videos_read on public.videos for select
  using (status = 'published' or author_id = (select auth.uid()) or (select public.pro_is_staff()));
drop policy if exists pro_videos_insert on public.videos;
create policy pro_videos_insert on public.videos for insert to authenticated with check (
  author_id = (select auth.uid()) and not (select public.pro_is_banned())
  and video_path like (select auth.uid())::text || '/%'
  and (thumb_path is null or thumb_path like (select auth.uid())::text || '/%')
  and (series_id is null or exists (select 1 from public.series s where s.id = series_id and s.owner_id = (select auth.uid()))));
drop policy if exists pro_videos_update_own on public.videos;
create policy pro_videos_update_own on public.videos for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid())
    and (series_id is null or exists (select 1 from public.series s where s.id = series_id and s.owner_id = (select auth.uid()))));
drop policy if exists pro_videos_delete on public.videos;
create policy pro_videos_delete on public.videos for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.pro_is_staff()));

-- hashtags (written only by the trigger)
grant select on public.hashtags, public.video_hashtags to anon, authenticated;
drop policy if exists pro_hashtags_read on public.hashtags;
create policy pro_hashtags_read on public.hashtags for select using (true);
drop policy if exists pro_video_hashtags_read on public.video_hashtags;
create policy pro_video_hashtags_read on public.video_hashtags for select using (true);

-- likes and saves: each person sees and changes only their own (the feed functions need select for anon too, they just see nothing)
grant select on public.likes, public.saves to anon, authenticated;
grant insert (user_id, video_id) on public.likes, public.saves to authenticated;
grant delete on public.likes, public.saves to authenticated;
drop policy if exists pro_likes_read on public.likes;
create policy pro_likes_read on public.likes for select using (user_id = (select auth.uid()));
drop policy if exists pro_likes_insert on public.likes;
create policy pro_likes_insert on public.likes for insert to authenticated with check (user_id = (select auth.uid()) and not (select public.pro_is_banned()));
drop policy if exists pro_likes_delete on public.likes;
create policy pro_likes_delete on public.likes for delete to authenticated using (user_id = (select auth.uid()));
drop policy if exists pro_saves_read on public.saves;
create policy pro_saves_read on public.saves for select using (user_id = (select auth.uid()));
drop policy if exists pro_saves_insert on public.saves;
create policy pro_saves_insert on public.saves for insert to authenticated with check (user_id = (select auth.uid()) and not (select public.pro_is_banned()));
drop policy if exists pro_saves_delete on public.saves;
create policy pro_saves_delete on public.saves for delete to authenticated using (user_id = (select auth.uid()));

-- follows: public read, you follow and unfollow as yourself
grant select on public.follows to anon, authenticated;
grant insert (follower_id, following_id) on public.follows to authenticated;
grant delete on public.follows to authenticated;
drop policy if exists pro_follows_read on public.follows;
create policy pro_follows_read on public.follows for select using (true);
drop policy if exists pro_follows_insert on public.follows;
create policy pro_follows_insert on public.follows for insert to authenticated with check (follower_id = (select auth.uid()) and not (select public.pro_is_banned()));
drop policy if exists pro_follows_delete on public.follows;
create policy pro_follows_delete on public.follows for delete to authenticated using (follower_id = (select auth.uid()));

-- comments: public read, write as yourself on published videos, delete your own (or comments on your video)
grant select on public.comments to anon, authenticated;
grant insert (video_id, author_id, parent_id, body) on public.comments to authenticated;
grant delete on public.comments to authenticated;
drop policy if exists pro_comments_read on public.comments;
create policy pro_comments_read on public.comments for select
  using (not is_removed or author_id = (select auth.uid()) or (select public.pro_is_staff()));
drop policy if exists pro_comments_insert on public.comments;
create policy pro_comments_insert on public.comments for insert to authenticated with check (
  author_id = (select auth.uid()) and not (select public.pro_is_banned())
  and exists (select 1 from public.videos v where v.id = video_id and v.status = 'published'));
drop policy if exists pro_comments_delete on public.comments;
create policy pro_comments_delete on public.comments for delete to authenticated using (
  author_id = (select auth.uid())
  or exists (select 1 from public.videos v where v.id = comments.video_id and v.author_id = (select auth.uid()))
  or (select public.pro_is_staff()));

-- reports (Phase 2 moderation): anyone signed in can report, only the reporter and staff can read
grant select on public.reports to authenticated;
grant insert (reporter_id, target_type, target_id, reason) on public.reports to authenticated;
grant update (status, handled_by, handled_at) on public.reports to authenticated;
drop policy if exists pro_reports_insert on public.reports;
create policy pro_reports_insert on public.reports for insert to authenticated with check (reporter_id = (select auth.uid()));
drop policy if exists pro_reports_read on public.reports;
create policy pro_reports_read on public.reports for select to authenticated using (reporter_id = (select auth.uid()) or (select public.pro_is_staff()));
drop policy if exists pro_reports_update_staff on public.reports;
create policy pro_reports_update_staff on public.reports for update to authenticated using ((select public.pro_is_staff())) with check ((select public.pro_is_staff()));

-- function privileges: helpers and feeds are callable by the app, trigger functions are not
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.pro_is_staff(), public.pro_is_banned() to anon, authenticated;
grant execute on function public.video_score(integer, integer, timestamptz) to anon, authenticated;
grant execute on function public.feed_for_you(integer, double precision, uuid) to anon, authenticated;
grant execute on function public.feed_following(integer, timestamptz, uuid) to anon, authenticated;

-- =====================================================================
-- 6) REALTIME (live comments)
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments') then
    alter publication supabase_realtime add table public.comments;
  end if;
end $$;

-- =====================================================================
-- 7) STORAGE: buckets + rules (each person writes only inside the folder named after their user id)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('videos',     'videos',     true, 52428800, array['video/mp4', 'video/webm', 'video/quicktime']),
  ('thumbnails', 'thumbnails', true,   524288, array['image/jpeg', 'image/webp', 'image/png']),
  ('avatars',    'avatars',    true,  2097152, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

drop policy if exists pro_media_read on storage.objects;
create policy pro_media_read on storage.objects for select using (bucket_id in ('videos', 'thumbnails', 'avatars'));
drop policy if exists pro_media_insert on storage.objects;
create policy pro_media_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('videos', 'thumbnails', 'avatars') and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists pro_media_update on storage.objects;
create policy pro_media_update on storage.objects for update to authenticated
  using (bucket_id in ('videos', 'thumbnails', 'avatars') and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists pro_media_delete on storage.objects;
create policy pro_media_delete on storage.objects for delete to authenticated
  using (bucket_id in ('videos', 'thumbnails', 'avatars') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- =====================================================================
-- 8) mark the tables as Pro's (lets this script run again safely)
-- =====================================================================
comment on table public.profiles       is 'pro-app';
comment on table public.series         is 'pro-app';
comment on table public.videos         is 'pro-app';
comment on table public.hashtags       is 'pro-app';
comment on table public.video_hashtags is 'pro-app';
comment on table public.likes          is 'pro-app';
comment on table public.saves          is 'pro-app';
comment on table public.follows        is 'pro-app';
comment on table public.comments       is 'pro-app';
comment on table public.reports        is 'pro-app';
