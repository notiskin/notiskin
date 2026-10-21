import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

// the GUI page calls rate-item directly from the local app, everything else goes through the app's server
const ALLOWED_ORIGINS = new Set(['http://localhost:3845', 'http://127.0.0.1:3845']);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'http://localhost:3845',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: corsHeaders(req) }) : null;
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('NS_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

export interface VerifiedUser {
  id: string;
  githubUsername: string;
}

// asks Supabase Auth to validate the token, never trust a decoded-but-unverified JWT
// the GitHub username comes from the linked GitHub identity, not user_metadata,
// because users can rewrite their own user_metadata with auth.updateUser()
export async function verifyUser(req: Request, db: SupabaseClient): Promise<VerifiedUser | null> {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;

  const github = data.user.identities?.find(i => i.provider === 'github');
  const githubUsername = github?.identity_data?.user_name;
  if (typeof githubUsername !== 'string' || !githubUsername) return null;

  return { id: data.user.id, githubUsername };
}

export async function isReviewer(db: SupabaseClient, user: VerifiedUser): Promise<boolean> {
  const { data } = await db
    .from('reviewers')
    .select('github_username')
    .ilike('github_username', user.githubUsername)
    .maybeSingle();
  return !!data;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]/g, '');
}

// "My  Theme " -> "my theme", null if it has anything besides letters, numbers, and spaces
export function cleanItemName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!clean || clean.length > 60 || !/^[a-z0-9 ]+$/.test(clean)) return null;
  return clean;
}

// what changed in a new version, required so users can see why they're updating
export function cleanChangelog(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  return clean.length >= 1 && clean.length <= 500 ? clean : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function cleanDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  return clean.length > 500 ? null : clean;
}
