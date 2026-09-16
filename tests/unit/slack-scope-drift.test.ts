// #340: an app installed from an older manifest keeps its original grant, and
// nothing told the operator. These tests drive the DEFICIENT state for real —
// "all green" proves nothing here, because every path under test only runs
// when a scope is actually missing.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    recordSlackScopeObservation,
    getSlackScopeStatus,
    describeSlackScopeGaps,
    resetSlackScopeStatus,
} from '../../src/slack/scope-status.ts';
import {
    REQUIRED_SLACK_BOT_SCOPES,
    SLACK_CAPABILITY_SCOPES,
} from '../../src/messaging/channel-validate.ts';
import { slackApi } from '../../src/slack/api.ts';

const ALL = [...REQUIRED_SLACK_BOT_SCOPES, ...SLACK_CAPABILITY_SCOPES];

test('an observed empty scope set is known and missing every declared permission', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation('');
    const status = getSlackScopeStatus();
    assert.equal(status.unknown, false);
    assert.equal(status.ok, false);
    assert.deepEqual(status.missingRequired, REQUIRED_SLACK_BOT_SCOPES);
    assert.deepEqual(status.missingCapabilities, SLACK_CAPABILITY_SCOPES);
});

const IDENTITY_SCOPES = ['users:read', 'team:read', 'channels:read', 'groups:read', 'im:read', 'mpim:read'];

/** The exact shape #340 reported: core scopes granted, identity/roster not. */
const OLD_INSTALL_GRANT = ALL.filter(s => !IDENTITY_SCOPES.includes(s)).join(',');

function headerFetch(granted: string | null): typeof fetch {
    return (async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'x-oauth-scopes' ? granted : null) },
        text: async () => JSON.stringify({ ok: true, user_id: 'U1', team_id: 'T1' }),
    } as unknown as Response)) as typeof fetch;
}

test('the six scopes from the bug report are reported by name', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, null);
    const status = getSlackScopeStatus();

    assert.equal(status.unknown, false);
    assert.equal(status.ok, true, 'optional identity scopes are not an outage');
    assert.deepEqual(status.missingRequired, [], 'core messaging still works — a degradation, not an outage');
    assert.deepEqual(status.missingCapabilities, IDENTITY_SCOPES);

    // The whole point: ONE line naming ALL of them, not one per failed call.
    const lines = describeSlackScopeGaps(status);
    assert.equal(lines.length, 1, 'nothing required is missing, so there is nothing to warn about');
    for (const scope of status.missingCapabilities) {
        assert.ok(lines[0]!.text.includes(scope), scope + ' missing from the operator line');
    }
});

test('a full grant produces no warning at all', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.join(','), null);
    const status = getSlackScopeStatus();

    assert.equal(status.ok, true);
    assert.equal(status.unknown, false);
    // A warning that always fires is a warning nobody reads.
    assert.deepEqual(describeSlackScopeGaps(status), []);
});

test('an unobserved header is "cannot check", not "nothing missing"', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(undefined, null);
    const status = getSlackScopeStatus();

    assert.equal(status.unknown, true);
    assert.equal(status.ok, true);
    assert.equal(status.checkedAt, null);
    // ok stays true so a header-stripping proxy cannot manufacture a false
    // alarm, but the unknown flag is what consumers must branch on.
    assert.deepEqual(describeSlackScopeGaps(status), [], 'no measurement means no claim');
});

test('a missing required scope is reported as a real break', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.filter(s => s !== 'chat:write').join(','), null);
    const status = getSlackScopeStatus();

    assert.deepEqual(status.missingRequired, ['chat:write']);
    assert.equal(status.ok, false);
    const required = describeSlackScopeGaps(status).find(l => l.level === 'warn')!;
    assert.match(required.text, /the transport needs/);
});

test('the reinstall URL appears only when the app id is known', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, 'A123');
    assert.match(describeSlackScopeGaps(getSlackScopeStatus())[0]!.text, /apps\/A123\/install-on-team/);

    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, null);
    const line = describeSlackScopeGaps(getSlackScopeStatus())[0]!.text;
    // Never guess an app id: a wrong one sends the operator to someone else's app.
    assert.doesNotMatch(line, /api\.slack\.com\/apps/);
    assert.match(line, /OAuth & Permissions/);
});

test('slackApi carries x-oauth-scopes through to the result', async () => {
    const result = await slackApi('xoxb-1', 'auth.test', undefined, {
        fetchImpl: headerFetch(OLD_INSTALL_GRANT),
    });
    assert.equal(result.ok, true);
    assert.equal(result.grantedScopes, OLD_INSTALL_GRANT);
});

test('a header-less response leaves grantedScopes undefined rather than empty', async () => {
    const result = await slackApi('xoxb-1', 'auth.test', undefined, {
        fetchImpl: (async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response)) as typeof fetch,
    });
    // No headers object at all — the shape most existing test mocks use.
    assert.equal(result.ok, true);
    assert.equal(result.grantedScopes, undefined);

    resetSlackScopeStatus();
    recordSlackScopeObservation(result.grantedScopes, null);
    assert.equal(getSlackScopeStatus().unknown, true);
});

test('a failed call still reports the grant it observed', async () => {
    const result = await slackApi('xoxb-1', 'users.info', undefined, {
        fetchImpl: (async () => ({
            ok: true,
            status: 200,
            headers: { get: (k: string) => (k === 'x-oauth-scopes' ? OLD_INSTALL_GRANT : null) },
            text: async () => JSON.stringify({ ok: false, error: 'missing_scope', needed: 'users:read' }),
        } as unknown as Response)) as typeof fetch,
    });
    // ok:false is where a missing_scope answer lives, so dropping the header
    // here would blind the exact case this feature exists for.
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_scope');
    assert.equal(result.grantedScopes, OLD_INSTALL_GRANT);
});

// #478: an app installed before v2.17.10 lacks four optional scopes. The single
// combined line announced `missing 4 scope(s)` at WARN while the socket was
// connected and answering, so the operator could not tell a degradation from an
// outage and reinstalled the app to find out. These pin that the two severities
// stay apart.

const V217_10_SCOPES = ['channels:join', 'chat:write.public', 'team:read', 'mpim:read'];

test('#478: an optional-only gap reports at info, never warn', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.filter(s => !V217_10_SCOPES.includes(s)).join(','), null);
    const status = getSlackScopeStatus();

    assert.deepEqual(status.missingRequired, [], 'the transport itself is intact');
    assert.equal(status.ok, true);
    const lines = describeSlackScopeGaps(status);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, 'info', 'messaging works — this must not read as a break');
    // The operator's actual question was "is the bot broken?". Answer it.
    assert.match(lines[0]!.text, /some optional features are unavailable/);
});

test('#478: a required gap does not drag optional scopes into its severity', () => {
    resetSlackScopeStatus();
    // Both kinds missing at once — the case the old single-line output flattened.
    recordSlackScopeObservation(
        ALL.filter(s => s !== 'chat:write' && !V217_10_SCOPES.includes(s)).join(','),
        null,
    );
    const lines = describeSlackScopeGaps(getSlackScopeStatus());

    assert.equal(lines.length, 2, 'two severities, two lines');
    const warn = lines.find(l => l.level === 'warn')!;
    const info = lines.find(l => l.level === 'info')!;

    assert.match(warn.text, /chat:write/);
    for (const scope of V217_10_SCOPES) {
        assert.ok(!warn.text.includes(scope), scope + ' is optional and must stay out of the warning');
        assert.ok(info.text.includes(scope), scope + ' missing from the optional line');
    }
    // The old output said "missing 5 scope(s)" — a count spanning an outage and
    // a degradation, which no operator can act on.
    assert.match(warn.text, /needs 1 scope\(s\)/);
    assert.match(info.text, /4 optional scope\(s\)/);
});

test('missing MPIM history describes group DM degradation without a core outage', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.filter(s => s !== 'mpim:history').join(','));
    const status = getSlackScopeStatus();
    assert.equal(status.unknown, false);
    assert.equal(status.ok, true);
    assert.deepEqual(status.missingRequired, []);
    assert.deepEqual(status.missingCapabilities, ['mpim:history']);
    const lines = describeSlackScopeGaps(status);
    assert.equal(lines.length, 1); assert.equal(lines[0]!.level, 'info');
    assert.match(lines[0]!.text, /group DM reception is unavailable/);
    assert.doesNotMatch(lines[0]!.text, /messaging is unaffected/);
});

test('#758: optional-only gap keeps ok true', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.filter(s => s !== 'mpim:history').join(','));
    const status = getSlackScopeStatus();
    assert.deepEqual(
        {
            ok: status.ok,
            unknown: status.unknown,
            missingRequired: status.missingRequired,
            missingCapabilities: status.missingCapabilities,
        },
        { ok: true, unknown: false, missingRequired: [], missingCapabilities: ['mpim:history'] },
    );
});
