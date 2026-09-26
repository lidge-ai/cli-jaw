// Contract: the installed SDK's own history helpers against synthetic transcripts in a
// temporary CLAUDE_CONFIG_DIR. Nothing here reads or writes the user's ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-claude-history-')));
process.env['CLAUDE_CONFIG_DIR'] = join(root, 'config');
delete process.env['CLAUDE_CODE_PROJECT_DIR_NAME'];
test.after(() => rmSync(root, { recursive: true, force: true }));

const { createClaudeCodeProvider } = await import('../../src/code-mode/providers/claude.ts');
const { CodeStoreError } = await import('../../src/code-mode/store.ts');
const { loadClaudeHistory } = await import('../../src/agent/runtime/claude-sdk-history-loader.ts');
const sdk = await loadClaudeHistory();

const provider = createClaudeCodeProvider({ describe: () => ({ capabilities: { permissionModes: ['ask'] } }) as never,
    binary: () => '/nonexistent/claude', environment: () => ({ ...process.env }) },
(async () => { throw new Error('a rollback never opens a runtime'); }) as never);

let workspaces = 0;
function workspace() {
    const cwd = join(root, `project-${++workspaces}`);
    mkdirSync(cwd, { recursive: true });
    const dir = join(root, 'config', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    return { cwd, dir, files: () => readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort() };
}

type Entry = Record<string, unknown> & { uuid?: string };
/** Entries shaped like the CLI's transcript lines (version 2.1.282), chained by parentUuid. */
function transcript(cwd: string, sessionId = randomUUID(), parent: string | null = null) {
    const lines: Entry[] = [];
    let clock = Date.parse('2026-09-26T00:00:00Z');
    const base = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId,
        version: '2.1.282', timestamp: new Date(clock += 1000).toISOString() });
    const push = (entry: Entry) => { lines.push(entry); if (entry.uuid) parent = entry.uuid; return entry.uuid!; };
    return {
        sessionId, lines,
        user: (text: string, uuid = randomUUID()) => push({ ...base(), type: 'user', promptId: randomUUID(),
            message: { role: 'user', content: [{ type: 'text', text }] }, uuid }),
        assistant: (content: unknown[], id = `msg_${randomUUID().slice(0, 8)}`) => push({ ...base(), type: 'assistant', uuid: randomUUID(),
            message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content, stop_reason: 'end_turn',
                stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
        text: (text: string) => [{ type: 'text', text }],
        toolResult: (id: string, output: string) => push({ ...base(), type: 'user', uuid: randomUUID(), toolUseResult: { stdout: output },
            message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output, is_error: false }] } }),
        attachment: (attachment: Record<string, unknown>) => push({ ...base(), type: 'attachment', attachment, uuid: randomUUID() }),
        /** An automatic compaction; `preserve` keeps that message as a preserved segment after the summary. */
        compact(preserve?: string) {
            const logical = parent, summary = randomUUID();
            push({ ...base(), parentUuid: null, logicalParentUuid: logical, type: 'system', subtype: 'compact_boundary',
                content: 'Conversation compacted', isMeta: false, level: 'info', uuid: randomUUID(),
                compactMetadata: { trigger: 'auto', preTokens: 30,
                    ...(preserve ? { preservedSegment: { headUuid: preserve, anchorUuid: summary, tailUuid: preserve } } : {}) } });
            push({ ...base(), type: 'user', uuid: summary, isVisibleInTranscriptOnly: true, isCompactSummary: true,
                message: { role: 'user', content: 'This session is being continued from a previous conversation. SUMMARY' } });
        },
        write(dir: string) { writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n'); },
        append(dir: string) { appendFileSync(join(dir, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n'); },
    };
}

type Turn = { turnId: string; promptUuid: string | null };
const rollback = (cwd: string, nativeCursor: string, kept: Turn[], later: Turn[]) => provider.rollback!({
    cwd, nativeCursor, title: 'Contract', target: { turnId: kept.at(-1)!.turnId, promptUuid: kept.at(-1)!.promptUuid! }, kept, later });
const texts = async (cwd: string, id: string) => (await sdk.getSessionMessages(id, { dir: cwd })).map(message => JSON.stringify(message.message));
const rejects = (code: string) => (error: unknown) => error instanceof CodeStoreError && error.code === code;

/** T1 runs a tool and receives a follow-up queued while the tool ran; T2 and T3 answer in text. */
function twoTurnsWithTool(cwd: string) {
    const t = transcript(cwd);
    const t1 = t.user('first prompt USE_TOOL');
    t.attachment({ type: 'total_tokens_reminder', text: 'tokens' });
    t.assistant(t.text('Running a tool.'), 'msg_tool');
    t.assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }], 'msg_tool');
    t.toolResult('toolu_1', 'hi');
    const queued = randomUUID();
    t.attachment({ type: 'queued_command', prompt: [{ type: 'text', text: 'FOLLOWUP during tool' }], source_uuid: queued, commandMode: 'prompt' });
    t.assistant(t.text('TOOL-DONE'));
    const t2 = t.user('second prompt SECRET-TWO');
    t.assistant(t.text('ANSWER two'));
    const t3 = t.user('third prompt');
    t.assistant(t.text('ANSWER three'));
    return { t, t1, t2, t3, queued };
}

test('rollback to the first of three turns forks through its tool result and queued follow-up, and a second rollback works on the fork', async () => {
    const w = workspace();
    const { t, t1, t2, t3, queued } = twoTurnsWithTool(w.cwd);
    t.write(w.dir);
    const sourceFile = join(w.dir, `${t.sessionId}.jsonl`), sourceBytes = readFileSync(sourceFile);
    const first = await rollback(w.cwd, t.sessionId, [{ turnId: 'turn-1', promptUuid: t1 }],
        [{ turnId: 'turn-2', promptUuid: t2 }, { turnId: 'turn-3', promptUuid: t3 }]);
    assert.deepEqual(readFileSync(sourceFile), sourceBytes, 'the source transcript is never modified');
    const forked = await sdk.getSessionMessages(first.forkCursor, { dir: w.cwd, includeSystemMessages: true });
    assert.deepEqual(forked.map(message => message.type), ['user', 'assistant', 'assistant', 'user', 'user', 'assistant']);
    const body = JSON.stringify(forked);
    assert.ok(body.includes('tool_result') && body.includes('FOLLOWUP during tool') && body.includes('TOOL-DONE'));
    assert.ok(!body.includes('SECRET-TWO') && !body.includes('third prompt'));
    assert.equal(first.remapped.length, 1);
    assert.equal(first.remapped[0]!.promptUuid, forked[0]!.uuid);
    assert.notEqual(first.remapped[0]!.promptUuid, t1, 'the fork re-identifies its messages');
    assert.equal(forked[4]!.uuid, queued, 'a folded follow-up keeps its source uuid, so fork and source ids overlap');
    assert.deepEqual(first.cleared, []);

    // The resumed fork gains two more turns, then rolls back to the middle one.
    const last = [...readFileSync(join(w.dir, `${first.forkCursor}.jsonl`), 'utf8').trim().split('\n')].map(line => JSON.parse(line) as Entry)
        .filter(entry => entry.uuid && ['user', 'assistant', 'attachment', 'system'].includes(String(entry['type']))).at(-1)!.uuid!;
    const more = transcript(w.cwd, first.forkCursor, last);
    const t4 = more.user('fourth prompt');
    more.assistant(more.text('ANSWER four'));
    const t5 = more.user('fifth prompt SECRET-FIVE');
    more.assistant(more.text('ANSWER five'));
    more.append(w.dir);
    const second = await rollback(w.cwd, first.forkCursor, [{ turnId: 'turn-1', promptUuid: first.remapped[0]!.promptUuid }, { turnId: 'turn-4', promptUuid: t4 }],
        [{ turnId: 'turn-5', promptUuid: t5 }]);
    const again = await texts(w.cwd, second.forkCursor);
    assert.ok(again.some(text => text.includes('first prompt USE_TOOL')) && again.some(text => text.includes('ANSWER four')));
    assert.ok(!again.some(text => text.includes('SECRET-FIVE')));
    const secondMessages = await sdk.getSessionMessages(second.forkCursor, { dir: w.cwd });
    assert.deepEqual(second.remapped.map(turn => turn.turnId), ['turn-1', 'turn-4']);
    assert.deepEqual(second.remapped.map(turn => secondMessages.find(message => message.uuid === turn.promptUuid)?.type), ['user', 'user']);
    assert.equal(w.files().length, 3, 'source, first fork and second fork');
});

test('the fork point passes a missing later boundary only up to its own turn', async () => {
    const w = workspace();
    const { t, t1, t3 } = twoTurnsWithTool(w.cwd);
    t.write(w.dir);
    await assert.rejects(rollback(w.cwd, t.sessionId, [{ turnId: 'turn-1', promptUuid: t1 }],
        [{ turnId: 'turn-2', promptUuid: randomUUID() }, { turnId: 'turn-3', promptUuid: t3 }]), rejects('rollback_boundary_unavailable'));
    const skipped = await rollback(w.cwd, t.sessionId, [{ turnId: 'turn-1', promptUuid: t1 }],
        [{ turnId: 'turn-2', promptUuid: null }, { turnId: 'turn-3', promptUuid: t3 }]);
    const body = JSON.stringify(await sdk.getSessionMessages(skipped.forkCursor, { dir: w.cwd }));
    assert.ok(body.includes('SECRET-TWO') && !body.includes('third prompt'), 'an undispatched turn is skipped, the next dispatched one bounds the fork');
    await assert.rejects(rollback(w.cwd, randomUUID(), [{ turnId: 'turn-1', promptUuid: t1 }], [{ turnId: 'turn-2', promptUuid: t3 }]),
        rejects('rollback_unavailable'), 'a missing session has no history');
    assert.equal(w.files().length, 2);
});

test('a prompt stopped before Claude recorded it is passed over, up to the next recorded prompt or the end of history', async () => {
    const w = workspace();
    const t = transcript(w.cwd);
    const t1 = t.user('one'); t.assistant(t.text('A1'));
    const t2 = t.user('two'); t.assistant([{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'true' } }]);
    t.toolResult('toolu_2', ''); t.assistant(t.text('A2'));
    const t4 = t.user('four SECRET-FOUR'); t.assistant(t.text('A4'));
    t.write(w.dir);
    const stopped = { turnId: 'turn-3', promptUuid: randomUUID() };
    const kept = [{ turnId: 'turn-1', promptUuid: t1 }, { turnId: 'turn-2', promptUuid: t2 }];
    const passed = await rollback(w.cwd, t.sessionId, kept, [stopped, { turnId: 'turn-4', promptUuid: t4 }]);
    const body = await texts(w.cwd, passed.forkCursor);
    assert.ok(body.some(text => text.includes('A2')) && !body.some(text => text.includes('SECRET-FOUR')));
    assert.deepEqual(passed.remapped.map(turn => turn.turnId), ['turn-1', 'turn-2']);
    // Rolled back again from the fork, where turn 4 never happened: the whole history is kept.
    const whole = await rollback(w.cwd, passed.forkCursor, [{ turnId: 'turn-1', promptUuid: passed.remapped[0]!.promptUuid },
        { turnId: 'turn-2', promptUuid: passed.remapped[1]!.promptUuid }], [stopped]);
    assert.deepEqual(await texts(w.cwd, whole.forkCursor), await texts(w.cwd, passed.forkCursor));
    // A turn typed elsewhere after the target is a human turn start: fail closed, no fork.
    const outside = transcript(w.cwd);
    const o1 = outside.user('one'); outside.assistant(outside.text('A1'));
    outside.user('typed in claude --resume'); outside.assistant(outside.text('elsewhere'));
    outside.write(w.dir);
    const files = w.files().length;
    await assert.rejects(rollback(w.cwd, outside.sessionId, [{ turnId: 'turn-1', promptUuid: o1 }], [stopped]), rejects('rollback_boundary_unavailable'));
    assert.equal(w.files().length, files);
});

for (const preserved of [false, true]) {
    test(`a compaction ${preserved ? 'with' : 'without'} a preserved segment fails closed across it`, async () => {
        const w = workspace();
        const t = transcript(w.cwd);
        const t1 = t.user('one'); t.assistant(t.text('A1'));
        const t2 = t.user('two SECRET-TWO'); const a2 = t.assistant(t.text('A2'));
        t.compact(preserved ? a2 : undefined);
        const t3 = t.user('three'); t.assistant(t.text('A3'));
        const t4 = t.user('four'); t.assistant(t.text('A4'));
        t.write(w.dir);
        const turns = [{ turnId: 'turn-1', promptUuid: t1 }, { turnId: 'turn-2', promptUuid: t2 },
            { turnId: 'turn-3', promptUuid: t3 }, { turnId: 'turn-4', promptUuid: t4 }];
        for (const target of [0, 1]) {
            await assert.rejects(rollback(w.cwd, t.sessionId, turns.slice(0, target + 1), turns.slice(target + 1)),
                rejects('rollback_boundary_unavailable'), `turn ${target + 1} was compacted away`);
        }
        assert.deepEqual(w.files(), [`${t.sessionId}.jsonl`], 'no fork before the boundaries are proven');
        const after = rollback(w.cwd, t.sessionId, turns.slice(0, 3), turns.slice(3));
        if (preserved) {
            await assert.rejects(after, rejects('rollback_unavailable'), 'the fork drops the preserved segment, so it cannot be verified');
            assert.deepEqual(w.files(), [`${t.sessionId}.jsonl`], 'the unverified fork was deleted');
        } else {
            const result = await after;
            assert.deepEqual(result.remapped.map(turn => turn.turnId), ['turn-3']);
            assert.deepEqual(result.cleared, ['turn-1', 'turn-2'], 'compacted kept turns lose their boundary');
            const body = JSON.stringify(await sdk.getSessionMessages(result.forkCursor, { dir: w.cwd }));
            assert.ok(body.includes('SUMMARY') && body.includes('A3') && !body.includes('four'));
        }
    });
}
