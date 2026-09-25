import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDockIcon, type DockIconHost } from '../../electron/src/main/lib/dock-icon.ts';

function host(overrides: Partial<DockIconHost> = {}) {
  const calls: string[] = [];
  const h: DockIconHost = {
    platform: 'darwin',
    dock: { setIcon: (p: string) => { calls.push(p); } },
    exists: () => true,
    ...overrides,
  };
  return { h, calls };
}

test('darwin sets the Dock tile from the bundled icon', () => {
  const { h, calls } = host();
  assert.equal(applyDockIcon(h, '/App/Resources/icon.png'), true);
  assert.deepEqual(calls, ['/App/Resources/icon.png']);
});

test('non-darwin and missing dock are no-ops', () => {
  const win = host({ platform: 'win32' });
  assert.equal(applyDockIcon(win.h, '/x.png'), false);
  assert.deepEqual(win.calls, []);
  assert.equal(applyDockIcon(host({ dock: undefined }).h, '/x.png'), false);
});

test('missing icon file or setIcon failure does not throw', () => {
  const missing = host({ exists: () => false });
  assert.equal(applyDockIcon(missing.h, '/x.png'), false);
  assert.deepEqual(missing.calls, []);
  const failing = host({ dock: { setIcon: () => { throw new Error('bad image'); } } });
  assert.equal(applyDockIcon(failing.h, '/x.png'), false);
});
