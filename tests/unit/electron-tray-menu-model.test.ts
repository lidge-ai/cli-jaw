import assert from 'node:assert/strict';
import test from 'node:test';

import {
    EMPTY_TRAY_INSTANCES,
    TRAY_INSTANCE_LIMIT,
    TRAY_STALE_AFTER_FAILURES,
    instanceMenuLabel,
    instancesSummaryLabel,
    orderInstances,
    parseDashboardInstances,
    visibleInstances,
    type TrayInstance,
    type TrayInstancesSnapshot,
} from '../../electron/src/main/lib/tray-menu-model.ts';

function instance(partial: Partial<TrayInstance> & { port: number }): TrayInstance {
    return {
        port: partial.port,
        label: partial.label ?? `cli-jaw ${partial.port}`,
        status: partial.status ?? 'offline',
        cli: partial.cli ?? null,
        model: partial.model ?? null,
    };
}

function snapshot(partial: Partial<TrayInstancesSnapshot> = {}): TrayInstancesSnapshot {
    return {
        instances: partial.instances ?? [],
        updatedAt: partial.updatedAt ?? null,
        failures: partial.failures ?? 0,
    };
}

test('parseDashboardInstances reads visible rows and falls back label -> homeDisplay -> cli-jaw <port>', () => {
    const rows = parseDashboardInstances({
        instances: [
            { port: 3457, label: 'Work', status: 'online', currentCli: 'codex', currentModel: 'gpt-5.6' },
            { port: 3458, homeDisplay: '/Users/jun/.cli-jaw/homes/side/', status: 'offline' },
            { port: 3459, label: '   ', homeDisplay: 'C:\\cli-jaw\\win-home' },
            { port: 3460, status: 'online', currentCli: '  ', currentModel: '' },
            { port: 3461, label: '  Padded  ' },
        ],
    });

    assert.deepEqual(rows, [
        { port: 3457, label: 'Work', status: 'online', cli: 'codex', model: 'gpt-5.6' },
        { port: 3458, label: 'side', status: 'offline', cli: null, model: null },
        { port: 3459, label: 'win-home', status: 'unknown', cli: null, model: null },
        { port: 3460, label: 'cli-jaw 3460', status: 'online', cli: null, model: null },
        { port: 3461, label: 'Padded', status: 'unknown', cli: null, model: null },
    ]);
});

test('parseDashboardInstances skips hidden, malformed, and out-of-range rows', () => {
    const rows = parseDashboardInstances({
        instances: [
            null,
            'nope',
            42,
            {},
            { port: '3457', status: 'online' },
            { port: 12.5 },
            { port: 0 },
            { port: -1 },
            { port: 70000 },
            { port: 3457, hidden: true },
            { port: 3457, hidden: false },
            { port: 3458, hidden: 'yes' },
            { port: 65535, status: 'online' },
        ],
    });

    assert.deepEqual(rows.map(row => [row.port, row.status]), [[3457, 'unknown'], [3458, 'unknown'], [65535, 'online']]);
});

test('parseDashboardInstances maps unrecognized statuses to unknown', () => {
    const rows = parseDashboardInstances({
        instances: [
            { port: 3457, status: 'starting' },
            { port: 3458, status: 'ONLINE' },
            { port: 3459, status: 200 },
        ],
    });

    assert.deepEqual(rows.map(row => row.status), ['unknown', 'unknown', 'unknown']);
});

test('parseDashboardInstances throws when the instances array is missing', () => {
    assert.throws(() => parseDashboardInstances({}), /unexpected instances response/);
    assert.throws(() => parseDashboardInstances({ instances: null }), /unexpected instances response/);
    assert.throws(() => parseDashboardInstances({ instances: {} }), /unexpected instances response/);
    assert.throws(() => parseDashboardInstances({ instances: 'nope' }), /unexpected instances response/);
    assert.throws(() => parseDashboardInstances(null), /unexpected instances response/);
});

test('orderInstances puts online rows first and sorts each group by port', () => {
    const input = [
        instance({ port: 3459, status: 'offline' }),
        instance({ port: 3461, status: 'error' }),
        instance({ port: 3460, status: 'online' }),
        instance({ port: 3457, status: 'online' }),
        instance({ port: 3458, status: 'timeout' }),
    ];

    assert.deepEqual(orderInstances(input).map(row => row.port), [3457, 3460, 3458, 3459, 3461]);
    assert.deepEqual(input.map(row => row.port), [3459, 3461, 3460, 3457, 3458]);
});

test('instanceMenuLabel marks online rows and omits the runtime suffix when there is no cli or model', () => {
    assert.equal(
        instanceMenuLabel(instance({ port: 3457, label: 'Work', status: 'online', cli: 'codex', model: 'gpt-5.6' })),
        '● Work  :3457 · codex/gpt-5.6',
    );
    assert.equal(
        instanceMenuLabel(instance({ port: 3458, label: 'Side', status: 'offline' })),
        '○ Side  :3458',
    );
    assert.equal(
        instanceMenuLabel(instance({ port: 3459, label: 'CliOnly', status: 'online', cli: 'claude' })),
        '● CliOnly  :3459 · claude',
    );
    assert.equal(
        instanceMenuLabel(instance({ port: 3460, label: 'ModelOnly', status: 'timeout', model: 'opus' })),
        '○ ModelOnly  :3460 · opus',
    );
});

test('instancesSummaryLabel reports loading, unavailable, counts, and staleness at two failures', () => {
    assert.deepEqual(EMPTY_TRAY_INSTANCES, snapshot());
    assert.equal(instancesSummaryLabel(EMPTY_TRAY_INSTANCES), 'Instances — loading…');
    assert.equal(instancesSummaryLabel(snapshot({ failures: 1 })), 'Instances — unavailable');

    const instances = [
        instance({ port: 3457, status: 'online' }),
        instance({ port: 3458, status: 'online' }),
        instance({ port: 3459, status: 'offline' }),
    ];
    const updatedAt = 1_700_000_000_000;

    assert.equal(instancesSummaryLabel(snapshot({ instances, updatedAt })), 'Instances — 2 online of 3');
    assert.equal(TRAY_STALE_AFTER_FAILURES, 2);
    assert.equal(
        instancesSummaryLabel(snapshot({ instances, updatedAt, failures: TRAY_STALE_AFTER_FAILURES - 1 })),
        'Instances — 2 online of 3',
    );
    assert.equal(
        instancesSummaryLabel(snapshot({ instances, updatedAt, failures: TRAY_STALE_AFTER_FAILURES })),
        'Instances — 2 online of 3 (stale)',
    );
    assert.equal(
        instancesSummaryLabel(snapshot({ instances, updatedAt, failures: TRAY_STALE_AFTER_FAILURES + 3 })),
        'Instances — 2 online of 3 (stale)',
    );
    assert.equal(
        instancesSummaryLabel(snapshot({ updatedAt, failures: TRAY_STALE_AFTER_FAILURES })),
        'Instances — 0 online of 0 (stale)',
    );
});

test('visibleInstances caps the ordered rows at the limit and reports the hidden count', () => {
    const instances = Array.from({ length: TRAY_INSTANCE_LIMIT + 3 }, (_, index) =>
        instance({ port: 3500 + index, status: index === TRAY_INSTANCE_LIMIT + 2 ? 'online' : 'offline' }));
    const onlyOnline = 3500 + TRAY_INSTANCE_LIMIT + 2;

    const capped = visibleInstances(snapshot({ instances }));
    assert.equal(capped.rows.length, TRAY_INSTANCE_LIMIT);
    assert.equal(capped.hidden, 3);
    assert.equal(capped.rows[0]?.port, onlyOnline);
    assert.deepEqual(capped.rows.map(row => row.port), [onlyOnline, 3500, 3501, 3502, 3503, 3504, 3505, 3506]);

    const custom = visibleInstances(snapshot({ instances }), 2);
    assert.deepEqual(custom.rows.map(row => row.port), [onlyOnline, 3500]);
    assert.equal(custom.hidden, instances.length - 2);

    const everything = visibleInstances(snapshot({ instances }), instances.length + 5);
    assert.equal(everything.rows.length, instances.length);
    assert.equal(everything.hidden, 0);

    const none = visibleInstances(snapshot({ instances }), 0);
    assert.deepEqual(none.rows, []);
    assert.equal(none.hidden, instances.length);
});
