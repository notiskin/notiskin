-- Harden marketplace auth.
--
-- The old policies trusted auth.jwt() -> 'user_metadata' ->> 'user_name'. Any signed-in user can
-- change their own user_metadata with supabase.auth.updateUser({ data: { user_name: '...' } }),
-- so anyone could pose as a reviewer and approve submissions straight through the REST API,
-- or pose as another author.
--
-- This migration:
--   1. adds current_github_username(), which reads the username from the linked GitHub identity
--      (written by Supabase Auth at sign-in, not editable by the user)
--   2. drops every existing policy on themes and plugins and recreates a known-good set
--   3. removes direct UPDATE access, approvals now only happen through the review-decide
--      edge function, which checks the reviewer server-side
--
-- Before running: look at what's live now with
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--   where schemaname = 'public' and tablename in ('themes', 'plugins', 'reviewers', 'ratings');

begin;

create or replace function public.current_github_username()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.identity_data ->> 'user_name'
  from auth.identities i
  where i.user_id = auth.uid() and i.provider = 'github'
  limit 1
$$;

revoke all on function public.current_github_username() from public, anon;
grant execute on function public.current_github_username() to authenticated;

do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('themes', 'plugins')
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

alter table public.themes enable row level security;
alter table public.plugins enable row level security;

-- themes

create policy "themes: public reads approved"
  on public.themes for select
  using (status = 'approved');

create policy "themes: authors read their own"
  on public.themes for select to authenticated
  using (lower(author_github) = lower(public.current_github_username()));

create policy "themes: authors submit as themselves"
  on public.themes for insert to authenticated
  with check (
    status = 'pending'
    and lower(author_github) = lower(public.current_github_username())
  );

create policy "themes: authors delete their unapproved submissions"
  on public.themes for delete to authenticated
  using (
    status <> 'approved'
    and lower(author_github) = lower(public.current_github_username())
  );

-- plugins

create policy "plugins: public reads approved"
  on public.plugins for select
  using (status = 'approved');

create policy "plugins: authors read their own"
  on public.plugins for select to authenticated
  using (lower(author_github) = lower(public.current_github_username()));

create policy "plugins: authors submit as themselves"
  on public.plugins for insert to authenticated
  with check (
    status = 'pending'
    and lower(author_github) = lower(public.current_github_username())
  );

create policy "plugins: authors delete their unapproved submissions"
  on public.plugins for delete to authenticated
  using (
    status <> 'approved'
    and lower(author_github) = lower(public.current_github_username())
  );

-- no client-side updates at all, review-decide uses the service role after checking the reviewer
revoke update on public.themes from anon, authenticated;
revoke update on public.plugins from anon, authenticated;
grant delete on public.themes to authenticated;
grant delete on public.plugins to authenticated;

-- the reviewer list is only needed server-side
drop policy if exists "Authenticated users can read reviewers" on public.reviewers;
revoke select on public.reviewers from anon, authenticated;

-- ratings are written only by the rate-item edge function (service role)
drop policy if exists "ratings_insert" on public.ratings;
drop policy if exists "ratings_update" on public.ratings;
revoke insert, update, delete on public.ratings from anon, authenticated;

commit;
