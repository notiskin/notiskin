import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, cleanChangelog, isUuid, json, preflight, readJson, verifyUser } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/limits.ts';
import { validateThemeCss } from '../_shared/css.ts';

const MAX_CODE = { theme: 20_000, plugin: 200_000 } as const;

// an author publishes a new version of their own approved item. The current version stays live until
// the new one is approved: themes that pass the allowlist at once, plugins only after a reviewer looks
export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in with GitHub to publish.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);

  const { type, id, code } = body;
  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (!isUuid(id)) return json(req, { error: 'Missing item id' }, 400);
  const changelog = cleanChangelog(body.changelog);
  if (changelog === null) return json(req, { error: 'Say what changed, in up to 500 characters.' }, 400);
  if (typeof code !== 'string' || !code.trim()) return json(req, { error: 'The new version is empty.' }, 400);
  if (code.length > MAX_CODE[type]) return json(req, { error: 'The new version is too long.' }, 400);

  const limited = await checkRateLimit(req, db, user, 'submit');
  if (limited) return limited;

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data: item, error: itemError } = await db
    .from(table)
    .select('id,author_github,status,version')
    .eq('id', id)
    .maybeSingle();
  if (itemError) {
    console.error('submit-version item lookup failed', itemError);
    return json(req, { error: 'Could not save the new version. Try again later.' }, 500);
  }
  if (!item) return json(req, { error: `That ${type} doesn't exist.` }, 404);
  // the author comes from the verified GitHub identity, never from the request
  if (String(item.author_github).toLowerCase() !== user.githubUsername.toLowerCase()) {
    return json(req, { error: `Only the author can publish a new version of this ${type}.` }, 403);
  }
  if (item.status !== 'approved') {
    return json(req, { error: `Wait until the first version of this ${type} is approved.` }, 409);
  }

  const { data: pending, error: pendingError } = await db
    .from('item_versions')
    .select('id')
    .eq('item_type', type)
    .eq('item_id', id)
    .eq('status', 'pending')
    .limit(1);
  const { data: latest, error: latestError } = await db
    .from('item_versions')
    .select('version')
    .eq('item_type', type)
    .eq('item_id', id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingError || latestError) {
    console.error('submit-version version lookup failed', pendingError ?? latestError);
    return json(req, { error: 'Could not save the new version. Try again later.' }, 500);
  }
  if (Array.isArray(pending) && pending.length > 0) {
    return json(req, { error: 'You already have a version waiting for review.' }, 409);
  }

  const version = Math.max(Number(item.version) || 1, Number(latest?.version) || 0) + 1;
  const { data: row, error: insertError } = await db
    .from('item_versions')
    .insert({ item_type: type, item_id: id, version, code, changelog, author_github: user.githubUsername, status: 'pending' })
    .select('id')
    .maybeSingle();
  if (insertError?.code === '23505') return json(req, { error: 'Another version was just submitted. Try again.' }, 409);
  if (insertError || !row) {
    console.error('submit-version insert failed', insertError);
    return json(req, { error: 'Could not save the new version. Try again later.' }, 500);
  }

  const problem = type === 'theme' ? validateThemeCss(code) : 'plugins are always reviewed';
  if (problem) {
    return json(req, { ok: true, version, autoApproved: false, reason: type === 'theme' ? `Auto-check failed: ${problem}` : undefined });
  }

  // a theme that passes the allowlist goes live now, if that fails it simply waits for a reviewer
  const { error: approveError } = await db.rpc('approve_item_version', { p_version_id: row.id });
  if (approveError) {
    console.error('submit-version auto-approve failed', approveError);
    return json(req, { ok: true, version, autoApproved: false });
  }
  return json(req, { ok: true, version, autoApproved: true });
}
