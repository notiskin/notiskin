import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, isUuid, json, preflight, readJson, verifyUser } from '../_shared/http.ts';

// the app calls this after a signed-in user installs an approved item. record_download() counts it
// at most once per user per item per day, so installing over and over doesn't pump the number
export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const user = await verifyUser(req, db);
  if (!user) return json(req, { error: 'Sign in to count downloads.' }, 401);

  const body = await readJson(req);
  if (!body) return json(req, { error: 'Invalid request body' }, 400);
  const { type, id } = body;
  if (type !== 'theme' && type !== 'plugin') return json(req, { error: 'type must be theme or plugin' }, 400);
  if (!isUuid(id)) return json(req, { error: 'Missing item id' }, 400);

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data: item, error: itemError } = await db.from(table).select('id').eq('id', id).eq('status', 'approved').maybeSingle();
  if (itemError) {
    console.error('count-download lookup failed', itemError);
    return json(req, { error: 'Could not count the download' }, 500);
  }
  if (!item) return json(req, { error: 'Item not found' }, 404);

  const { data: counted, error } = await db.rpc('record_download', { p_user_id: user.id, p_item_type: type, p_item_id: id });
  if (error) {
    console.error('count-download failed', error);
    return json(req, { error: 'Could not count the download' }, 500);
  }
  return json(req, { ok: true, counted: counted === true });
}
