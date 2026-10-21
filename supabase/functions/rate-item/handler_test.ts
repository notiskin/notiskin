import { assertEquals } from 'jsr:@std/assert@1';
import { mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const me = { id: 'u1', github: 'octocat' };
const valid = { item_id: 'abc', item_type: 'theme', rating: 4 };

// the item lookup and the ratings list both read "select", so tests answer per table
function db(extra: Record<string, { data?: unknown; error?: { code?: string } | null }> = {}) {
  return mockDb({ user: me, results: { themes: { data: { id: 'abc' } }, ratings: { data: [{ rating: 4 }, { rating: 2 }] }, ...extra } });
}

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), db().client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), db().client)).status, 401);
});

Deno.test('bad input is a 400', async () => {
  const cases: unknown[] = [
    '[]',
    { item_id: 'abc', item_type: 'theme' },
    { item_type: 'theme', rating: 3 },
    { ...valid, item_type: 'other' },
    { ...valid, rating: 6 },
    { ...valid, rating: -1 },
    { ...valid, rating: 2.5 },
    { ...valid, rating: '4' },
    { ...valid, item_id: { a: 1 } },
  ];
  for (const body of cases) {
    const d = db();
    assertEquals((await handle(post(body), d.client)).status, 400, JSON.stringify(body));
    assertEquals(d.calls.some(c => c.table === 'ratings'), false);
  }
});

Deno.test('an item that is missing or not approved cannot be rated', async () => {
  const d = db({ themes: { data: null } });
  assertEquals((await handle(post(valid), d.client)).status, 404);
  assertEquals(d.calls.some(c => c.table === 'ratings'), false);
  const lookup = d.calls.find(c => c.table === 'themes')!;
  assertEquals(lookup.filters.some(f => f[1] === 'status' && f[2] === 'approved'), true);
});

Deno.test('a rating is saved against the signed-in user, not one named in the body', async () => {
  const d = db();
  const res = await handle(post({ ...valid, user_id: 'someone-else' }), d.client);
  assertEquals(res.status, 200);
  const upsert = d.calls.find(c => c.op === 'upsert')!;
  assertEquals((upsert.values as Record<string, unknown>).user_id, 'u1');
  assertEquals((upsert.values as Record<string, unknown>).rating, 4);
  assertEquals(await res.json(), { avg_rating: 3, rating_count: 2 });
  const update = d.calls.find(c => c.op === 'update')!;
  assertEquals(update.table, 'themes');
  assertEquals(update.values, { avg_rating: 3, rating_count: 2 });
});

Deno.test('rating 0 removes your rating, only yours', async () => {
  const d = db({ ratings: { data: [] } });
  const res = await handle(post({ ...valid, rating: 0 }), d.client);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { avg_rating: 0, rating_count: 0 });
  const del = d.calls.find(c => c.op === 'delete')!;
  assertEquals(del.filters.some(f => f[1] === 'user_id' && f[2] === 'u1'), true);
});

Deno.test('plugins are rated on the plugins table', async () => {
  const d = mockDb({ user: me, results: { plugins: { data: { id: 'p1' } }, ratings: { data: [{ rating: 5 }] } } });
  assertEquals((await handle(post({ item_id: 'p1', item_type: 'plugin', rating: 5 }), d.client)).status, 200);
  assertEquals(d.calls.some(c => c.table === 'plugins' && c.op === 'update'), true);
});

Deno.test('write failures are a 500 with a friendly message', async () => {
  const d = db({ 'ratings.upsert': { error: { code: 'XX000' } } });
  assertEquals((await handle(post(valid), d.client)).status, 500);
});
