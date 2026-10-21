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

const IID = '00000000-0000-4000-8000-0000000000b1';
const RID = '00000000-0000-4000-8000-0000000000c1';
const logged = (db: ReturnType<typeof mockDb>) => db.calls.filter(c => c.table === 'review_actions' && c.op === 'insert').map(c => c.values as Record<string, unknown>);

Deno.test('every item decision is written to the action log', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'themes.update': { data: [{ id: 'abc' }] } } });
  await handle(post({ ...valid, status: 'rejected', reason: 'broken' }), db.client);
  const [entry] = logged(db);
  assertEquals([entry.actor_github, entry.action, entry.item_type, entry.item_id, entry.reason], ['octocat', 'reject', 'theme', 'abc', 'broken']);
  // rejecting settles the item's open reports
  const settle = db.calls.find(c => c.table === 'reports' && c.op === 'update')!;
  assertEquals((settle.values as Record<string, unknown>).status, 'actioned');
});

Deno.test('version decisions are logged too', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, ...pendingVersion } });
  await handle(post({ type: 'plugin', version_id: VID, status: 'approved' }), db.client);
  assertEquals(logged(db).map(e => [e.action, e.version_id]), [['approve_version', VID]]);
});

Deno.test('if the log cannot be written the reviewer is told', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'themes.update': { data: [{ id: 'abc' }] }, 'review_actions.insert': { error: { message: 'boom' } } } });
  const res = await handle(post(valid), db.client);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error.includes('action log'), true);
});

Deno.test('a reviewer hides an approved item, which settles its reports and is logged', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'plugins.update': { data: [{ id: IID }] } } });
  const res = await handle(post({ action: 'hide', type: 'plugin', id: IID, reason: 'reads tokens' }), db.client);
  assertEquals(res.status, 200);
  const update = db.calls.find(c => c.table === 'plugins' && c.op === 'update')!;
  assertEquals(update.values, { status: 'hidden' });
  assertEquals(update.filters.find(f => f[1] === 'status')?.[2], 'approved');
  const settle = db.calls.find(c => c.table === 'reports' && c.op === 'update')!;
  assertEquals((settle.values as Record<string, unknown>).status, 'actioned');
  assertEquals(logged(db).map(e => [e.action, e.item_id, e.reason]), [['hide', IID, 'reads tokens']]);
});

Deno.test('unhiding puts a hidden item back and dismisses its reports', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'themes.update': { data: [{ id: IID }] } } });
  await handle(post({ action: 'unhide', type: 'theme', id: IID }), db.client);
  const update = db.calls.find(c => c.table === 'themes' && c.op === 'update')!;
  assertEquals([update.values, update.filters.find(f => f[1] === 'status')?.[2]], [{ status: 'approved' }, 'hidden']);
  assertEquals((db.calls.find(c => c.table === 'reports' && c.op === 'update')!.values as Record<string, unknown>).status, 'dismissed');
  assertEquals(logged(db).map(e => e.action), ['unhide']);
});

Deno.test('hide and unhide refuse items in the wrong state, bad ids and unknown actions', async () => {
  const r = (results: Record<string, unknown> = {}) => mockDb({ user: me, results: { ...reviewer, ...results } as never });
  assertEquals((await handle(post({ action: 'hide', type: 'theme', id: IID }), r({ 'themes.update': { data: [] } }).client)).status, 409);
  assertEquals((await handle(post({ action: 'hide', type: 'theme', id: 'x' }), r().client)).status, 400);
  assertEquals((await handle(post({ action: 'hide', type: 'other', id: IID }), r().client)).status, 400);
  assertEquals((await handle(post({ action: 'delete', type: 'theme', id: IID }), r().client)).status, 400);
});

Deno.test('dismissing one report is logged with the report id', async () => {
  const db = mockDb({ user: me, results: { ...reviewer, 'reports.update': { data: [{ item_type: 'theme', item_id: IID }] } } });
  const res = await handle(post({ action: 'dismiss_report', report_id: RID }), db.client);
  assertEquals(res.status, 200);
  assertEquals(logged(db).map(e => [e.action, e.report_id, e.item_id]), [['dismiss_report', RID, IID]]);
  const gone = mockDb({ user: me, results: { ...reviewer, 'reports.update': { data: [] } } });
  assertEquals((await handle(post({ action: 'dismiss_report', report_id: RID }), gone.client)).status, 404);
});

Deno.test('non-reviewers cannot hide, unhide or dismiss', async () => {
  for (const body of [{ action: 'hide', type: 'theme', id: IID }, { action: 'unhide', type: 'theme', id: IID }, { action: 'dismiss_report', report_id: RID }]) {
    const db = mockDb({ user: me });
    assertEquals((await handle(post(body), db.client)).status, 403);
    assertEquals(db.calls.some(c => c.op === 'update' || c.op === 'insert'), false);
  }
});
