import { assertEquals } from 'jsr:@std/assert@1';
import { checkRateLimit, LIMITS } from './limits.ts';
import { mockDb, post } from './mock_db.ts';

const user = { id: 'u1', githubUsername: 'octocat' };
const req = post({});

Deno.test('under the limit: the action is recorded and allowed', async () => {
  const db = mockDb({ results: { rate_limit_events: { count: LIMITS.submit.max - 1 } } });
  assertEquals(await checkRateLimit(req, db.client, user, 'submit'), null);
  const insert = db.calls.find(c => c.op === 'insert')!;
  assertEquals(insert.table, 'rate_limit_events');
  assertEquals(insert.values, { user_id: 'u1', action: 'submit' });
});

Deno.test('the count is only for this user, this action and the recent window', async () => {
  const db = mockDb();
  await checkRateLimit(req, db.client, user, 'rate');
  const count = db.calls[0];
  assertEquals(count.filters.find(f => f[1] === 'user_id')?.[2], 'u1');
  assertEquals(count.filters.find(f => f[1] === 'action')?.[2], 'rate');
  const since = new Date(String(count.filters.find(f => f[0] === 'gte')?.[2])).getTime();
  const expected = Date.now() - LIMITS.rate.windowMinutes * 60_000;
  assertEquals(Math.abs(since - expected) < 5_000, true);
});

Deno.test('at the limit: 429 with Retry-After, and nothing is recorded', async () => {
  const db = mockDb({ results: { rate_limit_events: { count: LIMITS.submit.max } } });
  const res = (await checkRateLimit(req, db.client, user, 'submit'))!;
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('Retry-After'), String(LIMITS.submit.windowMinutes * 60));
  const body = await res.json();
  assertEquals(body.error.includes(String(LIMITS.submit.max)), true);
  assertEquals(db.calls.some(c => c.op === 'insert'), false);
});

Deno.test('if the database fails the request is refused, not let through', async () => {
  const broken = mockDb({ results: { rate_limit_events: { error: { code: 'XX000' } } } });
  assertEquals((await checkRateLimit(req, broken.client, user, 'submit'))?.status, 500);
  const noCount = mockDb({ results: { rate_limit_events: { count: null } } });
  assertEquals((await checkRateLimit(req, noCount.client, user, 'submit'))?.status, 500);
  const noInsert = mockDb({ results: { 'rate_limit_events.insert': { error: { code: 'XX000' } } } });
  assertEquals((await checkRateLimit(req, noInsert.client, user, 'submit'))?.status, 500);
});

Deno.test('old rows for this user are cleaned up after an allowed action', async () => {
  const db = mockDb();
  await checkRateLimit(req, db.client, user, 'submit');
  const del = db.calls.find(c => c.op === 'delete')!;
  assertEquals(del.filters.find(f => f[1] === 'user_id')?.[2], 'u1');
});
