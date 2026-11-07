import '../setup/isolated-home.ts';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { db } from '../../src/core/db.js';
import { settings, JAW_HOME } from '../../src/core/config.js';
import { recordRuntimeEvent, type RuntimeEventContext } from '../../src/agent/runtime/events.js';
import { readActivityPage, listActivityRuns, getActivityOwner, isTraceSessionOwner,
    ACTIVITY_RUN_ROWS, ACTIVITY_RUN_BYTES, ACTIVITY_GLOBAL_ROWS, ACTIVITY_GLOBAL_BYTES, ACTIVITY_PAGE_BYTES } from '../../src/trace/activity-journal.js';
import { closeActivity, readActivityControl, writeActivityControl, expireActivityPrefix } from '../../src/trace/activity-control.js';
import { startTraceRun, appendTraceEvent, finalizeTraceRun, getTraceRun, getTraceEvent,
    pruneTraceEvents, stampTraceTool, updateTraceToolRow } from '../../src/trace/store.js';
import { subscribe, type BusEvent } from '../../src/core/event-bus.js';
import { addBroadcastListener, removeBroadcastListener, broadcast } from '../../src/core/bus.js';
import { createChatSession, deleteChatSession, forkChatSession } from '../../src/core/chat-sessions.js';
import { withSessionScope } from '../../src/core/session-context.js';
import type { ToolEntry } from '../../src/types/agent.js';
import { RuntimeProjection } from '../../src/agent/runtime/projection.js';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';

const traceSettings = structuredClone(settings.trace);
beforeEach(() => { db.prepare('DELETE FROM trace_runs').run(); settings.trace = structuredClone(traceSettings); });
after(() => { db.close(); rmSync(JAW_HOME, { recursive: true, force: true }); });

function run(audience: 'public' | 'internal' = 'public', sessionId = 'default'): RuntimeEventContext {
    const scope = 'local:' + sessionId;
    return { runId: startTraceRun({ cli: 'fixture', audience, sessionId, scopeKey: scope }),
        sessionId, scope, turnId: 'turn-1', audience };
}
function started(audience: 'public' | 'internal' = 'public', sessionId = 'default') {
    const context = run(audience, sessionId);
    assert.ok(recordRuntimeEvent(context, { kind: 'turn-start', provider: 'fixture' }));
    return context;
}
const text = (context: RuntimeEventContext, value = 'hello') => recordRuntimeEvent(context,
    { kind: 'message', itemId: 'message', phase: 'unknown', text: value, operation: 'append' });
const page = (c: RuntimeEventContext, after = 0, through?: number, limit = 40) =>
    readActivityPage({ runId: c.runId, sessionId: c.sessionId, after, ...(through === undefined ? {} : { through }), limit });
const count = (runId: string) => (db.prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id=? AND source='runtime'").get(runId) as { n: number }).n;

test('preview loss is retained as incomplete while later events and the actual terminal remain recordable', t => {
    t.mock.method(console, 'warn', () => {});
    const c = run(); const projection = new RuntimeProjection(c);
    projection.start('fixture');
    projection.text('message', 'large', 'x'.repeat(4000), 'replace');
    assert.equal(readActivityControl(c.runId)?.state.loss, 'projection_degraded');
    assert.equal(page(c)?.incomplete, true);
    projection.tool('later', { name: 'Read', status: 'done' });
    assert.equal(page(c)?.events.at(-1)?.kind, 'tool');
    projection.close({ kind: 'turn-end', status: 'done', finalText: 'Actual final.' });
    finalizeTraceRun(c.runId, 'done');
    assert.equal(page(c)?.events.at(-1)?.kind, 'turn-end');
    assert.equal(page(c)?.loss, 'projection_degraded');
    assert.equal(getTraceRun(c.runId)?.status, 'done');
});

test('real journal loss supersedes preview loss and cannot resume recording', () => {
    const c = started();
    const projection = new RuntimeProjection(c);
    projection.report('truncated');
    assert.equal(page(c)?.loss, 'projection_degraded');
    assert.equal(text(c, 'x'.repeat(33000)), null);
    assert.equal(page(c)?.loss, 'event_limit');
    assert.equal(text(c, 'cannot resume'), null);
});

test('real byte cap seals after preview degradation and refuses a smaller record that would fit', t => {
    t.mock.method(console, 'warn', () => {});
    const scratch = started();
    const before = readActivityControl(scratch.runId)!.state.bytes;
    assert.ok(text(scratch, 's'));
    const afterSmall = readActivityControl(scratch.runId)!.state.bytes;
    assert.ok(text(scratch, 'L'.repeat(1000)));
    const afterLarge = readActivityControl(scratch.runId)!.state.bytes;
    const S = afterSmall - before, L = afterLarge - afterSmall;
    const c = started(); const projection = new RuntimeProjection(c);
    projection.report('truncated'); assert.equal(page(c)?.loss, 'projection_degraded');
    const control = readActivityControl(c.runId)!;
    const remaining = Math.floor((S + L) / 2);
    assert.ok(S < remaining && remaining < L);
    writeActivityControl(c.runId, control.seq, { ...control.state, bytes: ACTIVITY_RUN_BYTES - remaining });
    const n = count(c.runId);
    assert.equal(text(c, 'L'.repeat(1000)), null); assert.equal(page(c)?.loss, 'run_limit');
    assert.equal(text(c, 's'), null); assert.equal(count(c.runId), n);
});

test('an injected in-memory recorder cannot mutate a real journal sharing its identity', t => {
    t.mock.method(console, 'warn', () => {});
    const c = started(); const before = readActivityControl(c.runId);
    const recorded: RuntimeEvent[] = [];
    const projection = new RuntimeProjection(c, (owner, body) => {
        const event = { ...owner, version: 1 as const, seq: recorded.length + 1, ...body };
        recorded.push(event); return event;
    }, () => {});
    projection.start('fixture');
    projection.text('message', 'large', 'x'.repeat(4000), 'replace');
    projection.report('capacity');
    projection.close({ kind: 'turn-end', status: 'done', finalText: 'In-memory final.' });
    assert.equal(recorded.at(-1)?.kind, 'turn-end');
    assert.deepEqual(readActivityControl(c.runId), before);
    assert.equal(count(c.runId), 1);
});

test('committed noncontiguous sequence, immutable events and latest tool snapshots coexist', () => {
    const c = started();
    const first = text(c)!;
    const tool: ToolEntry = { icon: 'x', label: 'command', toolType: 'tool', stepRef: 'command-1', status: 'running' };
    stampTraceTool(tool, { traceRunId: c.runId });
    const second = text(c, 'world')!;
    assert.equal(second.seq, first.seq + 2);
    const before = getTraceEvent(c.runId, first.seq)?.raw;
    tool.status = 'done'; tool.detail = 'finished'; updateTraceToolRow(tool);
    assert.equal(getTraceEvent(c.runId, first.seq)?.raw, before);
    assert.deepEqual(page(c)?.events.map(e => e.seq), [2, first.seq, second.seq]);
    assert.equal(page(c)?.loss, null);
    assert.equal(page(c)?.incomplete, false);
});

test('frozen high watermark excludes concurrent tail; small pages advance by scanned cursor', () => {
    const c = started(); text(c, 'one'); text(c, 'two');
    const first = page(c, 0, undefined, 1)!;
    const tail = text(c, 'later')!;
    const rest = page(c, first.nextAfter, first.through)!;
    assert.ok(rest.events.every(e => e.seq < tail.seq));
    assert.equal(rest.nextAfter, first.through);
    assert.equal(rest.hasMore, false);
    assert.equal(page(c, first.through)?.events.at(-1)?.seq, tail.seq);
    assert.throws(() => page(c, 0, tail.seq + 1), RangeError);
    assert.throws(() => page(c, tail.seq + 1), RangeError);
});

test('page UTF-8 byte budget bounds valid multi-byte event streams', () => {
    const c = started();
    for (let i = 0; i < 40; i++) assert.ok(text(c, '한'.repeat(8000)));
    let cursor = 0, total = 0, through: number | undefined;
    do {
        const p = page(c, cursor, through)!;
        assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: p })) <= ACTIVITY_PAGE_BYTES);
        assert.ok(p.events.length <= 40);
        assert.ok(p.nextAfter > cursor);
        total += p.events.length; cursor = p.nextAfter; through = p.through;
        if (!p.hasMore) break;
    } while (total < 100);
    assert.equal(total, 41);
});

test('corrupt and oversized rows advance cursor; oversized control is distinct from absence', () => {
    const c = started(); const bad = text(c)!; const huge = text(c)!; const good = text(c)!;
    db.prepare('UPDATE trace_events SET raw_json=? WHERE run_id=? AND seq=?').run('{bad', c.runId, bad.seq);
    db.prepare('UPDATE trace_events SET raw_json=? WHERE run_id=? AND seq=?').run('x'.repeat(1_000_000), c.runId, huge.seq);
    const p = page(c, bad.seq - 1, undefined, 2)!;
    assert.equal(p.events.length, 0); assert.equal(p.nextAfter, huge.seq);
    assert.equal(p.loss, 'corrupt'); assert.equal(p.incomplete, true); assert.equal(p.hasMore, true);
    assert.equal(page(c, p.nextAfter, p.through)?.events[0]?.seq, good.seq);
    const control = readActivityControl(c.runId)!;
    db.prepare('UPDATE trace_events SET raw_json=? WHERE run_id=? AND seq=?').run('x'.repeat(1_000_000), c.runId, control.seq);
    assert.throws(() => page(c), /control_corrupt/);
    assert.equal(text(c), null);
    assert.doesNotThrow(() => finalizeTraceRun(c.runId, 'done'));
    assert.equal(getTraceRun(c.runId)?.status, 'done');
});

test('null, empty and whitespace finals survive; closure is idempotent and late writes stop', () => {
    for (const finalText of [null, '', ' \n']) {
        const c = started();
        assert.ok(recordRuntimeEvent(c, { kind: 'turn-end', status: 'done', finalText }));
        closeActivity(c.runId); finalizeTraceRun(c.runId, 'done'); closeActivity(c.runId);
        const p = page(c)!;
        const end = p.events.at(-1);
        assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, finalText);
        assert.equal(p.incomplete, false); assert.equal(text(c), null);
    }
    const interrupted = started(); text(interrupted, 'partial'); finalizeTraceRun(interrupted.runId, 'interrupted');
    assert.equal(page(interrupted)?.loss, 'storage_error');
    assert.equal(page(interrupted)?.incomplete, true);
});

test('owner, scope, start and audience checks block writes and public reads', () => {
    const c = run(); assert.equal(text(c), null);
    recordRuntimeEvent(c, { kind: 'turn-start', provider: 'fixture' });
    assert.equal(text({ ...c, sessionId: 'missing' }), null);
    assert.equal(text({ ...c, scope: 'foreign' }), null);
    assert.equal(text({ ...c, audience: 'internal' }), null);
    assert.equal(text({ ...c, sessionId: 'missing' }, 'x'.repeat(33_000)), null);
    assert.equal(text({ ...c, scope: 'foreign' }, 'x'.repeat(33_000)), null);
    assert.equal(page(c)?.loss, null, 'foreign preflight failures cannot mark another owner');
    assert.equal(getActivityOwner(c.runId, 'missing'), null);
    const internal = started('internal'); assert.ok(text(internal));
    assert.equal(page(internal), null);
    assert.equal(isTraceSessionOwner(internal.runId, internal.sessionId), false);
    assert.equal(text({ ...internal, audience: 'public' }), null);
    assert.equal(text({ ...internal, audience: 'public' }, 'x'.repeat(33_000)), null);
    assert.equal(readActivityControl(internal.runId)?.state.loss, null);
    assert.ok(listActivityRuns('default').every(r => r.id !== internal.runId));
    const unowned = startTraceRun({ cli: 'legacy' });
    assert.equal(getTraceRun(unowned)?.session_id, null);
    assert.equal(readActivityPage({ runId: unowned, sessionId: 'default', after: 0, limit: 40 }), null);
});

test('limits persist a loss instead of truncating an append or emitting a false terminal', () => {
    for (const [key, amount] of [['count', ACTIVITY_RUN_ROWS], ['bytes', ACTIVITY_RUN_BYTES]] as const) {
        const c = started(); const control = readActivityControl(c.runId)!;
        writeActivityControl(c.runId, control.seq, { ...control.state, [key]: amount });
        assert.equal(text(c), null); assert.equal(count(c.runId), 1); assert.equal(page(c)?.loss, 'run_limit');
    }
    const huge = started(); assert.equal(text(huge, 'x'.repeat(33_000)), null);
    assert.equal(page(huge)?.loss, 'event_limit'); assert.equal(count(huge.runId), 1);
    const cap = started(); settings.trace.maxRows = 1;
    assert.equal(text(cap), null); assert.equal(page(cap)?.loss, 'global_limit');
});

test('legacy runtime rows count toward global row and byte admission limits', () => {
    for (const [rows, raw] of [[ACTIVITY_GLOBAL_ROWS, '{}'], [1100, 'x'.repeat(32_000)]] as const) {
        db.prepare('DELETE FROM trace_runs').run();
        const c = started(); const old = startTraceRun({ cli: 'legacy' });
        db.prepare(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n < ?)
            INSERT INTO trace_events (run_id,seq,source,event_type,raw_json,bytes,retention_status,created_at)
            SELECT ?,n,'runtime','message',?,?,'available',? FROM nums`)
            .run(rows, old, raw, Buffer.byteLength(raw), Date.now());
        assert.equal(text(c), null); assert.equal(page(c)?.loss, 'global_limit');
    }
});

for (const pressure of ['rows', 'bytes', 'configured-rows'] as const) {
    test(`finished history cannot permanently starve new activity under ${pressure} pressure`, () => {
        const old = started(); text(old, 'old prefix');
        recordRuntimeEvent(old, { kind: 'turn-end', status: 'done', finalText: 'old answer' });
        finalizeTraceRun(old.runId, 'done');
        const high = page(old)!.through;
        const active = started(); const retained = text(active, 'active prefix')!;
        if (pressure === 'rows') {
            const n = ACTIVITY_GLOBAL_ROWS - 5;
            db.prepare(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n < ?)
                INSERT INTO trace_events (run_id,seq,source,event_type,raw_json,bytes,retention_status,created_at)
                SELECT ?,n+100,'runtime','message','{}',2,'available',? FROM nums`).run(n, old.runId, Date.now());
        } else if (pressure === 'bytes') {
            db.prepare("UPDATE trace_events SET bytes=? WHERE run_id=? AND source='runtime'")
                .run(Math.ceil(ACTIVITY_GLOBAL_BYTES / 3), old.runId);
        } else {
            settings.trace.maxRows = (db.prepare('SELECT count(*) n FROM trace_events').get() as { n: number }).n + 1;
        }
        const fresh = run();
        assert.ok(recordRuntimeEvent(fresh, { kind: 'turn-start', provider: 'fixture' }), 'new run must obtain capacity from closed history');
        assert.equal(page(fresh)?.loss, null);
        assert.equal(page(old)?.loss, 'retention');
        assert.equal(page(old)?.through, high);
        assert.deepEqual(page(old)?.events, []);
        assert.ok(getTraceRun(old.runId), 'expired history retains its ownership/tombstone');
        assert.equal(getTraceEvent(active.runId, retained.seq)?.raw !== undefined, true);
        assert.equal(page(active)?.loss, null, 'active prefix is never reclaimed for capacity');
        const total = db.prepare("SELECT count(*) n,sum(bytes) bytes FROM trace_events WHERE source='runtime'").get() as { n: number; bytes: number };
        assert.ok(total.n <= ACTIVITY_GLOBAL_ROWS); assert.ok(total.bytes <= ACTIVITY_GLOBAL_BYTES);
    });
}

test('failed admission rolls back capacity reclamation and publishes no partial history', t => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const old = started(); text(old);
    recordRuntimeEvent(old, { kind: 'turn-end', status: 'done', finalText: 'answer' });
    finalizeTraceRun(old.runId, 'done');
    const before = page(old);
    settings.trace.maxRows = (db.prepare('SELECT count(*) n FROM trace_events').get() as { n: number }).n + 1;
    const next = run();
    db.exec(`CREATE TRIGGER activity_capacity_fail BEFORE INSERT ON trace_events WHEN new.source='runtime'
        BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
    const events: BusEvent[] = []; const unsubscribe = subscribe(e => events.push(e));
    try {
        assert.equal(recordRuntimeEvent(next, { kind: 'turn-start', provider: 'fixture' }), null);
        assert.deepEqual(page(old), before);
        assert.equal(events.length, 0);
    } finally { db.exec('DROP TRIGGER activity_capacity_fail'); unsubscribe(); }
});

test('failed control update rolls back runtime insert and publishes nothing', t => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const c = started(); const control = readActivityControl(c.runId)!;
    const events: BusEvent[] = []; const unsubscribe = subscribe(e => events.push(e));
    db.exec(`CREATE TRIGGER activity_fail BEFORE UPDATE ON trace_events
        WHEN old.source='system' AND old.event_type='runtime.control.v1'
        BEGIN SELECT RAISE(ABORT, 'fixture control failure'); END`);
    try {
        assert.equal(text(c), null); assert.equal(count(c.runId), 1);
        assert.equal(readActivityControl(c.runId)?.state.lastSeq, control.state.lastSeq);
        assert.equal(events.length, 0);
    } finally { db.exec('DROP TRIGGER activity_fail'); unsubscribe(); }
    const next = text(c)!; assert.ok(next.seq > control.state.lastSeq + 1, 'rolled-back seq is never published/reused in-process');
});

test('SQL busy and failed insert leave final caller usable with no journal publication', t => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const c = started(); const other = new Database(join(JAW_HOME, 'jaw.db'));
    db.pragma('busy_timeout=1'); other.exec('BEGIN IMMEDIATE');
    try { assert.equal(text(c), null); assert.equal(count(c.runId), 1); }
    finally { other.exec('ROLLBACK'); other.close(); db.pragma('busy_timeout=5000'); }
    db.exec(`CREATE TRIGGER activity_insert_fail BEFORE INSERT ON trace_events WHEN new.source='runtime'
        BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
    try { assert.equal(text(c), null); assert.equal(count(c.runId), 1); }
    finally { db.exec('DROP TRIGGER activity_insert_fail'); }
    assert.equal(page(c)?.loss, 'storage_error');
});

test('retention expires whole prefixes, keeps active owners and eventually reclaims closed metadata', () => {
    const admitted = run();
    db.prepare('UPDATE trace_runs SET started_at=0 WHERE id=?').run(admitted.runId);
    pruneTraceEvents(7, 0);
    assert.ok(getTraceRun(admitted.runId), 'admitted owner survives before first semantic event');
    const c = started(); text(c); const high = page(c)!.through;
    db.prepare('UPDATE trace_events SET created_at=0 WHERE run_id=?').run(c.runId);
    db.prepare('UPDATE trace_runs SET started_at=0 WHERE id=?').run(c.runId);
    pruneTraceEvents(7, 0);
    assert.ok(getTraceRun(c.runId)); assert.equal(text(c), null);
    assert.deepEqual(page(c)?.events, []); assert.equal(page(c)?.through, high);
    assert.equal(page(c)?.nextAfter, high); assert.equal(page(c)?.hasMore, false);
    assert.equal(page(c)?.loss, 'retention');
    finalizeTraceRun(c.runId, 'interrupted'); pruneTraceEvents(7, 0);
    assert.equal(getTraceRun(c.runId), null);
    const closed = started(); text(closed); recordRuntimeEvent(closed, { kind: 'turn-end', status: 'done', finalText: 'answer' });
    finalizeTraceRun(closed.runId, 'done'); expireActivityPrefix(closed.runId);
    assert.equal(page(closed)?.loss, 'retention'); pruneTraceEvents(7, 0);
    assert.equal(getTraceRun(closed.runId), null);
});

test('retention reclaims obsolete raw spill files within a still-owned run', () => {
    const c = started();
    const spill = appendTraceEvent({ runId: c.runId, source: 'cli_raw', eventType: 'large', raw: 'x'.repeat(100_000) })!;
    const row = getTraceEvent(c.runId, spill.traceSeq)!; assert.ok(row.raw_path);
    const path = join(JAW_HOME, row.raw_path); assert.ok(existsSync(path));
    db.prepare('UPDATE trace_events SET created_at=0 WHERE run_id=? AND seq=?').run(c.runId, spill.traceSeq);
    pruneTraceEvents(7); assert.equal(existsSync(path), false); assert.ok(getTraceRun(c.runId));
});

test('corrupt control cannot block unrelated retention or closed owner reclamation', () => {
    const corrupt = started(); text(corrupt);
    const control = readActivityControl(corrupt.runId)!;
    db.prepare('UPDATE trace_events SET raw_json=? WHERE run_id=? AND seq=?').run('x'.repeat(1_000_000), corrupt.runId, control.seq);
    db.prepare('UPDATE trace_events SET created_at=0 WHERE run_id=?').run(corrupt.runId);
    const healthy = started(); text(healthy);
    db.prepare('UPDATE trace_events SET created_at=0 WHERE run_id=?').run(healthy.runId);
    const rawRun = startTraceRun({ cli: 'legacy' });
    const raw = appendTraceEvent({ runId: rawRun, source: 'cli_raw', eventType: 'large', raw: 'x'.repeat(100_000) })!;
    const rawPath = join(JAW_HOME, getTraceEvent(rawRun, raw.traceSeq)!.raw_path!);
    db.prepare('UPDATE trace_events SET created_at=0 WHERE run_id=?').run(rawRun);
    const pruned = pruneTraceEvents(7);
    assert.ok(pruned.deletedEvents >= 5);
    assert.equal(count(corrupt.runId), 0); assert.ok(getTraceRun(corrupt.runId));
    assert.equal(page(healthy)?.loss, 'retention'); assert.equal(existsSync(rawPath), false);
    assert.throws(() => page(corrupt), /control_corrupt/);
    finalizeTraceRun(corrupt.runId, 'error'); pruneTraceEvents(7, 0);
    assert.equal(getTraceRun(corrupt.runId), null);
    assert.ok(getTraceRun(healthy.runId));
});

test('retention refuses a symlinked trace root and preserves an external sentinel', () => {
    const c = started(); const root = join(JAW_HOME, 'traces'); const held = join(JAW_HOME, 'traces-held');
    const external = mkdtempSync(join(tmpdir(), 'cli-jaw-activity-external-'));
    mkdirSync(join(external, c.runId));
    const sentinel = join(external, c.runId, '999999.json'); writeFileSync(sentinel, 'external sentinel');
    const hadRoot = existsSync(root); if (hadRoot) renameSync(root, held);
    symlinkSync(external, root, process.platform === 'win32' ? 'junction' : 'dir');
    try { pruneTraceEvents(7); assert.equal(readFileSync(sentinel, 'utf8'), 'external sentinel'); }
    finally { unlinkSync(root); if (hadRoot) renameSync(held, root); rmSync(external, { recursive: true, force: true }); }
});

test('fork cannot acquire source journal and deleting the owner removes its trace', () => {
    const owner = createChatSession('journal-owner'); const c = started('public', owner.id); text(c);
    const fork = forkChatSession(owner.id);
    assert.equal(readActivityPage({ runId: c.runId, sessionId: fork.id, after: 0, limit: 40 }), null);
    assert.ok(deleteChatSession(owner.id)); assert.equal(getTraceRun(c.runId), null); assert.equal(text(c), null);
});

test('semantic records and broadcast defense bypass messaging listeners while legacy final remains', () => {
    const legacy: string[] = []; const seen: BusEvent[] = [];
    const listener = (type: string) => legacy.push(type); addBroadcastListener(listener);
    const unsubscribe = subscribe(e => seen.push(e));
    try {
        const c = started(); text(c);
        broadcast('agent_runtime_gap', { runId: c.runId, sessionId: c.sessionId, scope: c.scope });
        broadcast('agent_runtime', { runId: 'internal' }, 'internal');
        assert.deepEqual(legacy, []); assert.equal(seen.length, 3);
        const previous = settings.multiSession.enabled;
        settings.multiSession.enabled = true;
        try {
            withSessionScope({ scope: c.scope, chatSessionId: c.sessionId }, () => {
                for (const type of ['agent_runtime', 'agent_runtime_gap']) {
                    for (const key of ['runId', 'sessionId', 'scope']) {
                        for (const value of [undefined, null, '', '  ', 1, ['owner'], {}]) {
                            broadcast(type, { runId: c.runId, sessionId: c.sessionId, scope: c.scope, [key]: value });
                        }
                    }
                }
            });
        } finally { settings.multiSession.enabled = previous; }
        assert.deepEqual(legacy, []); assert.equal(seen.length, 3, 'ambient scope cannot fill missing canonical identity');
        broadcast('agent_done', { text: 'authoritative legacy final' });
        assert.deepEqual(legacy, ['agent_done']);
    } finally { unsubscribe(); removeBroadcastListener(listener); }
});

test('another process reads durable journal and marks only stale running traces interrupted', () => {
    const c = started(); text(c);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const s=await import('./src/trace/store.ts');s.markStaleTraceRunsInterrupted();
         const j=await import('./src/trace/activity-journal.ts');
         console.log('RESULT:'+JSON.stringify(j.readActivityPage({runId:${JSON.stringify(c.runId)},sessionId:'default',after:0,limit:40})));`],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.split('RESULT:')[1]!);
    assert.equal(result.status, 'interrupted'); assert.equal(result.events.length, 2);
    assert.equal(result.incomplete, true); assert.equal(text(c), null);
});

test('legacy schema migration backfills only original message ownership and remains idempotent', () => {
    for (const originalOwner of ['original-owner', 'default']) {
    const home = mkdtempSync(join(tmpdir(), 'cli-jaw-activity-migration-'));
    const legacy = new Database(join(home, 'jaw.db'));
    legacy.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL,
        content TEXT NOT NULL, cli TEXT, model TEXT, trace TEXT, cost_usd REAL, duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, ${originalOwner === 'default' ? '' : 'session_id TEXT,'} trace_run_id TEXT);
        CREATE TABLE trace_runs (id TEXT PRIMARY KEY, message_id INTEGER, parent_run_id TEXT,
        cli TEXT NOT NULL, model TEXT, working_dir TEXT, agent_label TEXT, audience TEXT DEFAULT 'public',
        status TEXT DEFAULT 'done', raw_retention_status TEXT DEFAULT 'available', event_count INTEGER DEFAULT 0,
        byte_count INTEGER DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER, last_event_at INTEGER, error TEXT);
        INSERT INTO trace_runs(id,message_id,cli,started_at) VALUES('tr_legacy1234567890',1,'legacy',1);
        INSERT INTO messages(id,role,content,trace_run_id) VALUES
            (1,'assistant','original','tr_legacy1234567890'),
            (2,'assistant','copied','tr_legacy1234567890');`);
    if (originalOwner !== 'default') legacy.exec("UPDATE messages SET session_id=CASE WHEN id=1 THEN 'original-owner' ELSE 'fork-owner' END");
    legacy.close();
    try {
        for (let i = 0; i < 2; i++) {
            const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
                `const {db}=await import('./src/core/db.ts');
                 console.log('RESULT:'+JSON.stringify(db.prepare('SELECT session_id,scope_key FROM trace_runs').all()));db.close();`],
            { cwd: process.cwd(), env: { ...process.env, CLI_JAW_HOME: home }, encoding: 'utf8', timeout: 10_000 });
            assert.equal(child.status, 0, child.stderr);
            assert.deepEqual(JSON.parse(child.stdout.split('RESULT:')[1]!), [{ session_id: originalOwner, scope_key: null }]);
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
    }
});
