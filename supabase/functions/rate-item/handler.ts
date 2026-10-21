import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { adminClient, json, preflight, readJson, verifyUser } from '../_shared/http.ts';

export async function handle(req: Request, db: SupabaseClient = adminClient()): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  try {
      const user = await verifyUser(req, db);
    if (!user) return json(req, { error: 'Unauthorized' }, 401);

    const body = await readJson(req);
    if (!body) return json(req, { error: 'Invalid request body' }, 400);
    const { item_id, item_type, rating } = body;

    if ((typeof item_id !== 'string' && typeof item_id !== 'number') || item_type === undefined || rating === undefined) {
      return json(req, { error: 'Missing required fields' }, 400);
    }
    if (item_type !== 'theme' && item_type !== 'plugin') return json(req, { error: 'Invalid item type' }, 400);
    if (!Number.isInteger(rating) || (rating as number) < 0 || (rating as number) > 5) {
      return json(req, { error: 'Rating must be between 0 and 5' }, 400);
    }

    const table = item_type === 'theme' ? 'themes' : 'plugins';

    // only approved items can be rated, stops rating spam on ids that don't exist or aren't public
    const { data: item } = await db.from(table).select('id').eq('id', item_id).eq('status', 'approved').maybeSingle();
    if (!item) return json(req, { error: 'Item not found' }, 404);

    // 0 means "remove my rating"
    const { error: writeError } = rating === 0
      ? await db.from('ratings').delete().eq('user_id', user.id).eq('item_id', item_id).eq('item_type', item_type)
      : await db.from('ratings').upsert(
          { user_id: user.id, item_id, item_type, rating, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,item_id,item_type' },
        );
    if (writeError) {
      console.error('rate-item write failed', writeError);
      return json(req, { error: 'Could not save your rating' }, 500);
    }

    const { data: ratings, error: fetchError } = await db
      .from('ratings')
      .select('rating')
      .eq('item_id', item_id)
      .eq('item_type', item_type);
    if (fetchError) {
      console.error('rate-item fetch failed', fetchError);
      return json(req, { error: 'Could not update the rating' }, 500);
    }

    const count = ratings.length;
    const avg = count > 0 ? ratings.reduce((sum, r) => sum + r.rating, 0) / count : 0;

    const { error: updateError } = await db.from(table).update({ avg_rating: avg, rating_count: count }).eq('id', item_id);
    if (updateError) {
      console.error('rate-item aggregate update failed', updateError);
      return json(req, { error: 'Could not update the rating' }, 500);
    }

    return json(req, { avg_rating: avg, rating_count: count });
  } catch (err) {
    console.error('rate-item failed', err);
    return json(req, { error: 'Something went wrong' }, 500);
  }
}
