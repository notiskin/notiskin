import { assertEquals } from 'jsr:@std/assert@1';
import { mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const GOOD_CSS = ':root { --ns-bg: #fff; }';
const me = { id: 'u1', github: 'octocat' };
const valid = { name: 'My Theme', description: 'nice', css: GOOD_CSS };

Deno.test('OPTIONS gets a CORS answer', async () => {
  assertEquals((await handle(post({}, { method: 'OPTIONS' }), mockDb().client)).status, 204);
});

Deno.test('only POST is allowed', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), mockDb({ user: me }).client)).status, 405);
});

Deno.test('signing in is required', async () => {
  const none = await handle(post(valid, { token: null }), mockDb({ user: me }).client);
  assertEquals(none.status, 401);
  const bad = await handle(post(valid, { token: 'bad' }), mockDb({ user: me }).client);
  assertEquals(bad.status, 401);
});

Deno.test('bad input is a 400 and nothing is written', async () => {
  const cases: unknown[] = [
    'not json',
    { ...valid, name: 'bad-name!' },
    { ...valid, name: '' },
    { ...valid, description: 'x'.repeat(501) },
    { ...valid, css: '' },
    { ...valid, css: 42 },
    { ...valid, css: ':root { --ns-a: red; }' + ' '.repeat(20_000) },
  ];
  for (const body of cases) {
    const db = mockDb({ user: me });
    assertEquals((await handle(post(body), db.client)).status, 400, JSON.stringify(body).slice(0, 60));
    assertEquals(db.calls.length, 0);
  }
});

Deno.test('a safe theme is auto-approved and the author comes from the verified identity', async () => {
  const db = mockDb({ user: me });
  const res = await handle(post({ ...valid, author_github: 'someone-else' }), db.client);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, autoApproved: true });
  const insert = db.calls.find(c => c.op === 'insert' && c.table !== 'rate_limit_events')!;
  assertEquals(insert.table, 'themes');
  const row = insert.values as Record<string, unknown>;
  assertEquals(row.status, 'approved');
  assertEquals(row.author_github, 'octocat');
  assertEquals(row.name, 'my theme');
  assertEquals(row.name_normalized, 'mytheme');
});

Deno.test('a theme that fails the allowlist waits for review', async () => {
  const db = mockDb({ user: me });
  const res = await handle(post({ ...valid, css: ':root { --ns-a: url(https://evil.example/x); }' }), db.client);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.autoApproved, false);
  const row = db.calls.find(c => c.op === 'insert' && c.table !== 'rate_limit_events')!.values as Record<string, unknown>;
  assertEquals(row.status, 'pending');
});

Deno.test('a duplicate name is a 409', async () => {
  const db = mockDb({ user: me, results: { 'themes.insert': { error: { code: '23505' } } } });
  assertEquals((await handle(post(valid), db.client)).status, 409);
});

Deno.test('other database errors are a 500 with a friendly message', async () => {
  const db = mockDb({ user: me, results: { 'themes.insert': { error: { code: 'XX000', message: 'secret detail' } } } });
  const res = await handle(post(valid), db.client);
  assertEquals(res.status, 500);
  assertEquals((await res.text()).includes('secret detail'), false);
});

Deno.test('over the limit: 429 and no theme is saved', async () => {
  const db = mockDb({ user: me, results: { rate_limit_events: { count: 5 } } });
  assertEquals((await handle(post(valid), db.client)).status, 429);
  assertEquals(db.calls.some(c => c.table === 'themes'), false);
});

Deno.test('bad input does not use up the limit', async () => {
  const db = mockDb({ user: me });
  await handle(post({ ...valid, name: '!!' }), db.client);
  assertEquals(db.calls.some(c => c.table === 'rate_limit_events'), false);
});

Deno.test('tags and a GitHub link are saved with the theme', async () => {
  const db = mockDb({ user: me });
  await handle(post({ ...valid, tags: ['dark', 'minimal'], link: 'https://github.com/octocat/t' }), db.client);
  const row = db.calls.find(c => c.op === 'insert' && c.table === 'themes')!.values as Record<string, unknown>;
  assertEquals([row.tags, row.link], [['dark', 'minimal'], 'https://github.com/octocat/t']);
});

Deno.test('no tags or link is fine, bad ones are a 400', async () => {
  const db = mockDb({ user: me });
  await handle(post(valid), db.client);
  const row = db.calls.find(c => c.op === 'insert' && c.table === 'themes')!.values as Record<string, unknown>;
  assertEquals([row.tags, row.link], [[], null]);
  assertEquals((await handle(post({ ...valid, tags: ['evil'] }), mockDb({ user: me }).client)).status, 400);
  assertEquals((await handle(post({ ...valid, link: 'https://evil.example' }), mockDb({ user: me }).client)).status, 400);
});
