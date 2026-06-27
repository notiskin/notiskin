import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'No auth token' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let username: string;
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    username = payload.user_metadata?.user_name;
    if (!username) throw new Error('no user_name');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
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

  if (!reviewer) {
    return new Response(JSON.stringify({ error: 'Not a reviewer' }), {
      status: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const [
    { data: themes },
    { data: plugins },
    { data: rejectedThemes },
    { data: rejectedPlugins },
  ] = await Promise.all([
    db.from('themes').select('*').eq('status', 'pending'),
    db.from('plugins').select('*').eq('status', 'pending'),
    db.from('themes')
      .select('id,name,author_github,description,css,rejection_reason')
      .eq('status', 'rejected')
      .order('updated_at', { ascending: false })
      .limit(30),
    db.from('plugins')
      .select('id,name,author_github,description,js,rejection_reason')
      .eq('status', 'rejected')
      .order('updated_at', { ascending: false })
      .limit(30),
  ]);

  return new Response(
    JSON.stringify({
      themes: themes ?? [],
      plugins: plugins ?? [],
      rejectedThemes: rejectedThemes ?? [],
      rejectedPlugins: rejectedPlugins ?? [],
    }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
});
