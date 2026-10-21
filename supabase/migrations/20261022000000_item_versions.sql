-- Item versions.
--
-- themes and plugins keep holding the current approved code (css / js), plus the number of that
-- version. Every later version an author publishes is a row in item_versions: pending until it is
-- approved (themes that pass the CSS allowlist are approved at once, plugins always wait for a
-- reviewer). Approving a version copies its code onto the item row, so browsing and installing keep
-- reading one row. The old code is archived as a version row first, so history is kept.
--
-- Only the edge functions (service role) write to item_versions. Clients may read approved versions
-- and their own versions, and nothing else.

begin;

alter table public.themes add column version integer not null default 1 check (version >= 1);
alter table public.plugins add column version integer not null default 1 check (version >= 1);

create table public.item_versions (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('theme', 'plugin')),
  item_id uuid not null,
  version integer not null check (version >= 1),
  code text not null,
  changelog text not null default '',
  author_github text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (item_type, item_id, version)
);

create index item_versions_item on public.item_versions (item_type, item_id);
create index item_versions_status on public.item_versions (status, created_at);

alter table public.item_versions enable row level security;

revoke all on public.item_versions from anon, authenticated;
grant select on public.item_versions to anon, authenticated;
-- the live project gives a new table's service role no read or write access by default
grant select, insert, update on public.item_versions to service_role;

create policy "item_versions: public reads approved"
  on public.item_versions for select
  using (status = 'approved');

create policy "item_versions: authors read their own"
  on public.item_versions for select to authenticated
  using (lower(author_github) = lower(public.current_github_username()));

-- makes a pending version the live one, all or nothing
create or replace function public.approve_item_version(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.item_versions%rowtype;
  cur_version integer;
  cur_code text;
  cur_author text;
begin
  select * into v from public.item_versions where id = p_version_id for update;
  if not found then
    raise exception 'version not found';
  end if;
  if v.status <> 'pending' then
    raise exception 'version is not pending';
  end if;

  if v.item_type = 'theme' then
    select t.version, t.css, t.author_github into cur_version, cur_code, cur_author
    from public.themes t where t.id = v.item_id for update;
  else
    select p.version, p.js, p.author_github into cur_version, cur_code, cur_author
    from public.plugins p where p.id = v.item_id for update;
  end if;
  if not found then
    raise exception 'item not found';
  end if;
  if v.version <= cur_version then
    raise exception 'a newer version is already live';
  end if;

  -- keep the code that is going out of service
  insert into public.item_versions (item_type, item_id, version, code, changelog, author_github, status)
  values (v.item_type, v.item_id, cur_version, cur_code, '', cur_author, 'approved')
  on conflict (item_type, item_id, version) do nothing;

  if v.item_type = 'theme' then
    update public.themes set css = v.code, version = v.version where id = v.item_id;
  else
    update public.plugins set js = v.code, version = v.version where id = v.item_id;
  end if;

  update public.item_versions set status = 'approved', rejection_reason = null where id = v.id;
end;
$$;

revoke all on function public.approve_item_version(uuid) from public, anon, authenticated;
grant execute on function public.approve_item_version(uuid) to service_role;

commit;
