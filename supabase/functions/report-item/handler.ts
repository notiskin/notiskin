import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isUuid, json, preflight, readJson, verifyUser } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/limits.ts';
import { REPORT_REASONS } from '../_shared/actions.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// a signed-in user reports an approved theme or plugin. file_report() stores it and hides the item
// when 3 different accounts at least a day old report it as harmful, until a reviewer looks
export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in with GitHub to report.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);
  const { type, id, reason } = body;
  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (!isUuid(id)) return json(req, { error: 'Missing item id' }, 400);
  if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    return json(req, { error: 'Pick a reason from the list.' }, 400);
  }
  const note = body.note === undefined || body.note === null ? '' : body.note;
  if (typeof note !== 'string' || note.trim().length > 500) {
    return json(req, { error: 'The note must be 500 characters or fewer.' }, 400);
  }

  const limited = await checkRateLimit(req, db, user, 'report');
  if (limited) return limited;

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data: item, error: itemError } = await db.from(table).select('id').eq('id', id).eq('status', 'approved').maybeSingle();
  if (itemError) {
    console.error('report-item lookup failed', itemError);
    return json(req, { error: 'Could not send the report. Try again later.' }, 500);
  }
  if (!item) return json(req, { error: `That ${type} isn't in the marketplace.` }, 404);

  // brand new accounts can still report, but don't count toward hiding, so a pile-on needs older accounts
  const created = user.createdAt ? Date.parse(user.createdAt) : NaN;
  const countsForHiding = Number.isFinite(created) && Date.now() - created >= DAY_MS;

  const { data: hidden, error } = await db.rpc('file_report', {
    p_item_type: type,
    p_item_id: id,
    p_reporter_id: user.id,
    p_reporter_github: user.githubUsername,
    p_reason: reason,
    p_note: note.trim(),
    p_counts_for_hiding: countsForHiding,
  });
  if (error?.code === '23505') return json(req, { error: `You already reported this ${type}.` }, 409);
  if (error) {
    console.error('report-item failed', error);
    return json(req, { error: 'Could not send the report. Try again later.' }, 500);
  }
  return json(req, { ok: true, hidden: hidden === true });
}
