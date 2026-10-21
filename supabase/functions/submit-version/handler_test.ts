import { assertEquals } from 'jsr:@std/assert@1';
import { type Call, type FakeResult, mockDb, post } from '../_shared/mock_db.ts';
import { handle } from './handler.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const me = { id: 'u1', github: 'Octocat' };
const theme = { type: 'theme', id: ID, code: ':root { --ns-bg: #000; }', changelog: 'darker background' };
const plugin = { type: 'plugin', id: ID, code: 'console.log(2)', changelog: 'fixes a bug' };

// item_versions is read twice: the pending check (status = pending) and the latest version
function versions(opts: { pending?: boolean; latest?: number | null } = {}) {
  return (call: Call): FakeResult => {
    if (call.op === 'insert') return { data: { id: 'v-new' } };
    if (call.filters.some(f => f[1] === 'status')) return { data: opts.pending ? [{ id: 'v-old' }] : [] };
    return { data: opts.latest ? { version: opts.latest } : null };
  };
}

function db(extra: Record<string, FakeResult | ((c: Call) => FakeResult)> = {}) {
  const item = { id: ID, author_github: 'octocat', status: 'approved', version: 1 };
  return mockDb({ user: me, results: { themes: { data: item }, plugins: { data: item }, item_versions: versions(), ...extra } });
}

const inserted = (d: ReturnType<typeof db>) =>
  d.calls.find(c => c.table === 'item_versions' && c.op === 'insert')?.values as Record<string, unknown> | undefined;

Deno.test('only POST, and signing in is required', async () => {
  assertEquals((await handle(post({}, { method: 'GET' }), db().client)).status, 405);
  assertEquals((await handle(post(theme, { token: null }), db().client)).status, 401);
});

Deno.test('bad input is a 400 and nothing is written', async () => {
  const cases: unknown[] = [
    'nope',
    { ...theme, type: 'other' },
    { ...theme, id: 'not-a-uuid' },
    { ...theme, changelog: '' },
    { ...theme, changelog: '   ' },
    { ...theme, changelog: 'x'.repeat(501) },
    { ...theme, code: '' },
    { ...theme, code: 'x'.repeat(20_001) },
    { ...plugin, code: 'x'.repeat(200_001) },
  ];
  for (const body of cases) {
    const d = db();
    assertEquals((await handle(post(body), d.client)).status, 400, JSON.stringify(body).slice(0, 80));
    assertEquals(d.calls.length, 0);
  }
});

Deno.test('someone who is not the author is refused', async () => {
  const d = db({ themes: { data: { id: ID, author_github: 'someone-else', status: 'approved', version: 1 } } });
  assertEquals((await handle(post(theme), d.client)).status, 403);
  assertEquals(inserted(d), undefined);
});

Deno.test('a missing item is a 404, an unapproved one a 409', async () => {
  assertEquals((await handle(post(theme), db({ themes: { data: null } }).client)).status, 404);
  const pendingItem = db({ themes: { data: { id: ID, author_github: 'octocat', status: 'pending', version: 1 } } });
  assertEquals((await handle(post(theme), pendingItem.client)).status, 409);
});

Deno.test('only one version can wait for review at a time', async () => {
  const d = db({ item_versions: versions({ pending: true }) });
  const res = await handle(post(plugin), d.client);
  assertEquals(res.status, 409);
  assertEquals(inserted(d), undefined);
});

Deno.test('a safe theme version is approved at once through the database function', async () => {
  const d = db();
  const res = await handle(post(theme), d.client);
  assertEquals(await res.json(), { ok: true, version: 2, autoApproved: true });
  const row = inserted(d)!;
  assertEquals(row.status, 'pending');
  assertEquals(row.author_github, 'Octocat');
  assertEquals(row.changelog, 'darker background');
  const rpc = d.calls.find(c => c.op === 'rpc')!;
  assertEquals([rpc.table, rpc.values], ['approve_item_version', { p_version_id: 'v-new' }]);
});

Deno.test('a theme version that fails the allowlist waits for review', async () => {
  const d = db();
  const res = await handle(post({ ...theme, code: ':root { --ns-a: url(x); }' }), d.client);
  const body = await res.json();
  assertEquals([res.status, body.autoApproved], [200, false]);
  assertEquals(d.calls.some(c => c.op === 'rpc'), false);
});

Deno.test('plugin versions always wait for a reviewer', async () => {
  const d = db();
  const res = await handle(post(plugin), d.client);
  assertEquals((await res.json()).autoApproved, false);
  assertEquals(d.calls.some(c => c.op === 'rpc'), false);
  assertEquals(inserted(d)!.status, 'pending');
});

Deno.test('the version number follows the highest one so far', async () => {
  const d = db({ item_versions: versions({ latest: 4 }) });
  await handle(post(plugin), d.client);
  assertEquals(inserted(d)!.version, 5);
});

Deno.test('if auto-approval fails the version still waits for review', async () => {
  const d = db({ 'rpc.approve_item_version': { error: { message: 'boom' } } });
  const res = await handle(post(theme), d.client);
  assertEquals(await res.json(), { ok: true, version: 2, autoApproved: false });
});

Deno.test('over the publishing limit: 429 and nothing is looked up or written', async () => {
  const d = db({ rate_limit_events: { count: 5 } });
  assertEquals((await handle(post(theme), d.client)).status, 429);
  assertEquals(d.calls.some(c => c.table === 'themes' || c.table === 'item_versions'), false);
});

Deno.test('a version number taken at the same moment is a 409', async () => {
  const d = db({
    item_versions: (call: Call) => (call.op === 'insert' ? { error: { code: '23505' } } : versions()(call)),
  });
  assertEquals((await handle(post(plugin), d.client)).status, 409);
});
