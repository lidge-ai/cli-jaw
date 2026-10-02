// Phase 9.4: settings patch merge 단위 테스트
// src/settings-merge.js 가 생성되면 통과 (server.js에서 로직 추출 예정)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettingsPatch, sanitizeSettingsInput, mergeSettingsLayer, SETTINGS_MERGE_SPEC } from '../../src/core/settings-merge.ts';

// ─── perCli deep merge ──────────────────────────────

test('SM-001: perCli deep merge preserves existing effort', () => {
    const current = { perCli: { copilot: { model: 'a', effort: 'high' } } };
    const next = mergeSettingsPatch(current, { perCli: { copilot: { model: 'b' } } });
    assert.equal(next.perCli.copilot.model, 'b');
    assert.equal(next.perCli.copilot.effort, 'high');
});

test('SM-002: perCli adds new CLI without removing others', () => {
    const current = { perCli: { claude: { model: 'opus' } } };
    const next = mergeSettingsPatch(current, { perCli: { codex: { model: 'o3' } } });
    assert.equal(next.perCli.claude.model, 'opus');
    assert.equal(next.perCli.codex.model, 'o3');
});

// ─── activeOverrides deep merge ─────────────────────

test('SM-003: activeOverrides deep merge preserves sibling keys', () => {
    const current = { activeOverrides: { codex: { model: 'o3', effort: 'medium' } } };
    const next = mergeSettingsPatch(current, { activeOverrides: { codex: { model: 'o4' } } });
    assert.equal(next.activeOverrides.codex.model, 'o4');
    assert.equal(next.activeOverrides.codex.effort, 'medium');
});

// ─── top-level fields ────────────────────────────────

test('SM-004: top-level scalar fields are replaced', () => {
    const current = { cli: 'claude', permissions: 'safe' };
    const next = mergeSettingsPatch(current, { permissions: 'auto' });
    assert.equal(next.permissions, 'auto');
    assert.equal(next.cli, 'claude'); // 기존 값 유지
});

test('SM-005: empty patch returns original', () => {
    const current = { cli: 'claude', perCli: { claude: { model: 'opus' } } };
    const next = mergeSettingsPatch(current, {});
    assert.deepEqual(next, current);
});

test('SM-006: tui deep merge preserves sibling keys', () => {
    const current = {
        tui: {
            pasteCollapseLines: 2,
            pasteCollapseChars: 160,
            keymapPreset: 'default',
            diffStyle: 'summary',
            themeSeed: 'jaw-default',
        },
    };
    const next = mergeSettingsPatch(current, { tui: { keymapPreset: 'vim' } });
    assert.equal(next.tui.keymapPreset, 'vim');
    assert.equal(next.tui.pasteCollapseLines, 2);
    assert.equal(next.tui.diffStyle, 'summary');
});

test('SM-007: jawCeo deep merge preserves saved voice settings siblings', () => {
    const current = { jawCeo: { openaiApiKey: 'sk-old', other: 'keep' } };
    const next = mergeSettingsPatch(current, { jawCeo: { openaiApiKey: 'sk-new' } });
    assert.equal(next.jawCeo.openaiApiKey, 'sk-new');
    assert.equal(next.jawCeo.other, 'keep');
});

test('SM-008: telegramHub deep merge preserves callback siblings', () => {
    const current = { telegramHub: { mode: 'hub-member', hubCallbackUrl: 'http://127.0.0.1:24576' } };
    const next = mergeSettingsPatch(current, { telegramHub: { mode: 'standalone' } });
    assert.deepEqual(next.telegramHub, { mode: 'standalone', hubCallbackUrl: 'http://127.0.0.1:24576' });
});

test('SM-009: runtime.codexApp merge preserves siblings at both depths', () => {
    const current = {
        runtime: {
            sibling: { keep: true },
            codexApp: { multiplex: false, probeOwned: 'keep' },
        },
    };
    const next = mergeSettingsPatch(current, { runtime: { codexApp: { multiplex: true } } });
    assert.deepEqual(next.runtime, {
        sibling: { keep: true },
        codexApp: { multiplex: true, probeOwned: 'keep' },
    });
    assert.equal(current.runtime.codexApp.multiplex, false, 'candidate merge must not mutate current settings');
});

test('SM-010: shared sanitizer separates execution default from persistence shape', () => {
    const absent = sanitizeSettingsInput({ cli: 'codex-app' }, 'boot');
    assert.equal(absent.value.runtime.codexApp.multiplex, false);
    assert.equal(absent.persistenceShape, 'absent');

    const explicit = sanitizeSettingsInput({
        runtime: { codexApp: { multiplex: false } },
    }, 'watch');
    assert.equal(explicit.value.runtime.codexApp.multiplex, false);
    assert.equal(explicit.persistenceShape, 'present');
});

test('SM-011: shared sanitizer strips laneMode and classifies invalid multiplex', () => {
    const api = sanitizeSettingsInput({
        runtime: { codexApp: { laneMode: 'native', multiplex: 'true', keep: 1 } },
    }, 'api');
    assert.deepEqual(api.serverOwnedPaths, ['runtime.codexApp.laneMode']);
    assert.deepEqual(api.invalidPaths, ['runtime.codexApp.multiplex']);
    assert.deepEqual(api.value.runtime.codexApp, { keep: 1 });
});

// ON-12b — a non-object multiSession is not a harmless no-op. It survives the merge, and
// migrateSettings reads a falsy block as an absent one and fills it with the current
// defaults; once those default to enabled, `{"multiSession": null}` switches sessions on
// for someone who never accepted the migration (110 §4b-3). Both ingresses that can carry
// one — the API patch and the settings-file watcher — pass through this function.
test('SM-012: a multiSession that is not an object never reaches the merge', () => {
    for (const source of ['api', 'watch', 'boot'] as const) {
        for (const bad of [null, 'on', 42, ['enabled']]) {
            const out = sanitizeSettingsInput({ cli: 'codex-app', multiSession: bad }, source);
            assert.equal('multiSession' in out.value, false,
                `${source} must drop ${JSON.stringify(bad)} rather than pass it on`);
            assert.ok(out.invalidPaths.includes('multiSession'));
        }
    }
});

test('SM-013: a well-formed multiSession is preserved, and a bad channels is not', () => {
    const kept = sanitizeSettingsInput({
        multiSession: { enabled: true, maxConcurrent: 2, channels: { slack: true } },
    }, 'api');
    assert.deepEqual(kept.value.multiSession, { enabled: true, maxConcurrent: 2, channels: { slack: true } });
    assert.deepEqual(kept.invalidPaths, []);

    const badChannels = sanitizeSettingsInput({
        multiSession: { enabled: true, channels: 'all' },
    }, 'api');
    assert.deepEqual(badChannels.value.multiSession, { enabled: true });
    assert.deepEqual(badChannels.invalidPaths, ['multiSession.channels']);
});

// A patch that says nothing about sessions must stay silent about them, or every unrelated
// settings save would rewrite the block.
test('SM-014: a patch without multiSession does not invent one', () => {
    const out = sanitizeSettingsInput({ cli: 'claude' }, 'api');
    assert.equal('multiSession' in out.value, false);
    assert.deepEqual(out.invalidPaths, []);
});

// ─── one merge policy for both ingresses (#696) ─────
//
// Before this, the boot merge and the API merge each carried their own list of
// nested keys, and the lists disagreed. Which sibling keys a partial write
// destroyed therefore depended on which door it came through.

test('SM-014: a partial network.remoteAccess patch keeps its siblings', () => {
    const current = { network: { bindHost: '0.0.0.0', lanBypass: true,
        remoteAccess: { mode: 'off', trustProxies: true, trustForwardedFor: false, publicOriginHint: 'x' } } };
    const next = mergeSettingsPatch(current, { network: { remoteAccess: { mode: 'lan' } } });
    assert.deepEqual(next.network.remoteAccess,
        { mode: 'lan', trustProxies: true, trustForwardedFor: false, publicOriginHint: 'x' });
    assert.equal(next.network.bindHost, '0.0.0.0');
});

test('SM-015: a partial avatar patch keeps the other side', () => {
    // The API ingress used to replace avatar wholesale while boot merged it.
    const current = { avatar: { agent: { imagePath: 'a', scale: 2 }, user: { imagePath: 'u' } } };
    const next = mergeSettingsPatch(current, { avatar: { agent: { imagePath: 'b' } } });
    assert.deepEqual(next.avatar.agent, { imagePath: 'b', scale: 2 });
    assert.deepEqual(next.avatar.user, { imagePath: 'u' });
});

test('SM-016: a partial messaging.latestSeen patch keeps other channel cursors', () => {
    const current = { messaging: { enabledChannels: ['slack'], homeChannel: 'slack',
        latestSeen: { slack: null, telegram: '111', discord: '222' } } };
    const next = mergeSettingsPatch(current, { messaging: { latestSeen: { slack: '999' } } });
    assert.deepEqual(next.messaging.latestSeen, { slack: '999', telegram: '111', discord: '222' });
    assert.deepEqual(next.messaging.enabledChannels, ['slack']);
});

test('SM-017: a key outside the spec is replaced wholesale, on purpose', () => {
    // Arrays must not be union-merged, and that is why the contract is a
    // declared list rather than a recursive deep merge.
    const next = mergeSettingsPatch(
        { employees: [{ id: 'a' }, { id: 'b' }], messaging: { enabledChannels: ['slack', 'telegram'] } },
        { employees: [{ id: 'c' }], messaging: { enabledChannels: ['discord'] } },
    );
    assert.deepEqual(next.employees, [{ id: 'c' }]);
    assert.deepEqual(next.messaging.enabledChannels, ['discord']);
});

test('SM-018: the layer does not mutate either input', () => {
    const base = { network: { bindHost: '127.0.0.1', remoteAccess: { mode: 'off' } } };
    const incoming = { network: { remoteAccess: { mode: 'lan' } } };
    const next = mergeSettingsLayer(base, incoming);
    assert.equal(base.network.remoteAccess.mode, 'off');
    assert.deepEqual(incoming, { network: { remoteAccess: { mode: 'lan' } } });
    assert.equal(next['network'].remoteAccess.mode, 'lan');
});

test('SM-019: an explicit null or array replaces the block rather than merging', () => {
    const current = { heartbeat: { enabled: true, every: '30m' } };
    assert.equal(mergeSettingsPatch(current, { heartbeat: null }).heartbeat, null);
    assert.deepEqual(mergeSettingsPatch(current, { heartbeat: [] }).heartbeat, []);
});

test('SM-020: the spec names every key both ingresses rely on', () => {
    for (const key of ['network', 'runtime', 'multiSession', 'avatar', 'messaging',
        'heartbeat', 'stt', 'presentation', 'telegram', 'discord', 'slack', 'dispatchApproval']) {
        assert.ok(SETTINGS_MERGE_SPEC[key], key + ' must be declared in SETTINGS_MERGE_SPEC');
    }
    assert.equal(SETTINGS_MERGE_SPEC['perCli']?.kind, 'perEntry');
    assert.equal(SETTINGS_MERGE_SPEC['employees'], undefined,
        'employees is an array and must stay a wholesale replacement');
});


for (const source of ['boot', 'watch', 'api'] as const) {
    test(`Aside selectors validate ${source} without mutating input`, () => {
        const input = { perCli: { aside: { account: 'u7', host: 'local', model: '', effort: '' } } };
        const output = sanitizeSettingsInput(input, source);
        assert.deepEqual(output.invalidPaths, []);
        assert.deepEqual(output.value.perCli.aside, { account: 'u7', host: 'local', model: 'default', effort: 'default' });
        assert.deepEqual(input.perCli.aside, { account: 'u7', host: 'local', model: '', effort: '' });
        for (const [key, value] of [['account', '../u0'], ['host', 'remote'], ['model', 'unqualified'],
            ['effort', 'ultra'], ['permissions', ['auto']], ['transport', 'native'], ['provider', 'p']] as const) {
            const bad = sanitizeSettingsInput({ perCli: { aside: { [key]: value } } }, source);
            assert.deepEqual(bad.invalidPaths, [`perCli.aside.${key}`]);
            assert.equal(Object.hasOwn(bad.value.perCli.aside, key), false);
        }
        const overriddenAccount = sanitizeSettingsInput({ activeOverrides: { aside: { account: 'u9' } } }, source);
        assert.deepEqual(overriddenAccount.invalidPaths, ['activeOverrides.aside.account']);
    });
}

test('Aside partial selector patches preserve configured account and unrelated providers', () => {
    const current = { perCli: { aside: { account: 'u7', host: 'local', model: 'default', effort: 'default' },
        codex: { model: 'other' } } };
    const patch = sanitizeSettingsInput({ perCli: { aside: { model: 'provider/model/id', effort: 'high' } } }, 'api');
    assert.deepEqual(patch.invalidPaths, []);
    const candidate = mergeSettingsPatch(current, patch.value);
    assert.deepEqual(candidate.perCli.aside, { account: 'u7', host: 'local', model: 'provider/model/id', effort: 'high' });
    assert.deepEqual(candidate.perCli.codex, { model: 'other' });
});
