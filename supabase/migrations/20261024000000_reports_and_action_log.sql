-- Reports and the reviewer action log.
--
-- reports: one per signed-in user per item, with a reason from a fixed list and an optional note.
-- Only edge functions (service role) read or write them; reporters' names are never shown to authors.
-- file_report() adds a report and, when 3 different accounts at least a day old report an approved item
-- as harmful, hides it ('hidden' status) until a reviewer decides. Hidden items drop out of Browse,
-- installs, updates and ratings, which all read approved items only.
--
-- review_actions: an append-only log of every review decision, hide, unhide and report decision.
-- The service role can only insert and read it, and a trigger refuses updates and deletes for everyone.
--
-- Authors could delete any of their items that wasn't approved, which would include a hidden one;
-- now only pending and rejected items can be deleted, so a reported item stays for the reviewer.

begin;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('theme', 'plugin')),
  item_id uuid not null,
  reporter_id uuid not null,
  reporter_github text not null,
  reason text not null check (reason in ('harmful', 'broken', 'offensive', 'copyright', 'spam', 'other')),
  note text not null default '' check (char_length(note) <= 500),
  counts_for_hiding boolean not null default false,
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  unique (item_type, item_id, reporter_id)
);

create index reports_open on public.reports (status, created_at);

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, insert, update on public.reports to service_role;

create table public.review_actions (
  id bigint generated always as identity primary key,
  actor_github text not null,
  action text not null check (action in (
    'approve', 'reject', 'approve_version', 'reject_version', 'hide', 'unhide', 'auto_hide', 'dismiss_report'
  )),
  item_type text check (item_type in ('theme', 'plugin')),
  item_id uuid,
  version_id uuid,
  report_id uuid,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index review_actions_recent on public.review_actions (created_at desc);

alter table public.review_actions enable row level security;
revoke all on public.review_actions from anon, authenticated;
grant select, insert on public.review_actions to service_role;

create or replace function public.review_actions_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'review_actions is append-only';
end;
$$;

create trigger review_actions_no_update_or_delete
  before update or delete on public.review_actions
  for each row execute function public.review_actions_append_only();

create trigger review_actions_no_truncate
  before truncate on public.review_actions
  for each statement execute function public.review_actions_append_only();

-- adds a report, and hides the item when 3 different eligible accounts report it as harmful.
-- Returns whether the item is hidden now. Raises unique_violation if this user already reported it
create or replace function public.file_report(
  p_item_type text,
  p_item_id uuid,
  p_reporter_id uuid,
  p_reporter_github text,
  p_reason text,
  p_note text,
  p_counts_for_hiding boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  harmful_count integer;
  hidden boolean := false;
begin
  insert into public.reports (item_type, item_id, reporter_id, reporter_github, reason, note, counts_for_hiding)
  values (p_item_type, p_item_id, p_reporter_id, p_reporter_github, p_reason, coalesce(p_note, ''), p_counts_for_hiding);

  if p_reason = 'harmful' and p_counts_for_hiding then
    select count(distinct reporter_id) into harmful_count
    from public.reports
    where item_type = p_item_type and item_id = p_item_id
      and reason = 'harmful' and counts_for_hiding and status = 'open';

    if harmful_count >= 3 then
      if p_item_type = 'theme' then
        update public.themes set status = 'hidden' where id = p_item_id and status = 'approved';
      else
        update public.plugins set status = 'hidden' where id = p_item_id and status = 'approved';
      end if;
      hidden := found;
      if hidden then
        insert into public.review_actions (actor_github, action, item_type, item_id, reason)
        values ('automatic', 'auto_hide', p_item_type, p_item_id, '3 accounts reported it as harmful');
      end if;
    end if;
  end if;

  return hidden;
end;
$$;

revoke all on function public.file_report(text, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.file_report(text, uuid, uuid, text, text, text, boolean) to service_role;

drop policy "themes: authors delete their unapproved submissions" on public.themes;
create policy "themes: authors delete their pending or rejected submissions"
  on public.themes for delete to authenticated
  using (
    status in ('pending', 'rejected')
    and lower(author_github) = lower(public.current_github_username())
  );

drop policy "plugins: authors delete their unapproved submissions" on public.plugins;
create policy "plugins: authors delete their pending or rejected submissions"
  on public.plugins for delete to authenticated
  using (
    status in ('pending', 'rejected')
    and lower(author_github) = lower(public.current_github_username())
  );

commit;
