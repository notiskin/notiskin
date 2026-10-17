import { adminClient, cleanDescription, cleanItemName, json, normalizeName, preflight, readJson, verifyUser } from '../_shared/http.ts';
import { validateThemeCss } from '../_shared/css.ts';

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const db = adminClient();
  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in with GitHub to publish.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);

  const name = cleanItemName(body.name);
  if (!name) return json(req, { error: 'Name must be 1-60 letters, numbers, and spaces.' }, 400);
  const description = cleanDescription(body.description);
  if (description === null) return json(req, { error: 'Description must be 500 characters or fewer.' }, 400);
  if (typeof body.css !== 'string' || !body.css.trim()) return json(req, { error: 'Theme CSS is empty.' }, 400);
  if (body.css.length > 20_000) return json(req, { error: 'Theme CSS is too long.' }, 400);
  const css = body.css;

  // valid themes are auto-approved, anything else waits for a human reviewer
  const problem = validateThemeCss(css);
  const { error } = await db.from('themes').insert({
    name,
    name_normalized: normalizeName(name),
    description,
    css,
    author_github: user.githubUsername,
    status: problem ? 'pending' : 'approved',
    rejection_reason: problem ? `Auto-check failed: ${problem}` : null,
  });

  if (error?.code === '23505') return json(req, { error: 'A theme with this name already exists.' }, 409);
  if (error) {
    console.error('submit-theme insert failed', error);
    return json(req, { error: 'Could not save your theme. Try again later.' }, 500);
  }
  return problem
    ? json(req, { ok: true, autoApproved: false, reason: `Auto-check failed: ${problem}` })
    : json(req, { ok: true, autoApproved: true });
});
