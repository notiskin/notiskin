import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'No auth token' }, 401);

  let username: string;
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    username = payload.user_metadata?.user_name;
    if (!username) throw new Error('no user_name');
  } catch {
    return json({ error: 'Invalid token' }, 401);
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('NS_SERVICE_ROLE_KEY')!,
  );

  const { data: reviewer } = await db
    .from('reviewers')
    .select('*')
    .eq('github_username', username)
    .single();

  if (!reviewer) return json({ error: 'Not a reviewer' }, 403);

  const { type, id, status, reason } = await req.json() as {
    type: string; id: string; status: string; reason?: string;
  };

  const update: Record<string, unknown> = { status };
  if (status === 'rejected') {
    update.rejection_reason = reason ?? null;
  } else if (status === 'approved') {
    update.rejection_reason = null;
  }

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data, error } = await db.from(table).update(update).eq('id', id).select();

  if (error) return json({ error: error.message }, 500);
  if (!data || data.length === 0) return json({ error: 'Submission not found' }, 404);

  return json({ ok: true });
});
