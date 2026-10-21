import { assertEquals } from 'jsr:@std/assert@1';
import { type FakeResult, mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const me = { id: 'u1', github: 'Octocat' };
const valid = { type: 'theme', id: ID, tags: ['dark', 'minimal'], link: 'https://github.com/octocat/dark' };

function db(extra: Record<string, FakeResult> = {}) {
  return mockDb({ user: me, results: { themes: { data: { id: ID, author_github: 'octocat' } }, plugins: { data: { id: ID, author_github: 'octocat' } }, ...extra } });
}
const updateOf = (d: ReturnType<typeof db>) => d.calls.find(c => c.op === 'update');

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), db().client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), db().client)).status, 401);
});

Deno.test('bad input is a 400 and nothing is written', async () => {
  for (const body of [
    'nope',
    { ...valid, type: 'x' },
    { ...valid, id: 'abc' },
    { ...valid, tags: ['evil'] },
    { ...valid, tags: ['dark', 'light', 'fun', 'fonts'] },
    { ...valid, link: 'https://evil.example/x' },
    { ...valid, link: 'javascript:alert(1)' },
  ]) {
    const d = db();
    assertEquals((await handle(post(body), d.client)).status, 400, JSON.stringify(body));
    assertEquals(d.calls.length, 0);
  }
});

Deno.test('the author saves tags and link', async () => {
  const d = db();
  const res = await handle(post(valid), d.client);
  assertEquals(res.status, 200);
  const update = updateOf(d)!;
  assertEquals([update.table, update.values], ['themes', { tags: ['dark', 'minimal'], link: 'https://github.com/octocat/dark' }]);
  assertEquals(update.filters, [['eq', 'id', ID]]);
});

Deno.test('an empty link removes it, and plugins use the plugins table', async () => {
  const d = db();
  await handle(post({ type: 'plugin', id: ID, tags: [], link: '' }), d.client);
  assertEquals([updateOf(d)!.table, updateOf(d)!.values], ['plugins', { tags: [], link: null }]);
});

Deno.test('someone else cannot edit the item', async () => {
  const d = db({ themes: { data: { id: ID, author_github: 'someone-else' } } });
  assertEquals((await handle(post(valid), d.client)).status, 403);
  assertEquals(updateOf(d), undefined);
});

Deno.test('a missing item is a 404, a failed write a 500, over the limit a 429', async () => {
  assertEquals((await handle(post(valid), db({ themes: { data: null } }).client)).status, 404);
  assertEquals((await handle(post(valid), db({ 'themes.update': { error: { code: 'XX000' } } }).client)).status, 500);
  const limited = db({ rate_limit_events: { count: 20 } });
  assertEquals((await handle(post(valid), limited.client)).status, 429);
  assertEquals(updateOf(limited), undefined);
});
