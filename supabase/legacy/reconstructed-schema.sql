-- Reconstructed marketplace schema, for reference only. DO NOT run this against the live project.
--
-- The live schema was built by hand in the Supabase SQL editor and never fully committed.
-- This file collects the SQL from the old phase handoff notes (phases 11 and 12) so the
-- database could be rebuilt if the project were lost.
--
-- Superseded: the real live schema was captured on 2026-10-17 and is now
-- supabase/migrations/20261016000000_baseline_marketplace_schema.sql
-- (raw catalog output in supabase/snapshots/2026-10-pre-hardening.txt). Use that, not this file.
-- Gaps this file had: name_normalized and rejection_reason weren't recorded, there's a
-- CHECK on name, and themes/plugins have no updated_at column.
--
-- The RLS policies below are the ORIGINAL ones. They trust user_metadata, which users can edit,
-- and are replaced by supabase/migrations/20261017000000_harden_marketplace_auth.sql.

-- phase 11: themes, plugins, reviewers

create table themes (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  author_github text not null,
  css text not null,
  status text not null default 'pending',
  created_at timestamp with time zone default now()
);

create table plugins (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  author_github text not null,
  js text not null,
  status text not null default 'pending',
  created_at timestamp with time zone default now()
);

-- reviewer GitHub usernames are added by hand in the table editor
create table reviewers (
  github_username text primary key
);

alter table themes enable row level security;

create policy "Anyone can read approved themes"
  on themes for select
  using (status = 'approved');

create policy "Authenticated users can insert themes"
  on themes for insert
  to authenticated
  with check (
    status = 'pending' and
    author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name')
  );

create policy "Reviewers can update theme status"
  on themes for update
  to authenticated
  using (
    exists (
      select 1 from reviewers
      where github_username = (auth.jwt() -> 'user_metadata' ->> 'user_name')
    )
  );

alter table plugins enable row level security;

create policy "Anyone can read approved plugins"
  on plugins for select
  using (status = 'approved');

create policy "Authenticated users can insert plugins"
  on plugins for insert
  to authenticated
  with check (
    status = 'pending' and
    author_github = (auth.jwt() -> 'user_metadata' ->> 'user_name')
  );

create policy "Reviewers can update plugin status"
  on plugins for update
  to authenticated
  using (
    exists (
      select 1 from reviewers
      where github_username = (auth.jwt() -> 'user_metadata' ->> 'user_name')
    )
  );

alter table reviewers enable row level security;

create policy "Authenticated users can read reviewers"
  on reviewers for select
  to authenticated
  using (true);

grant select, insert on themes to anon, authenticated;
grant select, insert on plugins to anon, authenticated;
grant update (status) on themes to authenticated;
grant update (status) on plugins to authenticated;
grant select on reviewers to authenticated;

-- phase 12: ratings

alter table themes add column if not exists avg_rating float default 0;
alter table themes add column if not exists rating_count integer default 0;

alter table plugins add column if not exists avg_rating float default 0;
alter table plugins add column if not exists rating_count integer default 0;

create table if not exists ratings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null,
  item_id uuid not null,
  item_type text not null check (item_type in ('theme', 'plugin')),
  rating integer not null check (rating >= 1 and rating <= 5),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, item_id, item_type)
);

alter table ratings enable row level security;

create policy "ratings_select" on ratings
  for select using (true);

create policy "ratings_insert" on ratings
  for insert with check (user_id = auth.uid());

create policy "ratings_update" on ratings
  for update using (user_id = auth.uid());

grant select on public.ratings to anon, authenticated;
grant insert, update on public.ratings to authenticated;
grant all on public.ratings to service_role;
