import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, cleanDescription, cleanItemName, json, normalizeName, preflight, readJson, verifyUser } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/limits.ts';

const MAX_JS_LENGTH = 200_000;

export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in with GitHub to publish.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);

  const name = cleanItemName(body.name);
  if (!name) return json(req, { error: 'Name must be 1-60 letters, numbers, and spaces.' }, 400);
  const description = cleanDescription(body.description);
  if (description === null) return json(req, { error: 'Description must be 500 characters or fewer.' }, 400);
  if (typeof body.js !== 'string' || !body.js.trim()) return json(req, { error: 'Plugin code is empty.' }, 400);
  if (body.js.length > MAX_JS_LENGTH) return json(req, { error: 'Plugin code is too long.' }, 400);

  const limited = await checkRateLimit(req, db, user, 'submit');
  if (limited) return limited;

  // plugins run arbitrary JS in Notion, they always wait for a human reviewer
  const { error } = await db.from('plugins').insert({
    name,
    name_normalized: normalizeName(name),
    description,
    js: body.js,
    author_github: user.githubUsername,
    status: 'pending',
  });

  if (error?.code === '23505') return json(req, { error: 'A plugin with this name already exists.' }, 409);
  if (error) {
    console.error('submit-plugin insert failed', error);
    return json(req, { error: 'Could not save your plugin. Try again later.' }, 500);
  }
  return json(req, { ok: true, autoApproved: false });
}
