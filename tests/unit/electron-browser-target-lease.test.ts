import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TargetLeaseAuthority, createLeaseRevokePoster, attachManagerWindowLease, type LeaseRevokeBody } from '../../electron/src/main/lib/browser/lease-notifier.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('document replacement queues revoke first and generations increase across windows', async () => {
  const calls: LeaseRevokeBody[] = [];
  const a = new TargetLeaseAuthority({ post: async body => { calls.push(body); return 200; } });
  const first = a.beginDocument(1);
  const other = a.beginDocument(2);
  const next = a.beginDocument(1);
  assert.equal(calls[0]?.generation, first.generation);
  assert.equal(calls[0]?.reason, 'document-replaced');
  assert.ok(first.generation < other.generation && other.generation < next.generation);
  assert.equal(first.ownerId, next.ownerId);
  assert.notEqual(first.ownerId, other.ownerId);
});

test('acquire rejects stale, foreign, malformed and closed documents', async () => {
  const a = new TargetLeaseAuthority({ post: async () => 200 });
  const doc = a.beginDocument(1);
  for (const invalid of [null, {}, { ...doc, authorityId: 'other' }, { ...doc, ownerId: 'other' }, { ...doc, generation: 0 }]) {
    assert.equal((await a.acquireMount(1, invalid)).ok, false);
  }
  a.beginDocument(1);
  assert.equal((await a.acquireMount(1, doc)).ok, false);
  const current = a.beginDocument(2);
  a.closeWindow(2, 'closed');
  assert.equal((await a.acquireMount(2, current)).ok, false);
  assert.equal((await a.acquireMount(999, current)).ok, false);
});

test('revoke barrier times out and grants after recovery', async () => {
  let status = 503;
  const a = new TargetLeaseAuthority({ post: async () => status, grantWaitMs: 25, backoff: { initialMs: 5, maxMs: 10 } });
  a.beginDocument(1);
  const doc = a.beginDocument(1);
  assert.deepEqual(await a.acquireMount(1, doc), { ok: false, retryable: true, error: 'lease revoke pending' });
  status = 200;
  await a.flush(200);
  assert.equal((await a.acquireMount(1, doc)).ok, true);
});

test('terminal statuses drain; network errors and 5xx retry in order', async () => {
  const results: Array<number | 'network-error'> = ['network-error', 503, 204, 400, 403, 404];
  const calls: string[] = [];
  const a = new TargetLeaseAuthority({ post: async body => { calls.push(body.reason); return results.shift()!; }, backoff: { initialMs: 3, maxMs: 5 } });
  a.beginDocument(1);
  for (const reason of ['a', 'b', 'c', 'd']) a.revokeWindow(1, reason);
  await a.flush(200);
  assert.deepEqual(calls, ['a', 'a', 'a', 'b', 'c', 'd']);
});

test('window and guest revokes carry only current identity; closed window refuses grants', async () => {
  const calls: LeaseRevokeBody[] = [];
  const a = new TargetLeaseAuthority({ post: async body => { calls.push(body); return 200; } });
  a.beginDocument(1);
  const doc = a.beginDocument(1);
  a.revokeWindow(1, 'manual');
  a.revokeGuest(1, 42);
  a.closeWindow(1, 'closed');
  await a.flush(100);
  assert.deepEqual(calls.slice(1).map(x => x.generation), [doc.generation, doc.generation, doc.generation]);
  assert.deepEqual(calls[2], { ...doc, guestEpoch: 1, webContentsIds: [42], reason: 'guest-destroyed' });
  assert.equal(a.guestEpoch, 1);
  assert.equal((await a.acquireMount(1, doc)).ok, false);
});

test('only latest unreleased mount is active', async () => {
  const a = new TargetLeaseAuthority({ post: async () => 200 });
  const doc = a.beginDocument(1);
  const first = await a.acquireMount(1, doc);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(a.isMountActive(1, first), true);
  const second = await a.acquireMount(1, doc);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(a.isMountActive(1, first), false);
  assert.equal(a.releaseMount(1, second), true);
  assert.equal(a.isMountActive(1, second), false);
  a.beginDocument(1);
  assert.equal(a.releaseMount(1, second), false);
});

test('flush resolves on drain and timeout', async () => {
  let finish!: (status: number) => void;
  const a = new TargetLeaseAuthority({ post: () => new Promise(resolve => { finish = resolve; }) });
  a.beginDocument(1); a.revokeWindow(1, 'test');
  await a.flush(10);
  let drained = false;
  const pending = a.flush(200).then(() => { drained = true; });
  await delay(5); assert.equal(drained, false);
  finish(200); await pending; assert.equal(drained, true);
});

test('poster uses manager revoke URL, token, and handles transport errors', async () => {
  let url = ''; let init: RequestInit | undefined;
  const post = createLeaseRevokePoster({ managerUrl: () => 'http://localhost:3457/base/', token: 'secret', fetchImpl: (async (input, opts) => { url = String(input); init = opts; return new Response(null, { status: 204 }); }) as typeof fetch });
  const body = { authorityId: 'a', ownerId: 'o', generation: 1, reason: 'test' };
  assert.equal(await post(body), 204);
  assert.equal(url, 'http://localhost:3457/base/api/manager/embedded-browser/lease/revoke');
  assert.equal(new Headers(init?.headers).get('X-CLI-Jaw-Electron'), 'secret');
  assert.deepEqual(JSON.parse(String(init?.body)), body);
  const failing = createLeaseRevokePoster({ managerUrl: () => 'http://localhost/', token: () => 'secret', fetchImpl: (async () => { throw Error('offline'); }) as typeof fetch });
  assert.equal(await failing(body), 'network-error');
});

test('window events revoke current document and close it', async () => {
  const calls: LeaseRevokeBody[] = [];
  const a = new TargetLeaseAuthority({ post: async body => { calls.push(body); return 200; } });
  const contents = new EventEmitter(); const win = new EventEmitter();
  attachManagerWindowLease(a, 1, contents, win);
  const doc = a.beginDocument(1);
  contents.emit('render-process-gone'); win.emit('closed');
  await a.flush(100);
  assert.deepEqual(calls.map(x => x.reason), ['render-process-gone', 'window-closed']);
  assert.equal((await a.acquireMount(1, doc)).ok, false);
});
