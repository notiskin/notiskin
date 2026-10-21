import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isUuid, json, preflight, readJson, verifyUser } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/limits.ts';
import { cleanLink, cleanTags } from '../_shared/details.ts';

// an author changes the tags and GitHub link of their own theme or plugin. Neither needs a review:
// tags come from a fixed list and the link can only point at github.com
export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in with GitHub to edit your items.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);
  const { type, id } = body;
  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (!isUuid(id)) return json(req, { error: 'Missing item id' }, 400);
  const tags = cleanTags(body.tags);
  if (tags === null) return json(req, { error: 'Pick up to 3 tags from the list.' }, 400);
  const link = cleanLink(body.link);
  if (link === false) return json(req, { error: 'The link must be a github.com repo or gist.' }, 400);

  const limited = await checkRateLimit(req, db, user, 'details');
  if (limited) return limited;

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data: item, error: itemError } = await db.from(table).select('id,author_github').eq('id', id).maybeSingle();
  if (itemError) {
    console.error('update-details lookup failed', itemError);
    return json(req, { error: 'Could not save. Try again later.' }, 500);
  }
  if (!item) return json(req, { error: `That ${type} doesn't exist.` }, 404);
  // the author comes from the verified GitHub identity, never from the request
  if (String(item.author_github).toLowerCase() !== user.githubUsername.toLowerCase()) {
    return json(req, { error: `Only the author can edit this ${type}.` }, 403);
  }

  const { error } = await db.from(table).update({ tags, link }).eq('id', id);
  if (error) {
    console.error('update-details update failed', error);
    return json(req, { error: 'Could not save. Try again later.' }, 500);
  }
  return json(req, { ok: true, tags, link });
}
