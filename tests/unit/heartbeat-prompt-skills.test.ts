import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import express from 'express';
import { createServer } from 'node:http';
import { loadHeartbeatPromptSkills } from '../../src/memory/heartbeat-prompt-skills.ts';
import { isHeartbeatPromptSkills, loadHeartbeatFile, saveHeartbeatFile } from '../../src/core/config.ts';
import { registerHeartbeatRoutes } from '../../src/routes/heartbeat.ts';
import { stopHeartbeat } from '../../src/memory/heartbeat.ts';
import { normalizeJobsResponse } from '../../public/manager/src/settings/pages/components/heartbeat-helpers.ts';

function fixture(t: import('node:test').TestContext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-prompt-skills-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const put = (id: string, body: string) => {
        const skill = path.join(dir, id);
        fs.mkdirSync(skill, { recursive: true });
        fs.writeFileSync(path.join(skill, 'SKILL.md'), body);
        return path.join(skill, 'SKILL.md');
    };
    return { dir, put };
}

test('valid IDs and bounded SKILL bodies remove frontmatter', t => {
    const f = fixture(t);
    f.put('lens', '---\nname: lens\n---\nPinned rule one.\n');
    const result = loadHeartbeatPromptSkills(['lens'], { skillsDir: f.dir });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.match(result.block, /Skill: lens \(operator-pinned for this job\)/);
        assert.match(result.block, /Pinned rule one/);
        assert.doesNotMatch(result.block, /name: lens/);
    }
    for (const ids of [[], ['../escape'], ['UPPER'], ['a', 'a'], Array(9).fill('x'), Array(1)]) {
        assert.equal(isHeartbeatPromptSkills(ids), false);
        assert.deepEqual(loadHeartbeatPromptSkills(ids, { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_invalid_id', id: '' });
    }
    const brokenArray = new Proxy(['lens'], { get() { throw new Error('unexpected getter'); } });
    assert.deepEqual(loadHeartbeatPromptSkills(brokenArray, { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_read_failed', id: '' });
});


test('a FIFO named SKILL.md is refused without blocking the event loop', { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.dir, 'pipe'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(f.dir, 'pipe', 'SKILL.md')]);
    const started = Date.now();
    assert.deepEqual(loadHeartbeatPromptSkills(['pipe'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_not_file', id: 'pipe' });
    assert.ok(Date.now() - started < 1000, 'loader returned promptly');
});


test('each unsafe or unreadable SKILL has a reason and never throws', t => {
    const f = fixture(t);
    assert.deepEqual(loadHeartbeatPromptSkills(['absent'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_missing', id: 'absent' });
    fs.mkdirSync(path.join(f.dir, 'directory', 'SKILL.md'), { recursive: true });
    assert.deepEqual(loadHeartbeatPromptSkills(['directory'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_not_file', id: 'directory' });
    fs.mkdirSync(path.join(f.dir, 'broken'));
    fs.symlinkSync('missing.md', path.join(f.dir, 'broken', 'SKILL.md'));
    assert.deepEqual(loadHeartbeatPromptSkills(['broken'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_missing', id: 'broken' });
    const outside = path.join(os.tmpdir(), `jaw-outside-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(outside, 'outside');
    t.after(() => fs.rmSync(outside, { force: true }));
    fs.mkdirSync(path.join(f.dir, 'outside'));
    fs.symlinkSync(outside, path.join(f.dir, 'outside', 'SKILL.md'));
    assert.deepEqual(loadHeartbeatPromptSkills(['outside'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_outside_root', id: 'outside' });
    f.put('large', 'x'.repeat(32 * 1024 + 1));
    assert.deepEqual(loadHeartbeatPromptSkills(['large'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_too_large', id: 'large' });
    for (const id of ['one', 'two', 'three']) f.put(id, 'y'.repeat(22 * 1024));
    assert.deepEqual(loadHeartbeatPromptSkills(['one', 'two', 'three'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_too_large', id: 'three' });
    f.put('frontmatter', '---\nname: never closed\nbody');
    assert.deepEqual(loadHeartbeatPromptSkills(['frontmatter'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_bad_frontmatter', id: 'frontmatter' });
    f.put('only-dashes', '---');
    assert.deepEqual(loadHeartbeatPromptSkills(['only-dashes'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_bad_frontmatter', id: 'only-dashes' });
    const readPath = f.put('unreadable', 'text');
    fs.chmodSync(readPath, 0);
    const unreadable = loadHeartbeatPromptSkills(['unreadable'], { skillsDir: f.dir });
    if (unreadable.ok) { // Privileged test runners can read mode 0000: inject an open error instead.
        const original = fs.openSync;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
            if (String(args[0]) === readPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return original(...args);
        });
        assert.deepEqual(loadHeartbeatPromptSkills(['unreadable'], { skillsDir: f.dir }), { ok: false, reason: 'prompt_skill_read_failed', id: 'unreadable' });
        mock.restoreAll();
    } else {
        assert.deepEqual(unreadable, { ok: false, reason: 'prompt_skill_read_failed', id: 'unreadable' });
    }
});

/** Run the Classic source's own normalization function, which is private to its browser module. */
function classicBody(job: Record<string, unknown>): Record<string, unknown> {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../public/js/features/heartbeat.ts'), 'utf8');
    const start = source.indexOf('function normalizeHeartbeatJob(');
    const end = source.indexOf('function withBrowserTimeZone(', start);
    assert.ok(start >= 0 && end > start);
    const js = ts.transpileModule(`${source.slice(start, end)}\nnormalizeHeartbeatJob(input)`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInNewContext(js, { input: job, Date, String, Number, Math }) as Record<string, unknown>;
}

test('Classic and Manager five-field PUT bodies inherit pinned skills; null clears and invalid inputs fail', async t => {
    const f = fixture(t);
    f.put('lens', 'Pinned rule.');
    const job = { id: 'hb_ui', name: 'UI', enabled: false, schedule: { kind: 'every', minutes: 5 }, prompt: 'Check', promptSkills: ['lens'] };
    saveHeartbeatFile({ jobs: [job] });
    const app = express(); app.use(express.json());
    registerHeartbeatRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address(); assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}/api/heartbeat`;
    const put = async (input: unknown) => {
        const response = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs: [input] }) });
        return { status: response.status, data: await response.json() as { jobs?: Array<{ promptSkills?: string[] }>; error?: string } };
    };
    try {
        const classic = classicBody(job);
        assert.equal('promptSkills' in classic, false);
        assert.equal((await put(classic)).status, 200);
        assert.deepEqual(loadHeartbeatFile().jobs[0]?.promptSkills, ['lens']);
        const manager = normalizeJobsResponse({ jobs: [job] })[0];
        assert.ok(manager);
        assert.equal('promptSkills' in manager, false);
        assert.equal((await put(manager)).status, 200);
        assert.deepEqual((await (await fetch(base)).json() as { jobs: Array<{ promptSkills?: string[] }> }).jobs[0]?.promptSkills, ['lens']);
        for (const invalid of [[], ['../escape'], ['lens', 'lens'], ['UPPER']]) {
            const response = await put({ ...job, promptSkills: invalid });
            assert.equal(response.status, 400);
            assert.equal(response.data.error, 'invalid heartbeat prompt skills');
        }
        assert.equal((await put({ ...job, runner: 'script', command: ['true'] })).status, 400);
        assert.equal((await put({ ...job, promptSkills: null })).status, 200);
        assert.equal(loadHeartbeatFile().jobs[0]?.promptSkills, undefined);
        saveHeartbeatFile({ jobs: [{ ...job, promptSkills: ['../escape'] }] });
        assert.equal(loadHeartbeatFile().jobs[0]?.enabled, false);
        saveHeartbeatFile({ jobs: [{ ...job, runner: 'script', command: ['true'] }] });
        assert.equal(loadHeartbeatFile().jobs[0]?.enabled, false);
    } finally {
        stopHeartbeat(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        saveHeartbeatFile({ jobs: [] });
    }
});
