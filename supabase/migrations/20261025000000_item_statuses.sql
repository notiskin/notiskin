-- Lets the app ask what happened to the marketplace items a user installed.
--
-- RLS only shows approved items to the public, so the app couldn't tell an item that was hidden after
-- reports or rejected by a reviewer from one that was deleted, and users with a pulled plugin were never
-- told. item_statuses() answers with only id, status and version, for at most 200 ids of one type, and
-- only for approved, hidden and rejected items (pending submissions stay private). Item ids are random
-- UUIDs, so this tells nobody anything about items they don't already know the id of.
--
-- The app sends every id in ~/.notiskin/installed.json, in groups of 200, as part of its update check,
-- which this replaces the plain approved-items read in, so it costs no extra requests.

begin;

create or replace function public.item_statuses(p_item_type text, p_ids uuid[])
returns table (id uuid, status text, version integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_item_type is null or p_item_type not in ('theme', 'plugin') then
    raise exception 'item type must be theme or plugin' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'at most 200 ids at a time' using errcode = '22023';
  end if;

  if p_item_type = 'theme' then
    return query
      select t.id, t.status, t.version from public.themes t
      where t.id = any(p_ids) and t.status in ('approved', 'hidden', 'rejected');
  else
    return query
      select p.id, p.status, p.version from public.plugins p
      where p.id = any(p_ids) and p.status in ('approved', 'hidden', 'rejected');
  end if;
end;
$$;

revoke all on function public.item_statuses(text, uuid[]) from public;
grant execute on function public.item_statuses(text, uuid[]) to anon, authenticated, service_role;

commit;
