import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

// a fake Supabase client for tests: records every query and answers with whatever the test set up
// results are looked up by "table.operation" (e.g. "themes.insert"), then by "table", then default to { data: null, error: null }

export interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  values?: unknown;
  filters: [string, string, unknown][];
}

export interface FakeResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

export interface FakeUser {
  id: string;
  github?: string | null;
}

export interface MockDb {
  client: SupabaseClient;
  calls: Call[];
}

export function mockDb(opts: { user?: FakeUser | null; results?: Record<string, FakeResult> } = {}): MockDb {
  const calls: Call[] = [];
  const results = opts.results ?? {};

  function from(table: string) {
    const call: Call = { table, op: 'select', filters: [] };
    const answer = (): FakeResult => {
      const r = results[`${table}.${call.op}`] ?? results[table] ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    };
    let recorded = false;
    const record = () => {
      if (!recorded) calls.push(call);
      recorded = true;
    };
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => (...args: unknown[]) => {
      if (name === 'insert' || name === 'update' || name === 'upsert' || name === 'delete') {
        call.op = name;
        call.values = args[0];
      } else if (['eq', 'ilike', 'in', 'gte', 'lte'].includes(name)) {
        call.filters.push([name, String(args[0]), args[1]]);
      }
      return builder;
    };
    for (const name of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'ilike', 'in', 'gte', 'lte', 'order', 'limit']) {
      builder[name] = chain(name);
    }
    builder.maybeSingle = () => {
      record();
      return Promise.resolve(answer());
    };
    builder.single = builder.maybeSingle;
    // awaiting the builder itself runs the query
    builder.then = (resolve: (r: FakeResult) => unknown, reject?: (e: unknown) => unknown) => {
      record();
      return Promise.resolve(answer()).then(resolve, reject);
    };
    return builder;
  }

  const user = opts.user;
  const client = {
    from,
    auth: {
      getUser: (token: string) => {
        if (!user || token === 'bad') return Promise.resolve({ data: { user: null }, error: { message: 'invalid' } });
        return Promise.resolve({
          data: {
            user: {
              id: user.id,
              identities: user.github === null ? [] : [{ provider: 'github', identity_data: { user_name: user.github ?? 'octocat' } }],
            },
          },
          error: null,
        });
      },
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

export function post(body: unknown, opts: { token?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? 'good'}`;
  const method = opts.method ?? 'POST';
  return new Request('http://localhost/fn', {
    method,
    headers,
    body: method === 'GET' || method === 'OPTIONS' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
