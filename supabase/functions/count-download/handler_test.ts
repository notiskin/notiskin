import { assertEquals } from 'jsr:@std/assert@1';
import { type FakeResult, mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const me = { id: 'u1', github: 'octocat' };
const valid = { type: 'theme', id: ID };

function db(extra: Record<string, FakeResult> = {}) {
  return mockDb({ user: me, results: { themes: { data: { id: ID } }, plugins: { data: { id: ID } }, 'rpc.record_download': { data: true }, ...extra } });
}

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), db().client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), db().client)).status, 401);
});

Deno.test('bad input is a 400', async () => {
  for (const body of ['x', { type: 'x', id: ID }, { type: 'theme', id: 'abc' }, { type: 'theme' }]) {
    const d = db();
    assertEquals((await handle(post(body), d.client)).status, 400, JSON.stringify(body));
    assertEquals(d.calls.length, 0);
  }
});

Deno.test('counts for the signed-in user, not one named in the body', async () => {
  const d = db();
  const res = await handle(post({ ...valid, user_id: 'someone-else' }), d.client);
  assertEquals(await res.json(), { ok: true, counted: true });
  const rpc = d.calls.find(c => c.op === 'rpc')!;
  assertEquals([rpc.table, rpc.values], ['record_download', { p_user_id: 'u1', p_item_type: 'theme', p_item_id: ID }]);
  const lookup = d.calls.find(c => c.table === 'themes')!;
  assertEquals(lookup.filters.some(f => f[1] === 'status' && f[2] === 'approved'), true);
});

Deno.test('a second install the same day is not counted', async () => {
  const res = await handle(post(valid), db({ 'rpc.record_download': { data: false } }).client);
  assertEquals(await res.json(), { ok: true, counted: false });
});

Deno.test('unapproved or missing items are a 404, database errors a 500', async () => {
  const missing = db({ plugins: { data: null } });
  assertEquals((await handle(post({ type: 'plugin', id: ID }), missing.client)).status, 404);
  assertEquals(missing.calls.some(c => c.op === 'rpc'), false);
  assertEquals((await handle(post(valid), db({ 'rpc.record_download': { error: { message: 'boom' } } }).client)).status, 500);
});
