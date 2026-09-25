import { activityStatus, type ActivityState } from '../../../src/shared/activity-state.js';
import { groupActivityEntries } from '../../../src/shared/activity-kind.js';
import { createActivityRow, updateActivityRow, createActivityRows } from './activity-rows.js';
import type { RuntimeItemStatus } from '../../../src/shared/runtime-contract.js';
import { hydrateIcons } from '../icons.js';

export interface ActivityChoices {
    open: boolean;
    items: Map<string, boolean>;
    page: number | null;
}

const MAX_CHOICES = 128;
const PAGE_SIZE = 40;

export const createActivityChoices = (): ActivityChoices => ({ open: false, items: new Map(), page: null });

export function rememberActivityChoice(choices: ActivityChoices, id: string, open: boolean, running = false): boolean {
    // Closed is the default for finished items; a running item remembers an explicit close.
    // Saturation never evicts an existing explicit choice.
    if (!open && !running) { choices.items.delete(id); return true; }
    if (!choices.items.has(id) && choices.items.size >= MAX_CHOICES) return false;
    choices.items.set(id, open);
    return true;
}

export interface ActivityDisplayStatus {
    status?: RuntimeItemStatus | 'finished';
    degraded?: boolean;
    connectionUnavailable?: boolean;
    steered?: boolean;
}

export function createActivityView(
    host: HTMLElement,
    choices: ActivityChoices,
    inspectHistory?: (state: ActivityState) => void,
) {
    const doc = host.ownerDocument;
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
        const node = doc.createElement(tag);
        node.className = className;
        return node;
    }
    function button(label: string, className: string) {
        const node = element('button', className);
        node.type = 'button';
        node.textContent = label;
        return node;
    }
    function text(node: HTMLElement, value: string): void {
        if (node.textContent !== value) node.textContent = value;
    }

    const root = element('section', 'activity-turn');
    root.setAttribute('aria-label', 'Turn activity');
    const status = element('p', 'activity-status sr-only');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const disclosure = element('details', 'activity-disclosure');
    const summary = element('summary', 'activity-summary');
    const chevron = element('span', 'activity-chevron');
    chevron.dataset['icon'] = 'chevronRight'; chevron.setAttribute('aria-hidden', 'true');
    const statusLabel = element('span', 'activity-status-label');
    const summaryText = element('span', 'activity-summary-text');
    const steerPill = element('span', 'activity-steer-pill'); steerPill.hidden = true;
    const steerArrow = element('span', 'pending-steer-arrow');
    steerArrow.textContent = '↳'; steerArrow.setAttribute('aria-hidden', 'true');
    const steerLabel = element('span', 'pending-steer-label'); steerLabel.textContent = 'steered';
    steerPill.append(steerArrow, doc.createTextNode(' '), steerLabel);
    const accessory = element('span', 'activity-accessory');
    summary.append(chevron, statusLabel, summaryText, steerPill, accessory);
    hydrateIcons(summary);
    const list = element('div', 'activity-list');
    const empty = element('p', 'activity-empty');
    empty.textContent = 'No activity recorded';
    const nav = element('nav', 'activity-pages');
    nav.setAttribute('aria-label', 'Activity pages');
    const previous = button('Earlier activity', 'activity-previous');
    const next = button('Later activity', 'activity-next');
    const position = element('span', 'activity-page-position');
    nav.append(previous, position, next);
    disclosure.append(summary, empty, list, nav);
    const error = element('p', 'activity-error');
    const degraded = element('p', 'activity-degraded');
    const connection = element('p', 'activity-connection'); connection.hidden = true;
    const omitted = element('p', 'activity-omitted');
    const choiceNotice = element('p', 'activity-choice-notice');
    choiceNotice.setAttribute('role', 'status');
    const requests = element('p', 'activity-requests');
    for (const notice of [error, degraded, omitted, choiceNotice, requests]) notice.hidden = true;
    disclosure.append(degraded, connection, omitted, choiceNotice, requests);
    root.append(status, error, disclosure);
    const historyButton = inspectHistory ? button('Open in Trace', 'activity-trace') : null;
    if (historyButton) {
        historyButton.setAttribute('aria-label', 'Inspect retained activity in Trace');
        const footer = element('footer', 'activity-footer');
        footer.append(historyButton); disclosure.append(footer);
    }
    // The existing message and its copy/widget actions retain full answer ownership.
    host.insertBefore(root, host.querySelector(':scope > .msg-content'));

    let current: ActivityState | null = null;
    let display: ActivityDisplayStatus = {};
    let displayedPage = 0;
    let disposed = false;
    let choicesFull = false;
    const nodes = new Map<string, HTMLDetailsElement>();
    const rowLayout = createActivityRows(doc, list);
    const renderedOpen = new WeakMap<HTMLDetailsElement, boolean>();

    function updateChoiceNotice(): void {
        choiceNotice.hidden = !choicesFull;
        text(choiceNotice, choicesFull
            ? '128 detail choices are remembered. Close a completed open item to free a choice; existing choices are preserved.' : '');
    }
    function saveItem(id: string, node: HTMLDetailsElement): void {
        if (disposed || nodes.get(id) !== node || node.open === renderedOpen.get(node)) return;
        const running = node.dataset['status'] === 'running';
        if (!rememberActivityChoice(choices, id, node.open, running)) {
            node.open = renderedOpen.get(node) ?? false;
            choicesFull = true;
        } else {
            choicesFull = false;
            if (node.open && choices.page === null) choices.page = displayedPage;
        }
        renderedOpen.set(node, node.open); updateChoiceNotice();
    }
    function saveChoices(): void {
        // Native toggle is queued. Capture synchronous open changes before recycle/end.
        choices.open = disclosure.open;
        for (const [id, node] of nodes) saveItem(id, node);
    }

    disclosure.open = choices.open;
    disclosure.ontoggle = () => { if (!disposed) choices.open = disclosure.open; };
    if (historyButton) historyButton.onclick = () => { if (current && !disposed) inspectHistory?.(current); };
    function changePage(offset: number, clicked: HTMLButtonElement, opposite: HTMLButtonElement): void {
        if (!current || disposed) return;
        saveChoices();
        const last = Math.max(0, Math.ceil(current.entries.size / PAGE_SIZE) - 1);
        choices.page = Math.max(0, Math.min(last, displayedPage + offset));
        render(current, display);
        const target = nav.hidden || !disclosure.open ? summary
            : !clicked.disabled ? clicked : !opposite.disabled ? opposite : summary;
        target.focus({ preventScroll: true });
    }
    previous.onclick = () => changePage(-1, previous, next);
    next.onclick = () => changePage(1, next, previous);

    function render(model: ActivityState, displayStatus: ActivityDisplayStatus = {}): void {
        if (disposed) return;
        saveChoices();
        current = model;
        display = { ...displayStatus };
        const phase = display.status ?? activityStatus(model);
        root.dataset['status'] = phase;
        root.dataset['degraded'] = String(display.degraded === true);
        const label = phase === 'running' ? 'Working' : phase === 'finished' ? 'Finished' : phase === 'done' ? 'Complete'
            : phase === 'stopped' ? 'Stopped' : 'Failed';
        text(status, label);
        const errorSummary = phase === 'error' && model.end?.status === 'error' ? model.end.error ?? '' : '';
        text(error, errorSummary);
        error.hidden = !errorSummary;
        const count = `${model.entries.size} step${model.entries.size === 1 ? '' : 's'}`;
        text(statusLabel, label);
        text(summaryText, model.latestAction || count);
        text(accessory, String(model.entries.size));
        accessory.dataset['unit'] = model.entries.size === 1 ? ' step' : ' steps';
        accessory.hidden = !model.latestAction;
        summary.setAttribute('aria-label', `${label} · ${model.latestAction ? `${model.latestAction} · ` : ''}${count}${display.steered ? ' · steered' : ''}`);
        steerPill.hidden = display.steered !== true;
        text(degraded, display.degraded ? 'Activity is incomplete. Some runtime updates were not received.' : '');
        degraded.hidden = !display.degraded;
        text(connection, display.connectionUnavailable ? 'Live activity updates are unavailable. Retained activity can be refreshed separately.' : '');
        connection.hidden = !display.connectionUnavailable;
        const loss = model.omitted;
        const entries = [...model.entries.values()];
        // Rows render everything retention kept, so the notice fires only when
        // retention itself dropped something — never for display clipping.
        const limited = !!(loss.entries || loss.textChars || loss.requests || loss.finalChars);
        text(omitted, limited
            ? 'Preview is limited. Some activity, text or request notices are omitted.' : '');
        omitted.hidden = !limited;
        const hasRequests = !!(model.requests.size || loss.requests);
        text(requests, hasRequests ? 'Request notices recorded; see live Requests controls for current requests.' : '');
        requests.hidden = !hasRequests;

        const last = Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1);
        displayedPage = choices.page === null ? last : Math.max(0, Math.min(last, Math.floor(choices.page)));
        const visible = entries.slice(displayedPage * PAGE_SIZE, (displayedPage + 1) * PAGE_SIZE);
        const wanted = new Set(visible.map(entry => entry.itemId));
        const focused = doc.activeElement;
        const focusedInside = focused !== null && list.contains(focused);
        let focusedRowRemoved = false;
        for (const [id, node] of nodes) {
            if (!wanted.has(id)) {
                if (node.contains(focused)) focusedRowRemoved = true;
                node.ontoggle = null;
                node.remove();
                nodes.delete(id);
            }
        }
        rowLayout.render(groupActivityEntries(visible), entry => {
            let node = nodes.get(entry.itemId);
            if (!node) {
                node = createActivityRow(doc, entry.itemId);
                const itemNode = node;
                node.ontoggle = () => saveItem(entry.itemId, itemNode);
                nodes.set(entry.itemId, node);
            }
            updateActivityRow(node, entry);
            const open = choices.items.get(entry.itemId) ?? (entry.kind === 'tool' && entry.status === 'running');
            renderedOpen.set(node, open);
            if (node.open !== open) node.open = open;
            return node;
        });
        const hiddenGroup = focused?.closest<HTMLElement>('.activity-group-body[hidden]');
        if (focusedInside && hiddenGroup) {
            (hiddenGroup.previousElementSibling as HTMLButtonElement).focus({ preventScroll: true });
        } else if (focusedInside && focused?.isConnected && doc.activeElement !== focused) {
            (focused as HTMLElement).focus({ preventScroll: true });
        } else if (focusedInside && !focused?.isConnected) focusedRowRemoved = true;
        empty.hidden = entries.length !== 0;
        previous.disabled = displayedPage === 0;
        next.disabled = displayedPage >= last;
        text(position, entries.length ? `${displayedPage + 1} / ${last + 1}` : '0 / 0');
        nav.hidden = entries.length <= PAGE_SIZE;
        updateChoiceNotice();
        if (focusedRowRemoved) summary.focus({ preventScroll: true });
    }

    function dispose(): void {
        if (disposed) return;
        saveChoices();
        disposed = true;
        disclosure.ontoggle = null;
        previous.onclick = next.onclick = null;
        if (historyButton) historyButton.onclick = null;
        for (const node of nodes.values()) node.ontoggle = null;
        rowLayout.dispose();
        nodes.clear();
        current = null;
        root.remove();
    }
    return { element: root, render, dispose };
}
