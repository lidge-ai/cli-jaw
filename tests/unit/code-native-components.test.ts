import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { CodeControllerModel } from '../../public/manager/src/code/code-controller-types';
import type { CodeItem, CodePermissionRequest, CodeSessionInfo } from '../../src/code-mode/wire';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost:43225' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CodeComposer } = await import('../../public/manager/src/code/CodeComposer');
const { ComposerFooter } = await import('../../public/manager/src/code/ComposerFooter');
const { CodePermissionQueue } = await import('../../public/manager/src/code/CodePermissionQueue');
const { CodeSessionList } = await import('../../public/manager/src/code/CodeSessionList');
const { CodeTranscriptItem, CodeTranscript } = await import('../../public/manager/src/code/CodeTranscript');
const { CodeWorkbench } = await import('../../public/manager/src/code/CodeWorkbench');
const { CodeDraftEmptyState } = await import('../../public/manager/src/code/CodeDraftEmptyState');
const { recentCodeWorkspaces } = await import('../../public/manager/src/code/code-recent-workspaces');
const { formatShortcut } = await import('../../public/manager/src/manager-shortcuts');
const { useThrottledMarkdown } = await import('../../public/manager/src/code/use-throttled-markdown');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
async function surface(t: TestContext) {
    // The sidebar remembers its view; every test starts from the default Projects view.
    dom.window.localStorage.clear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected view network request'); });
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, render: async (node: ReactNode) => { await act(async () => root.render(node)); } };
}
function session(patch: Partial<CodeSessionInfo> = {}): CodeSessionInfo {
    return { sessionId: 's-a', provider: 'codex-app', cwd: '/work/alpha', title: 'Alpha', model: 'native-model', effort: null,
        permissionMode: 'ask', status: 'idle', turnId: null, archivedAt: null, error: null, resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false, efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] },
        epoch: 2, sequence: 10, revision: 4, createdAt: 1, lastUsedAt: 2, lastTurnCompletedAt: null, lastVisitedAt: null, ...patch };
}
function model(patch: Partial<CodeControllerModel> = {}): CodeControllerModel {
    const s = session();
    return { catalog: { defaultProvider: 'codex-app', providers: ['codex-app', 'claude', 'cursor', 'grok'].map(id => ({
        id: id as CodeSessionInfo['provider'], label: id, available: true, reason: null, models: ['native-model', 'another-native-model'], defaultModel: 'native-model',
        defaultEffort: null, capabilities: s.capabilities, modelSource: 'native' as const,
    })) }, sessions: [s], session: s, selectedId: s.sessionId, items: [], permissions: [], input: 'draft text', hasUnsentDraft: false,
    selection: { provider: s.provider, cwd: s.cwd, model: s.model, effort: null, permissionMode: s.permissionMode },
    gitInfo: null, loading: false, pending: false, busy: false, synced: true, error: null, transport: 'connected', workspacePicking: false,
    operation: { kind: 'idle', error: null }, retryText: null, canRetrySameSend: false, permissionOperations: {},
    hasMoreSessions: false, hasOlderHistory: false, filter: { scope: 'all', archived: false },
    creationUnknown: false, startAnotherSession() {}, newSession() {}, async selectSession() {}, setInput() {}, async setSelection() {}, async pickWorkspace() {},
    async send() {}, async stop() {}, async resume() {}, async rename() {}, async archive() {}, async answer() {},
    async refresh() {}, async loadMoreSessions() {}, async loadOlderHistory() {}, setFilter() {}, clearError() {}, async retrySameSend() {}, ...patch };
}
function button(container: ParentNode, name: string) {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name);
    assert.ok(found, `button ${name} must exist`); return found;
}
async function key(node: Element, value: string, options: KeyboardEventInit = {}) {
    await act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); });
}
async function click(node: HTMLButtonElement) { await act(async () => node.click()); }

// These exercise actual rendered controls; requests are supplied through the frozen view port.
test('composer sends literal slash text once, preserves IME Enter and Shift+Enter', bounded, async t => {
    const h = await surface(t); const gate = Promise.withResolvers<void>(); let sends = 0;
    t.after(() => gate.resolve());
    await h.render(createElement(CodeComposer, { inputText: '/model is literal input', canSend: true, busy: false, canStop: false,
        stopping: false, pending: false, readOnly: false, onInputChange() {}, async onSubmit() { sends++; await gate.promise; }, async onStop() {} }));
    const input = h.container.querySelector('textarea'); assert.ok(input);
    assert.equal(input.value, '/model is literal input');
    await key(input, 'Enter', { isComposing: true }); await key(input, 'Enter', { shiftKey: true }); assert.equal(sends, 0);
    await key(input, 'Enter'); await key(input, 'Enter'); assert.equal(sends, 1);
    await act(async () => gate.resolve());
});

test('streaming keeps draft editable and exposes keyboard Stop with duplicate guard', bounded, async t => {
    const h = await surface(t); const gate = Promise.withResolvers<void>(); let stops = 0;
    t.after(() => gate.resolve());
    const props = { inputText: 'follow-up draft', canSend: false, busy: true, canStop: true, stopping: false, pending: false,
        readOnly: false, onInputChange() {}, async onSubmit() { assert.fail('busy send'); }, async onStop() { stops++; await gate.promise; } };
    await h.render(createElement(CodeComposer, props));
    const input = h.container.querySelector('textarea'); assert.ok(input); assert.equal(input.disabled, false); assert.equal(input.readOnly, false);
    const stop = button(h.container, 'Stop current turn'); stop.focus(); assert.equal(document.activeElement, stop);
    await click(stop); await click(stop); assert.equal(stops, 1);
    await h.render(createElement(CodeComposer, { ...props, stopping: true, canStop: false }));
    assert.equal(button(h.container, 'Stop current turn').disabled, true); assert.match(h.container.textContent ?? '', /Stopping/);
    await act(async () => gate.resolve());
});

test('footer arrows explore without committing, native default is null, and runtime change creates an explicit new target', bounded, async t => {
    const h = await surface(t); const patches: unknown[] = [];
    const c = model({ async setSelection(patch) { patches.push(patch); } });
    await h.render(createElement(ComposerFooter, { controller: c }));
    await key(button(h.container, 'Effort: Native default'), 'ArrowDown');
    assert.deepEqual(patches, []); assert.equal(document.activeElement?.textContent, 'Native default');
    await key(document.activeElement!, 'ArrowDown'); assert.deepEqual(patches, []); assert.equal(document.activeElement?.textContent, 'low');
    await click(document.activeElement as HTMLButtonElement); assert.deepEqual(patches, [{ effort: 'low' }]);
    assert.equal(document.activeElement, button(h.container, 'Effort: Native default'), 'choosing returns focus to the trigger');
    await click(button(h.container, 'Runtime: Codex')); await click(button(document, 'New Claude session'));
    assert.deepEqual(patches[1], { provider: 'claude' });
});

test('idle model and effort updates work without hot-switch capability and stay gated during non-idle states', bounded, async t => {
    const h = await surface(t); const patches: unknown[] = [];
    const c = model({ async setSelection(patch) { patches.push(patch); } });
    assert.equal(c.session?.capabilities.setModelMidSession, false);
    await h.render(createElement(ComposerFooter, { controller: c }));
    assert.equal(button(h.container, 'Model: native-model').disabled, false);
    assert.equal(button(h.container, 'Effort: Native default').disabled, false);
    await click(button(h.container, 'Model: native-model')); await click(button(document, 'another-native-model'));
    await click(button(h.container, 'Effort: Native default')); await click(button(document, 'high'));
    await click(button(h.container, 'Effort: Native default')); await click(button(document, 'Native default'));
    assert.deepEqual(patches, [{ model: 'another-native-model' }, { effort: 'high' }, { effort: null }]);
    const unavailable: Partial<CodeControllerModel>[] = [
        { session: session({ status: 'starting', turnId: 't-a' }), busy: true },
        { session: session({ status: 'streaming', turnId: 't-a' }), busy: true },
        { session: session({ status: 'stopping', turnId: 't-a' }), busy: true },
        { session: session({ status: 'suspended' }) },
        { session: session({ status: 'failed' }) },
        { session: session({ archivedAt: 123 }) },
        { synced: false },
        { pending: true, operation: { kind: 'patching', error: null } },
    ];
    for (const state of unavailable) {
        await h.render(createElement(ComposerFooter, { controller: { ...c, ...state } }));
        assert.equal(button(h.container, 'Model: native-model').disabled, true);
        assert.equal(button(h.container, 'Effort: Native default').disabled, true);
    }
    assert.equal(patches.length, 3, 'disabled states must not dispatch settings mutations');
});

test('creation freezes runtime/model/policy and Auto YOLO remains explicit', bounded, async t => {
    const h = await surface(t);
    const c = model({ selectedId: null, session: null, pending: true, operation: { kind: 'creating', error: null },
        selection: { provider: 'grok', cwd: '/work/beta', model: 'native-model', effort: null, permissionMode: 'auto' } });
    await h.render(createElement(ComposerFooter, { controller: c }));
    assert.equal(button(h.container, 'Runtime: Grok').disabled, true); assert.equal(button(h.container, 'Permission: Auto (YOLO)').disabled, true);
    assert.equal(button(h.container, 'Model: native-model').disabled, true);
    assert.match(h.container.textContent ?? '', /Auto \(YOLO\)/);
});

test('icon-only controls keep an accessible name that names the current value', bounded, async t => {
    const h = await surface(t);
    await h.render(createElement(ComposerFooter, { controller: model() }));
    // The runtime trigger shows a glyph, so the name is the only thing a screen
    // reader or a keyboard user has to identify it by.
    const runtime = button(h.container, 'Runtime: Codex');
    assert.equal(runtime.textContent?.trim(), '', 'the runtime trigger is icon-only');
    assert.equal(runtime.querySelector('svg')?.getAttribute('aria-hidden'), 'true', 'the glyph is decorative');
    assert.equal(runtime.getAttribute('title'), 'Codex');
    await h.render(createElement(CodeComposer, { inputText: 'ready', canSend: true, busy: false, canStop: false,
        stopping: false, pending: false, readOnly: false, onInputChange() {}, async onSubmit() {}, async onStop() {} }));
    for (const name of ['Send prompt', 'Dictation']) {
        const control = button(h.container, name);
        assert.equal(control.textContent?.trim(), '', `${name} is icon-only`);
        assert.equal(control.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
        assert.ok(control.getAttribute('title'), `${name} needs a hover title too`);
    }
});

test('the model menu filters a large catalog and marks the current choice', bounded, async t => {
    const h = await surface(t); const patches: unknown[] = [];
    const wide = ['gpt-6-astra', 'gpt-5.6-sol', 'anthropic/claude-opus-5', 'xai/grok-4.6'];
    const c = model({ async setSelection(patch) { patches.push(patch); } });
    const catalog = { ...c.catalog!, providers: c.catalog!.providers.map(entry => entry.id === 'codex-app'
        ? { ...entry, models: wide, effortsByModel: { 'gpt-6-astra': ['low', 'ultra'], 'xai/grok-4.6': [] } } : entry) };
    await h.render(createElement(ComposerFooter, { controller: { ...c, catalog,
        selection: { ...c.selection, model: 'gpt-6-astra' } } }));
    await click(button(h.container, 'Model: gpt-6-astra'));
    const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(options().length, wide.length);
    assert.deepEqual(options().filter(option => option.getAttribute('aria-selected') === 'true').map(o => o.textContent?.trim()),
        ['gpt-6-astra'], 'exactly the current model is marked selected');
    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter model"]');
    assert.ok(filter, 'a catalog this size needs a filter');
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(filter, 'anthropic');
        filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(options().map(option => option.textContent?.trim()), ['anthropic/claude-opus-5']);
    await click(options()[0]!);
    assert.deepEqual(patches, [{ model: 'anthropic/claude-opus-5' }]);
});

test('effort offers only what the selected model accepts', bounded, async t => {
    const h = await surface(t);
    const c = model();
    const withPerModel = (id: string) => ({ ...c.catalog!, providers: c.catalog!.providers.map(entry => entry.id === 'codex-app'
        ? { ...entry, models: ['narrow', 'wide'], effortsByModel: { narrow: [], wide: ['low', 'ultra'] } } : entry) });
    // A routed model that takes no effort must not show a control at all,
    // because the union would otherwise offer a value the session rejects.
    await h.render(createElement(ComposerFooter, { controller: { ...c, catalog: withPerModel('narrow'),
        session: null, selectedId: null, selection: { ...c.selection, model: 'narrow' } } }));
    assert.equal([...h.container.querySelectorAll('button')].some(node => node.getAttribute('aria-label')?.startsWith('Effort')), false);
    await h.render(createElement(ComposerFooter, { controller: { ...c, catalog: withPerModel('wide'),
        session: null, selectedId: null, selection: { ...c.selection, model: 'wide' } } }));
    await click(button(h.container, 'Effort: Native default'));
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(o => o.textContent?.trim()),
        ['Native default', 'low', 'ultra']);
});

test('an open session is bound by the capabilities it stored, not by a newer catalog', bounded, async t => {
    const h = await surface(t);
    const c = model();
    // The catalog grew after this session was created. The server still checks
    // the stored capabilities, so offering the new value would produce a 400.
    const catalog = { ...c.catalog!, providers: c.catalog!.providers.map(entry => entry.id === 'codex-app'
        ? { ...entry, models: ['native-model'], effortsByModel: { 'native-model': ['low', 'high', 'ultra'] } } : entry) };
    await h.render(createElement(ComposerFooter, { controller: { ...c, catalog } }));
    await click(button(h.container, 'Effort: Native default'));
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(o => o.textContent?.trim()),
        ['Native default', 'low', 'high'], 'ultra is not in the session capabilities');
});

test('Tab leaves an open menu instead of returning focus to its trigger', bounded, async t => {
    const h = await surface(t);
    await h.render(createElement(ComposerFooter, { controller: model() }));
    const trigger = button(h.container, 'Permission: Ask first');
    await click(trigger);
    assert.ok(document.querySelector('[role="listbox"]'), 'the menu is open');
    await key(document.activeElement!, 'Tab');
    assert.equal(document.querySelector('[role="listbox"]'), null, 'Tab closes the menu');
    // Restoring focus here would swallow the Tab and strand the user for one press.
    assert.notEqual(document.activeElement, trigger);
});

test('narrow widths keep every composer control reachable on one surface', bounded, async t => {
    const h = await surface(t);
    await h.render(createElement(CodeWorkbench, { controller: model(), endpointKey: '43225' }));
    // Rendering at 390px showed the footer already reflows: the model pill takes
    // its own row while the runtime, permission, mic and send controls stay put.
    // JSDOM has no layout, so this pins the structural contract that makes the
    // reflow possible instead of re-asserting pixel positions.
    const footer = h.container.querySelector('.code-composer-footer');
    assert.ok(footer, 'the footer is a single flex row that is allowed to wrap');
    assert.ok(footer.querySelector('.code-composer-footer-spacer'), 'the spacer is what splits left and right groups');
    for (const name of ['Runtime: Codex', 'Permission: Ask first', 'Model: native-model']) {
        assert.ok(button(footer, name), `${name} stays in the footer at every width`);
    }
    // Send and dictation live with the input, not the footer, so a wrapping
    // footer can never push them off the surface.
    const actions = h.container.querySelector('.code-composer-actions');
    assert.ok(actions);
    assert.ok(button(actions, 'Send prompt') && button(actions, 'Dictation'));
    assert.equal(footer.contains(actions), false);
});

function permission(id: string): CodePermissionRequest {
    return { permissionId: id, sessionId: 's-a', turnId: 't-a', epoch: 2, title: `Request ${id}`, detail: 'Read a selected file', requestedAt: 1,
        options: [{ optionId: `opaque/${id}:37`, label: 'Read this file', kind: 'allow_once' }, { optionId: `opaque/${id}:94`, label: 'Do not read', kind: 'reject_once' }] };
}
test('permissions preserve opaque choices and isolate each request pending/error state', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = []; const a = permission('a'), b = permission('b');
    await h.render(createElement(CodePermissionQueue, { permissions: [a, b], session: session({ status: 'streaming', turnId: 't-a' }), synced: true,
        operations: { a: { pending: true, error: 'Decision acknowledgement pending' } },
        async onAnswer(p, id) { calls.push([p.permissionId, id]); throw Error('Second decision failed'); } }));
    const cards = h.container.querySelectorAll('section'); assert.equal(cards.length, 2);
    assert.equal(button(cards[0]!, 'Read this file').disabled, true); assert.equal(button(cards[1]!, 'Read this file').disabled, false);
    await click(button(cards[1]!, 'Read this file'));
    assert.deepEqual(calls, [['b', 'opaque/b:37']]); assert.match(cards[1]!.textContent ?? '', /Second decision failed/);
    assert.equal(h.container.querySelectorAll('button').length, 4, 'only supplied actions exist');
});

test('stale permission ownership renders choices disabled without answering', bounded, async t => {
    const h = await surface(t); let answers = 0;
    await h.render(createElement(CodePermissionQueue, { permissions: [permission('a')], session: session({ status: 'streaming', turnId: 'new-turn' }),
        synced: true, operations: {}, async onAnswer() { answers++; } }));
    await click(button(h.container, 'Read this file')); assert.equal(answers, 0); assert.equal(button(h.container, 'Read this file').disabled, true);
});

test('list reports unknown attention, preserves row on failed archive, and supports Escape rename', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = [];
    const c = model({ synced: false, async archive(id, archived) { calls.push([id, archived]); throw Error('Revision changed. Refresh session.'); } });
    await h.render(createElement(CodeSessionList, { controller: c }));
    assert.match(h.container.textContent ?? '', /Approval status unknown/);
    await click(button(h.container, 'Rename'));
    const title = h.container.querySelector('input[aria-label="Session title"]'); assert.ok(title);
    await key(title, 'Escape'); assert.equal(h.container.querySelector('input[aria-label="Session title"]'), null);
    await click(button(h.container, 'Archive')); assert.deepEqual(calls, [['s-a', true]]);
    assert.match(h.container.textContent ?? '', /Revision changed/); assert.match(h.container.textContent ?? '', /Alpha/);
});

test('workbench sibling identities stay unique through rerenders and selected-session changes', bounded, async t => {
    const h = await surface(t);
    const diagnostics: string[] = [];
    const report = console.error;
    t.mock.method(console, 'error', (...args: unknown[]) => {
        diagnostics.push(args.map(String).join(' '));
        report.apply(console, args);
    });
    const render = async (id: string | null, input: string) => {
        const selected = id === null ? null : session({ sessionId: id });
        await h.render(createElement(CodeWorkbench, {
            controller: model({ selectedId: id, session: selected, input }), endpointKey: '43225',
        }));
        assert.equal(h.container.querySelectorAll('textarea[aria-label="Code prompt"]').length, 1);
        assert.equal(h.container.querySelectorAll('.code-footer-model button').length, 1);
        assert.equal(h.container.querySelectorAll('.code-composer-footer').length, 1);
        assert.equal(h.container.querySelector('textarea')?.value, input);
    };
    await render('s-a', 'draft A');
    const firstInput = h.container.querySelector('textarea');
    const firstModel = h.container.querySelector<HTMLButtonElement>('.code-footer-model button');
    assert.ok(firstModel);
    await render('s-a', 'draft A extended');
    assert.equal(h.container.querySelector('textarea'), firstInput, 'same-session input retains DOM identity');
    assert.equal(h.container.querySelector('.code-footer-model button'), firstModel, 'same-session rerender keeps the model control mounted');
    for (const id of ['s-b', null, 's-a', null]) {
        await render(id, id === null ? 'preserved new draft' : `draft ${id}`);
        assert.match(h.container.querySelector('.code-footer-model button')?.textContent ?? '', /native-model/,
            'different-session controls show the accepted model');
    }
    assert.deepEqual(diagnostics.filter(message => /same key|unique.*key/i.test(message)), [],
        'React must report no sibling-key collisions');
});

test('unknown-send retry previews original text and never submits the edited draft', bounded, async t => {
    const h = await surface(t); let retries = 0, sends = 0;
    const c = model({ input: 'edited follow-up', operation: { kind: 'unknown-send', error: null }, retryText: 'original request', canRetrySameSend: true,
        async retrySameSend() { retries++; }, async send() { sends++; } });
    await h.render(createElement(CodeWorkbench, { controller: c, endpointKey: '43225' }));
    assert.equal(h.container.querySelector('[aria-label="Original prompt"]')?.textContent, 'original request');
    assert.equal(h.container.querySelector('textarea')?.value, 'edited follow-up'); assert.equal(button(h.container, 'Send prompt').disabled, true);
    await click(button(h.container, 'Retry same send')); assert.equal(retries, 1); assert.equal(sends, 0);
});

function item(patch: Partial<CodeItem>): CodeItem { return { itemId: 'item-a', turnId: 't-a', kind: 'user_message', status: 'done', createdAt: 1, updatedAt: 1, ...patch }; }
test('timeline retains stable item ID, escaped tool output, truncation and distinct stopped/failed states', bounded, async t => {
    const h = await surface(t);
    // Tool detail is built only while the disclosure is open, so this asserts
    // the escaping contract on an expanded row -- the state where the output is
    // actually shown to a reader.
    const render = (value: CodeItem) => h.render(createElement(CodeTranscriptItem, { item: value, provider: 'cursor', sessionKey: '43225:s-a', expanded: true }));
    await render(item({ kind: 'tool_call', status: 'cancelled', tool: { name: 'read', output: '<script>bad()</script>partial' },
        truncation: { storedChars: 12, sourceChars: 500, reason: 'field_limit' } }));
    assert.equal(h.container.querySelector('article')?.getAttribute('data-code-item-id'), 'item-a');
    assert.equal(h.container.querySelector('script'), null); assert.match(h.container.textContent ?? '', /Stopped/);
    assert.match(h.container.textContent ?? '', /12 of 500 characters retained/);
    assert.equal(h.container.querySelector('pre')?.textContent, '<script>bad()</script>partial');
    await render(item({ kind: 'turn_failed', status: 'error', text: 'Runtime closed unexpectedly' }));
    assert.match(h.container.textContent ?? '', /Failed/); assert.doesNotMatch(h.container.textContent ?? '', /Stopped/);
});

test('a collapsed tool call keeps its output out of the document', bounded, async t => {
    const h = await surface(t);
    const call = item({ kind: 'tool_call', status: 'done', tool: { name: 'read', input: '{"path":"/a.ts"}', output: 'secret-output-body' } });
    await h.render(createElement(CodeTranscriptItem, { item: call, provider: 'cursor', sessionKey: '43225:s-a' }));
    assert.match(h.container.textContent ?? '', /Read/, 'the summary line still says what ran');
    assert.doesNotMatch(h.container.textContent ?? '', /secret-output-body/);
    assert.equal(h.container.querySelector('pre'), null);
    await h.render(createElement(CodeTranscriptItem, { item: call, provider: 'cursor', sessionKey: '43225:s-a', expanded: true }));
    assert.match(h.container.textContent ?? '', /secret-output-body/);
});

test('a running tool call reads in the present tense without a duplicate status badge', bounded, async t => {
    const h = await surface(t);
    const running = item({ kind: 'tool_call', status: 'running', tool: { name: 'bash', input: '{"command":"npm test"}' } });
    await h.render(createElement(CodeTranscriptItem, { item: running, provider: 'cursor', sessionKey: '43225:s-a' }));
    assert.match(h.container.textContent ?? '', /Running npm test/);
    // The verb already carries the state; the badge would repeat it.
    assert.equal(h.container.querySelector('.code-tool-status'), null);
    assert.ok(h.container.querySelector('.code-tool-name-running'), 'the row is marked as streaming');
    await h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'tool_call', status: 'error', tool: { name: 'bash', input: '{"command":"npm test"}' } }), provider: 'cursor', sessionKey: '43225:s-a' }));
    assert.match(h.container.textContent ?? '', /Failed/, 'failure still gets a word');
});

test('a tool card shows the decoded call, its description and a waiting line', bounded, async t => {
    const h = await surface(t);
    const heredoc = "ssh host 'cat > file <<EOF\nalpha\nbeta\nEOF'";
    const running = item({ kind: 'tool_call', status: 'running',
        tool: { name: 'bash', input: JSON.stringify({ command: heredoc, timeout: 30, cwd: '/work/repo', description: 'Deploy the config\nThen verify workers' }) } });
    await h.render(createElement(CodeTranscriptItem, { item: running, provider: 'cursor', sessionKey: 's', expanded: true }));
    assert.match(h.container.textContent ?? '', /Running ssh host/, 'the label is the decoded first line');
    // The row borrows one line of the description; the body keeps all of it.
    assert.equal(h.container.querySelector('.code-tool-desc')?.textContent, 'Deploy the config');
    assert.equal(h.container.querySelector('pre.code-tool-text')?.textContent, 'Deploy the config\nThen verify workers');
    // The Input block is the command with real newlines, never the JSON envelope.
    const args = h.container.querySelector<HTMLElement>('pre.code-tool-args');
    assert.equal(args?.textContent, heredoc);
    assert.ok(button(h.container, 'Copy input'), 'the command offers a copy button');
    // Envelope fields beyond the command stay visible instead of disappearing.
    assert.equal(h.container.querySelector('pre.code-tool-json')?.textContent,
        JSON.stringify({ timeout: 30, cwd: '/work/repo' }, null, 2));
    // A call in flight with nothing back yet reads as waiting, not a blank box.
    assert.match(h.container.textContent ?? '', /Waiting for output…/);
    assert.equal(h.container.querySelector('pre.code-tool-output'), null);
});

test('a settled card pretty-prints non-command input and uncaps tall bodies on demand', bounded, async t => {
    const h = await surface(t);
    const done = item({ kind: 'tool_call', status: 'done',
        tool: { name: 'rg', input: JSON.stringify({ pattern: 'needle', path: '/work/repo' }), output: 'x\n'.repeat(40) } });
    await h.render(createElement(CodeTranscriptItem, { item: done, provider: 'cursor', sessionKey: 's', expanded: true }));
    assert.equal(h.container.querySelector('pre.code-tool-args')?.textContent,
        JSON.stringify({ pattern: 'needle', path: '/work/repo' }, null, 2));
    assert.equal(h.container.querySelector('.code-tool-body')?.getAttribute('data-expanded'), 'false');
    await click(button(h.container, 'Show all'));
    assert.equal(h.container.querySelector('.code-tool-body')?.getAttribute('data-expanded'), 'true');
    assert.ok(button(h.container, 'Show less'));
    // Short content earns no toggle at all. A fresh root, because the state under
    // test belongs to the instance: re-rendering the one above would carry the
    // reader's choice forward and assert nothing about short content.
    const fresh = await surface(t);
    const short = item({ kind: 'tool_call', status: 'done', tool: { name: 'read', input: '{"path":"/a.ts"}', output: 'small' } });
    await fresh.render(createElement(CodeTranscriptItem, { item: short, provider: 'cursor', sessionKey: 's', expanded: true }));
    assert.equal([...fresh.container.querySelectorAll('button')].some(node => node.textContent === 'Show all'), false);
    // Compared as a boolean: node:test inspects a DOM node it is handed, and a
    // jsdom node's message never comes back.
    assert.ok(fresh.container.querySelector('.code-tool-toggle') === null, 'short content earns no toggle at all');
    assert.equal(fresh.container.querySelector('.code-tool-body')?.getAttribute('data-expanded'), 'false');
    assert.doesNotMatch(fresh.container.textContent ?? '', /Waiting for output/);
});

test('an open body that stops overflowing retracts its disclosure', bounded, async t => {
    const h = await surface(t);
    const render = (output: string) => h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'tool_call', status: 'done',
        tool: { name: 'rg', input: JSON.stringify({ pattern: 'needle' }), output } }), provider: 'cursor', sessionKey: 's', expanded: true }));
    await render('x\n'.repeat(40));
    await click(button(h.container, 'Show all'));
    assert.equal(h.container.querySelector('.code-tool-body')?.getAttribute('data-expanded'), 'true');
    // Same root, same instance, shorter content: an expansion granted for a tall
    // body cannot survive the body it was granted for.
    await render('small');
    assert.equal(h.container.querySelector('pre.code-tool-output')?.textContent, 'small');
    assert.equal(h.container.querySelector('.code-tool-body')?.getAttribute('data-expanded'), 'false');
    assert.ok(h.container.querySelector('.code-tool-toggle') === null, 'a body that no longer overflows offers no toggle');
});

// jsdom lays nothing out, so the panes have to be told what a browser would
// report. Here the detail paragraph is the body's only overflowing pane, and it
// is short enough that the estimate standing in for layout calls it short: the
// toggle can only appear by measuring the paragraph itself.
function overflowingDetailPane(t: TestContext) {
    const prototype = dom.window.HTMLElement.prototype;
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, overflowing] of Object.entries({ clientHeight: 120, scrollHeight: 300 })) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
        Object.defineProperty(prototype, key, { configurable: true,
            get(this: HTMLElement) { return this.matches('p.code-tool-text') ? overflowing : 0; } });
    }
    t.after(() => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(prototype, key, descriptor);
            else Reflect.deleteProperty(prototype, key);
        }
    });
}

test('a capped pane that is not a pre is measured for overflow too', bounded, async t => {
    const h = await surface(t); overflowingDetailPane(t);
    await h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'tool_call', status: 'done',
        tool: { name: 'bash', input: JSON.stringify({ command: 'ls -la' }), detail: 'Listed the workspace root' } }),
        provider: 'cursor', sessionKey: 's', expanded: true }));
    assert.equal(h.container.querySelector('p.code-tool-text')?.textContent, 'Listed the workspace root');
    assert.equal(button(h.container, 'Show all').textContent, 'Show all',
        'the overflowing detail paragraph alone earns the toggle');
});

test('a detail-carrying call does not also claim to be waiting for output', bounded, async t => {
    const h = await surface(t);
    await h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'tool_call', status: 'running',
        tool: { name: 'bash', input: JSON.stringify({ command: 'npm test' }), detail: 'Runs the suite' } }),
        provider: 'cursor', sessionKey: 's', expanded: true }));
    assert.equal(h.container.querySelector('p.code-tool-text')?.textContent, 'Runs the suite');
    assert.ok(h.container.querySelector('.code-tool-waiting') === null, 'a call with its detail shown is not also waiting for output');
    assert.match(h.container.textContent ?? '', /Running npm test/);
});

test('throttled text flushes empty, whitespace and final replacements immediately across identities', bounded, async t => {
    const h = await surface(t);
    function Probe({ text, final, identity }: { text: string; final: boolean; identity: string }) {
        return createElement('span', null, useThrottledMarkdown(text, final, identity));
    }
    await h.render(createElement(Probe, { text: 'streaming prefix', final: false, identity: 'a' }));
    for (const text of ['', '   ', 'exact final']) {
        await h.render(createElement(Probe, { text, final: true, identity: 'a' })); assert.equal(h.container.textContent, text);
    }
    await h.render(createElement(Probe, { text: 'new session', final: false, identity: 'b' })); assert.equal(h.container.textContent, 'new session');
});

test('failed rename keeps the edited title and inline error until explicit cancel', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = [];
    await h.render(createElement(CodeSessionList, { controller: model({ async rename(id, title) {
        calls.push([id, title]); throw Error('Title update rejected');
    } }) }));
    await click(button(h.container, 'Rename'));
    const input = h.container.querySelector<HTMLInputElement>('[aria-label="Session title"]'); assert.ok(input);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'My edited title');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(calls, [['s-a', 'My edited title']]);
    assert.equal(h.container.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.value, 'My edited title');
    assert.match(h.container.textContent ?? '', /Title update rejected/);
    await key(input, 'Escape'); assert.equal(h.container.querySelector('[aria-label="Session title"]'), null);
});

test('terminal append bypasses an active Markdown throttle interval in its first render', bounded, async t => {
    const h = await surface(t); const renders: string[] = [];
    t.mock.method(Date, 'now', () => 1000);
    function Probe({ text, final }: { text: string; final: boolean }) {
        const shown = useThrottledMarkdown(text, final, 'same-item');
        renders.push(shown); return createElement('span', null, shown);
    }
    await h.render(createElement(Probe, { text: 'start', final: false }));
    await h.render(createElement(Probe, { text: 'start streaming', final: false }));
    renders.length = 0;
    await h.render(createElement(Probe, { text: 'start streaming final', final: true }));
    assert.equal(renders[0], 'start streaming final');
    assert.equal(h.container.textContent, 'start streaming final');
});

test('assistant uses sanitized Markdown, math and linear tables; local file opens only on explicit click', bounded, async t => {
    const h = await surface(t); const opened: string[] = [];
    await import('../../public/manager/src/notes/rendering/MarkdownRenderer');
    const text = '**Result**\n\n$x^2$\n\n| Name | Value |\n| --- | --- |\n| alpha | 42 |\n\nOpen /tmp/report.md.\n\n[Unsafe](javascript:alert%281%29)\n\n<script>bad()</script>\n\n![private](/Users/example/secret.png)';
    await h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'assistant_message', phase: 'final', status: 'done', text }),
        provider: 'claude', sessionKey: 'markdown-session', onOpenLocalFile: path => opened.push(path) }));
    assert.equal(h.container.querySelector('strong')?.textContent, 'Result');
    assert.ok(h.container.querySelector('.katex'), 'math must pass through the established math renderer');
    assert.ok(h.container.querySelector('.markdown-linear-table'));
    assert.equal(h.container.querySelector('.markdown-linear-table-td')?.textContent, 'alpha');
    assert.equal(h.container.querySelector('script'), null);
    assert.equal(h.container.querySelector('a[href^="javascript:"]'), null);
    assert.equal(h.container.querySelector('img[src^="/Users/"]'), null);
    assert.deepEqual(opened, []);
    await click(button(h.container, 'report.md')); assert.deepEqual(opened, ['/tmp/report.md']);
});

function virtualGeometry(t: TestContext) {
    const prototype = dom.window.HTMLElement.prototype;
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const offsets = new WeakMap<HTMLElement, number>();
    const properties: Record<string, PropertyDescriptor> = {
        offsetWidth: { get() { return 1000; } },
        offsetHeight: { get(this: HTMLElement) { return this.classList.contains('code-transcript') ? 600 : 92; } },
        clientHeight: { get() { return 600; } },
        scrollHeight: { get(this: HTMLElement) { return Math.max(600, Number.parseFloat(this.querySelector<HTMLElement>('.code-transcript-virtual-spacer')?.style.height ?? '0') || 0); } },
        scrollTop: {
            get(this: HTMLElement) { return offsets.get(this) ?? 0; },
            set(this: HTMLElement, value: number) { offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
        },
    };
    for (const [key, value] of Object.entries(properties)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
        Object.defineProperty(prototype, key, { configurable: true, ...value });
    }
    t.after(() => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(prototype, key, descriptor);
            else Reflect.deleteProperty(prototype, key);
        }
    });
}

test('real virtualizer keeps item DOM identity through equal text, updates and prepend, while bounding rendered rows', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    const a = item({ itemId: 'a', firstSequence: 1, text: 'same text' });
    const b = item({ itemId: 'b', firstSequence: 2, text: 'same text' });
    const render = (items: CodeItem[]) => h.render(createElement(CodeTranscript, {
        items, provider: 'codex-app', sessionKey: 'virtual-session', workingDir: '/tmp/work', loading: false,
        hasOlderHistory: false, async loadOlderHistory() {}, permissionCount: 0,
    }));
    await render([a, b]);
    const before = h.container.querySelector('[data-code-item-id="a"]'); assert.ok(before);
    assert.equal(h.container.querySelectorAll('[data-code-item-id]').length, 2, 'equal text is two real items');
    await render([{ ...a, text: 'same text updated' }, b]);
    assert.equal(h.container.querySelector('[data-code-item-id="a"]'), before);
    await render([item({ itemId: 'older', firstSequence: 0, text: 'older text' }), { ...a, text: 'same text updated' }, b]);
    assert.equal(h.container.querySelector('[data-code-item-id="a"]'), before);
    const many = Array.from({ length: 200 }, (_, index) => item({ itemId: `row-${index}`, firstSequence: index + 1, text: `Message ${index}` }));
    await render(many);
    const rows = h.container.querySelectorAll('[data-code-item-id]');
    assert.ok(rows.length > 0 && rows.length < 40, `virtualized DOM must stay bounded, got ${rows.length}`);
});

test('turn bookkeeping stays out of the transcript while actionable endings remain', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    const render = (items: CodeItem[]) => h.render(createElement(CodeTranscript, {
        items, provider: 'codex-app', sessionKey: 'turn-session', workingDir: '/tmp/work', loading: false,
        hasOlderHistory: false, async loadOlderHistory() {}, permissionCount: 0,
    }));
    await render([
        item({ itemId: 'started', kind: 'turn_started', firstSequence: 1 }),
        item({ itemId: 'answer', kind: 'assistant_message', firstSequence: 2, text: 'hello' }),
        item({ itemId: 'done', kind: 'turn_completed', firstSequence: 3 }),
    ]);
    assert.equal(h.container.querySelector('[data-code-item-id="started"]'), null);
    assert.equal(h.container.querySelector('[data-code-item-id="done"]'), null);
    assert.ok(h.container.querySelector('[data-code-item-id="answer"]'), 'the answer itself still renders');
    assert.doesNotMatch(h.container.textContent ?? '', /Turn started/);
    assert.doesNotMatch(h.container.textContent ?? '', /Completed/);
    // A turn that failed or was stopped is something the reader can act on.
    await render([
        item({ itemId: 'answer', kind: 'assistant_message', firstSequence: 1, text: 'hello' }),
        item({ itemId: 'failed', kind: 'turn_failed', status: 'error', firstSequence: 2, text: 'Runtime closed' }),
    ]);
    assert.ok(h.container.querySelector('[data-code-item-id="failed"]'), 'failure is not bookkeeping');
});

test('a reader can close a failed call and it stays closed', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    const failed = item({ itemId: 'boom', kind: 'tool_call', status: 'error', firstSequence: 1,
        tool: { name: 'bash', input: '{"command":"npm test"}', output: 'stack trace body' } });
    const render = () => h.render(createElement(CodeTranscript, {
        items: [failed], provider: 'codex-app', sessionKey: 'fail-session', workingDir: '/tmp/work', loading: false,
        hasOlderHistory: false, async loadOlderHistory() {}, permissionCount: 0,
    }));
    await render();
    const card = h.container.querySelector('details.code-tool-card') as HTMLDetailsElement | null;
    assert.ok(card?.open, 'a failure opens itself, because the reader has to see why');
    assert.match(h.container.textContent ?? '', /stack trace body/);
    // Closing is a choice about this row, and a choice outlives the default.
    await act(async () => {
        card!.open = false;
        card!.dispatchEvent(new dom.window.Event('toggle', { bubbles: false }));
    });
    await render();
    const after = h.container.querySelector('details.code-tool-card') as HTMLDetailsElement | null;
    assert.equal(after?.open, false, 'the reader closed it; the failure default must not reopen it');
    assert.doesNotMatch(h.container.textContent ?? '', /stack trace body/);
});

test('CodeCanvas uses the sidebar portal and forwards workspace and explicit file-open callbacks', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    await import('../../public/manager/src/notes/rendering/MarkdownRenderer');
    const { CodeCanvas } = await import('../../public/manager/src/code/CodeCanvas');
    const host = document.createElement('div'); host.id = 'code-session-sidebar-host'; document.body.append(host);
    const oldSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
    const sources: Array<{ closed: boolean }> = [];
    class FixtureEventSource {
        static CLOSED = 2;
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        closed = false;
        constructor(_url: string) { sources.push(this); }
        close() { this.closed = true; }
    }
    globals['EventSource'] = FixtureEventSource;
    t.after(() => {
        host.remove();
        if (oldSource) Object.defineProperty(globalThis, 'EventSource', oldSource); else delete globals['EventSource'];
    });
    const calls: Array<[string, string]> = [], picked: Array<string | null> = [], files: string[] = [];
    const s = session(); const catalog = model().catalog!;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        const method = options?.method ?? 'GET'; calls.push([method, path]);
        let data: object;
        if (path === '/api/code/models') data = catalog;
        else if (path === '/api/code/sessions') data = { sessions: [s], limit: 100, offset: 0, hasMore: false };
        else if (path === '/api/code/git-info') data = { isRepo: false, branch: null, worktrees: [] };
        else if (path === '/api/code/workspace/pick') data = { path: '/tmp/chosen' };
        else if (path === '/api/code/sessions/s-a') data = { session: s, sequence: s.sequence, truncated: false, pendingPermissions: [],
            items: [item({ firstSequence: 1, kind: 'assistant_message', phase: 'final', text: 'Open /tmp/report.md.' })] };
        else if (path === '/api/code/sessions/s-a/events') data = { events: [], nextSequence: s.sequence, throughSequence: s.sequence, hasMore: false };
        else throw Error(`Unexpected fixture request ${method} ${path}`);
        return new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' } });
    });
    await h.render(createElement(CodeCanvas, { port: 43227, workingDir: '/tmp/work', onWorkingDirChange: path => picked.push(path), onOpenLocalFile: path => files.push(path) }));
    assert.ok(host.querySelector('nav[aria-label="Code sessions"]'));
    assert.equal(h.container.querySelector('.code-canvas-sidebar'), null);
    await click(button(h.container, 'Choose Code workspace')); assert.deepEqual(picked, ['/tmp/chosen']);
    const alpha = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.querySelector('.code-session-cwd')?.textContent === 'Alpha'); assert.ok(alpha);
    await click(alpha);
    assert.deepEqual(files, []); await click(button(h.container, 'report.md')); assert.deepEqual(files, ['/tmp/report.md']);
    // Opening a session posts its read receipt (/visit); nothing else may start or prompt a runtime.
    assert.deepEqual(calls.filter(([method, path]) => method !== 'GET' && !String(path).endsWith('/visit')), [['POST', '/api/code/workspace/pick']], 'navigation and file preview must not start or prompt a runtime');
    await h.render(null);
    assert.ok(sources.length > 0 && sources.every(source => source.closed));
    assert.equal(host.querySelector('nav'), null);
});

test('unknown creation recovery warns, preserves the draft and choices, and requires a separate Send', bounded, async t => {
    const h = await surface(t); let recoveries = 0, sends = 0, normalNew = 0;
    const selection = { provider: 'claude' as const, cwd: '/tmp/selected-workspace', model: 'native-model', effort: 'low', permissionMode: 'ask' as const };
    let c = model({ selectedId: null, session: null, creationUnknown: true, input: 'unsent text after lost create response', selection,
        operation: { kind: 'creating', error: 'Creation could not be confirmed' },
        startAnotherSession() {
            recoveries++;
            c = { ...c, creationUnknown: false, operation: { kind: 'idle', error: null } };
        },
        newSession() { normalNew++; }, async send() { sends++; },
    });
    const render = () => h.render(createElement(CodeWorkbench, { controller: c, endpointKey: '43225' }));
    await render();
    const recovery = h.container.querySelector('[aria-label="Unconfirmed session creation"]'); assert.ok(recovery);
    assert.match(recovery.textContent ?? '', /The original session may still exist/);
    assert.match(recovery.textContent ?? '', /Press Send/);
    assert.equal(button(h.container, 'Send prompt').disabled, true);
    assert.equal(button(h.container, 'Runtime: Claude').disabled, true);
    assert.equal(h.container.querySelector('textarea')?.readOnly, false, 'uncertain creation does not discard or lock the text');
    await click(button(h.container, 'Start another session'));
    assert.equal(recoveries, 1); assert.equal(normalNew, 0); assert.equal(sends, 0);
    await render();
    assert.equal(h.container.querySelector('[aria-label="Unconfirmed session creation"]'), null);
    assert.equal(h.container.querySelector('textarea')?.value, 'unsent text after lost create response');
    assert.deepEqual(c.selection, selection);
    assert.equal(button(h.container, 'Send prompt').disabled, false);
    assert.equal(button(h.container, 'Runtime: Claude').disabled, false);
    assert.match(button(h.container, 'Model: native-model').textContent ?? '', /native-model/);
    assert.match(button(h.container, 'Effort: low').textContent ?? '', /low/);
    assert.equal(sends, 0, 'recovery and rerender must not send automatically');
    await click(button(h.container, 'Send prompt')); assert.equal(sends, 1);
});

test('switching to Auto (YOLO) announces the change over the transcript, not under the composer', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    const c = model();
    await h.render(createElement(CodeWorkbench, { controller: c, endpointKey: '43225' }));
    // The policy is legible on its own control; a permanent line under the
    // composer is not what tells the reader it just changed. The live regions
    // are mounted from the start -- one that appears together with its first
    // message is not announced -- but they hold nothing yet.
    assert.ok(h.container.querySelector('.code-toast-host'), 'the live regions exist before there is anything to say');
    assert.equal(h.container.querySelector('.code-toast'), null);
    assert.doesNotMatch(h.container.textContent ?? '', /actions may run without approval/);
    const auto = model({ selection: { ...c.selection, permissionMode: 'auto' } });
    await h.render(createElement(CodeWorkbench, { controller: auto, endpointKey: '43225' }));
    const toast = h.container.querySelector('.code-toast');
    assert.ok(toast, 'the switch is announced');
    assert.match(toast?.textContent ?? '', /Auto \(YOLO\)/);
    assert.ok(h.container.querySelector('.code-toast-warning'));
    // Derived from the policy, not from a transition: a new session that is
    // already Auto still says so, because the footer remounts and re-raises it.
    // A transition detector would read that remount as "nothing changed" and
    // stay silent exactly when the session starts acting on the policy.
    await h.render(createElement(CodeWorkbench, { controller: model({ selection: { ...c.selection, permissionMode: 'auto' } }), endpointKey: '43225', ...{} }));
    assert.match(h.container.querySelector('.code-toast')?.textContent ?? '', /Auto \(YOLO\)/);
    // Leaving the policy retires it rather than letting it assert something
    // about the session that is no longer true.
    await h.render(createElement(CodeWorkbench, { controller: model({ selection: { ...c.selection, permissionMode: 'read-only' } }), endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-toast'), null, 'the warning leaves with the policy');
    await h.render(createElement(CodeWorkbench, { controller: auto, endpointKey: '43225' }));
    await click(h.container.querySelector('.code-toast-dismiss') as HTMLButtonElement);
    assert.equal(h.container.querySelector('.code-toast'), null, 'a notice can be dismissed from the keyboard');
});

test('states the reader must act on stay on screen instead of becoming a toast', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    // An unconfirmed send has a recovery path attached to it. A notice that
    // dismisses itself after a few seconds would take that path with it.
    await h.render(createElement(CodeWorkbench, { controller: model({ operation: { kind: 'unknown-send', error: null }, retryText: 'original request', canRetrySameSend: true }), endpointKey: '43225' }));
    assert.match(h.container.textContent ?? '', /Send outcome not confirmed/);
    assert.ok(h.container.querySelector('[aria-label="Original prompt"]'));
    await h.render(createElement(CodeWorkbench, { controller: model({ transport: 'disconnected' }), endpointKey: '43225' }));
    assert.match(h.container.textContent ?? '', /Live updates disconnected/);
});

test('the new session entry is a primary button with a shortcut hint and a Draft badge', bounded, async t => {
    const h = await surface(t); let created = 0;
    const c = model({ newSession() { created++; } });
    await h.render(createElement(CodeSessionList, { controller: c }));
    const entry = h.container.querySelector<HTMLButtonElement>('.code-session-new-primary');
    assert.ok(entry, 'the primary new-session button exists');
    assert.match(entry.textContent ?? '', /New session/);
    assert.ok(entry.querySelector('svg'), 'the entry carries a plus glyph');
    assert.ok(entry.querySelector('.code-session-new-hint')?.textContent?.trim(), 'the shortcut chord is shown as a hint');
    assert.equal(entry.getAttribute('aria-label'), 'New Code session', 'the accessible name stays stable while the visible label and badge change');
    assert.equal(entry.querySelector('.code-session-new-hint')?.getAttribute('aria-hidden'), 'true', 'the chord hint stays out of the accessible name');
    assert.equal(entry.querySelector('.code-session-draft-badge'), null, 'no badge without an unsent draft');
    assert.equal(entry.getAttribute('aria-describedby'), null, 'nothing is described while there is no draft to name');
    assert.doesNotMatch(h.container.textContent ?? '', /Preserved unsent draft/, 'the old draft row is gone');
    await click(entry); assert.equal(created, 1);
    await h.render(createElement(CodeSessionList, { controller: c, newSessionShortcut: 'Meta+Shift+Q' }));
    assert.equal(h.container.querySelector('.code-session-new-hint')?.textContent, formatShortcut('Meta+Shift+Q'), 'the hint shows the resolved keymap chord, not the default');
    await h.render(createElement(CodeSessionList, { controller: { ...c, hasUnsentDraft: true } }));
    assert.equal(h.container.querySelector('.code-session-draft-badge')?.textContent, 'Draft');
    // aria-label fixes the name, so the badge has to reach the reader as a
    // description rather than being dropped from it.
    assert.equal(entry.getAttribute('aria-describedby'), h.container.querySelector('.code-session-draft-badge')?.id, 'the draft state is described while the badge is shown');
});

test('the manager newCodeSession shortcut action opens a fresh draft while the list is mounted', bounded, async t => {
    const h = await surface(t); let created = 0;
    await h.render(createElement(CodeSessionList, { controller: model({ newSession() { created++; } }) }));
    await act(async () => {
        document.dispatchEvent(new dom.window.CustomEvent('jaw:shortcut-action', { detail: 'newCodeSession' }));
    });
    assert.equal(created, 1);
    await act(async () => {
        document.dispatchEvent(new dom.window.CustomEvent('jaw:shortcut-action', { detail: 'terminalClear' }));
    });
    assert.equal(created, 1, 'unrelated shortcut actions do not start a draft');
});

test('workspace groups each offer a + that starts a draft with that cwd', bounded, async t => {
    const h = await surface(t); const selections: unknown[] = []; let created = 0;
    const c = model({
        sessions: [session({ cwd: '/work/alpha' }), session({ sessionId: 's-b', cwd: '/work/beta', title: 'Beta' })],
        newSession() { created++; },
        async setSelection(patch) { selections.push(patch); },
    });
    await h.render(createElement(CodeSessionList, { controller: c }));
    // Projects is the default view: one group per workspace, named by its folder.
    const headers = [...h.container.querySelectorAll('.code-session-group-title')];
    assert.equal(headers.length, 2, 'each workspace is its own group');
    const beta = headers.find(node => node.getAttribute('title') === '/work/beta'); assert.ok(beta);
    assert.equal(beta.querySelector('span')?.textContent, 'beta', 'the heading shows the folder name, the full path stays in the title');
    await click(button(beta, 'New session in /work/beta'));
    assert.equal(created, 1);
    assert.deepEqual(selections, [{ cwd: '/work/beta' }], 'the group workspace preselects the draft cwd');
    // The Activity view groups by time, so it has no per-group workspace to preselect.
    await click(button(h.container, 'Recent activity'));
    assert.equal(h.container.querySelector('.code-session-group-new'), null);
});

test('a workspace + does not retarget a draft that already holds unsent content', bounded, async t => {
    const h = await surface(t); const selections: unknown[] = [];
    const c = model({
        sessions: [session({ cwd: '/work/alpha' })],
        hasUnsentDraft: true,
        async setSelection(patch) { selections.push(patch); },
    });
    await h.render(createElement(CodeSessionList, { controller: c }));
    await click(button(h.container.querySelector('.code-session-group-title')!, 'New session in /work/alpha'));
    assert.deepEqual(selections, [], 'a draft with unsent content keeps its workspace');
    assert.match(h.container.querySelector('.code-session-list-error')?.textContent ?? '', /Send or clear the current draft/, 'the reason is surfaced instead of a silent no-op');
    assert.ok(h.container.querySelector('.code-session-draft-badge'), 'the Draft badge explains which draft is blocked');
});

test('a workspace + still retargets the fresh draft while the viewed session is busy', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = [];
    const c = model({
        sessions: [session({ cwd: '/work/alpha' })],
        selectedId: 's-a',
        pending: true,
        newSession() { calls.push('new'); },
        async setSelection(patch) { calls.push(patch); },
    });
    await h.render(createElement(CodeSessionList, { controller: c }));
    await click(button(h.container.querySelector('.code-session-group-title')!, 'New session in /work/alpha'));
    // The reader has already left for a fresh draft, so the busy session's own
    // pending operation is not a reason to refuse the workspace it picked.
    assert.deepEqual(calls, ['new', { cwd: '/work/alpha' }], 'a busy session does not pin the fresh draft to its workspace');
    assert.equal(h.container.querySelector('.code-session-list-error'), null, 'nothing was refused, so nothing is explained');
});

test('a workspace + explains a fresh draft that is itself mid-operation in its own words', bounded, async t => {
    const h = await surface(t); const selections: unknown[] = [];
    const c = model({
        sessions: [session({ cwd: '/work/alpha' })], selectedId: null, session: null, pending: true,
        async setSelection(patch) { selections.push(patch); },
    });
    await h.render(createElement(CodeSessionList, { controller: c }));
    await click(button(h.container.querySelector('.code-session-group-title')!, 'New session in /work/alpha'));
    assert.deepEqual(selections, [], 'setSelection early-returns while the draft is mid-operation');
    assert.match(h.container.querySelector('.code-session-list-error')?.textContent ?? '', /Wait for the current change to finish/, 'the in-flight reason is distinct from the unsent-draft reason');
    assert.doesNotMatch(h.container.querySelector('.code-session-list-error')?.textContent ?? '', /Send or clear/, 'a busy draft is not an unsent draft');
});

test('recent workspaces are unique directories ordered by last use, capped at five', () => {
    const at = (cwd: string, lastUsedAt: number, createdAt = lastUsedAt) => session({ cwd, lastUsedAt, createdAt });
    assert.deepEqual(recentCodeWorkspaces([]), []);
    assert.deepEqual(recentCodeWorkspaces([at('/a', 1), at('/b', 5), at('/a', 4), at('/c', 3)]), ['/b', '/a', '/c'],
        'the workspace, not the session, is the unique unit and newest use wins');
    assert.deepEqual(recentCodeWorkspaces([at('', 99), at('  ', 50), at('/a', 1)]), ['/a'],
        'a blank cwd is not a workspace');
    assert.deepEqual(recentCodeWorkspaces([at('/a', 1), at('/b', 2), at('/c', 3), at('/d', 4), at('/e', 5), at('/f', 6), at('/g', 7)]),
        ['/g', '/f', '/e', '/d', '/c'], 'the list is capped at five');
});

test('draft empty state offers workspace, recents and suggested prompts without sending', bounded, async t => {
    const h = await surface(t);
    const selections: unknown[] = [], inputs: string[] = []; let sends = 0, picks = 0;
    const draft = model({ selectedId: null, session: null, items: [], input: '',
        selection: { provider: 'codex-app', cwd: '/work/current', model: 'native-model', effort: null, permissionMode: 'ask' },
        sessions: [session({ cwd: '/work/current', lastUsedAt: 9 }), session({ cwd: '/work/recent', lastUsedAt: 8 }), session({ cwd: '/work/older', lastUsedAt: 1 })],
        async setSelection(patch) { selections.push(patch); },
        setInput(text) { inputs.push(text); },
        async pickWorkspace() { picks++; },
        async send() { sends++; },
    });
    await h.render(createElement(CodeWorkbench, { controller: draft, endpointKey: '43225' }));
    const empty = h.container.querySelector('.code-draft-empty'); assert.ok(empty);
    assert.match(empty.textContent ?? '', /New session/);
    assert.match(empty.textContent ?? '', /Codex · native-model/);
    // The current workspace is already the picker's value; offering it again
    // would be a button that does nothing.
    assert.deepEqual([...empty.querySelectorAll<HTMLButtonElement>('.code-draft-recent')].map(b => b.textContent),
        ['/work/recent', '/work/older']);
    await click(button(empty, '/work/recent')); assert.deepEqual(selections, [{ cwd: '/work/recent' }]);
    await click(button(empty, 'Explain this codebase'));
    assert.deepEqual(inputs, ['Explain this codebase']);
    assert.equal(sends, 0, 'a suggested prompt fills the composer draft, never sends');
    await click(button(empty, 'Choose workspace for the new session')); assert.equal(picks, 1);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Code prompt', 'entering the draft lands focus in the composer');
    // One folder dialog at a time: while the pick is in flight both the header
    // and the empty-state picker read as busy, not just the one that was clicked.
    await h.render(createElement(CodeWorkbench, { controller: { ...draft, workspacePicking: true }, endpointKey: '43225' }));
    // The two pickers sit in the same view, so each accessible name must resolve
    // to exactly one of them for a screen reader to tell them apart.
    const headerPicker = h.container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose Code workspace"]');
    const draftPicker = h.container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose workspace for the new session"]');
    assert.equal(headerPicker.length, 1); assert.equal(draftPicker.length, 1);
    for (const picker of [...headerPicker, ...draftPicker]) assert.equal(picker.disabled, true);
    // A prompt the composer already holds must not be silently overwritten by a chip.
    await h.render(createElement(CodeWorkbench, { controller: { ...draft, input: 'Explain this codebase' }, endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-draft-prompt'), null);
});

test('activating a draft chip or a recent hands focus to the composer', bounded, async t => {
    const h = await surface(t);
    const inputs: string[] = [];
    const draft = model({ selectedId: null, session: null, items: [], input: '',
        selection: { provider: 'codex-app', cwd: '/work/current', model: 'native-model', effort: null, permissionMode: 'ask' },
        sessions: [session({ cwd: '/work/recent', lastUsedAt: 8 })],
        setInput(text) { inputs.push(text); }, async setSelection() {} });
    await h.render(createElement(CodeWorkbench, { controller: draft, endpointKey: '43225' }));
    const focused = () => document.activeElement?.getAttribute('aria-label');
    const chip = button(h.container, 'Explain this codebase');
    chip.focus(); assert.equal(document.activeElement, chip);
    await click(chip);
    assert.deepEqual(inputs, ['Explain this codebase']);
    assert.equal(focused(), 'Code prompt', 'the chip unmounts once the draft is filled, so focus moves into the composer');
    // The chip really disappears rather than merely losing focus, so the focus
    // has to be re-homed rather than kept by the control that was activated.
    await h.render(createElement(CodeWorkbench, { controller: { ...draft, input: 'Explain this codebase' }, endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-draft-prompt'), null);
    assert.equal(focused(), 'Code prompt');
    const recent = button(h.container, '/work/recent');
    recent.focus(); assert.equal(document.activeElement, recent);
    await click(recent);
    assert.equal(focused(), 'Code prompt', 'choosing a recent changes the list, so focus moves into the composer');
});

test('recent list still fills five slots when the current workspace is among the most used', bounded, async t => {
    const h = await surface(t);
    const draft = model({ selectedId: null, session: null, items: [], input: '',
        selection: { provider: 'codex-app', cwd: '/w/current', model: 'native-model', effort: null, permissionMode: 'ask' },
        sessions: ['/w/current', '/w/2', '/w/3', '/w/4', '/w/5', '/w/6'].map((cwd, i) => session({ cwd, lastUsedAt: 10 - i })) });
    await h.render(createElement(CodeWorkbench, { controller: draft, endpointKey: '43225' }));
    // Excluding the current cwd must happen before the cap, or it eats a slot
    // and the sixth workspace never surfaces.
    assert.deepEqual([...h.container.querySelectorAll<HTMLButtonElement>('.code-draft-recent')].map(b => b.textContent),
        ['/w/2', '/w/3', '/w/4', '/w/5', '/w/6']);
});

test('in-flight creation freezes the draft empty state instead of offering stale choices', bounded, async t => {
    const h = await surface(t);
    const draft = model({ selectedId: null, session: null, items: [], pending: true, input: '',
        operation: { kind: 'creating', error: null }, sessions: [session({ cwd: '/work/recent' })] });
    await h.render(createElement(CodeWorkbench, { controller: draft, endpointKey: '43225' }));
    const empty = h.container.querySelector('.code-draft-empty'); assert.ok(empty);
    assert.equal(empty.querySelector('button.code-draft-empty-picker'), null,
        'an in-flight create owns the workspace now; the picker reads as a chip');
    for (const b of empty.querySelectorAll<HTMLButtonElement>('.code-draft-recent, .code-draft-prompt')) assert.equal(b.disabled, true);
});

test('the draft empty state only replaces the transcript for a draft', bounded, async t => {
    const h = await surface(t);
    await h.render(createElement(CodeWorkbench, { controller: model(), endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-draft-empty'), null);
    assert.ok(h.container.querySelector('[aria-label="Code transcript"]'), 'a selected session keeps its transcript');
    await h.render(createElement(CodeDraftEmptyState, { controller: model({ selectedId: null, session: null, sessions: [] }) }));
    assert.ok(h.container.querySelector('.code-draft-empty'));
});

test('the bell switches to Recent activity with unread sessions under Priority and a dot on the bell', bounded, async t => {
    const h = await surface(t);
    localStorage.removeItem('jaw.code.sidebarView');
    const now = Date.now();
    const c = model({ sessions: [
        session({ sessionId: 's-unread', title: 'Unread one', cwd: '/work/alpha', lastUsedAt: now, lastTurnCompletedAt: now, lastVisitedAt: now - 1000 }),
        session({ sessionId: 's-read', title: 'Read one', cwd: '/work/beta', lastUsedAt: now, lastTurnCompletedAt: now - 5000, lastVisitedAt: now }),
        session({ sessionId: 's-never', title: 'Never opened', cwd: '/work/beta', lastUsedAt: now, lastTurnCompletedAt: now, lastVisitedAt: null }),
    ], selectedId: null, session: null });
    await h.render(createElement(CodeSessionList, { controller: c }));
    const bell = h.container.querySelector<HTMLButtonElement>('.code-session-bell'); assert.ok(bell);
    assert.equal(bell.getAttribute('aria-pressed'), 'false');
    assert.ok(bell.querySelector('.code-session-unread-dot'), 'the bell carries a dot while anything is unread');
    assert.equal(h.container.querySelectorAll('.code-session-item .code-session-unread-dot').length, 1, 'only the unread row has a dot');
    await click(bell);
    assert.equal(bell.getAttribute('aria-pressed'), 'true');
    assert.equal(localStorage.getItem('jaw.code.sidebarView'), 'activity', 'the chosen view persists');
    const titles = [...h.container.querySelectorAll('.code-session-group-title')].map(node => node.textContent);
    assert.deepEqual(titles, ['Priority', 'Today']);
    const priority = h.container.querySelector('.code-session-group-priority')!.closest('.code-session-group')!;
    assert.match(priority.textContent ?? '', /Unread one/);
    assert.doesNotMatch(priority.textContent ?? '', /Never opened/, 'a never-opened session is not unread');
    assert.match(h.container.querySelector('.code-session-meta')?.textContent ?? '', /^alpha · /, 'activity rows show their workspace');
    await click(bell);
    assert.equal(h.container.querySelector('.code-session-list-title')?.textContent, 'Projects');
    localStorage.removeItem('jaw.code.sidebarView');
});

test('the open session never shows as unread, even before its receipt lands', bounded, async t => {
    const h = await surface(t);
    const now = Date.now();
    const c = model({ sessions: [session({ sessionId: 's-a', lastUsedAt: now, lastTurnCompletedAt: now, lastVisitedAt: now - 1 })], selectedId: 's-a' });
    await h.render(createElement(CodeSessionList, { controller: c }));
    assert.equal(h.container.querySelector('.code-session-unread-dot'), null);
    await click(button(h.container, 'Recent activity'));
    assert.equal(h.container.querySelector('.code-session-group-priority'), null, 'nor is it listed under Priority');
    assert.deepEqual([...h.container.querySelectorAll('.code-session-group-title')].map(node => node.textContent), ['Today']);
});

test('the search icon left of the bell opens search with an archived switch; closing clears the query', bounded, async t => {
    const h = await surface(t); const filters: unknown[] = [];
    const c = model({ sessions: [session({ sessionId: 's-a', title: 'Alpha' }), session({ sessionId: 's-b', title: 'Beta', cwd: '/work/beta' })],
        filter: { scope: 'all', archived: false }, setFilter(next) { filters.push(next); } });
    await h.render(createElement(CodeSessionList, { controller: c }));
    assert.equal(h.container.querySelector('.code-session-view-toggle'), null, 'the All / This cwd toggle is gone');
    assert.equal(h.container.querySelector('input[aria-label="Search loaded sessions"]'), null, 'search is closed by default');
    const actions = [...h.container.querySelectorAll('.code-session-header-actions button')].map(b => b.getAttribute('aria-label'));
    assert.equal(actions[0], 'Search sessions', 'search sits left of the bell');
    assert.match(actions[1] ?? '', /Recent activity/);
    await click(button(h.container, 'Search sessions'));
    const input = h.container.querySelector<HTMLInputElement>('input[aria-label="Search loaded sessions"]'); assert.ok(input);
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'beta'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual([...h.container.querySelectorAll('.code-session-cwd')].map(n => n.textContent), ['Beta']);
    await click(button(h.container, 'Archived'));
    assert.deepEqual(filters, [{ scope: 'all', archived: true }]);
    await click(button(h.container, 'Search sessions'));
    assert.equal(h.container.querySelector('input[aria-label="Search loaded sessions"]'), null);
    assert.equal(h.container.querySelectorAll('.code-session-cwd').length, 2, 'closing search clears the filter');
});

test('a working row shows a spinner and reads Starting before the server reports the turn', bounded, async t => {
    const h = await surface(t);
    const c = model({ sessions: [session({ sessionId: 's-a', status: 'idle' })], workingIds: new Set(['s-a']) });
    await h.render(createElement(CodeSessionList, { controller: c }));
    const status = h.container.querySelector('.code-session-status');
    assert.ok(status?.querySelector('.code-session-spinner'));
    assert.match(status?.textContent ?? '', /Starting/);
    assert.equal(status?.getAttribute('data-quiet'), null, 'a working row is not visually quiet');
});

test('the transcript shows Working… while the session works, unless a running row already animates', bounded, async t => {
    const h = await surface(t);
    const done = { itemId: 'm1', turnId: 't', kind: 'assistant_message', status: 'done', text: 'hi', createdAt: 1, updatedAt: 1, firstSequence: 1 } as CodeItem;
    await h.render(createElement(CodeWorkbench, { controller: model({ items: [done], working: true, busy: true }), endpointKey: '43225' }));
    assert.match(h.container.querySelector('.code-transcript-working')?.textContent ?? '', /Working/);
    const running = { ...done, itemId: 'tool', kind: 'tool_call', status: 'running' } as CodeItem;
    await h.render(createElement(CodeWorkbench, { controller: model({ items: [done, running], working: true, busy: true }), endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-transcript-working'), null);
    await h.render(createElement(CodeWorkbench, { controller: model({ items: [done], working: false }), endpointKey: '43225' }));
    assert.equal(h.container.querySelector('.code-transcript-working'), null);    await h.render(createElement(CodeWorkbench, { controller: model({ items: [], working: true, busy: true }), endpointKey: '43225' }));
    assert.match(h.container.querySelector('.code-transcript-working')?.textContent ?? '', /Working/, 'an empty transcript still shows the session working');
});

test('Send is enabled on a resumable suspended session and not on a non-recoverable failure', bounded, async t => {
    const h = await surface(t);
    const suspended = session({ status: 'suspended', resume: { available: true, reason: null } });
    await h.render(createElement(CodeWorkbench, { controller: model({ session: suspended, sessions: [suspended], input: 'continue', synced: true }), endpointKey: '43225' }));
    assert.equal(button(h.container, 'Send prompt').disabled, false, 'send attaches the session first');
    const failed = session({ status: 'failed', error: { code: 'x', message: 'x', at: 1, recoverable: false } });
    await h.render(createElement(CodeWorkbench, { controller: model({ session: failed, sessions: [failed], input: 'continue', synced: true }), endpointKey: '43225' }));
    assert.equal(button(h.container, 'Send prompt').disabled, true);
});

test('the Claude permission menu lists today\'s catalog modes, not the session snapshot', bounded, async t => {
    const h = await surface(t);
    const base = model();
    const claudeModes = ['ask', 'accept-edits', 'plan', 'auto-review', 'dont-ask', 'auto'] as const;
    const catalog = { ...base.catalog!, providers: base.catalog!.providers.map(entry => entry.id === 'claude'
        ? { ...entry, capabilities: { ...entry.capabilities, permissions: true, permissionModes: [...claudeModes] } } : entry) };
    const snapshot = session({ provider: 'claude', permissionMode: 'ask',
        capabilities: { ...session().capabilities, permissions: true, permissionModes: ['ask', 'auto'] } });
    const changes: unknown[] = [];
    const c = model({ catalog, session: snapshot, sessions: [snapshot],
        selection: { provider: 'claude', cwd: snapshot.cwd, model: snapshot.model, effort: null, permissionMode: 'ask' },
        async setSelection(patch) { changes.push(patch); } });
    await h.render(createElement(ComposerFooter, { controller: c }));
    await click(button(h.container, 'Permission: Ask first'));
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(o => o.textContent?.match(/^[^A-Z]*([A-Z][^A-Z]*?(?:\([^)]*\))?)(?=[A-Z]|$)/)?.[1]?.trim() ?? ''),
        ['Ask first', 'Accept edits', 'Plan', 'Auto review', "Don't ask", 'Auto (YOLO)']);
});

test('the Thinking menu shows only for Claude and switches the setting', bounded, async t => {
    const h = await surface(t);
    const changes: unknown[] = [];
    const claude = model({ selection: { provider: 'claude', cwd: '/workspace', model: 'native-model', effort: null, permissionMode: 'ask' },
        async setSelection(patch) { changes.push(patch); } });
    await h.render(createElement(ComposerFooter, { controller: claude }));
    await click(button(h.container, 'Thinking: Thinking on'));
    const off = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent?.startsWith('Thinking off'));
    assert.ok(off, 'an Off option is offered');
    await click(off!);
    assert.deepEqual(changes, [{ thinking: false }]);
    await h.render(createElement(ComposerFooter, { controller: model({
        selection: { provider: 'codex-app', cwd: '/workspace', model: 'native-model', effort: null, permissionMode: 'ask' } }) }));
    assert.equal([...h.container.querySelectorAll('button')].some(b => b.getAttribute('aria-label')?.startsWith('Thinking')), false);
});
