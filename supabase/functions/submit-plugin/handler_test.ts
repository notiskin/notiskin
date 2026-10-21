import { assertEquals } from 'jsr:@std/assert@1';
import { mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const me = { id: 'u1', github: 'octocat' };
const valid = { name: 'My Plugin', description: 'does a thing', js: 'console.log(1)' };

Deno.test('only POST is allowed, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), mockDb({ user: me }).client)).status, 405);
  assertEquals((await handle(post(valid, { token: null }), mockDb({ user: me }).client)).status, 401);
});

Deno.test('bad input is a 400 and nothing is written', async () => {
  const cases: unknown[] = [
    '[]',
    { ...valid, name: 'no/slashes' },
    { ...valid, description: 'x'.repeat(501) },
    { ...valid, js: '   ' },
    { ...valid, js: 5 },
    { ...valid, js: 'x'.repeat(200_001) },
  ];
  for (const body of cases) {
    const db = mockDb({ user: me });
    assertEquals((await handle(post(body), db.client)).status, 400, JSON.stringify(body).slice(0, 60));
    assertEquals(db.calls.length, 0);
  }
});

Deno.test('plugins are always pending, whatever the client says', async () => {
  const db = mockDb({ user: me });
  const res = await handle(post({ ...valid, status: 'approved' }), db.client);
  assertEquals(await res.json(), { ok: true, autoApproved: false });
  const row = db.calls.find(c => c.op === 'insert')!.values as Record<string, unknown>;
  assertEquals(row.status, 'pending');
  assertEquals(row.author_github, 'octocat');
  assertEquals(row.name_normalized, 'myplugin');
});

Deno.test('a duplicate name is a 409, other errors a 500', async () => {
  const dup = mockDb({ user: me, results: { 'plugins.insert': { error: { code: '23505' } } } });
  assertEquals((await handle(post(valid), dup.client)).status, 409);
  const broken = mockDb({ user: me, results: { 'plugins.insert': { error: { code: 'XX000' } } } });
  assertEquals((await handle(post(valid), broken.client)).status, 500);
});
