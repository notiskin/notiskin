import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { json, type VerifiedUser } from './http.ts';

// the rate limits, per signed-in GitHub user. Change the numbers here, then redeploy the functions
export const LIMITS = {
  submit: { max: 5, windowMinutes: 60, label: 'publishing' }, // themes and plugins together
  rate: { max: 30, windowMinutes: 60, label: 'rating' },
  details: { max: 20, windowMinutes: 60, label: 'editing tags and links' },
  report: { max: 10, windowMinutes: 60, label: 'reporting' },
} as const;

export type LimitedAction = keyof typeof LIMITS;

// events older than this are cleaned up, it only has to be longer than the longest window
const KEEP_HOURS = 24;

// returns a 429 Response when the user is over the limit, otherwise records this action and returns null
// if the database can't be reached it refuses (fails closed), a limit that turns off on errors isn't a limit
export async function checkRateLimit(
  req: Request,
  db: SupabaseClient,
  user: VerifiedUser,
  action: LimitedAction,
): Promise<Response | null> {
  const { max, windowMinutes, label } = LIMITS[action];
  const now = Date.now();
  const since = new Date(now - windowMinutes * 60_000).toISOString();

  const { count, error } = await db
    .from('rate_limit_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('action', action)
    .gte('created_at', since);
  if (error || count === null || count === undefined) {
    console.error('rate limit check failed', error);
    return json(req, { error: 'Something went wrong. Try again later.' }, 500);
  }

  if (count >= max) {
    const res = json(
      req,
      { error: `You've hit the limit for ${label} (${max} per ${windowMinutes} minutes). Try again later.` },
      429,
    );
    res.headers.set('Retry-After', String(windowMinutes * 60));
    return res;
  }

  const { error: insertError } = await db.from('rate_limit_events').insert({ user_id: user.id, action });
  if (insertError) {
    console.error('rate limit record failed', insertError);
    return json(req, { error: 'Something went wrong. Try again later.' }, 500);
  }

  // tidy up this user's old rows, not worth failing the request over
  await db
    .from('rate_limit_events')
    .delete()
    .eq('user_id', user.id)
    .lte('created_at', new Date(now - KEEP_HOURS * 3_600_000).toISOString());
  return null;
}
