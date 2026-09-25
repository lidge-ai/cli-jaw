import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { createActivityChoices, rememberActivityChoice, createActivityView } from '../../public/js/features/activity-view.ts';
import { createActivityState, applyActivityEvent } from '../../src/shared/activity-state.ts';
import type { ActivityState } from '../../src/shared/activity-state.ts';
import type { RuntimeEventBody, RuntimeItemStatus } from '../../src/shared/runtime-contract.ts';
import { classifyExitError } from '../../src/agent/error-classifier.ts';

const identity = { version: 1 as const, sessionId: 'chat-a', scope: 'local:chat-a', runId: 'run-a', turnId: 'turn-a', seq: 1 };
function send(model: ActivityState, body: RuntimeEventBody): void {
    assert.equal(applyActivityEvent(model, { ...identity, ...body, seq: model.seq + 1 }), true);
}
function tool(model: ActivityState, id: string, output = '결과', status: RuntimeItemStatus = 'done'): void {
    send(model, { kind: 'tool', itemId: id, name: `read ${id}`, output, status });
}
function mount(inspect?: (state: ActivityState) => void) {
    const message = document.createElement('div');
    message.className = 'msg-agent';
    message.innerHTML = '<div class="agent-body"><div class="process-block">Legacy</div><div class="msg-content">Canonical answer</div><div class="message-actions"><button>Copy</button></div></div>';
    document.body.append(message);
    const host = message.querySelector<HTMLElement>('.agent-body')!;
    const answer = host.querySelector<HTMLElement>('.msg-content')!;
    const choices = createActivityChoices();
    const model = createActivityState(identity);
    const view = createActivityView(host, choices, inspect);
    const group = view.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!;
    return { message, host, answer, choices, model, view, group };
}
function rows(root: Element): HTMLDetailsElement[] {
    return [...root.querySelectorAll<HTMLDetailsElement>('[data-activity-item-id]')];
}
function button(root: Element, label: string): HTMLButtonElement {
    const result = [...root.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(result, `Missing button: ${label}`);
    return result;
}
async function toggle(node: HTMLDetailsElement, open: boolean): Promise<void> {
    const changed = new Promise<void>(resolve => node.addEventListener('toggle', () => resolve(), { once: true }));
    node.open = open;
    await changed;
}

test.beforeEach(setupWebUiDom);
test.afterEach(resetWebUiDom);

test('compact Activity keeps live status, accessible disclosures and a separate Trace action', async () => {
    let inspected: ActivityState | undefined;
    const { model, view, group, answer } = mount(state => { inspected = state; });
    tool(model, 'one', 'read one'); tool(model, 'two', 'read two');
    view.render(model);
    const status = view.element.querySelector<HTMLElement>('.activity-status')!;
    assert.equal(status.classList.contains('sr-only'), true);
    assert.equal(status.hidden, false); assert.equal(status.closest('details'), null);
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite'); assert.equal(status.getAttribute('aria-atomic'), 'true');
    const summary = group.querySelector('summary')!;
    assert.equal(summary, group.firstElementChild); assert.equal(summary.querySelector('button, a, input'), null);
    assert.equal(summary.querySelector('.activity-chevron')?.getAttribute('aria-hidden'), 'true');
    const tools = view.element.querySelector('.activity-group[data-kind="file"]')!;
    assert.equal(tools.getAttribute('role'), null);
    const heading = tools.querySelector<HTMLButtonElement>('.activity-group-summary')!;
    const body = tools.querySelector<HTMLElement>('.activity-group-body')!;
    assert.equal(heading.tagName, 'BUTTON'); assert.equal(heading.type, 'button');
    assert.ok(heading.textContent?.trim()); assert.equal(heading.getAttribute('aria-expanded'), 'true');
    assert.equal(body.hidden, false);
    heading.click(); assert.equal(heading.getAttribute('aria-expanded'), 'false'); assert.equal(body.hidden, true);
    heading.click(); assert.equal(heading.getAttribute('aria-expanded'), 'true'); assert.equal(body.hidden, false);
    for (const row of rows(view.element)) {
        assert.equal(row.tagName, 'DETAILS'); assert.equal(row.firstElementChild?.tagName, 'SUMMARY');
        assert.ok(row.querySelector('summary')?.getAttribute('aria-label')?.trim());
        assert.ok(row.querySelector('.activity-row-label')?.textContent?.trim());
        assert.equal(row.querySelector('.activity-row-icon')?.getAttribute('aria-hidden'), 'true');
        assert.equal(row.querySelector('.activity-chevron-sm')?.getAttribute('aria-hidden'), 'true');
    }
    await toggle(group, true);
    const trace = view.element.querySelector<HTMLButtonElement>('.activity-footer .activity-trace')!;
    assert.ok(trace); assert.equal(trace.closest('details'), group);
    assert.equal(trace.textContent, 'Open in Trace');
    assert.equal(trace.getAttribute('aria-label'), 'Inspect retained activity in Trace');
    trace.click(); assert.equal(inspected, model);
    send(model, { kind: 'turn-end', status: 'stopped', finalText: null }); view.render(model);
    assert.equal(status.textContent, 'Stopped'); assert.equal(answer.textContent, 'Canonical answer');
    assert.equal(view.element.querySelectorAll('.activity-status[role="status"]').length, 1);
});

test('summary keeps five ordered slots and an independent live status', () => {
    const { model, view, group, answer } = mount(); tool(model, 'one');
    view.render(model, { steered: true });
    const summary = group.querySelector('summary')!;
    assert.deepEqual([...summary.children].map(el => el.className.split(' ')[0]), [
        'activity-chevron', 'activity-status-label', 'activity-summary-text', 'activity-steer-pill', 'activity-accessory']);
    assert.ok(summary.querySelector('.activity-chevron svg'));
    assert.equal(summary.querySelector('.activity-chevron')?.getAttribute('aria-hidden'), 'true');
    assert.equal(summary.querySelector<HTMLElement>('.activity-steer-pill')!.hidden, false);
    assert.equal(view.element.querySelector('.activity-status')?.classList.contains('sr-only'), true);
    assert.equal(answer.textContent, 'Canonical answer');
    for (const status of ['running', 'finished', 'done', 'stopped', 'error'] as const) {
        view.render(model, { status });
        assert.equal(summary.querySelector('.activity-status-label')?.textContent,
            ({ running: 'Working', finished: 'Finished', done: 'Complete', stopped: 'Stopped', error: 'Failed' })[status]);
        assert.equal(summary.querySelector<HTMLElement>('.activity-steer-pill')!.hidden, true);
    }
});

test('empty Activity mounts before the untouched answer and has no unavailable Trace control', () => {
    const { host, answer, model, view, group } = mount();
    view.render(model);
    assert.equal(view.element.nextElementSibling, answer);
    assert.equal(group.open, false);
    assert.equal(rows(view.element).length, 0);
    assert.match(view.element.textContent!, /No activity recorded/);
    assert.equal(view.element.querySelector('.activity-status')?.textContent, 'Working');
    assert.equal(view.element.querySelector('.activity-status')?.getAttribute('role'), 'status');
    assert.equal(view.element.querySelector('.activity-trace'), null);
    assert.equal(host.querySelector('.message-actions button')?.textContent, 'Copy');
    assert.equal(answer.textContent, 'Canonical answer');
});

test('terminal text never creates or modifies a final answer, including empty and null', () => {
    for (const finalText of ['FINAL_SENTINEL' + '끝'.repeat(40000), '', null]) {
        const { model, view, answer, host } = mount();
        send(model, { kind: 'message', itemId: 'comment', phase: 'commentary', text: 'Checking files', operation: 'replace' });
        send(model, { kind: 'turn-end', status: 'done', finalText });
        view.render(model);
        view.render(model);
        assert.equal(host.querySelectorAll('.msg-content').length, 1);
        assert.equal(host.querySelector('.msg-content'), answer);
        assert.equal(answer.textContent, 'Canonical answer');
        assert.equal(view.element.querySelector('.activity-final'), null);
        assert.doesNotMatch(view.element.textContent!, /FINAL_SENTINEL|Canonical answer/);
    }
});

test('tool fields and latest action render literal XSS text without HTML or markdown', () => {
    const { model, view, group } = mount();
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold**';
    send(model, { kind: 'tool', itemId: '"]<img>', name: attack, input: attack, output: attack, detail: attack, status: 'running' });
    view.render(model);
    assert.equal(group.open, false);
    assert.match(group.firstElementChild!.getAttribute('aria-label')!, /1 step/);
    assert.ok(group.firstElementChild!.textContent!.includes(attack));
    assert.equal(view.element.querySelector('img, script, strong'), null);
    const pres = [...rows(view.element)[0].querySelectorAll('.activity-item-body pre')].map(node => node.textContent);
    assert.deepEqual(pres, [attack, attack, attack]);
});

for (const ending of ['done', 'error'] as const) {
test(`explicit disclosure and focused keyed tool survive replacement, growth and turn end (${ending}; A08)`, async () => {
    const { model, choices, view, group } = mount();
    tool(model, 'tool-0', 'old');
    view.render(model);
    await toggle(group, true);
    const row = rows(view.element)[0];
    await toggle(row, true);
    const title = row.querySelector('summary')!;
    title.focus();
    tool(model, 'tool-0', 'new', 'done');
    for (let i = 1; i <= 80; i++) tool(model, `tool-${i}`);
    view.render(model);
    send(model, { kind: 'turn-end', status: ending, finalText: 'Answer', ...(ending === 'error' ? { error: 'Later failure' } : {}) });
    view.render(model);
    assert.equal(rows(view.element)[0], row);
    assert.equal(row.querySelector('pre')?.textContent, 'new');
    assert.equal(row.open, true);
    assert.equal(group.open, true);
    assert.equal(choices.open, true);
    assert.equal(choices.items.get('tool-0'), true);
    assert.equal(document.activeElement, title);
    assert.equal(rows(view.element).length, 40);
    assert.match(group.firstElementChild!.textContent!, /read tool-80/);
    assert.match(group.firstElementChild!.getAttribute('aria-label')!, /81 steps/);
});
}

test('A01: bounded terminal error is literal text outside collapsed Activity, never a final', () => {
    const { model, view, group, answer, host } = mount();
    const error = '<img src=x onerror="alert(1)"><script>alert(2)</script> **failed** ' + '경로'.repeat(400);
    send(model, { kind: 'turn-end', status: 'error', error, finalText: 'FINAL_SENTINEL' });
    view.render(model);
    const notice = view.element.querySelector<HTMLElement>('.activity-error')!;
    assert.equal(group.open, false);
    assert.equal(notice.hidden, false);
    assert.equal(notice.closest('details'), null);
    assert.equal(notice.textContent, error.slice(0, 500));
    assert.equal(notice.textContent.length, 500);
    assert.equal(view.element.querySelector('img, script, strong, .activity-final'), null);
    assert.doesNotMatch(view.element.textContent!, /FINAL_SENTINEL/);
    assert.equal(host.querySelectorAll('.msg-content').length, 1);
    assert.equal(host.querySelector('.msg-content'), answer);
    assert.equal(answer.textContent, 'Canonical answer');
});

test('A02: stopped, successful and absent errors hide the notice; stopped override clears a prior error', () => {
    for (const status of ['stopped', 'done', 'error'] as const) {
        const { model, view } = mount();
        send(model, { kind: 'turn-end', status, finalText: null, ...(status === 'error' ? {} : { error: 'Not a failure' }) });
        view.render(model);
        const notice = view.element.querySelector<HTMLElement>('.activity-error')!;
        assert.equal(notice.hidden, true);
        assert.equal(notice.textContent, '');
    }
    const { model, view } = mount();
    send(model, { kind: 'turn-end', status: 'error', finalText: null, error: 'Failure summary' });
    view.render(model);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-error')!.hidden, false);
    assert.equal(view.element.querySelector('.activity-error')!.textContent, 'Failure summary');
    view.render(model, { status: 'stopped', degraded: true });
    assert.equal(view.element.querySelector<HTMLElement>('.activity-error')!.hidden, true);
    assert.equal(view.element.querySelector('.activity-error')!.textContent, '');
    assert.doesNotMatch(view.element.textContent!, /Failure summary/);
    assert.equal(view.element.querySelector('.activity-status')!.textContent, 'Stopped');
});

test('A03: page clicks focus the enabled clicked button or the opposite button at either boundary', t => {
    const { model, view, group } = mount();
    for (let i = 0; i < 81; i++) tool(model, `tool-${i}`);
    view.render(model);
    group.open = true;
    const previous = button(view.element, 'Earlier activity'), next = button(view.element, 'Later activity');
    const focusPrevious = t.mock.method(previous, 'focus'), focusNext = t.mock.method(next, 'focus');
    // No pre-focus: pointer clicks need the production focus handoff too.
    previous.click();
    assert.equal(previous.disabled, false);
    assert.equal(document.activeElement, previous);
    assert.deepEqual(focusPrevious.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    previous.click();
    assert.equal(previous.disabled, true);
    assert.equal(document.activeElement, next);
    assert.deepEqual(focusNext.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    next.click();
    assert.equal(next.disabled, false);
    assert.equal(document.activeElement, next);
    assert.deepEqual(focusNext.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    next.click();
    assert.equal(next.disabled, true);
    assert.equal(document.activeElement, previous);
    assert.deepEqual(focusPrevious.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
});

test('A04: page click focuses summary when updated entries leave no enabled page control', t => {
    const { model, view, group } = mount();
    for (let i = 0; i < 41; i++) tool(model, `tool-${i}`);
    view.render(model);
    group.open = true;
    const previous = button(view.element, 'Earlier activity'), next = button(view.element, 'Later activity');
    const summary = group.querySelector('summary')!;
    previous.focus();
    model.entries.clear();
    const focusSummary = t.mock.method(summary, 'focus');
    previous.click();
    assert.equal(previous.disabled, true);
    assert.equal(next.disabled, true);
    assert.equal(document.activeElement, summary);
    assert.deepEqual(focusSummary.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
});

test('A05: focused tool eviction restores summary focus and retains explicit disclosure choices', t => {
    const { model, view, group, choices } = mount();
    tool(model, 'tool-0'); view.render(model);
    group.open = true;
    const row = rows(view.element)[0], summary = group.querySelector('summary')!;
    row.open = true;
    row.querySelector('summary')!.focus();
    const focusSummary = t.mock.method(summary, 'focus');
    for (let i = 1; i <= 130; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(model.entries.has('tool-0'), false);
    assert.equal(row.isConnected, false);
    assert.equal(document.activeElement, summary);
    assert.deepEqual(focusSummary.mock.calls.at(-1)!.arguments, [{ preventScroll: true }]);
    assert.equal(group.open, true);
    assert.equal(choices.items.get('tool-0'), true);
});

test('A06: external page selection removes the focused last-page row and focuses summary', () => {
    const { model, view, group, choices } = mount();
    for (let i = 0; i < 81; i++) tool(model, `tool-${i}`);
    view.render(model); group.open = true;
    const row = rows(view.element)[0];
    assert.equal(row.dataset.activityItemId, 'tool-80');
    row.querySelector('summary')!.focus();
    choices.page = 0; view.render(model);
    assert.equal(row.isConnected, false);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-0');
    assert.equal(document.activeElement, group.querySelector('summary'));
});

test('A07: streaming, eviction and error preserve external focus and unchanged status text node', t => {
    const { model, view, group } = mount();
    tool(model, 'tool-0', 'old'); view.render(model);
    const external = document.createElement('button');
    external.textContent = 'Outside Activity'; document.body.append(external);
    const status = view.element.querySelector('.activity-status')!, statusText = status.firstChild;
    assert.ok(statusText);
    const focusSummary = t.mock.method(group.querySelector('summary')!, 'focus');
    external.focus();
    tool(model, 'tool-0', 'new'); view.render(model);
    assert.equal(status.firstChild, statusText);
    assert.equal(document.activeElement, external);
    for (let i = 1; i <= 130; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(model.entries.has('tool-0'), false);
    assert.equal(status.firstChild, statusText);
    assert.equal(document.activeElement, external);
    assert.equal(focusSummary.mock.callCount(), 0);
    send(model, { kind: 'turn-end', status: 'error', error: 'Read failed', finalText: null });
    view.render(model);
    assert.equal(document.activeElement, external);
    assert.equal(focusSummary.mock.callCount(), 0);
});

test('explicit close and open choices persist across paging and DOM recycling', async () => {
    const { model, choices, host, view, group } = mount();
    for (let i = 0; i < 41; i++) tool(model, `tool-${i}`);
    view.render(model);
    await toggle(group, true);
    await toggle(rows(view.element)[0], true);
    button(view.element, 'Earlier activity').click();
    button(view.element, 'Later activity').click();
    assert.equal(rows(view.element)[0].open, true);
    await toggle(rows(view.element)[0], false);
    await toggle(group, false);
    view.dispose();
    const recycled = createActivityView(host, choices);
    recycled.render(model);
    assert.equal(recycled.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!.open, false);
    assert.equal(rows(recycled.element)[0].open, false);
    assert.equal(choices.items.has('tool-40'), false);
    await toggle(recycled.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!, true);
    await toggle(rows(recycled.element)[0], true);
    recycled.dispose();
    const restored = createActivityView(host, choices);
    restored.render(model);
    assert.equal(rows(restored.element)[0].open, true);
    assert.equal(restored.element.querySelector<HTMLDetailsElement>('.activity-disclosure')!.open, true);
});

test('40/41/81 entry pages follow latest until selected and clamp when entries shrink', () => {
    const { model, choices, view } = mount();
    for (let i = 0; i < 40; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(rows(view.element).length, 40);
    assert.equal(view.element.querySelector<HTMLElement>('nav')!.hidden, true);
    tool(model, 'tool-40');
    view.render(model);
    assert.equal(rows(view.element).length, 1);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-40');
    assert.equal(choices.page, null);
    for (let i = 41; i < 81; i++) tool(model, `tool-${i}`);
    view.render(model);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-80');
    button(view.element, 'Earlier activity').click();
    assert.equal(rows(view.element).length, 40);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-40');
    button(view.element, 'Earlier activity').click();
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-0');
    assert.equal(button(view.element, 'Earlier activity').disabled, true);
    choices.page = 999;
    view.render(model);
    assert.equal(rows(view.element)[0].dataset.activityItemId, 'tool-80');
    assert.equal(button(view.element, 'Later activity').disabled, true);
    model.entries.clear();
    view.render(model);
    assert.equal(rows(view.element).length, 0);
    assert.equal(button(view.element, 'Earlier activity').disabled, true);
});

test('pending native toggles survive immediate recycle and preview eviction does not discard choices', () => {
    const { model, choices, host, view, group } = mount();
    tool(model, 'remembered');
    view.render(model);
    group.open = true;
    rows(view.element)[0].open = true;
    // Recycle before the queued toggle event runs.
    view.dispose();
    assert.equal(choices.open, true);
    assert.equal(choices.items.get('remembered'), true);
    const recycled = createActivityView(host, choices);
    for (let i = 0; i < 130; i++) tool(model, `later-${i}`);
    recycled.render(model);
    assert.equal(model.entries.has('remembered'), false);
    assert.equal(choices.items.get('remembered'), true);
    assert.ok(rows(recycled.element).length <= 40);
    tool(model, 'remembered', 'returned snapshot');
    choices.page = null;
    recycled.render(model);
    const returned = rows(recycled.element).find(row => row.dataset.activityItemId === 'remembered')!;
    assert.equal(returned.open, true);
    assert.equal(returned.querySelector('pre')!.textContent, 'returned snapshot');
});

test('retention-omission notice lives in the disclosure body and survives a collapsed group', () => {
    const { model, view, group } = mount();
    tool(model, 'long', '가'.repeat(5000));
    assert.ok(model.omitted.textChars > 0);
    view.render(model);
    assert.equal(group.open, false);
    const notice = view.element.querySelector<HTMLElement>('.activity-omitted')!;
    assert.equal(notice.hidden, false);
    assert.equal(notice.closest('details'), group);
    assert.match(notice.textContent!, /omitted/);
});

test('fully retained text is shown without the omission notice', () => {
    const { model, view } = mount();
    tool(model, 'long', '가'.repeat(3500));
    assert.equal(model.omitted.textChars, 0);
    view.render(model);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-omitted')!.hidden, true);
    assert.equal(rows(view.element)[0].querySelector('pre')!.textContent, '가'.repeat(3500));
});

test('choice saturation preserves all 128 prior choices, refuses new opens and recovers after closing', async () => {
    const { model, choices, view } = mount();
    for (let i = 0; i < 128; i++) assert.equal(rememberActivityChoice(choices, `old-${i}`, true), true);
    assert.equal(rememberActivityChoice(choices, 'new', true), false);
    tool(model, 'new');
    view.render(model);
    const row = rows(view.element)[0];
    await toggle(row, true);
    assert.equal(row.open, false);
    assert.equal(choices.items.size, 128);
    view.render(model);
    assert.match(view.element.querySelector('.activity-choice-notice')!.textContent!, /128/);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-choice-notice')!.hidden, false);
    assert.equal(rememberActivityChoice(choices, 'old-0', false), true);
    await toggle(row, true);
    assert.equal(row.open, true);
    assert.equal(choices.items.size, 128);
    assert.equal(choices.items.get('new'), true);
});

test('status distinguishes terminal outcomes without rewriting unfinished tools; degraded survives pagination', () => {
    const classified=classifyExitError('codex-app',1,'connection lost\n    at RAW_STACK_SENTINEL (private.ts:1)');
    assert.match(classified.detail,/RAW_STACK_SENTINEL/);
    for (const [status, label] of [['done', 'Complete'], ['stopped', 'Stopped'], ['error', 'Failed']] as const) {
        const { model, view } = mount();
        tool(model, 'unfinished', '결과', 'running');
        send(model, { kind: 'turn-end', status, finalText: null, error: classified.message });
        view.render(model);
        assert.match(view.element.querySelector('.activity-status')!.textContent!, new RegExp(`^${label}`));
        assert.match(rows(view.element)[0].querySelector('summary')!.textContent!, /running/);
        assert.doesNotMatch(view.element.textContent!, /RAW_STACK_SENTINEL/);
        if(status==='error')assert.equal(view.element.querySelector('.activity-error')?.textContent,classified.message);
    }
    const { model, view } = mount();
    for (let i = 0; i < 41; i++) tool(model, `tool-${i}`);
    view.render(model, { status: 'stopped', degraded: true });
    button(view.element, 'Earlier activity').click();
    assert.match(view.element.querySelector('.activity-status')!.textContent!, /^Stopped/);
    assert.equal(view.element.querySelector<HTMLElement>('.activity-degraded')!.hidden, false);
    assert.match(view.element.querySelector('.activity-degraded')!.textContent!, /incomplete/i);
    assert.equal(model.end, null);
    view.render(model, {});
    assert.equal(view.element.querySelector('.activity-status')!.textContent, 'Working');
    assert.equal(view.element.querySelector<HTMLElement>('.activity-degraded')!.hidden, true);
});

test('notices and Trace belong to the disclosure body; answer remains independent', () => {
    const inspected: ActivityState[] = [];
    const { model, view, group } = mount(state => inspected.push(state));
    tool(model, 'long', '가'.repeat(4000));
    model.omitted.entries = 1;
    send(model, { kind: 'request', requestId: 'approval', requestType: 'approval', view: { title: 'Approve', fields: [] } });
    view.render(model);
    assert.equal(group.open, false);
    const omitted = view.element.querySelector<HTMLElement>('.activity-omitted')!;
    assert.equal(omitted.hidden, false);
    assert.equal(omitted.closest('details'), group);
    assert.match(omitted.textContent!, /omitted/i);
    assert.match(view.element.textContent!, /live Requests/);
    assert.equal(rows(view.element)[0].querySelector('pre')!.textContent, '가'.repeat(4000));
    const trace = button(view.element, 'Open in Trace');
    assert.equal(trace.closest('summary'), null);
    assert.equal(trace.closest('details'), group);
    assert.equal(trace.parentElement, group.querySelector('.activity-footer'));
    group.open = true;
    assert.equal(view.element.querySelector('input, select, textarea'), null);
    trace.click();
    assert.deepEqual(inspected, [model]);
    view.dispose();
    trace.click();
    view.render(model);
    assert.equal(inspected.length, 1);
    assert.equal(view.element.isConnected, false);
});

test('CSS mode switch hides only semantic legacy previews and live answer, and is reversible', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../../public/css/activity.css', import.meta.url), 'utf8');
    document.head.append(style);
    const { message, host, answer, model, view } = mount();
    const unrelated = mount();
    message.dataset.activityKey = 'key';
    message.dataset.activityLive = 'true';
    view.render(model);
    const process = host.querySelector<HTMLElement>('.process-block')!;
    assert.equal(getComputedStyle(process).display, 'none');
    assert.equal(getComputedStyle(answer).display, 'none');
    assert.notEqual(getComputedStyle(unrelated.answer).display, 'none');
    message.dataset.activityLive = 'false';
    assert.notEqual(getComputedStyle(answer).display, 'none');
    document.documentElement.dataset.presentationMode = 'legacy';
    assert.equal(getComputedStyle(view.element).display, 'none');
    assert.notEqual(getComputedStyle(process).display, 'none');
    document.documentElement.dataset.presentationMode = 'activity';
    assert.notEqual(getComputedStyle(view.element).display, 'none');
    assert.equal(getComputedStyle(process).display, 'none');
});

test('empty stopped/error turns never claim partial output was retained', () => {
    for (const [status, label] of [['stopped', 'Stopped'], ['error', 'Failed']] as const) {
        const { model, view } = mount();
        send(model, { kind: 'turn-end', status, finalText: null });
        view.render(model);
        assert.equal(view.element.querySelector('.activity-status')!.textContent, label);
        assert.equal(rows(view.element).length, 0);
        assert.equal(view.element.querySelector('.activity-final'), null);
    }
});

test('running auto-open is not an explicit choice; manual close survives replace and recycle', async () => {
    const { model, view, choices, host } = mount();
    tool(model, 'a', 'first', 'running'); view.render(model);
    const row = rows(view.element)[0]!; assert.equal(row.open, true); assert.equal(choices.items.size, 0); assert.equal(choices.page, null);
    await toggle(row, false); assert.equal(choices.items.get('a'), false);
    tool(model, 'a', 'next', 'running'); view.render(model);
    assert.equal(rows(view.element)[0], row); assert.equal(row.open, false);
    view.dispose(); const restored = createActivityView(host, choices); restored.render(model);
    assert.equal(rows(restored.element)[0]!.open, false); restored.dispose();
});
test('unselected running closes on done; explicit open stays and pins its page', async () => {
    const { model, view, choices } = mount();
    tool(model, 'a', '', 'running'); view.render(model);
    tool(model, 'a', 'done', 'done'); view.render(model);
    assert.equal(rows(view.element)[0]!.open, false); assert.equal(choices.page, null);
    await toggle(rows(view.element)[0]!, true);
    tool(model, 'b'); view.render(model); assert.equal(rows(view.element)[0]!.open, true); assert.equal(choices.items.get('a'), true); assert.equal(choices.page, 0);
});
test('standalone grows into a keyed group without losing summary focus; group toggles independently', () => {
    const { model, view, group } = mount(); tool(model, 'a'); view.render(model); group.open = true;
    const row = rows(view.element)[0]!, head = row.querySelector('summary')!; head.focus();
    tool(model, 'b'); view.render(model);
    assert.equal(rows(view.element)[0], row); assert.equal(document.activeElement, head);
    const button = view.element.querySelector<HTMLButtonElement>('.activity-group-summary')!;
    assert.equal(button.querySelector('.activity-row-label')!.textContent, 'Read 2 files');
    button.click(); assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(view.element.querySelector<HTMLElement>('.activity-group-body')!.hidden, true);
    tool(model, 'b', 'updated'); view.render(model); assert.equal(button.getAttribute('aria-expanded'), 'false');
    button.click(); model.entries.delete('b'); view.render(model); assert.equal(rows(view.element)[0], row); assert.equal(view.element.querySelector('.activity-group'), null);
});
test('R-05 renders Read, Edited and Worked on and updates the same group after name changes', () => {
    const { model, view } = mount();
    const label = () => view.element.querySelector('.activity-group-summary .activity-row-label')!.textContent;
    const put = (itemId: string, name: string) => send(model, { kind: 'tool', itemId, name, status: 'done' });
    put('a', 'cat'); view.render(model);
    const first = rows(view.element)[0]!;
    assert.equal(first.querySelector('.activity-row-label')!.textContent, 'Read cat');
    put('b', 'view'); view.render(model);
    const group = view.element.querySelector('.activity-group');
    assert.equal(label(), 'Read 2 files');
    put('b', 'patch'); view.render(model);
    assert.equal(label(), 'Worked on 2 files');
    assert.equal(rows(view.element)[1]!.querySelector('.activity-row-label')!.textContent, 'Edited patch');
    put('a', 'apply_patch'); view.render(model);
    assert.equal(label(), 'Edited 2 files');
    assert.equal(rows(view.element)[0], first);
    assert.equal(view.element.querySelector('.activity-group'), group);
    model.entries.delete('b'); view.render(model);
    assert.equal(view.element.querySelector('.activity-group'), null);
    assert.equal(first.querySelector('.activity-row-label')!.textContent, 'Edited apply_patch');
    view.dispose();
});
test('reasoning/message split groups, use icons and retain literal bounded preview', () => {
    const { model, view } = mount(); tool(model, 'a'); tool(model, 'b');
    send(model, { kind: 'reasoning', itemId: 'r', text: 'Plan', operation: 'replace' }); tool(model, 'c');
    send(model, { kind: 'message', itemId: 'm', text: '<script>literal</script>', phase: 'commentary', operation: 'replace' });
    tool(model, 'd', 'x'.repeat(3500)); view.render(model);
    assert.equal(view.element.querySelectorAll('.activity-group').length, 1);
    assert.equal(view.element.querySelectorAll('.activity-row-reasoning').length, 1); assert.equal(view.element.querySelectorAll('.activity-row-message').length, 1);
    assert.equal(view.element.querySelector('script'), null); assert.equal(view.element.querySelectorAll('.activity-row-icon svg').length, 7);
    const pre = rows(view.element).at(-1)!.querySelector('pre')!;
    assert.equal(pre.textContent, 'x'.repeat(3500));
    assert.equal(pre.tabIndex, 0); assert.equal(view.element.querySelector<HTMLElement>('.activity-omitted')!.hidden, true);
});

// The turn carries no leading margin so its summary row lines up with the 24px avatar.
// jsdom does not lay out, so this pins the declaration and the DOM position that make the
// alignment hold; the measured pixel proof lives in the browser suite.
test('the activity turn carries no leading margin and leads the visible body content', () => {
    const css = readFileSync(new URL('../../public/css/activity.css', import.meta.url), 'utf8');
    const { host, model, view, message } = mount();
    message.dataset.activityKey = 'key';
    tool(model, 'a');
    view.render(model);

    const turn = view.element;
    // jsdom does not parse the margin-block logical shorthand, so computed style cannot tell
    // the two forms apart. Assert the declaration itself; the pixel proof is in the browser suite.
    const rule = /^\.activity-turn \{([^}]*)\}/m.exec(css.slice(css.indexOf('\n.activity-turn {') + 1));
    assert.ok(rule, 'the .activity-turn rule must exist');
    const declared = /margin-block:\s*([^;]+);/.exec(rule[1]!);
    assert.ok(declared, '.activity-turn must declare margin-block');
    const [blockStart, blockEnd] = declared[1]!.trim().split(/\s+/);
    assert.equal(blockStart, '0',
        'a leading margin offsets the summary row from the agent avatar');
    assert.ok(blockEnd && blockEnd !== '0',
        'the trailing margin still separates the turn from the answer');

    // Removing the leading margin is only safe if everything that CAN precede the turn either
    // generates no box or owns its bottom margin. Walking this fixture's children is not
    // enough: ws.ts prepends .activity-unavailable into .agent-body, it never appears in this
    // mount(), and it originally had no CSS rule at all — so a fixture-scoped walk passed
    // while a real 8px gap closed. Probe the classes the product can actually put above the
    // turn.
    // jsdom does not parse margin-block, so read the declarations rather than computed style.
    // Read every stylesheet that can style these classes: .process-block lives in tool-ui.css,
    // not activity.css, so scanning one file would report a false failure.
    const allCss = ['activity.css', 'tool-ui.css'].map(name =>
        readFileSync(new URL(`../../public/css/${name}`, import.meta.url), 'utf8')).join('\n');
    const declaresBottomMargin = (selector: string) => {
        const rules = [...allCss.matchAll(/([^{}]+)\{([^}]*)\}/g)];
        return rules.some(([, selectors, body]) => {
            if (!selectors!.split(',').some(part => part.trim().split(/\s+/).pop() === selector)) return false;
            const shorthand = /margin-block:\s*([^;]+);/.exec(body!);
            if (shorthand) {
                const parts = shorthand[1]!.trim().split(/\s+/);
                return (parts[1] ?? parts[0]) !== '0';
            }
            const margin = /(?:^|;)\s*margin:\s*([^;]+);/.exec(body!);
            if (margin) {
                const parts = margin[1]!.trim().split(/\s+/);
                const bottom = parts.length >= 3 ? parts[2]! : parts[0]!;
                return bottom !== '0' && bottom !== '0px';
            }
            return /margin-block-end:\s*(?!0\s*;)/.test(body!)
                || /margin-bottom:\s*(?!0\s*;)/.test(body!);
        });
    };
    const hidesItself = (selector: string) =>
        new RegExp(String.raw`\${selector}\b[^{}]*\{[^}]*display:\s*none`).test(allCss);
    for (const className of ['activity-read-control', 'activity-unavailable', 'process-block']) {
        assert.ok(declaresBottomMargin('.' + className) || hidesItself('.' + className),
            `.${className} can render above the turn with neither a box nor a bottom margin, `
            + "so the turn's removed leading margin would close a real gap");
    }
    view.dispose();
});

test('T1: JSON tool input labels the decoded command, shows its description and a structured body', () => {
    const { model, view } = mount();
    const command = 'ssh clisu-oracle \'cat > ~/git/hooks/pre-receive <<EOF\n#!/bin/bash\nreject\nEOF\'';
    send(model, { kind: 'tool', itemId: 'ssh', name: 'bash', status: 'done',
        input: JSON.stringify({ command, description: 'Install raw-rejecting pre-receive hook on clisu' }),
        output: 'hook installed' });
    view.render(model);
    const row = rows(view.element)[0];
    const summary = row.querySelector('summary')!;
    assert.equal(summary.querySelector('.activity-row-label')!.textContent,
        `Ran ${'ssh clisu-oracle \'cat > ~/git/hooks/pre-receive <<EOF'}`);
    assert.doesNotMatch(summary.textContent!, /\{"command":/);
    const desc = summary.querySelector<HTMLElement>('.activity-row-desc')!;
    assert.equal(desc.hidden, false);
    assert.equal(desc.textContent, 'Install raw-rejecting pre-receive hook on clisu');
    const blocks = [...row.querySelectorAll<HTMLElement>('.activity-block')];
    assert.deepEqual(blocks.map(node => node.dataset['block']), ['input', 'output']);
    assert.equal(blocks[0].querySelector('.activity-block-label')!.textContent, 'Command');
    assert.equal(blocks[0].querySelector('pre')!.textContent, command);
    assert.equal(blocks[1].querySelector('.activity-block-label')!.textContent, 'Output');
    assert.equal(blocks[1].querySelector('pre')!.textContent, 'hook installed');
    assert.ok(blocks[0].querySelector<HTMLButtonElement>('.activity-block-copy'));
    assert.equal(row.querySelector('.activity-waiting'), null);
});

test('T2: non-command JSON input renders as pretty-printed Input, unrecognised objects label the tool name', () => {
    const { model, view } = mount();
    send(model, { kind: 'tool', itemId: 'mcp', name: 'svc__lookup', status: 'done',
        input: '{"region":"us","limit":3}', output: 'ok' });
    send(model, { kind: 'tool', itemId: 'grep', name: 'grep', status: 'done',
        input: '{"pattern":"needle"}', output: 'hit' });
    view.render(model);
    const [mcp, grep] = rows(view.element);
    assert.equal(mcp.querySelector('.activity-block-label')!.textContent, 'Input');
    assert.equal(mcp.querySelector('.activity-block pre')!.textContent, '{\n  "region": "us",\n  "limit": 3\n}');
    assert.equal(mcp.querySelector('.activity-row-label')!.textContent, 'Called svc__lookup');
    assert.equal(grep.querySelector('.activity-row-label')!.textContent, 'Searched needle');
});

test('T3: a running row without output shows a waiting line, not an empty block', () => {
    const { model, view } = mount();
    send(model, { kind: 'tool', itemId: 'run', name: 'bash', status: 'running',
        input: '{"command":"npm test"}' });
    view.render(model);
    const row = rows(view.element)[0];
    assert.equal(row.querySelector('.activity-waiting')!.textContent, 'Waiting for output…');
    assert.equal(row.querySelectorAll('.activity-block').length, 1);
    send(model, { kind: 'tool', itemId: 'run', name: 'bash', status: 'running',
        input: '{"command":"npm test"}', output: 'partial line' });
    view.render(model);
    assert.equal(row.querySelector('.activity-waiting'), null);
    assert.equal(row.querySelectorAll('.activity-block').length, 2);
});

test('T4: tall content offers Show all which lifts the cap and toggles back', () => {
    const { model, view } = mount();
    const tall = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    send(model, { kind: 'tool', itemId: 'tall', name: 'bash', status: 'done',
        input: '{"command":"seq 40"}', output: tall });
    view.render(model);
    const row = rows(view.element)[0];
    const body = row.querySelector<HTMLElement>('.activity-item-body')!;
    const toggle = row.querySelector<HTMLButtonElement>('.activity-block-toggle')!;
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.textContent, 'Show all');
    toggle.click();
    assert.equal(body.dataset['expanded'], 'true');
    assert.equal(toggle.textContent, 'Show less');
    toggle.click();
    assert.equal(body.dataset['expanded'], 'false');
    assert.equal(toggle.textContent, 'Show all');
    view.render(model);
    assert.equal(row.querySelector<HTMLButtonElement>('.activity-block-toggle')!.hidden, false);
});
