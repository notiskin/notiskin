import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isReviewer, json, preflight, readJson, verifyUser } from '../_shared/http.ts';

export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Invalid or expired sign-in' }, 401);
  if (!(await isReviewer(db, user))) return json(req, { error: 'Not a reviewer' }, 403);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);
  const { type, id, status, reason } = body;

  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (typeof id !== 'string' && typeof id !== 'number') return json(req, { error: 'Missing id' }, 400);
  if (status !== 'approved' && status !== 'rejected') {
    return json(req, { error: 'status must be approved or rejected' }, 400);
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 1000)) {
    return json(req, { error: 'Reason must be 1000 characters or fewer' }, 400);
  }

  const update = {
    status,
    rejection_reason: status === 'rejected' ? (reason as string | undefined)?.trim() || null : null,
  };

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data, error } = await db.from(table).update(update).eq('id', id).select('id');

  if (error) {
    console.error('review-decide update failed', error);
    return json(req, { error: 'Could not save the decision' }, 500);
  }
  if (!data || data.length === 0) return json(req, { error: 'Submission not found' }, 404);

  console.log(`review: ${user.githubUsername} set ${type} ${id} to ${status}`);
  return json(req, { ok: true });
}
