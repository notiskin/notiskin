import { assertEquals } from 'jsr:@std/assert@1';
import { mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const me = { id: 'u1', github: 'octocat' };
const reviewer = { reviewers: { data: { github_username: 'octocat' } } };
const valid = { type: 'theme', id: 'abc', status: 'approved' };

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), mockDb({ user: me, results: reviewer }).client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), mockDb({ user: me, results: reviewer }).client)).status, 401);
});

Deno.test('a signed-in non-reviewer is refused and nothing changes', async () => {
  const db = mockDb({ user: me });
  assertEquals((await handle(post(valid), db.client)).status, 403);
  assertEquals(db.calls.some(c => c.op === 'update'), false);
});

Deno.test('bad input is a 400', async () => {
  const cases: unknown[] = [
    'nope',
    { ...valid, type: 'other' },
    { ...valid, id: undefined },
    { ...valid, id: { a: 1 } },
    { ...valid, status: 'pending' },
    { ...valid, status: 'rejected', reason: 'x'.repeat(1001) },
    { ...valid, status: 'rejected', reason: 5 },
  ];
  for (const body of cases) {
    const db = mockDb({ user: me, results: reviewer });
    assertEquals((await handle(post(body), db.client)).status, 400, JSON.stringify(body));
    assertEquals(db.calls.some(c => c.op === 'update'), false);
  }
});

Deno.test('a reviewer approves a theme, which clears any old rejection reason', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'themes.update': { data: [{ id: 'abc' }] } } });
  const res = await handle(post({ ...valid, reason: 'ignored' }), db.client);
  assertEquals(res.status, 200);
  const update = db.calls.find(c => c.op === 'update')!;
  assertEquals(update.table, 'themes');
  assertEquals(update.values, { status: 'approved', rejection_reason: null });
  assertEquals(update.filters, [['eq', 'id', 'abc']]);
});

Deno.test('a rejection keeps the trimmed reason, on the plugins table for plugins', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'plugins.update': { data: [{ id: 7 }] } } });
  const res = await handle(post({ type: 'plugin', id: 7, status: 'rejected', reason: '  too risky ' }), db.client);
  assertEquals(res.status, 200);
  const update = db.calls.find(c => c.op === 'update')!;
  assertEquals(update.table, 'plugins');
  assertEquals(update.values, { status: 'rejected', rejection_reason: 'too risky' });
});

Deno.test('an unknown id is a 404, a database error a 500', async () => {
  const none = mockDb({ user: me, results: { ...reviewer, 'themes.update': { data: [] } } });
  assertEquals((await handle(post(valid), none.client)).status, 404);
  const broken = mockDb({ user: me, results: { ...reviewer, 'themes.update': { error: { code: 'XX000' } } } });
  assertEquals((await handle(post(valid), broken.client)).status, 500);
});

const VID = '00000000-0000-4000-8000-0000000000a2';
const pendingVersion = { item_versions: { data: { id: VID, item_type: 'plugin', status: 'pending' } } };

Deno.test('a reviewer approves a version through the database function', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, ...pendingVersion } });
  const res = await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), db.client);
  assertEquals(res.status, 200);
  const rpc = db.calls.find(c => c.op === 'rpc')!;
  assertEquals([rpc.table, rpc.values], ['approve_item_version', { p_version_id: VID }]);
  assertEquals(db.calls.some(c => c.table === 'plugins'), false);
});

Deno.test('rejecting a version keeps the reason and leaves the live code alone', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, ...pendingVersion } });
  const res = await handle(post({ type: 'plugin', version_id: VID, status: 'rejected', reason: ' unsafe ' }), db.client);
  assertEquals(res.status, 200);
  const update = db.calls.find(c => c.op === 'update')!;
  assertEquals([update.table, update.values], ['item_versions', { status: 'rejected', rejection_reason: 'unsafe' }]);
  assertEquals(db.calls.some(c => c.op === 'rpc'), false);
});

Deno.test('version decisions: non-reviewers, bad ids, wrong type, already decided', async () => {
  const notReviewer = mockDb({ user: me, results: pendingVersion });
  assertEquals((await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), notReviewer.client)).status, 403);
  assertEquals(notReviewer.calls.some(c => c.op === 'rpc'), false);

  const r = (results: Record<string, unknown>) => mockDb({ user: me, results: { ...reviewer, ...results } as never }).client;
  assertEquals((await handle(post({ type: 'plugin', version_id: 'nope', status: 'approved' }), r(pendingVersion))).status, 400);
  assertEquals((await handle(post({ type: 'theme', version_id: VID, status: 'approved' }), r(pendingVersion))).status, 404);
  assertEquals((await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), r({}))).status, 404);
  const decided = { item_versions: { data: { id: VID, item_type: 'plugin', status: 'approved' } } };
  assertEquals((await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), r(decided))).status, 409);
  const broken = { ...pendingVersion, 'rpc.approve_item_version': { error: { message: 'boom' } } };
  assertEquals((await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), r(broken))).status, 500);
});
