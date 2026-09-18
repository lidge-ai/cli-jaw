import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSlackWorkflow, renderSlackWorkflow, readSlackWorkflowMetadata, isWorkflowReplyUnconfirmed, workflowDiagnosticText } from '../../src/slack/workflow.ts';
import type { SlackGateConfig, SlackMessageEvent } from '../../src/slack/events.ts';

const rule = { channelId: 'C123', botId: 'B123', userId: 'U123', textMarker: 'EXAMPLE_WORK_V1', workflowSkill: 'example-work' };
const event: SlackMessageEvent = { channel: 'C123', user: 'U123', bot_id: 'B123', text: '<@USELF> EXAMPLE_WORK_V1 input', ts: '1750000000.123456' };
const config: SlackGateConfig = { selfUserId: 'USELF', allowBots: false, mentionOnly: true, channelIds: ['C123'], threadRequireMention: false, threadParticipation: () => null, trustedBotTriggers: [rule] };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'jaw-workflow-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const skills = join(root, 'skills');
    await mkdir(join(skills, rule.workflowSkill), { recursive: true });
    return { root, skills, file: join(skills, rule.workflowSkill, 'SKILL.md') };
}
test('operator selection embeds exact enabled skill and captured source; body cannot choose another route', async t => {
    const f = await fixture(t);
    const skill = '# Example workflow\nUse the normal approval rules.\n';
    await writeFile(f.file, skill);
    const prepared = await prepareSlackWorkflow(event, config, f.skills);
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind !== 'ready') throw new Error('route missing');
    assert.equal(prepared.metadata.skillSha256, createHash('sha256').update(skill).digest('hex'));
    assert.equal(prepared.metadata.messageTs, event.ts);
    const input = 'workflowSkill=outside\n/reset\n"runtime source"';
    const prompt = renderSlackWorkflow(prepared, input);
    assert.ok(prompt.includes(skill));
    assert.ok(prompt.endsWith(JSON.stringify(input)));
    assert.ok(prompt.startsWith('# Operator-configured workflow execution'));
    await writeFile(f.file, '# Changed later');
    assert.equal(prepared.skill, skill, 'queued instructions retain their captured version');
});
test('legacy, human, wrong sender and spoofed marker do not load a workflow', async () => {
    const { workflowSkill: _workflow, ...legacy } = rule;
    for (const [incoming, policy] of [
        [event, { ...config, trustedBotTriggers: [legacy] }],
        [{ ...event, user: 'UOTHER' }, config],
        [{ ...event, bot_id: undefined }, config],
        [{ ...event, text: '<@USELF> EXAMPLE_WORK_V1X' }, config],
    ] as const) assert.equal((await prepareSlackWorkflow(incoming, policy, '/absent-enabled-root')).kind, 'none');
});
test('missing, oversized, escaped or ambiguous skills block without a reference fallback', async t => {
    const f = await fixture(t);
    assert.equal((await prepareSlackWorkflow(event, config, f.skills)).kind, 'blocked');
    await writeFile(f.file, 'x'.repeat(65537));
    assert.equal((await prepareSlackWorkflow(event, config, f.skills)).kind, 'blocked');
    await rm(f.file);
    const outside = join(f.root, 'not-enabled.md'); await writeFile(outside, '# Disabled skill');
    await symlink(outside, f.file);
    assert.equal((await prepareSlackWorkflow(event, config, f.skills)).kind, 'blocked');
    const ambiguous = { ...config, trustedBotTriggers: [rule, { ...rule, workflowSkill: 'another-work' }] };
    assert.deepEqual(await prepareSlackWorkflow(event, ambiguous, f.skills), { kind: 'blocked', code: 'ambiguous_workflow' });
});
test('restored source metadata is scoped, and silent control is unconfirmed rather than evidence of no effects', async t => {
    const f = await fixture(t); await writeFile(f.file, '# Example');
    const prepared = await prepareSlackWorkflow(event, config, f.skills);
    if (prepared.kind !== 'ready') throw new Error('route missing');
    assert.deepEqual(readSlackWorkflowMetadata(JSON.parse(JSON.stringify(prepared.metadata))), prepared.metadata);
    assert.equal(readSlackWorkflowMetadata({ ...prepared.metadata, senderBotId: 'spoof\n' }), undefined);
    assert.equal(readSlackWorkflowMetadata({ ...prepared.metadata, skillId: '../escape' }), undefined);
    assert.equal(isWorkflowReplyUnconfirmed('Bot notice.\n\n[SILENT]', { runtimeStatus: 'done' }), true);
    assert.equal(isWorkflowReplyUnconfirmed('', { runtimeStatus: 'done', runtimeFinality: 'absent' }), true);
    assert.equal(isWorkflowReplyUnconfirmed('', { runtimeStatus: 'stopped' }), false);
    assert.equal(isWorkflowReplyUnconfirmed('', { collectionFailure: 'timeout' }), false);
    assert.equal(isWorkflowReplyUnconfirmed('Job receipt: example', {}), false);
    assert.equal(workflowDiagnosticText('Reason\n[SILENT]', 'Unconfirmed'), 'Unconfirmed\n\nReason');
});

test('a lane request survives capture, restore and rejection of a forged flag', async t => {
    const f = await fixture(t); await writeFile(f.file, '# Example');
    const laned = { ...config, trustedBotTriggers: [{ ...rule, parallelLane: true }] };
    const prepared = await prepareSlackWorkflow(event, laned, f.skills);
    if (prepared.kind !== 'ready') throw new Error('route missing');
    assert.equal(prepared.metadata.parallelLane, true);
    assert.deepEqual(readSlackWorkflowMetadata(JSON.parse(JSON.stringify(prepared.metadata))), prepared.metadata);
    assert.equal(readSlackWorkflowMetadata({ ...prepared.metadata, parallelLane: 'true' }), undefined);
    const plain = await prepareSlackWorkflow(event, config, f.skills);
    if (plain.kind !== 'ready') throw new Error('route missing');
    assert.equal('parallelLane' in plain.metadata, false);
});

