import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isReviewer, json, preflight, verifyUser } from '../_shared/http.ts';

export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Invalid or expired sign-in' }, 401);
  if (!(await isReviewer(db, user))) return json(req, { error: 'Not a reviewer' }, 403);

  const [themes, plugins, rejectedThemes, rejectedPlugins, versions, reports, actions] = await Promise.all([
    db.from('themes').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
    db.from('plugins').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
    db.from('themes')
      .select('id,name,author_github,description,css,rejection_reason')
      .eq('status', 'rejected')
      .order('created_at', { ascending: false })
      .limit(30),
    db.from('plugins')
      .select('id,name,author_github,description,js,rejection_reason')
      .eq('status', 'rejected')
      .order('created_at', { ascending: false })
      .limit(30),
    db.from('item_versions').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
    db.from('reports')
      .select('id,item_type,item_id,reporter_github,reason,note,counts_for_hiding,created_at')
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(200),
    db.from('review_actions').select('*').order('created_at', { ascending: false }).limit(50),
  ]);

  const failed = [themes, plugins, rejectedThemes, rejectedPlugins, versions, reports, actions].find(r => r.error);
  if (failed?.error) {
    console.error('review-pending query failed', failed.error);
    return json(req, { error: 'Could not load the review queue' }, 500);
  }

  // pending versions come with their item's name and the code that is live now, for the diff, and
  // reports with their item's name and status (approved or hidden)
  const pendingVersions = (versions.data ?? []) as Record<string, unknown>[];
  const openReports = (reports.data ?? []) as Record<string, unknown>[];
  const logEntries = (actions.data ?? []) as Record<string, unknown>[];
  const ids = (t: string) => [
    ...new Set(
      [...pendingVersions, ...openReports, ...logEntries].filter(v => v.item_type === t && v.item_id).map(v => v.item_id as string),
    ),
  ];
  const [liveThemes, livePlugins] = await Promise.all([
    ids('theme').length ? db.from('themes').select('id,name,css,status').in('id', ids('theme')) : { data: [], error: null },
    ids('plugin').length ? db.from('plugins').select('id,name,js,status').in('id', ids('plugin')) : { data: [], error: null },
  ]);
  if (liveThemes.error || livePlugins.error) {
    console.error('review-pending live code query failed', liveThemes.error ?? livePlugins.error);
    return json(req, { error: 'Could not load the review queue' }, 500);
  }
  const live = new Map<string, { name: string; code: string; status: string }>();
  for (const t of (liveThemes.data ?? []) as Record<string, string>[]) live.set(`theme:${t.id}`, { name: t.name, code: t.css, status: t.status });
  for (const p of (livePlugins.data ?? []) as Record<string, string>[]) live.set(`plugin:${p.id}`, { name: p.name, code: p.js, status: p.status });
  const withLive = pendingVersions.map(v => {
    const item = live.get(`${v.item_type}:${v.item_id}`);
    return { ...v, name: item?.name ?? null, previous_code: item?.code ?? '' };
  });

  const reportsWithItem = openReports.map(r => {
    const item = live.get(`${r.item_type}:${r.item_id}`);
    return { ...r, name: item?.name ?? null, item_status: item?.status ?? null };
  });

  return json(req, {
    reports: reportsWithItem,
    actions: logEntries.map(a => ({ ...a, name: live.get(`${a.item_type}:${a.item_id}`)?.name ?? null })),
    versions: withLive,
    themes: themes.data ?? [],
    plugins: plugins.data ?? [],
    rejectedThemes: rejectedThemes.data ?? [],
    rejectedPlugins: rejectedPlugins.data ?? [],
  });
}
