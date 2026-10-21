import { assertEquals } from 'jsr:@std/assert@1';
import { cleanDescription, cleanItemName, isReviewer, normalizeName, preflight, readJson, verifyUser } from './http.ts';
import { mockDb, post } from './mock_db.ts';

Deno.test('normalizeName drops case, spaces, dashes and underscores', () => {
  assertEquals(normalizeName('My Dark-Theme_2'), 'mydarktheme2');
});

Deno.test('cleanItemName tidies spaces and lowercases', () => {
  assertEquals(cleanItemName('  My   Theme '), 'my theme');
});

Deno.test('cleanItemName rejects bad names', () => {
  for (const bad of ['', '   ', 'a'.repeat(61), 'dark-mode', 'héllo', '<b>x</b>', 5, null, undefined]) {
    assertEquals(cleanItemName(bad), null, String(bad));
  }
  assertEquals(cleanItemName('a'.repeat(60)), 'a'.repeat(60));
});

Deno.test('cleanDescription allows empty, trims, caps at 500', () => {
  assertEquals(cleanDescription(undefined), '');
  assertEquals(cleanDescription(null), '');
  assertEquals(cleanDescription('  hi  '), 'hi');
  assertEquals(cleanDescription('a'.repeat(500)), 'a'.repeat(500));
  assertEquals(cleanDescription('a'.repeat(501)), null);
  assertEquals(cleanDescription(42), null);
});

Deno.test('readJson only accepts a JSON object', async () => {
  assertEquals(await readJson(post({ a: 1 })), { a: 1 });
  assertEquals(await readJson(post('not json')), null);
  assertEquals(await readJson(post('[1,2]')), null);
  assertEquals(await readJson(post('null')), null);
});

Deno.test('preflight answers OPTIONS and nothing else', () => {
  assertEquals(preflight(post({}, { method: 'OPTIONS' }))?.status, 204);
  assertEquals(preflight(post({})), null);
});

Deno.test('verifyUser: needs a bearer token Supabase accepts', async () => {
  const ok = mockDb({ user: { id: 'u1', github: 'Octocat' } });
  assertEquals(await verifyUser(post({}), ok.client), { id: 'u1', githubUsername: 'Octocat' });
  assertEquals(await verifyUser(post({}, { token: null }), ok.client), null);
  assertEquals(await verifyUser(post({}, { token: 'bad' }), ok.client), null);
  assertEquals(await verifyUser(post({}, { token: '' }), ok.client), null);
});

Deno.test('verifyUser: refuses a user with no GitHub identity', async () => {
  const noGithub = mockDb({ user: { id: 'u1', github: null } });
  assertEquals(await verifyUser(post({}), noGithub.client), null);
});

Deno.test('isReviewer follows the reviewers table', async () => {
  const user = { id: 'u1', githubUsername: 'octocat' };
  assertEquals(await isReviewer(mockDb({ results: { reviewers: { data: { github_username: 'octocat' } } } }).client, user), true);
  assertEquals(await isReviewer(mockDb().client, user), false);
});
