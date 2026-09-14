import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { hasActiveEnforcedSlackDestination } from '../../src/slack/tool-context.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';

const collectUrl = new URL('../../src/orchestrator/collect.ts', import.meta.url).href;
const sendUrl = new URL('../../src/messaging/send.ts', import.meta.url).href;
const dbUrl = new URL('../../src/core/db.ts', import.meta.url).href;
const stateUrl = new URL('../../src/orchestrator/state-machine.ts', import.meta.url).href;
const spawnUrl = new URL('../../src/agent/spawn.ts', import.meta.url).href;
const registryUrl = new URL('../../src/orchestrator/worker-registry.ts', import.meta.url).href;
const distributeUrl = new URL('../../src/orchestrator/distribute.ts', import.meta.url).href;

const [realSend, realDb, realState, realSpawn, realRegistry, realDistribute] = await Promise.all([
    import('../../src/messaging/send.js'), import('../../src/core/db.js'), import('../../src/orchestrator/state-machine.js'),
    import('../../src/agent/spawn.js'), import('../../src/orchestrator/worker-registry.js'), import('../../src/orchestrator/distribute.js'),
]);

let collectCalls = 0;
let plannerOnly = false;
let employeeBusy = false;
let collectObserver = () => {};
const sent: string[] = [];
const sentRequests: Array<Record<string, any>> = [];
const anchors: unknown[][] = [];
let employeeRunMeta: Record<string, unknown> | undefined;
const employee = { id: 'emp-1', name: 'reviewer', cli: 'codex', model: null, role: 'reviewer' };

mock.module(collectUrl, { namedExports: {
    orchestrateAndCollectData: async () => {
        collectObserver();
        collectCalls++;
        return { text: 'status: ok\nsummary: main complete', data: { agyPlannerOnly: plannerOnly } };
    },
    orchestrateAndCollect: async () => 'unused',
} });
mock.module(sendUrl, { namedExports: {
    ...realSend,
    sendChannelOutput: async (input: Record<string, any>) => {
        sent.push(input["text"]);
        sentRequests.push(structuredClone(input));
        return { ok: true };
    },
} });
mock.module(dbUrl, { namedExports: {
    ...realDb,
    getEmployees: { all: () => [employee] },
    insertHeartbeatAnchor: { run: (...args: unknown[]) => { anchors.push(args); } },
} });
mock.module(stateUrl, { namedExports: { ...realState, getState: () => 'IDLE' } });
mock.module(spawnUrl, { namedExports: { ...realSpawn, isAgentBusy: () => false, messageQueue: [] } });
mock.module(registryUrl, { namedExports: {
    ...realRegistry,
    claimWorker: () => {
        if (employeeBusy) throw new realRegistry.WorkerBusyError({ employeeName: employee.name, task: 'manual' } as never);
        return { agentId: employee.id };
    },
    finishWorker: () => undefined,
    failWorker: () => undefined,
    hasPendingWorkerReplays: () => false,
} });
mock.module(distributeUrl, { namedExports: { ...realDistribute,
    runSingleAgent: async (...args: unknown[]) => {
        employeeRunMeta = args[4] as Record<string, unknown> | undefined;
        return { text: 'status: ok\nsummary: employee complete', tools: [] };
    },
} });

const {
    decideHeartbeatReport,
    getHeartbeatLiveDestinationHold,
    runHeartbeatJob,
    runHeartbeatScript,
} = await import('../../src/memory/heartbeat.js');
const { resolveHeartbeatBinding } = await import('../../src/memory/heartbeat-destination.js');
const defaultDestination = { channel: 'slack' as const, targetId: 'C_REPORTS', scope: 'channel_root' as const };
function runJob(job: Record<string, unknown>) {
    return runHeartbeatJob({ destination: defaultDestination, ...job }, {
        // Runner tests own orchestration/report policy. Live Slack membership is
        // exercised directly in heartbeat-destination-binding.test.ts.
        verifyDestination: async destination => resolveHeartbeatBinding(destination),
        reserveDestinationGrant: async () => () => {},
    });
}
type Status = 'ok' | 'warning' | 'failed';
const report = (status: Status, userVisible = false) => ({ status, changed: false, recordRequired: false, userVisible, summary: 's', evidence: '', nextAction: '', raw: 's' });

for (const policy of ['always', 'anomaly_only', 'silent'] as const) {
    for (const status of ['ok', 'warning', 'failed'] as const) {
        test(`report gate ${policy} x ${status}`, () => {
            const decision = decideHeartbeatReport(report(status), policy);
            const expectedSend = policy === 'always' || (policy === 'anomaly_only' && status !== 'ok');
            assert.deepEqual(decision, { send: expectedSend, anchor: true, delivered: expectedSend });
        });
    }
}

test('anomaly_only sends an ok report explicitly marked user-visible', () => {
    assert.deepEqual(decideHeartbeatReport(report('ok', true), 'anomaly_only'), { send: true, anchor: true, delivered: true });
});

test('planner-only main heartbeat retries exactly once even when every result is planner-only', async () => {
    collectCalls = 0; plannerOnly = true;
    await runJob({ id: 'retry', name: 'retry', enabled: true, schedule: { minutes: 5 }, prompt: 'check' });
    assert.equal(collectCalls, 2);
    plannerOnly = false;
});

test('production default verifies, reserves, activates the guard during collection, and releases it', async t => {
    const previousSlack = settings.slack;
    collectCalls = 0;
    sentRequests.length = 0;
    resetVerifiedSlackWorkspace();
    settings.slack = { ...previousSlack, enabled: true, botToken: 'xoxb-fixture' };
    const threadId = '1787616871.254919';
    let replyCalls = 0;
    let authCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/conversations.replies')) {
            replyCalls++;
            return new Response(JSON.stringify({
                ok: true,
                messages: [{ ts: threadId, text: 'parent' }],
                has_more: false,
            }), { headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/auth.test')) {
            authCalls++;
            return new Response(JSON.stringify({
                ok: true,
                team_id: 'T1FIXTURE',
                user_id: 'U1FIXTURE',
            }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error('unexpected Slack method: ' + url);
    });
    collectObserver = () => {
        assert.equal(hasActiveEnforcedSlackDestination(), true,
            'native/headerless agent calls are guarded for the whole collection');
    };
    try {
        await runHeartbeatJob({
            id: 'default-path',
            name: 'default-path',
            enabled: true,
            schedule: { minutes: 5 },
            prompt: 'check',
            destination: { channel: 'slack', targetId: 'C1REPORTS', threadId },
        });
    } finally {
        collectObserver = () => {};
        settings.slack = previousSlack;
        resetVerifiedSlackWorkspace();
    }
    assert.equal(replyCalls, 1);
    assert.equal(authCalls, 1);
    assert.equal(collectCalls, 1);
    assert.equal(hasActiveEnforcedSlackDestination(), false, 'grant is released after collection');
    assert.equal(sentRequests[0]?.['target']?.threadId, threadId);
});

test('non-planner main heartbeat runs once', async () => {
    collectCalls = 0; plannerOnly = false;
    await runJob({ id: 'once', name: 'once', enabled: true, schedule: { minutes: 5 }, prompt: 'check' });
    assert.equal(collectCalls, 1);
});

test('busy employee produces warning delivery without running employee', async () => {
    employeeBusy = true; sent.length = 0;
    await runJob({ id: 'busy', name: 'busy', runner: 'employee', employee: employee.name,
        reportPolicy: 'anomaly_only', schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.254919' } });
    employeeBusy = false;
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /\[warning\].*skipped: employee busy/);
});

test('script runner parses real exit-0 contract output', async () => {
    const result = await runHeartbeatScript([process.execPath, '-e', "console.log('status: ok\\nchanged: yes\\nsummary: script complete')"]);
    assert.equal(result.status, 'ok');
    assert.equal(result.changed, true);
    assert.equal(result.summary, 'script complete');
});

test('script runner maps a real nonzero exit to failed', async () => {
    const result = await runHeartbeatScript([process.execPath, '-e', "console.error('boom'); process.exit(3)"]);
    assert.equal(result.status, 'failed');
});

// Timeout configuration remains a source-contract assertion: waiting ten real minutes is not an acceptable unit test.
test('script runner configures the audited timeout and output bound', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/memory/heartbeat.ts', import.meta.url), 'utf8'));
    assert.ok(source.includes('timeout: 10 * 60_000'));
    assert.ok(source.includes('maxBuffer: 64 * 1024'));
});

// ─── destination routing (#437) ─────────────────────
//
// The incident: two scheduled reports were delivered to whichever Slack thread
// had most recently spoken to the bot, because the send carried no target and
// the resolver filled one in. These assert on the REQUEST the job builds, since
// that is where the destination is either honoured or lost.

test('a job with a destination sends there and forbids the active fallback', async () => {
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'pinned', name: 'pinned', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.254919' },
    });

    assert.equal(sentRequests.length, 1);
    const req = sentRequests[0]!;
    assert.equal(req['channel'], 'slack');
    assert.equal(req['target']?.targetId, 'C_REPORTS');
    assert.equal(req['target']?.threadId, '1787616871.254919');
    assert.equal(req['allowActiveFallback'], false,
        'a pinned job must not be re-routed by whoever spoke last');
});

test('a destination that opts into the conversation root posts there', async () => {
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'root', name: 'root', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', scope: 'channel_root' },
    });

    assert.equal(sentRequests[0]?.['target']?.targetId, 'C_REPORTS');
    assert.equal(sentRequests[0]?.['target']?.threadId, undefined);
});

test('a configured destination carries its own authority to the send', async () => {
    // Regression: the target here is operator-written config, but the send left
    // fullAccess unset and fell through to the explicit-target allowlist. With
    // slack.channelIds empty the only remaining vouchers are the last-active slot
    // and an existing binding, so a correctly configured job aimed at a channel
    // nobody had recently addressed the bot in was refused with 'Invalid or
    // disallowed target'. Two live instances sat like that: the daily scrum job
    // failed three runs in a row, and the daily digest thread had no binding at
    // all. Widening the allowlist is not the fix — that list also gates inbound.
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'authority', name: 'authority', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787571776.141519' },
    });
    assert.equal(sentRequests.length, 1);
    assert.equal(sentRequests[0]?.['fullAccess'], true,
        'a destination the operator wrote must not rank below whoever spoke most recently');
    assert.equal(sentRequests[0]?.['target']?.targetId, 'C_REPORTS');
    assert.equal(sentRequests[0]?.['target']?.threadId, '1787571776.141519');
    assert.equal(sentRequests[0]?.['allowActiveFallback'], false,
        'authority is permission to reach the named conversation, never licence to pick another');
});

test('a Slack destination with no thread and no root opt-in is held', async () => {
    // "Channel but no thread" is indistinguishable from a form nobody finished.
    // Guessing the root put scheduled reports at the bottom of channels their
    // operator had pointed at a specific thread (#745).
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'incomplete', name: 'incomplete', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS' },
    });

    assert.equal(sentRequests.length, 0, 'an unfinished destination delivers nowhere');
});

test('an empty-string thread is not a thread', async () => {
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'blank-thread', name: 'blank-thread', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '' },
    });

    assert.equal(sentRequests.length, 0, 'a blank ts used to pass validation then read as falsy at send time');
});

test('the derived target carries the kinds the operator never types', async () => {
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'kinds', name: 'kinds', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', scope: 'channel_root' },
    });

    // Stored form is three fields; targetKind/peerKind come from the id prefix.
    assert.equal(sentRequests[0]?.['target']?.targetKind, 'channel');
    assert.equal(sentRequests[0]?.['target']?.peerKind, 'channel');
});

test('a job without a destination delivers nowhere', async () => {
    // This used to fall through to the active channel. That path is why a
    // scheduled report could arrive in a conversation that had never asked for
    // it: "active" is whoever spoke to the bot last, which is not a property of
    // the job at all (#437, #745). Silence with a logged reason is the honest
    // answer to an unconfigured destination.
    sent.length = 0; sentRequests.length = 0;
    await runHeartbeatJob({ id: 'legacy', name: 'legacy', enabled: true, schedule: { minutes: 5 }, prompt: 'check' });

    assert.equal(sentRequests.length, 0);
});

test('a live thread mismatch stops before model work and before send', async () => {
    collectCalls = 0; sent.length = 0; sentRequests.length = 0;
    await runHeartbeatJob({
        id: 'mismatch', name: 'mismatch', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.254919' },
    }, {
        verifyDestination: async () => ({ state: 'held', reason: 'thread_channel_mismatch' }),
        reserveDestinationGrant: async () => () => {},
    });
    assert.equal(collectCalls, 0, 'an unverified destination spends no model turn');
    assert.equal(sentRequests.length, 0, 'an unverified destination sends nowhere');
    assert.equal(getHeartbeatLiveDestinationHold({
        id: 'mismatch',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.254919' },
    }), 'thread_channel_mismatch', 'GET/UI can surface the live hold');
    assert.equal(getHeartbeatLiveDestinationHold({
        id: 'mismatch',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.999999' },
    }), null, 'editing the destination invalidates the old live hold immediately');
});

test('a Slack main job reserves and releases destination-bound tool authority around its turn', async () => {
    collectCalls = 0; sentRequests.length = 0;
    let reserved = 0;
    let released = 0;
    const destination = { channel: 'slack' as const, targetId: 'C_REPORTS', threadId: '1787616871.254919' };
    const binding = resolveHeartbeatBinding(destination);
    assert.equal(binding.state, 'bound');
    await runHeartbeatJob({
        id: 'grant', name: 'grant', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination,
    }, {
        verifyDestination: async () => binding,
        reserveDestinationGrant: async (actual, requestId) => {
            reserved++;
            assert.equal(actual.state, 'bound');
            assert.equal(actual.target.targetId, destination.targetId);
            assert.ok(requestId);
            return () => { released++; };
        },
    });
    assert.equal(collectCalls, 1);
    assert.equal(reserved, 1);
    assert.equal(released, 1);
    assert.equal(sentRequests[0]?.['target']?.threadId, destination.threadId);
});

test('planner-only retry receives a fresh destination grant and releases both', async () => {
    collectCalls = 0; plannerOnly = true;
    const requestIds = new Set<string>();
    let released = 0;
    await runHeartbeatJob({
        id: 'grant-retry', name: 'grant-retry', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', scope: 'channel_root' },
    }, {
        verifyDestination: async destination => resolveHeartbeatBinding(destination),
        reserveDestinationGrant: async (_binding, requestId) => {
            requestIds.add(requestId);
            return () => { released++; };
        },
    });
    plannerOnly = false;
    assert.equal(collectCalls, 2);
    assert.equal(requestIds.size, 2);
    assert.equal(released, 2);
});

for (const runner of ['employee', 'script'] as const) {
    test(`${runner} runner is covered by the same destination guard`, async () => {
        employeeRunMeta = undefined;
        let reserved = 0;
        let released = 0;
        await runHeartbeatJob({
            id: 'guard-' + runner,
            name: 'guard-' + runner,
            enabled: true,
            runner,
            ...(runner === 'employee' ? { employee: employee.name } : {
                command: [process.execPath, '-e',
                    "if(!process.env.JAW_SLACK_TURN_GRANT)process.exit(2);console.log('status: ok\\nchanged: no\\nsummary: script complete')"],
            }),
            schedule: { minutes: 5 },
            prompt: 'check',
            destination: { channel: 'slack', targetId: 'C_REPORTS', scope: 'channel_root' },
        }, {
            verifyDestination: async destination => resolveHeartbeatBinding(destination),
            reserveDestinationGrant: async () => {
                reserved++;
                return () => { released++; };
            },
            ...(runner === 'script' ? { activateDestinationGrant: () => 'fixture-grant' } : {}),
        });
        assert.equal(reserved, 1);
        assert.equal(released, 1);
        if (runner === 'employee') {
            assert.equal(employeeRunMeta?.['origin'], 'heartbeat');
            assert.equal(employeeRunMeta?.['scopeKey'], 'default');
            assert.ok(employeeRunMeta?.['requestId']);
            assert.equal((employeeRunMeta?.['target'] as { targetId?: string } | undefined)?.targetId, 'C_REPORTS');
        }
    });
}

test('a malformed destination is refused, not redirected to the active channel', async () => {
    // A job that named a destination has stated an intent. When that intent
    // cannot be resolved, delivering to whoever spoke last is the original bug
    // wearing a different hat — the report still lands in an unrelated place.
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'bad', name: 'bad', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack' },
    });

    assert.equal(sentRequests.length, 0, 'a broken pin must not deliver anywhere');
});

test('a destination naming an unknown transport is refused too', async () => {
    sent.length = 0; sentRequests.length = 0;
    await runJob({
        id: 'bad-channel', name: 'bad-channel', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'irc', targetId: 'C_X' },
    });

    assert.equal(sentRequests.length, 0);
});

test('a scheduled run survives a malformed destination without throwing', async () => {
    // Refusing to deliver must not take the heartbeat loop down with it.
    await runJob({
        id: 'bad-survives', name: 'bad-survives', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { targetId: 'C_X' },
    });
    sent.length = 0; sentRequests.length = 0;
    await runJob({ id: 'after', name: 'after', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', threadId: '1787616871.254919' } });
    assert.equal(sentRequests.length, 1, 'the next job still runs');
});

test('the anchor records where the report actually went', async () => {
    anchors.length = 0;
    await runJob({
        id: 'anchored', name: 'anchored', enabled: true, schedule: { minutes: 5 }, prompt: 'check',
        destination: { channel: 'slack', targetId: 'C_REPORTS', scope: 'channel_root' },
    });

    // Routing and the record must not disagree: 'active' here would attribute the
    // report to a channel it was explicitly kept away from.
    assert.equal(anchors.at(-1)?.[3], 'slack');
    assert.equal(anchors.at(-1)?.[4], 'C_REPORTS');
});

// ─── #450: an employee heartbeat stalled the default queue ───

test('an employee heartbeat consumes its own worker replay', async () => {
    // finishWorker arms a replay for a Boss to collect, and processQueue skips
    // any scope holding one. A heartbeat has no Boss, so a single successful
    // employee run left the default queue waiting on a handoff that could never
    // arrive.
    const { hasPendingWorkerReplays } = await import('../../src/orchestrator/worker-registry.js');

    await runJob({
        id: 'emp', name: 'emp', runner: 'employee', employee: employee.name,
        enabled: true, schedule: { minutes: 5 }, prompt: 'check',
    });

    assert.equal(hasPendingWorkerReplays('default'), false,
        'a heartbeat must not leave the default scope blocked on a replay');
});
