import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isReviewer, json, preflight, verifyUser } from '../_shared/http.ts';

export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Invalid or expired sign-in' }, 401);
  if (!(await isReviewer(db, user))) return json(req, { error: 'Not a reviewer' }, 403);

  const [themes, plugins, rejectedThemes, rejectedPlugins] = await Promise.all([
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
  ]);

  const failed = [themes, plugins, rejectedThemes, rejectedPlugins].find(r => r.error);
  if (failed?.error) {
    console.error('review-pending query failed', failed.error);
    return json(req, { error: 'Could not load the review queue' }, 500);
  }

  return json(req, {
    themes: themes.data ?? [],
    plugins: plugins.data ?? [],
    rejectedThemes: rejectedThemes.data ?? [],
    rejectedPlugins: rejectedPlugins.data ?? [],
  });
}
