-- Tags, an optional GitHub link, and download counts.
--
-- tags: up to 3 from a fixed list (nothing to moderate). The list here must match TAGS in
-- supabase/functions/_shared/details.ts and the GUI.
-- link: one optional https link to a github.com repo or gist, opened in the browser, never loaded in the app.
-- download_count: counted by the count-download function, once per signed-in user per item per day,
-- using the downloads table. Only the edge functions (service role) write any of this.

begin;

alter table public.themes
  add column tags text[] not null default '{}',
  add column link text,
  add column download_count integer not null default 0;
alter table public.plugins
  add column tags text[] not null default '{}',
  add column link text,
  add column download_count integer not null default 0;

alter table public.themes add constraint themes_tags_valid check (
  cardinality(tags) <= 3
  and tags <@ array['dark', 'light', 'minimal', 'colorful', 'productivity', 'fun', 'accessibility', 'fonts']
);
alter table public.plugins add constraint plugins_tags_valid check (
  cardinality(tags) <= 3
  and tags <@ array['dark', 'light', 'minimal', 'colorful', 'productivity', 'fun', 'accessibility', 'fonts']
);
alter table public.themes add constraint themes_link_valid check (
  link is null or link ~ '^https://(gist\.)?github\.com/[A-Za-z0-9._~/-]{1,200}$'
);
alter table public.plugins add constraint plugins_link_valid check (
  link is null or link ~ '^https://(gist\.)?github\.com/[A-Za-z0-9._~/-]{1,200}$'
);

create index themes_download_count on public.themes (download_count desc);
create index plugins_download_count on public.plugins (download_count desc);

create table public.downloads (
  user_id uuid not null,
  item_type text not null check (item_type in ('theme', 'plugin')),
  item_id uuid not null,
  day date not null default current_date,
  primary key (user_id, item_type, item_id, day)
);

alter table public.downloads enable row level security;
revoke all on public.downloads from anon, authenticated;
-- the live project gives a new table's service role no read or write access by default
grant select, insert, delete on public.downloads to service_role;

-- counts one download per user per item per day, returns whether this one counted
create or replace function public.record_download(p_user_id uuid, p_item_type text, p_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  counted boolean;
begin
  insert into public.downloads (user_id, item_type, item_id)
  values (p_user_id, p_item_type, p_item_id)
  on conflict do nothing;
  counted := found;
  if counted then
    if p_item_type = 'theme' then
      update public.themes set download_count = download_count + 1 where id = p_item_id and status = 'approved';
    else
      update public.plugins set download_count = download_count + 1 where id = p_item_id and status = 'approved';
    end if;
  end if;
  return counted;
end;
$$;

revoke all on function public.record_download(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.record_download(uuid, text, uuid) to service_role;

commit;
