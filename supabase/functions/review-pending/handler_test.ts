import { assertEquals } from 'jsr:@std/assert@1';
import { mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const me = { id: 'u1', github: 'octocat' };
const reviewer = { reviewers: { data: { github_username: 'octocat' } } };

Deno.test('signing in is required', async () => {
  assertEquals((await handle(post({}, { token: null }), mockDb({ user: me, results: reviewer }).client)).status, 401);
  assertEquals((await handle(post({}, { token: 'bad' }), mockDb({ user: me, results: reviewer }).client)).status, 401);
});

Deno.test('a non-reviewer sees nothing from the queue', async () => {
  const db = mockDb({ user: me, results: { themes: { data: [{ id: 1 }] } } });
  const res = await handle(post({}), db.client);
  assertEquals(res.status, 403);
  assertEquals(db.calls.some(c => c.table === 'themes' || c.table === 'plugins'), false);
});

Deno.test('a reviewer gets all four lists', async () => {
  const db = mockDb({
    user: me,
    results: { ...reviewer, themes: { data: [{ id: 1 }] }, plugins: { data: [{ id: 2 }] } },
  });
  const res = await handle(post({}), db.client);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    versions: [],
    themes: [{ id: 1 }],
    plugins: [{ id: 2 }],
    rejectedThemes: [{ id: 1 }],
    rejectedPlugins: [{ id: 2 }],
  });
});

Deno.test('a failing query is a 500', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, plugins: { error: { code: 'XX000' } } } });
  assertEquals((await handle(post({}), db.client)).status, 500);
});

Deno.test('pending versions come with the item name and the live code to diff against', async () => {
  const db = mockDb({
    user: me,
    results: {
      ...reviewer,
      item_versions: { data: [{ id: 'v2', item_type: 'plugin', item_id: 'p1', version: 2, code: 'new()' }] },
      plugins: (call) => call.filters.some(f => f[0] === 'in')
        ? { data: [{ id: 'p1', name: 'clock', js: 'old()' }] }
        : { data: [] },
    },
  });
  const body = await (await handle(post({}), db.client)).json();
  assertEquals(body.versions, [{ id: 'v2', item_type: 'plugin', item_id: 'p1', version: 2, code: 'new()', name: 'clock', previous_code: 'old()' }]);
});
