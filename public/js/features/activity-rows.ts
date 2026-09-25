import { activityEntryLabel, type ActivityEntry } from '../../../src/shared/activity-state.js';
import { classifyActivityTool, isActivityFileEdit, type ActivityRenderGroup, type ActivityToolKind } from '../../../src/shared/activity-kind.js';
import { firstInputLine, parseToolInput, prettyToolInput, TOOL_DESCRIPTION_KEYS, TOOL_INPUT_KEYS } from '../../../src/shared/tool-input.js';
import { copyText } from './copy-text.js';
import { hydrateIcons, type IconName } from '../icons.js';
const glyphs: Record<ActivityToolKind, IconName> = { command: 'terminal', file: 'file', search: 'search', mcp: 'plug', other: 'tool' };
function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string) {
    const node = doc.createElement(tag); node.className = cls; return node; }
function text(node: Element, value: string) { if (node.textContent !== value) node.textContent = value; }
function glyph(node: HTMLElement, name: IconName) {
    if (node.dataset['icon'] === name) return;
    node.dataset['icon'] = name; node.setAttribute('aria-hidden', 'true');
    hydrateIcons(node.parentElement!); }

// Past ~15 wrapped lines the capped scroll height already engages; only then is
// a Show-all toggle worth showing (jsdom cannot measure overflow, so estimate).
function isTallContent(value: string): boolean {
    return value.length > 1400 || value.split('\n').length > 14;
}

/** One flash per copy button: a second click restarts it instead of being cut short. */
const copyFlash = new WeakMap<HTMLButtonElement, number>();

function flashCopied(btn: HTMLButtonElement, doc: Document): void {
    const icon = btn.querySelector<HTMLElement>('[data-icon]');
    if (!icon) return;
    const pending = copyFlash.get(btn);
    if (pending !== undefined) doc.defaultView?.clearTimeout(pending);
    icon.dataset['icon'] = 'checkSimple'; hydrateIcons(btn); btn.classList.add('copied');
    const timer = doc.defaultView?.setTimeout(() => { icon.dataset['icon'] = 'copy'; hydrateIcons(btn); btn.classList.remove('copied'); }, 800);
    if (timer !== undefined) copyFlash.set(btn, timer);
}

interface Block { key: string; label: string; content: string; copy: boolean }

/** Rebuild when the block set or a label changes; text stays live between rebuilds. */
function syncBody(body: HTMLElement, blocks: readonly Block[], waiting: boolean): void {
    // Labels follow the entry (the detail block becomes `Error` on failure), so they
    // belong in the signature: a key-only signature left `Detail` on a failed row.
    const signature = `${waiting ? 'wait|' : ''}${blocks.map(block => `${block.key}:${block.label}`).join('|')}`;
    if (body.dataset['sig'] !== signature) {
        body.dataset['sig'] = signature;
        for (const child of [...body.children]) child.remove();
        const doc = body.ownerDocument;
        for (const block of blocks) {
            const section = el(doc, 'section', 'activity-block');
            section.dataset['block'] = block.key;
            const head = el(doc, 'div', 'activity-block-head');
            const label = el(doc, 'span', 'activity-block-label');
            text(label, block.label);
            head.append(label);
            if (block.copy) {
                const copy = el(doc, 'button', 'activity-block-copy');
                copy.type = 'button';
                copy.setAttribute('aria-label', `Copy ${block.label.toLowerCase()}`);
                const icon = el(doc, 'span', 'activity-block-copy-icon');
                icon.dataset['icon'] = 'copy'; icon.setAttribute('aria-hidden', 'true');
                copy.append(icon);
                copy.onclick = () => {
                    const value = section.querySelector('pre')?.textContent;
                    if (value) void copyText(value).then(result => { if (result.ok) flashCopied(copy, doc); });
                };
                head.append(copy);
            }
            const pre = el(doc, 'pre', 'activity-item-text activity-block-text');
            pre.setAttribute('aria-label', block.label);
            section.append(head, pre);
            body.append(section);
        }
        if (waiting) {
            const line = el(doc, 'p', 'activity-waiting');
            text(line, 'Waiting for output…');
            body.append(line);
        }
        const toggle = el(doc, 'button', 'activity-block-toggle');
        toggle.type = 'button';
        toggle.onclick = () => {
            const next = body.dataset['expanded'] !== 'true';
            body.dataset['expanded'] = String(next);
            toggle.textContent = next ? 'Show less' : 'Show all';
            toggle.setAttribute('aria-expanded', String(next));
        };
        body.append(toggle);
        hydrateIcons(body);
    }
    const sections = body.querySelectorAll<HTMLElement>('.activity-block');
    const pres = blocks.map((_, index) => sections[index]!.querySelector('pre')!);
    blocks.forEach((block, index) => text(pres[index]!, block.content));
    // Measure real overflow when layout exists (browser); jsdom reports 0
    // everywhere and falls back to the character estimate.
    const unmeasured = pres.every(pre => pre.scrollHeight === 0);
    const overflowing = pres.map((pre, index) => unmeasured
        ? isTallContent(blocks[index]!.content)
        : pre.scrollHeight > pre.clientHeight + 2);
    // Only a block that actually scrolls belongs in the tab order.
    pres.forEach((pre, index) => {
        if (overflowing[index]) pre.tabIndex = 0;
        else pre.removeAttribute('tabindex');
    });
    // The reader's choice outranks the measurement: an expanded body has the cap
    // lifted, so it measures as short and would otherwise collapse itself on the
    // next render, taking the toggle away with it.
    const expanded = body.dataset['expanded'] === 'true';
    const tall = expanded || overflowing.some(Boolean);
    const toggle = body.querySelector<HTMLElement>('.activity-block-toggle')!;
    toggle.hidden = !tall;
    text(toggle, expanded ? 'Show less' : 'Show all');
    toggle.setAttribute('aria-expanded', String(expanded));
}

function toolBlocks(entry: Extract<ActivityEntry, { kind: 'tool' }>, kind: ActivityToolKind): Block[] {
    const blocks: Block[] = [];
    const parsed = parseToolInput(entry.input);
    if (parsed.value !== null || parsed.object || entry.input) {
        const command = parsed.field === 'command' || (!parsed.object && kind === 'command');
        blocks.push({
            key: 'input',
            label: command ? 'Command' : 'Input',
            content: parsed.field === 'command' && parsed.value !== null ? parsed.value
                : parsed.object ? prettyToolInput(entry.input ?? '') : parsed.value ?? entry.input ?? '',
            copy: true,
        });
        // A command envelope can carry more than the command (timeout, cwd…):
        // surface the remaining fields so nothing the call sent is hidden.
        if (parsed.object && parsed.field === 'command') {
            const hidden = new Set([...TOOL_INPUT_KEYS.command, ...TOOL_DESCRIPTION_KEYS]);
            const rest = Object.fromEntries(Object.entries(parsed.object).filter(([key]) => !hidden.has(key)));
            if (Object.keys(rest).length)
                blocks.push({ key: 'params', label: 'Parameters', content: JSON.stringify(rest, null, 2), copy: false });
        }
        if (parsed.description)
            blocks.push({ key: 'description', label: 'Description', content: parsed.description, copy: false });
    }
    if (entry.output) blocks.push({ key: 'output', label: 'Output', content: entry.output, copy: false });
    if (entry.detail) blocks.push({ key: 'detail', label: entry.status === 'error' ? 'Error' : 'Detail', content: entry.detail, copy: false });
    return blocks;
}

export function createActivityRow(doc: Document, id: string): HTMLDetailsElement {
    const row = el(doc, 'details', 'activity-item activity-row'); row.dataset['activityItemId'] = id;
    const head = el(doc, 'summary', 'activity-item-summary');
    const labelWrap = el(doc, 'span', 'activity-row-text');
    const desc = el(doc, 'span', 'activity-row-desc'); desc.hidden = true;
    labelWrap.append(el(doc, 'span', 'activity-row-label'), desc);
    head.append(el(doc, 'span', 'activity-row-icon'), labelWrap,
        el(doc, 'span', 'activity-row-status'), el(doc, 'span', 'activity-chevron-sm'));
    const body = el(doc, 'div', 'activity-item-body');
    row.append(head, body); glyph(head.lastElementChild as HTMLElement, 'chevronDown'); return row; }
export function updateActivityRow(row: HTMLDetailsElement, entry: ActivityEntry): void {
    const kind = entry.kind === 'tool' ? classifyActivityTool(entry.name) : entry.kind;
    row.className = `activity-item activity-row${entry.kind === 'tool' ? '' : ` activity-row-${entry.kind}`}`;
    row.dataset['kind'] = kind; row.dataset['status'] = entry.kind === 'tool' ? entry.status : '';
    const head = row.querySelector('summary')!;
    glyph(head.querySelector<HTMLElement>('.activity-row-icon')!, entry.kind === 'tool' ? glyphs[classifyActivityTool(entry.name)]
        : entry.kind === 'reasoning' ? 'brain' : 'thinking');
    const desc = head.querySelector<HTMLElement>('.activity-row-desc')!;
    let label = activityEntryLabel(entry), status = '', description = '';
    if (entry.kind === 'tool') {
        const edit = kind === 'file' && isActivityFileEdit(entry.name);
        const past = kind === 'command' ? 'Ran' : kind === 'file' ? edit ? 'Edited' : 'Read' : kind === 'search' ? 'Searched' : 'Called';
        const active = kind === 'command' ? 'Running' : kind === 'file' ? edit ? 'Editing' : 'Reading' : kind === 'search' ? 'Searching' : 'Calling';
        const verb = entry.status === 'done' ? past : entry.status === 'running' ? active : entry.status === 'error' ? 'Failed' : 'Stopped';
        const parsed = parseToolInput(entry.input);
        // Never label a row with a raw {"command": ...} object: decode the
        // recognised argument, else fall back to the tool's own name. Retention can
        // cut the input before any recognised field, and that prefix is still an
        // envelope, so the tool name is the honest label there too.
        const raw = entry.input?.trim() ?? '';
        const target = parsed.value !== null ? firstInputLine(parsed.value)
            : (parsed.object || raw.startsWith('{')) ? entry.name
            : firstInputLine(raw) || entry.name;
        description = parsed.description ? firstInputLine(parsed.description) : '';
        label = `${verb} ${target}`;
        status = entry.status === 'error' ? 'failed' : entry.status === 'done' ? '' : entry.status;
    }
    text(head.querySelector('.activity-row-label')!, label);
    text(desc, description); desc.hidden = !description;
    head.setAttribute('aria-label', description ? `${label} — ${description}` : label);
    const state = head.querySelector<HTMLElement>('.activity-row-status')!;
    text(state, status); state.setAttribute('aria-label', status === 'failed' ? 'Tool call failed' : status);
    const body = row.querySelector<HTMLElement>('.activity-item-body')!;
    if (entry.kind === 'tool') {
        syncBody(body, toolBlocks(entry, kind as ActivityToolKind),
            entry.status === 'running' && !entry.output && !entry.detail);
    } else {
        syncBody(body, entry.text ? [{ key: 'text', label: 'Activity preview', content: entry.text, copy: false }] : [], false);
    }
}
export function createActivityRows(doc: Document, list: HTMLElement) {
    const groups = new Map<string, { root: HTMLDivElement; head: HTMLButtonElement; body: HTMLDivElement }>();
    function place(parent: HTMLElement, node: HTMLElement, index: number) {
        if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    }
    return {
        render(units: readonly ActivityRenderGroup[], rowFor: (entry: ActivityEntry) => HTMLDetailsElement) {
            const wanted = new Set<string>();
            units.forEach((unit, index) => {
                if (unit.type === 'row') { place(list, rowFor(unit.entry), index); return; }
                wanted.add(unit.key); let group = groups.get(unit.key);
                if (!group) {
                    const root = el(doc, 'div', 'activity-group'), head = el(doc, 'button', 'activity-group-summary');
                    const body = el(doc, 'div', 'activity-group-body'); head.type = 'button';
                    head.setAttribute('aria-expanded', 'true');
                    head.append(el(doc, 'span', 'activity-row-icon'), el(doc, 'span', 'activity-row-label'), el(doc, 'span', 'activity-chevron-sm'));
                    body.tabIndex = 0; body.setAttribute('role', 'region'); body.setAttribute('aria-label', 'Tool calls');
                    root.append(head, body); root.dataset['kind'] = unit.kind;
                    glyph(head.firstElementChild as HTMLElement, glyphs[unit.kind]); glyph(head.lastElementChild as HTMLElement, 'chevronDown');
                    head.onclick = () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)); };
                    group = { root, head, body }; groups.set(unit.key, group);
                }
                const state = ['error', 'stopped', 'running'].find(s => unit.entries.some(entry => entry.status === s));
                const noun = unit.kind === 'command' ? 'commands' : unit.kind === 'file' ? 'files' : unit.kind === 'search' ? 'searches' : 'tools';
                text(group.head.querySelector('.activity-row-label')!, state ? `${unit.entries.length} ${noun} · ${state === 'error' ? 'failed' : state}` : unit.label);
                place(list, group.root, index);
                unit.entries.forEach((entry, i) => place(group!.body, rowFor(entry), i));
            });
            // Reparent surviving item nodes BEFORE removing obsolete wrappers.
            for (const [key, group] of groups) if (!wanted.has(key)) {
                group.head.onclick = null; group.root.remove(); groups.delete(key);
            }
        },
        dispose() { for (const group of groups.values()) group.head.onclick = null; groups.clear(); },
    };
}
