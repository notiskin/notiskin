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

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]/g, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'No auth token' }, 401);

  const { name: rawName, description, js, author_github } = await req.json() as {
    name: string; description: string; js: string; author_github: string;
  };

  const cleanName = rawName.trim().replace(/  +/g, ' ').toLowerCase();
  if (!cleanName || !/^[a-z0-9 ]+$/.test(cleanName)) {
    return json({ error: 'Letters, numbers, and spaces only.' }, 400);
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('NS_SERVICE_ROLE_KEY')!,
  );

  const name_normalized = normalizeName(cleanName);

  const { error } = await db.from('plugins').insert({
    name: cleanName, name_normalized, description, js, author_github, status: 'pending',
  });

  if (error?.code === '23505') return json({ error: 'A plugin with this name already exists.' }, 409);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, autoApproved: false });
});
