import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isReviewer, isUuid, json, preflight, readJson, verifyUser, type VerifiedUser } from '../_shared/http.ts';
import { type ActionEntry, logAction } from '../_shared/actions.ts';

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

  // every decision is written to the append-only action log; if that fails the reviewer is told
  const finish = async (entry: Omit<ActionEntry, 'actor'>) => {
    const logged = await logAction(db, { ...entry, actor: user.githubUsername });
    return logged
      ? json(req, { ok: true })
      : json(req, { error: 'The decision was saved, but the action log could not be written.' }, 500);
  };

  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 1000)) {
    return json(req, { error: 'Reason must be 1000 characters or fewer' }, 400);
  }
  const why = typeof reason === 'string' ? reason.trim() : '';

  if (body.action !== undefined) return reportAction(req, db, user, body, why, finish);

  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (body.version_id === undefined && typeof id !== 'string' && typeof id !== 'number') {
    return json(req, { error: 'Missing id' }, 400);
  }
  if (status !== 'approved' && status !== 'rejected') {
    return json(req, { error: 'status must be approved or rejected' }, 400);
  }
  const rejectionReason = status === 'rejected' ? (reason as string | undefined)?.trim() || null : null;

  // a decision on a new version of an item, not on the item itself
  if (body.version_id !== undefined) {
    const versionId = body.version_id;
    if (!isUuid(versionId)) return json(req, { error: 'Invalid version id' }, 400);
    const { data: version, error: lookupError } = await db
      .from('item_versions')
      .select('id,item_type,status')
      .eq('id', versionId)
      .maybeSingle();
    if (lookupError) {
      console.error('review-decide version lookup failed', lookupError);
      return json(req, { error: 'Could not save the decision' }, 500);
    }
    if (!version || version.item_type !== type) return json(req, { error: 'Version not found' }, 404);
    if (version.status !== 'pending') return json(req, { error: 'This version was already decided' }, 409);

    // approving swaps the live code and archives the old one in one database transaction
    const { error } = status === 'approved'
      ? await db.rpc('approve_item_version', { p_version_id: versionId })
      : await db
          .from('item_versions')
          .update({ status: 'rejected', rejection_reason: rejectionReason })
          .eq('id', versionId)
          .eq('status', 'pending');
    if (error) {
      console.error('review-decide version decision failed', error);
      return json(req, { error: 'Could not save the decision' }, 500);
    }
    console.log(`review: ${user.githubUsername} set ${type} version ${versionId} to ${status}`);
    return finish({
      action: status === 'approved' ? 'approve_version' : 'reject_version',
      itemType: type,
      versionId,
      reason: why,
    });
  }

  const update = { status, rejection_reason: rejectionReason };

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data, error } = await db.from(table).update(update).eq('id', id).select('id');

  if (error) {
    console.error('review-decide update failed', error);
    return json(req, { error: 'Could not save the decision' }, 500);
  }
  if (!data || data.length === 0) return json(req, { error: 'Submission not found' }, 404);

  // rejecting an item settles any open reports about it
  if (status === 'rejected') await settleReports(db, type, String(id), 'actioned', user.githubUsername);
  console.log(`review: ${user.githubUsername} set ${type} ${id} to ${status}`);
  return finish({ action: status === 'approved' ? 'approve' : 'reject', itemType: type, itemId: String(id), reason: why });
}

async function settleReports(
  db: SupabaseClient,
  type: 'theme' | 'plugin',
  itemId: string,
  status: 'dismissed' | 'actioned',
  reviewer: string,
): Promise<void> {
  const { error } = await db
    .from('reports')
    .update({ status, resolved_at: new Date().toISOString(), resolved_by: reviewer })
    .eq('item_type', type)
    .eq('item_id', itemId)
    .eq('status', 'open');
  if (error) console.error('review-decide settling reports failed', error);
}

// hide / unhide an item, or dismiss one report
async function reportAction(
  req: Request,
  db: SupabaseClient,
  user: VerifiedUser,
  body: Record<string, unknown>,
  why: string,
  finish: (entry: Omit<ActionEntry, 'actor'>) => Promise<Response>,
): Promise<Response> {
  const { action, type, id } = body;

  if (action === 'dismiss_report') {
    const reportId = body.report_id;
    if (!isUuid(reportId)) return json(req, { error: 'Invalid report id' }, 400);
    const { data, error } = await db
      .from('reports')
      .update({ status: 'dismissed', resolved_at: new Date().toISOString(), resolved_by: user.githubUsername })
      .eq('id', reportId)
      .eq('status', 'open')
      .select('item_type,item_id');
    if (error) {
      console.error('review-decide dismiss failed', error);
      return json(req, { error: 'Could not save the decision' }, 500);
    }
    if (!data || data.length === 0) return json(req, { error: 'Report not found or already decided' }, 404);
    const report = data[0] as { item_type: 'theme' | 'plugin'; item_id: string };
    return finish({ action: 'dismiss_report', itemType: report.item_type, itemId: report.item_id, reportId, reason: why });
  }

  if (action !== 'hide' && action !== 'unhide') return json(req, { error: 'Unknown action' }, 400);
  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (!isUuid(id)) return json(req, { error: 'Missing id' }, 400);

  // hide: approved -> hidden (out of Browse, installs, updates). unhide: hidden -> approved
  const [from, to] = action === 'hide' ? ['approved', 'hidden'] : ['hidden', 'approved'];
  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data, error } = await db.from(table).update({ status: to }).eq('id', id).eq('status', from).select('id');
  if (error) {
    console.error(`review-decide ${action} failed`, error);
    return json(req, { error: 'Could not save the decision' }, 500);
  }
  if (!data || data.length === 0) {
    return json(req, { error: action === 'hide' ? 'Only approved items can be hidden' : 'That item is not hidden' }, 409);
  }
  // hiding acts on the reports, unhiding means they were wrong
  await settleReports(db, type, id, action === 'hide' ? 'actioned' : 'dismissed', user.githubUsername);
  console.log(`review: ${user.githubUsername} ${action} ${type} ${id}`);
  return finish({ action, itemType: type, itemId: id, reason: why });
}
