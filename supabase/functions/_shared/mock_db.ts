import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

// a fake Supabase client for tests: records every query and answers with whatever the test set up
// results are looked up by "table.operation" (e.g. "themes.insert"), then by "table", then default to { data: null, error: null }

export interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
  values?: unknown;
  filters: [string, string, unknown][];
}

export interface FakeResult {
  data?: unknown;
  count?: number | null;
  error?: { code?: string; message?: string } | null;
}

// a result can also be worked out from the query, for tables that are read more than one way
export type ResultSpec = FakeResult | ((call: Call) => FakeResult);

export interface FakeUser {
  id: string;
  github?: string | null;
  createdAt?: string;
}

export interface MockDb {
  client: SupabaseClient;
  calls: Call[];
}

export function mockDb(opts: { user?: FakeUser | null; results?: Record<string, ResultSpec> } = {}): MockDb {
  const calls: Call[] = [];
  const results = opts.results ?? {};

  function from(table: string) {
    const call: Call = { table, op: 'select', filters: [] };
    const answer = (): FakeResult => {
      const spec = results[`${table}.${call.op}`] ?? results[table] ?? {};
      const r = typeof spec === 'function' ? spec(call) : spec;
      // count defaults to 0 so code that checks rate limits sees an unused limit
      return { data: r.data ?? null, error: r.error ?? null, count: r.count === undefined ? 0 : r.count };
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

  function rpc(name: string, args: unknown) {
    const call: Call = { table: name, op: 'rpc', values: args, filters: [] };
    calls.push(call);
    const spec = results[`rpc.${name}`] ?? {};
    const r = typeof spec === 'function' ? spec(call) : spec;
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  }

  const user = opts.user;
  const client = {
    from,
    rpc,
    auth: {
      getUser: (token: string) => {
        if (!user || token === 'bad') return Promise.resolve({ data: { user: null }, error: { message: 'invalid' } });
        return Promise.resolve({
          data: {
            user: {
              id: user.id,
              created_at: user.createdAt ?? '2026-01-01T00:00:00Z',
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
