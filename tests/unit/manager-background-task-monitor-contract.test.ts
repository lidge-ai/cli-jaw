import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { countBackgroundTasksByStatus, sortBackgroundTasks } from '../../public/manager/src/background-tasks/useBackgroundTasks.ts';
import {
    backgroundMonitorRowsFixture,
    backgroundTaskFixture,
} from '../fixtures/manager-runtime-monitors.ts';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

function sourceFiles(dir: string): string[] {
    return readdirSync(join(root, dir)).flatMap((entry) => {
        const path = join(dir, entry);
        const absolute = join(root, path);
        if (lstatSync(absolute).isDirectory()) return sourceFiles(path);
        return /\.(?:ts|tsx|js|jsx)$/.test(entry) ? [path] : [];
    });
}

test('background task view helpers sort and count all server statuses', () => {
    const rows = [
        backgroundTaskFixture({ id: 'bg_old', status: 'complete', createdAt: '2026-06-19T00:00:00.000Z' }),
        backgroundTaskFixture({ id: 'bg_new', status: 'running', createdAt: '2026-06-19T00:02:00.000Z' }),
        backgroundTaskFixture({ id: 'bg_orphan', status: 'orphaned', createdAt: '2026-06-19T00:01:00.000Z' }),
    ];

    assert.deepEqual(sortBackgroundTasks(rows).map(row => row.id), ['bg_new', 'bg_orphan', 'bg_old']);
    assert.deepEqual(countBackgroundTasksByStatus(rows), {
        running: 1,
        complete: 1,
        failed: 0,
        cancelled: 0,
        orphaned: 1,
    });
});

test('background monitor fixtures cover deterministic task states without production imports', () => {
    const rows = backgroundMonitorRowsFixture();

    assert.deepEqual(
        rows.map(row => row.status),
        ['running', 'complete', 'failed', 'cancelled', 'orphaned', 'running'],
    );
    assert.equal(rows.some(row => row.kind === 'web-ai' && row.spec.completion.type === 'session-status'), true);

    const importedByProduction = [...sourceFiles('public/manager/src'), ...sourceFiles('src')]
        .filter(path => read(path).includes('manager-runtime-monitors'));
    assert.deepEqual(importedByProduction, [], 'runtime monitor fixtures must stay test-only');
});

test('background task hook hydrates from API and listens for SSE replay gaps', () => {
    const hook = read('public/manager/src/background-tasks/useBackgroundTasks.ts');

    assert.ok(hook.includes('client.listTasks({ limit: 50 })'), 'hook must hydrate from GET /api/bgtask');
    assert.ok(hook.includes('subscribeToBackgroundTaskUpdates'), 'hook must listen to bgtask SSE updates');
    assert.ok(hook.includes('onReplayGap'), 'hook must handle SSE replay gaps');
    assert.ok(hook.includes('void refresh()'), 'SSE updates and replay gaps must trigger rehydration');
    assert.ok(hook.includes('client.cancelTask(taskId)'), 'hook must expose cancellation');
    assert.ok(hook.includes("client.createTask({ kind: task.kind, spec: task.spec, originMeta: task.originMeta })"), 'retry must reuse the durable task spec');
});

test('background task monitor panel exposes state, detail, cancel, retry, and result affordances', () => {
    const panel = read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx');
    const css = read('public/manager/src/background-tasks/background-task-monitor.css');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const cssEntry = read('public/manager/src/code/code.css');

    assert.ok(panel.includes('aria-label="Background task monitor"'), 'panel must expose monitor semantics');
    for (const status of ['running', 'complete', 'failed', 'cancelled', 'orphaned']) {
        assert.ok(panel.includes(status), `panel must render ${status} state`);
    }
    assert.ok(panel.includes('onRetry(task)'), 'panel must expose retry action');
    assert.ok(panel.includes('onCancel(task.id)'), 'panel must expose cancel action');
    assert.ok(panel.includes('navigator.clipboard.writeText(task.result)'), 'panel must expose result copy action');
    assert.ok(panel.includes('task.spec.command?.length'), 'detail must show command-like context');
    assert.ok(panel.includes('web-ai session'), 'detail must label web-ai session-status probes distinctly');
    assert.ok(panel.includes('task.spec.completion.type'), 'detail must show completion mode');
    assert.ok(panel.includes('BrowserPanel state and Code transcript stay separate.'), 'web-ai bridge note must preserve surface boundaries');
    assert.ok(css.includes('.code-bg-task-list'), 'monitor must have bounded list styles');
    assert.ok(css.includes('max-height: min(30vh, 300px);'), 'monitor list must not push composer off screen');
    assert.ok(panel.includes('useContextMenu'), 'rows must expose the shared right-click context menu');
    assert.ok(panel.includes('jaw-row-hover-actions'), 'row actions must be hover/focus-revealed icon buttons');
    assert.ok(panel.includes("'Show details'"), 'row menu must toggle the detail pane');
    assert.ok(panel.includes("'Copy result'"), 'row menu must expose result copy');
    assert.equal(css.includes('.code-bg-task-actions button'), false, 'rows must not keep always-visible text action buttons');
    assert.equal(workbench.includes('<BackgroundTaskMonitorPanel />'), false, 'Code session transcript lane must not inline the background task monitor');
    assert.equal(cssEntry.includes("@import '../background-tasks/background-task-monitor.css';"), false, 'Code CSS entry must NOT import monitor CSS (slice 211 boundary)');
});

test('background task monitor remains Manager-local and session-independent', () => {
    const combined = [
        read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx'),
        read('public/manager/src/background-tasks/useBackgroundTasks.ts'),
        read('public/manager/src/background-tasks/background-task-client.ts'),
    ].join('\n');

    assert.equal(combined.includes('selectedInstance'), false, 'monitor must not depend on selected child Jaw instance');
    assert.equal(combined.includes('CodeSession'), false, 'monitor must not model background tasks as Code sessions');
    assert.equal(combined.includes('/api/code'), false, 'monitor must not call Code session APIs');
    assert.equal(combined.includes('3465'), false, 'monitor must not hardcode child Jaw ports');
});

test('background task retry preserves web-ai preset semantics instead of raw probe specs', () => {
    const hook = read('public/manager/src/background-tasks/useBackgroundTasks.ts');
    const panel = read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx');

    assert.ok(hook.includes("task.kind === 'web-ai' && task.spec.completion.type === 'session-status'"), 'retry must detect web-ai probe rows');
    assert.ok(hook.includes("preset: 'web-ai'"), 'retry must recreate web-ai tasks through the preset');
    assert.ok(hook.includes('sessionId: task.spec.completion.sessionId'), 'retry must keep the native web-ai session id');
    assert.ok(hook.includes('prompt: task.spec.promptTemplate'), 'retry must keep the existing completion prompt');
    assert.ok(hook.includes('client.createTask({ kind: task.kind, spec: task.spec, originMeta: task.originMeta })'), 'non-web-ai retry must still reuse the raw spec');
    assert.ok(panel.includes('no Manager probe runner is attached'), 'running web-ai rows without runner ownership must explain recovery');
});
