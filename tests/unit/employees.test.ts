// Static employee retirement and DB employee dispatch resolution.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { insertEmployee, deleteEmployee } from '../../src/core/db.ts';
import {
    STATIC_EMPLOYEES,
    findStaticEmployee,
    checkModelSupport,
    resolveDispatchableEmployee,
    listEmployees,
    withDerivedRuntimeHints,
} from '../../src/core/employees.ts';

const ROOT = process.cwd();

test('P37-CU-001: Computer Use has no static Control employee', async () => {
    assert.deepEqual(STATIC_EMPLOYEES, []);
    assert.equal(findStaticEmployee('Control'), null);
    assert.equal(await resolveDispatchableEmployee('Control', []), null);
    assert.equal((await listEmployees()).some(e => e.name === 'Control' && e.source === 'static'), false);
});

test('P37-CU-002: a user-created DB employee named Control remains dispatchable', async () => {
    const dbRows = [{
        id: 'db-row-123',
        name: 'Control',
        cli: 'claude',
        model: 'sonnet',
        role: 'user-created employee',
    }];
    const res = await resolveDispatchableEmployee('Control', dbRows);
    assert.ok(res);
    assert.equal(res.source, 'db');
    assert.equal(res.row.id, 'db-row-123');
    assert.equal(res.row.cli, 'claude');
    insertEmployee.run('db-row-123', 'Control', 'claude', 'sonnet', 'user-created employee');
    try {
        const listed = (await listEmployees()).find(e => e.name === 'Control');
        assert.equal(listed?.source, 'db');
        assert.equal(listed?.id, 'db-row-123');
    } finally {
        deleteEmployee.run('db-row-123');
    }
});

test('P37-CU-003: static runtime-hint compatibility stays available for future specialists', () => {
    assert.equal(withDerivedRuntimeHints({ supportedPlatforms: ['darwin'] })?.requiresDarwin, true);
    assert.equal(withDerivedRuntimeHints({ supportedPlatforms: ['win32'] })?.requiresDarwin, false);
    assert.equal(withDerivedRuntimeHints(undefined), undefined);
});

test('P37-CU-008: unknown employee returns null', async () => {
    const res = await resolveDispatchableEmployee('Nonexistent', []);
    assert.equal(res, null);
});

test('P37-CU-009: STATIC_EMPLOYEES has no duplicate names', () => {
    const names = STATIC_EMPLOYEES.map((e) => e.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, 'STATIC_EMPLOYEES has duplicate names');
});

test('checkModelSupport: scaffold returns empty result for all inputs (Spark handled by args.ts, not dispatch)', () => {
    // Spark's reasoning-param incompatibility is enforced at argv-build time (args.ts isCodexSparkModel),
    // so the dispatch-level checkModelSupport has no active rules for Spark. Scaffold kept for future policies.
    assert.deepEqual(checkModelSupport('codex', 'gpt-5.3-codex-spark', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('codex', 'gpt-5.4', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('claude', 'sonnet', {}), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport(null, 'gpt-5.4'), { fail: [], warn: [] });
    assert.deepEqual(checkModelSupport('codex', null), { fail: [], warn: [] });
});

test('employee cli/model updates clear stale employee session', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/employees.ts'), 'utf8');
    assert.match(src, /clearEmployeeSessionIfResumeKeyChanged/);
    assert.match(src, /const before = db\.prepare\('SELECT \* FROM employees WHERE id = \?'\)/);
    assert.match(src, /clearEmployeeSessionIfResumeKeyChanged\(employeeId, before, emp\)/);
    assert.match(src, /\/api\/employees\/sessions\/reset/);
    assert.match(src, /resetEmployeeSessions\(\)/);
});

test('employee create/reset defaults use ocx-aware model resolver', () => {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/employees.ts'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/employees.ts'), 'utf8');
    assert.match(routeSrc, /import \{ resolveCliDefaultModel \} from '\.\.\/cli\/opencodex-models\.js'/);
    assert.match(routeSrc, /app\.post\('\/api\/employees', requireAuth, async \(req, res\) =>/);
    assert.match(routeSrc, /await resolveCliDefaultModel\(cli\)/);
    assert.match(routeSrc, /app\.post\('\/api\/employees\/reset', requireAuth, async \(_req, res\) =>/);
    assert.match(routeSrc, /await seedDefaultEmployees\(\{ reset: true, notify: true \}\)/);
    assert.match(routeSrc, /app\.put\('\/api\/employees\/:id', requireAuth, async \(req, res\) =>/);
    assert.doesNotMatch(routeSrc, /CLI_REGISTRY\[cli/);
    assert.match(coreSrc, /import \{ resolveCliDefaultModel \} from '\.\.\/cli\/opencodex-models\.js'/);
    assert.match(coreSrc, /export async function seedDefaultEmployees/);
    assert.match(coreSrc, /const defaultModel = await resolveCliDefaultModel\(cli\)/);
    assert.doesNotMatch(coreSrc, /CLI_REGISTRY\[cli/);
});

test('static employee list/dispatch fallbacks use ocx-aware model resolver', () => {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/employees.ts'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/employees.ts'), 'utf8');
    const cliSrc = fs.readFileSync(path.join(ROOT, 'src/cli/employee-handler.ts'), 'utf8');
    const orcSrc = fs.readFileSync(path.join(ROOT, 'src/routes/orchestrate.ts'), 'utf8');
    assert.match(coreSrc, /async function resolveStaticEmployeeModel/);
    assert.match(coreSrc, /override\?\.model \?\? spec\.model \?\? await resolveCliDefaultModel\(spec\.cli\)/);
    assert.match(coreSrc, /export async function resolveDispatchableEmployee/);
    assert.match(coreSrc, /export async function listEmployees/);
    assert.match(routeSrc, /app\.get\('\/api\/employees', async \(_, res\) => ok\(res, await listEmployees\(\)\)\)/);
    assert.match(cliSrc, /const list = await listEmployees\(\)/);
    assert.match(cliSrc, /async function findByName/);
    assert.match(cliSrc, /async function updateField/);
    assert.match(orcSrc, /staticSpec: Awaited<ReturnType<typeof resolveDispatchableEmployee>> \| null/);
    assert.match(orcSrc, /await resolveDispatchableEmployee\(agentName, emps\)/);
});

test('dispatch clears mismatched employee resume key before attempting resume', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/orchestrator/distribute.ts'), 'utf8');
    assert.match(src, /clearStaleEmployeeSessionIfResumeKeyMismatch\(empId,\s*empSession/);
    assert.match(src, /!clearedStaleResumeKey[\s\S]*?isSessionPersistingCli/);
});

test('employee CLI supports list and honest help text', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin/commands/employee.ts'), 'utf8');
    assert.match(src, /cli-jaw employee list \[--port 3457\] \[--json\]/);
    assert.match(src, /cli-jaw employee sessions-reset \[--port 3457\]/);
    assert.match(src, /case 'list'/);
    assert.match(src, /case 'sessions-reset'/);
    assert.match(src, /\/api\/employees\/sessions\/reset/);
    assert.match(src, /\/api\/employees/);
    assert.match(src, /values\.json/);
    assert.doesNotMatch(src, /default 5 profiles/);
});
