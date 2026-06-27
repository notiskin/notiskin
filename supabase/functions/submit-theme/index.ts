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

  const { name: rawName, description, css, author_github } = await req.json() as {
    name: string; description: string; css: string; author_github: string;
  };

  const cleanName = rawName.trim().replace(/  +/g, ' ').toLowerCase();
  if (!cleanName || !/^[a-z0-9 ]+$/.test(cleanName)) {
    return json({ error: 'Letters, numbers, and spaces only.' }, 400);
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('NS_SERVICE_ROLE_KEY')!,
  );

  let reason: string | null = null;

  if (/url\s*\(/i.test(css)) {
    reason = "url() isn't allowed";
  } else if (/@import/i.test(css)) {
    reason = "@import isn't allowed";
  } else {
    const rootStripped = css
      .replace(/:root\s*\{[\s\S]*?\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\S/.test(rootStripped)) {
      reason = 'All rules must be inside a :root block';
    } else {
      for (const rawLine of css.split('\n')) {
        const line = rawLine.trim();
        if (!line.includes(':')) continue;
        if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('//')) continue;
        if (line.startsWith(':root') || line === '{' || line.startsWith('}')) continue;
        const prop = line.split(':')[0].trim();
        if (prop && !prop.startsWith('--ns-')) {
          reason = `${prop} must start with --ns-`;
          break;
        }
      }
    }
  }

  const name_normalized = normalizeName(cleanName);

  if (reason) {
    const { error } = await db.from('themes').insert({
      name: cleanName, name_normalized, description, css, author_github, status: 'pending',
      rejection_reason: `Auto-check failed: ${reason}`,
    });
    if (error?.code === '23505') return json({ error: 'A theme with this name already exists.' }, 409);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, autoApproved: false, reason: `Auto-check failed: ${reason}` });
  } else {
    const { error } = await db.from('themes').insert({
      name: cleanName, name_normalized, description, css, author_github, status: 'approved',
    });
    if (error?.code === '23505') return json({ error: 'A theme with this name already exists.' }, 409);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, autoApproved: true });
  }
});
