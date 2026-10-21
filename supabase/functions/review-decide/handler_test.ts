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
