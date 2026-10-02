import test from 'node:test';
import assert from 'node:assert/strict';

import {
  quitAfterDialog,
  runStartupAfterBootstrap,
} from '../../electron/src/main/lib/fatal-quit.ts';

test('quitAfterDialog quits once after the dialog resolves without logging', async () => {
  let quits = 0;
  const logs: string[] = [];

  await quitAfterDialog(
    async () => undefined,
    () => { quits += 1; },
    message => logs.push(message),
  );

  assert.equal(quits, 1);
  assert.deepEqual(logs, []);
});

test('quitAfterDialog logs a rejected dialog and still quits once', async () => {
  let quits = 0;
  const logs: string[] = [];

  await quitAfterDialog(
    async () => { throw new Error('dialog unavailable'); },
    () => { quits += 1; },
    message => logs.push(message),
  );

  assert.equal(quits, 1);
  assert.deepEqual(logs, ['[fatal dialog error] dialog unavailable\n']);
});

test('runStartupAfterBootstrap stops startup after bootstrap begins shutdown', async () => {
  let shuttingDown = false;
  let continuations = 0;

  const result = await runStartupAfterBootstrap(
    async () => { shuttingDown = true; },
    () => shuttingDown,
    async () => { continuations += 1; },
  );

  assert.equal(result, 'shutdown');
  assert.equal(continuations, 0);
});

test('runStartupAfterBootstrap continues startup once after a normal bootstrap', async () => {
  let continuations = 0;

  const result = await runStartupAfterBootstrap(
    async () => undefined,
    () => false,
    async () => { continuations += 1; },
  );

  assert.equal(result, 'continued');
  assert.equal(continuations, 1);
});

test('runStartupAfterBootstrap propagates bootstrap rejection without continuing', async () => {
  let continuations = 0;

  await assert.rejects(
    runStartupAfterBootstrap(
      async () => { throw new Error('bootstrap failed'); },
      () => false,
      async () => { continuations += 1; },
    ),
    /bootstrap failed/,
  );
  assert.equal(continuations, 0);
});
