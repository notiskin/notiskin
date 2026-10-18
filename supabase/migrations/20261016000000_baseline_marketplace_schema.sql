-- Baseline: the marketplace schema as it was live on 2026-10-17, before the auth hardening.
--
-- The tables were originally built by hand in the Supabase SQL editor. This file was written from
-- the live catalog (supabase/snapshots/2026-10-pre-hardening.txt) so a fresh project can be rebuilt
-- from migrations alone. On the existing project it must NOT be run, mark it as applied instead:
--   supabase migration repair --status applied 20261016000000
--
-- The policies below are the ORIGINAL ones. They trust user_metadata, which users can edit,
-- and are replaced by 20261017000000_harden_marketplace_auth.sql straight after.
--
-- The live grants also include MAINTAIN (Postgres 17 only), left out here so this runs on older
-- local Postgres too. The hardening migration doesn't depend on it.

create table public.themes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  author_github text not null,
  css text not null,
  status text not null default 'pending',
  created_at timestamptz default now(),
  rejection_reason text,
  name_normalized text,
  avg_rating double precision default 0,
  rating_count integer default 0,
  constraint themes_name_normalized_unique unique (name_normalized),
  constraint themes_name_valid check (name ~ '^[a-z0-9 ]+$')
);

create table public.plugins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  author_github text not null,
  js text not null,
  status text not null default 'pending',
  created_at timestamptz default now(),
  rejection_reason text,
  name_normalized text,
  avg_rating double precision default 0,
  rating_count integer default 0,
  constraint plugins_name_normalized_unique unique (name_normalized),
  constraint plugins_name_valid check (name ~ '^[a-z0-9 ]+$')
);

-- reviewer GitHub usernames are added by hand in the table editor
create table public.reviewers (
  github_username text primary key
);

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  item_id uuid not null,
  item_type text not null check (item_type in ('theme', 'plugin')),
  rating integer not null check (rating >= 1 and rating <= 5),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, item_id, item_type)
);

alter table public.themes enable row level security;
alter table public.plugins enable row level security;
alter table public.reviewers enable row level security;
alter table public.ratings enable row level security;

-- original policies

create policy "Read approved only" on public.themes
  for select using (status = 'approved');
create policy "Authors can read own submissions" on public.themes
  for select using (author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name'));
create policy "Authenticated users can insert themes" on public.themes
  for insert to authenticated
  with check (status = 'pending' and author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name'));
create policy "Reviewers can update theme status" on public.themes
  for update to authenticated
  using (exists (
    select 1 from public.reviewers
    where reviewers.github_username = (auth.jwt() -> 'user_metadata' ->> 'user_name')
  ));
create policy "Authors can delete own pending or rejected" on public.themes
  for delete to authenticated
  using (
    author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name')
    and status in ('pending', 'rejected')
  );

create policy "Read approved only" on public.plugins
  for select using (status = 'approved');
create policy "Authors can read own submissions" on public.plugins
  for select using (author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name'));
create policy "Authenticated users can insert plugins" on public.plugins
  for insert to authenticated
  with check (status = 'pending' and author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name'));
create policy "Reviewers can update plugin status" on public.plugins
  for update to authenticated
  using (exists (
    select 1 from public.reviewers
    where reviewers.github_username = (auth.jwt() -> 'user_metadata' ->> 'user_name')
  ));
create policy "Authors can delete own pending or rejected" on public.plugins
  for delete to authenticated
  using (
    author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name')
    and status in ('pending', 'rejected')
  );

create policy "Authenticated users can read reviewers" on public.reviewers
  for select to authenticated using (true);

create policy "ratings_select" on public.ratings for select using (true);
create policy "ratings_insert" on public.ratings for insert with check (user_id = auth.uid());
create policy "ratings_update" on public.ratings for update using (user_id = auth.uid());

-- grants, exactly as live (Supabase's default privileges grant everything, so reset first)

revoke all on public.themes, public.plugins, public.reviewers, public.ratings from anon, authenticated, service_role;

grant select, insert, references, trigger, truncate on public.themes, public.plugins to anon;
grant select, insert, update, delete, references, trigger, truncate on public.themes, public.plugins to authenticated;
grant select, insert, update, delete, references, trigger, truncate on public.themes, public.plugins to service_role;
grant update (status) on public.themes, public.plugins to authenticated;

grant references, trigger, truncate on public.reviewers to anon;
grant select, references, trigger, truncate on public.reviewers to authenticated, service_role;

grant select, references, trigger, truncate on public.ratings to anon;
grant select, insert, update, references, trigger, truncate on public.ratings to authenticated;
grant select, insert, update, delete, references, trigger, truncate on public.ratings to service_role;
