import test from 'node:test';
import assert from 'node:assert/strict';
import { isCliStatusUsable, type CliStatusInfo, type QuotaEntry } from '../../public/js/features/settings-types.ts';

function row(overrides: Partial<CliStatusInfo> = {}): CliStatusInfo {
    return {
        available: true,
        binaryInstalled: true,
        capabilityReady: true,
        authenticated: true,
        path: '/usr/local/bin/x',
        source: 'probe',
        checkedCapability: 'spawn-probe',
        probeState: 'fresh',
        ...overrides,
    };
}

function quota(overrides: Partial<QuotaEntry> = {}): QuotaEntry {
    return { authenticated: true, ...overrides };
}

test('isCliStatusUsable keeps detected+authenticated CLIs on top', () => {
    assert.equal(isCliStatusUsable(row(), undefined), true);
    assert.equal(isCliStatusUsable(row(), quota()), true);
    assert.equal(isCliStatusUsable(row({ authenticated: null }), quota()), true);
    assert.equal(isCliStatusUsable(row(), quota({ error: true, authenticated: undefined })), true);
});

test('isCliStatusUsable demotes not-installed rows (fresh probe)', () => {
    for (const info of [
        row({ available: false }),
        row({ available: null }),
        row({ available: false, authenticated: null, probeState: 'fresh' }),
    ]) {
        assert.equal(isCliStatusUsable(info, undefined), false);
        assert.equal(isCliStatusUsable(info, quota()), false);
    }
});

test('isCliStatusUsable demotes capability-failed rows', () => {
    const info = row({ capabilityReady: false });
    assert.equal(isCliStatusUsable(info, undefined), false);
});

test('isCliStatusUsable demotes unauthenticated rows (status probe or quota)', () => {
    assert.equal(isCliStatusUsable(row({ authenticated: false }), undefined), false);
    assert.equal(isCliStatusUsable(row(), quota({ authenticated: false })), false);
});

test('isCliStatusUsable keeps stale-but-previously-working CLIs on top', () => {
    assert.equal(isCliStatusUsable(row({ probeState: 'stale' }), undefined), true);
    assert.equal(isCliStatusUsable(row({ probeState: 'stale' }), quota()), true);
});

test('isCliStatusUsable demotes stale rows that were already broken', () => {
    assert.equal(isCliStatusUsable(row({ probeState: 'stale', available: false }), undefined), false);
    assert.equal(isCliStatusUsable(row({ probeState: 'stale', authenticated: false }), undefined), false);
    assert.equal(isCliStatusUsable(row({ probeState: 'stale' }), quota({ authenticated: false })), false);
});

test('isCliStatusUsable keeps indeterminate probe states on top', () => {
    for (const probeState of ['checking', 'unknown', 'failing'] as const) {
        const info = row({ probeState, probeError: probeState === 'checking' ? undefined : 'boom' });
        assert.equal(isCliStatusUsable(info, undefined), true, probeState);
        assert.equal(isCliStatusUsable(info, quota({ authenticated: false })), true, probeState);
    }
});
