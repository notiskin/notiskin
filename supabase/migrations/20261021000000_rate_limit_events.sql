-- Server-side rate limits.
--
-- The edge functions record one row here for each limited action (publishing, rating) and count a
-- user's recent rows before allowing the next one. The numbers live in
-- supabase/functions/_shared/limits.ts, not in the database.
--
-- Only the edge functions (service role) touch this table. RLS is on with no policies and no
-- grants for anon or authenticated, so the API can't read, write or clear it.

begin;

create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_events_lookup
  on public.rate_limit_events (user_id, action, created_at desc);

alter table public.rate_limit_events enable row level security;

revoke all on public.rate_limit_events from anon, authenticated;

commit;
