import { assertEquals } from 'jsr:@std/assert@1';
import { type FakeResult, mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const old = { id: 'u1', github: 'Octocat', createdAt: '2026-01-01T00:00:00Z' };
const valid = { type: 'plugin', id: ID, reason: 'harmful', note: '  sends my pages somewhere  ' };

function db(user = old, extra: Record<string, FakeResult> = {}) {
  return mockDb({ user, results: { plugins: { data: { id: ID } }, themes: { data: { id: ID } }, 'rpc.file_report': { data: false }, ...extra } });
}
const rpcArgs = (d: ReturnType<typeof db>) => d.calls.find(c => c.op === 'rpc')?.values as Record<string, unknown> | undefined;

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), db().client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), db().client)).status, 401);
});

Deno.test('bad input is a 400 and nothing is stored', async () => {
  for (const body of ['x', { ...valid, type: 'x' }, { ...valid, id: 'abc' }, { ...valid, reason: 'boring' }, { ...valid, reason: undefined }, { ...valid, note: 'x'.repeat(501) }, { ...valid, note: 5 }]) {
    const d = db();
    assertEquals((await handle(post(body), d.client)).status, 400, JSON.stringify(body).slice(0, 80));
    assertEquals(d.calls.length, 0);
  }
});

Deno.test('a report is stored for the verified user with a trimmed note', async () => {
  const d = db();
  const res = await handle(post({ ...valid, reporter_github: 'someone-else' }), d.client);
  assertEquals(await res.json(), { ok: true, hidden: false });
  assertEquals(rpcArgs(d), {
    p_item_type: 'plugin',
    p_item_id: ID,
    p_reporter_id: 'u1',
    p_reporter_github: 'Octocat',
    p_reason: 'harmful',
    p_note: 'sends my pages somewhere',
    p_counts_for_hiding: true,
  });
});

Deno.test('accounts younger than a day can report but do not count toward hiding', async () => {
  const d = db({ id: 'u2', github: 'newbie', createdAt: new Date(Date.now() - 60_000).toISOString() });
  await handle(post(valid), d.client);
  assertEquals(rpcArgs(d)?.p_counts_for_hiding, false);
});

Deno.test('the response says when the item got hidden', async () => {
  const res = await handle(post(valid), db(old, { 'rpc.file_report': { data: true } }).client);
  assertEquals(await res.json(), { ok: true, hidden: true });
});

Deno.test('one report per person per item', async () => {
  const res = await handle(post(valid), db(old, { 'rpc.file_report': { error: { code: '23505' } } }).client);
  assertEquals(res.status, 409);
});

Deno.test('only approved items can be reported, and the limit applies', async () => {
  const missing = db(old, { plugins: { data: null } });
  assertEquals((await handle(post(valid), missing.client)).status, 404);
  assertEquals(rpcArgs(missing), undefined);
  const ok = db();
  await handle(post(valid), ok.client);
  const lookup = ok.calls.find(c => c.table === 'plugins')!;
  assertEquals(lookup.filters.some(f => f[1] === 'status' && f[2] === 'approved'), true);
  const limited = db(old, { rate_limit_events: { count: 10 } });
  assertEquals((await handle(post(valid), limited.client)).status, 429);
  assertEquals(rpcArgs(limited), undefined);
});

Deno.test('a database error is a 500', async () => {
  assertEquals((await handle(post(valid), db(old, { 'rpc.file_report': { error: { message: 'boom' } } }).client)).status, 500);
});
