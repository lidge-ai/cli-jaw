import assert from 'node:assert/strict';
import test from 'node:test';

import { readInitialSelectedPort, readInitialSidebarMode, readTrayRemindersMode } from '../../public/manager/src/dashboard-url-state.ts';

test('readInitialSidebarMode accepts supported sidebar modes', () => {
    assert.equal(readInitialSidebarMode('?sidebar=reminders'), 'reminders');
    assert.equal(readInitialSidebarMode('?tray=1&sidebar=board'), 'board');
});

test('readInitialSidebarMode rejects missing or unknown sidebar modes', () => {
    assert.equal(readInitialSidebarMode(''), null);
    assert.equal(readInitialSidebarMode('?sidebar=unknown'), null);
    assert.equal(readInitialSidebarMode('?sidebar='), null);
});

test('readTrayRemindersMode accepts only explicit tray mode', () => {
    assert.equal(readTrayRemindersMode('?sidebar=reminders&tray=1'), true);
    assert.equal(readTrayRemindersMode('?tray=0&sidebar=reminders'), false);
    assert.equal(readTrayRemindersMode('?sidebar=reminders'), false);
});

test('readInitialSelectedPort accepts a well-formed in-range port', () => {
    assert.equal(readInitialSelectedPort('?port=3457'), 3457);
    assert.equal(readInitialSelectedPort('?tray=1&port=1&sidebar=instances'), 1);
    assert.equal(readInitialSelectedPort('?port=65535'), 65535);
});

test('readInitialSelectedPort rejects missing, non-numeric, and out-of-range ports', () => {
    assert.equal(readInitialSelectedPort('?sidebar=instances'), null);
    assert.equal(readInitialSelectedPort('?port=0'), null);
    assert.equal(readInitialSelectedPort('?port=70000'), null);
    assert.equal(readInitialSelectedPort('?port=abc'), null);
    assert.equal(readInitialSelectedPort('?port=12.5'), null);
});
