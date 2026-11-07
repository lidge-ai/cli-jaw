import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CodeItem, CodeItemKind, CodeProviderId } from '../../../../src/code-mode/wire';
import { useCodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';
import { useCodeTranscriptScroll } from './use-code-transcript-scroll';
import { useThrottledMarkdown } from './use-throttled-markdown';
import { CODE_RUNTIME_LABELS, codeItemStatus } from './code-types';
import { noteworthyStatus, shortenPath, toolInputDescription, toolInputDisplay, toolSummary } from './tool-summary';
import { readTranscriptView, writeTranscriptView } from './transcript-view-memory';
import { copyText } from '../clipboard/copy-text';
import { PENDING_USER_ITEM_ID } from './pending-user-item';

const MarkdownRenderer = lazy(() => import('../notes/rendering/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })));
export const CODE_ROLLBACK_CONFIRM = 'Later turns are removed from this conversation. Workspace files are not changed. No prompt is sent.';

/**
 * Turn boundaries are bookkeeping, not conversation. A one-line answer framed by
 * "Turn started" and "Completed" reads as a status board, and neither line tells
 * the reader anything the answer itself does not.
 *
 * They stay in the store and on the wire: history replay, the failed-input
 * recovery lookup in CodeWorkbench and the transcript-limit accounting all still
 * see them. Only this view drops them. Failure and cancellation are kept,
 * because those are states a reader can act on.
 */
const HIDDEN_KINDS: ReadonlySet<CodeItemKind> = new Set<CodeItemKind>(['turn_started', 'turn_completed']);

/**
 * What a collapsible row measures before it has been measured. Collapsed is one
 * line and exact. Expanded is a guess and deliberately only that: the panes are
 * capped at min(18rem,50dvh) each by `.code-tool-output` / `.code-tool-args`,
 * so a call with both is far taller, and the real number arrives from the
 * ResizeObserver a frame later. This only has to be closer than one line.
 */
const COLLAPSED_ROW_PX = 44;
const EXPANDED_ROW_PX = 480;

// Past ~15 wrapped lines the capped scroll height already engages; only then
// is a Show-all toggle worth showing (jsdom cannot measure overflow either, so
// this estimates by length the same way the activity rows do).
function isTallToolText(value: string): boolean {
    return value.length > 1400 || value.split('\n').length > 14;
}

/**
 * A failed call opens itself, because the reader has to see why it failed. That
 * is a default, not a lock: once the reader has said what they want for this
 * row, their choice wins, including closing a failure they have already read.
 */
function isRowOpen(chosen: ReadonlyMap<string, boolean>, sessionKey: string, item: CodeItem): boolean {
    const choice = chosen.get(`${sessionKey}:${item.itemId}`);
    if (choice !== undefined) return choice;
    return item.status === 'error' && item.kind !== 'reasoning';
}

function ItemMarkdown({ item, identity, onOpenLocalFile }: { item: CodeItem; identity: string; onOpenLocalFile?: ((path: string) => void) | undefined }) {
    const text = useThrottledMarkdown(item.text ?? '', item.status !== 'running' && item.status !== 'pending', identity);
    if (!text.trim()) return <span className="code-plain-text">{text}</span>;
    return <Suspense fallback={<span className="code-plain-text">{text}</span>}>
        <MarkdownRenderer markdown={text} tableMode="linear" onLocalFileOpen={onOpenLocalFile} />
    </Suspense>;
}

export function CodeTranscriptItem({ item, provider, sessionKey, workingDir = '', onOpenLocalFile, expanded, onExpandedChange, onRollback, choices, onChoiceChange, onLayoutChange }: {
    item: CodeItem; provider: CodeProviderId; sessionKey: string; workingDir?: string;
    onOpenLocalFile?: ((path: string) => void) | undefined;
    expanded?: boolean;
    onExpandedChange?: ((itemId: string, open: boolean) => void) | undefined;
    choices?: ReadonlyMap<string, boolean> | undefined;
    onChoiceChange?: ((key: string, open: boolean) => void) | undefined;
    onLayoutChange?: ((itemId: string) => void) | undefined;
    /** Present only on a row the conversation may be rolled back to; asks before calling. */
    onRollback?: ((itemId: string) => void) | undefined;
}) {
    const tool = item.kind === 'tool_call' || item.kind === 'file_change';
    const reasoning = item.kind === 'reasoning';
    const assistant = item.kind === 'assistant_message';
    const user = item.kind === 'user_message';
    const status = codeItemStatus(item);
    // A completed turn should read as prose, not as a status board: only
    // states the reader can act on are worth a visible badge.
    const note = noteworthyStatus(item);
    const unsent = item.itemId === PENDING_USER_ITEM_ID;
    // The transcript owns the disclosure, because the virtualizer unmounts rows
    // and per-row state would be lost on scroll. Rendered standalone (tests, a
    // future embed) it falls back to the same failure default.
    const open = expanded ?? (item.status === 'error' && item.kind !== 'reasoning');
    const running = item.status === 'running' || item.status === 'pending';
    // The verb already says the call is in flight; a second badge next to
    // "Reading src/app.ts" is the same fact twice. Keyed off the status rather
    // than the badge text, so renaming either vocabulary cannot quietly bring
    // the duplicate back. Failure and cancellation still get a word, because
    // those change what to do next.
    const toolNote = running ? null : note;
    const description = tool ? toolInputDescription(item.tool?.input) : '';
    const inputDisplay = tool ? toolInputDisplay(item.tool?.input) : null;
    const toolBlocks: Array<{ key: string; label: string; content: string; className: string; copyable: boolean }> = [];
    if (tool) {
        if (inputDisplay) toolBlocks.push({ key: 'input', label: 'Input', content: inputDisplay.content, className: 'code-tool-args', copyable: true });
        if (inputDisplay?.parameters) toolBlocks.push({ key: 'params', label: 'Parameters', content: inputDisplay.parameters, className: 'code-tool-json', copyable: false });
        if (inputDisplay?.description) toolBlocks.push({ key: 'description', label: 'Description', content: inputDisplay.description, className: 'code-tool-text', copyable: false });
        if (item.tool?.output !== undefined) toolBlocks.push({ key: 'output', label: 'Output', content: item.tool.output, className: 'code-tool-output', copyable: false });
    }
    const toolBodyTall = toolBlocks.some(block => isTallToolText(block.content))
        || (item.tool?.detail !== undefined && isTallToolText(item.tool.detail))
        || (item.text !== undefined && isTallToolText(item.text));
    const [showAll, setShowAll] = useState(false);
    const [localReviews, setLocalReviews] = useState<ReadonlyMap<string, boolean>>(new Map());
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [measuredTall, setMeasuredTall] = useState<boolean | null>(null);
    // A measurement describes the body it was taken from, and the estimate is
    // what moves when that body changes, so a number taken while the content was
    // taller is dropped instead of deciding for the shorter content in its place.
    useEffect(() => { setMeasuredTall(null); }, [toolBodyTall]);
    // The toggle measures real overflow once the body lays out (browser); where
    // layout cannot be measured (jsdom reports 0 everywhere) the character
    // estimate stands in, the same rule the activity rows use. Every capped pane
    // is measured, not only the <pre> ones: the call's own detail is a paragraph
    // under the same cap. While expanded the cap is off, so measuring is skipped
    // — the button must stay to toggle back — and closing the body resets the
    // measure for the next open.
    useEffect(() => {
        if (!open || showAll) return;
        const panes = bodyRef.current?.querySelectorAll('pre, .code-tool-body > .code-tool-text');
        if (!panes || panes.length === 0) { setMeasuredTall(null); return; }
        const list = [...panes];
        const measured = list.some(pane => pane.scrollHeight > pane.clientHeight + 2);
        setMeasuredTall(measured || (list.every(pane => pane.scrollHeight === 0) && toolBodyTall));
    }, [open, showAll, toolBodyTall]);
    const toolBodyOverflowing = measuredTall ?? toolBodyTall;
    // Content that no longer overflows has nothing left to disclose: leaving the
    // disclosure set would hold a "Show less" button, and an uncapped body, over
    // a call that already fits.
    useEffect(() => { if (!toolBodyOverflowing) setShowAll(false); }, [toolBodyOverflowing]);
    const [copied, setCopied] = useState(false);
    const copiedTimerRef = useRef<number | null>(null);
    useEffect(() => () => { if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current); }, []);
    const markCopied = useCallback(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => { copiedTimerRef.current = null; setCopied(false); }, 1200);
    }, []);
    const label = user ? 'You' : assistant ? CODE_RUNTIME_LABELS[provider] : reasoning ? 'Reasoning'
        : item.kind === 'turn_started' ? 'Turn started' : item.kind === 'session_runtime' ? 'Runtime'
            : item.kind === 'permission_request' ? 'Permission record' : item.kind === 'notice' ? 'Notice' : status;
    return <article className={`code-message code-message-${tool ? 'tool' : assistant ? 'assistant' : user ? 'user' : 'system'} is-${item.status}${unsent ? ' is-unsent' : ''}`}
        data-code-item-id={item.itemId} aria-label={`${label} · ${status}`}>
        {tool ? <details className={`code-tool-card code-tool-${item.status}`} open={open}
            onToggle={event => onExpandedChange?.(item.itemId, event.currentTarget.open)}>
            <summary className="code-tool-summary"><span className="code-tool-chevron" aria-hidden="true">›</span>
                <span className="code-tool-summary-text">
                    <span className={`code-tool-name${running ? ' code-tool-name-running' : ''}`}>{toolSummary(item, workingDir)}</span>
                    {description !== '' && <span className="code-tool-desc">{description}</span>}
                </span>
                {toolNote && <span className="code-tool-status">{toolNote}</span>}</summary>
            {/* Built only while open: a collapsed call's output can be megabytes,
                and constructing it costs the same whether or not it is painted. */}
            {open && <div ref={bodyRef} className="code-tool-body" data-expanded={showAll}>
                {item.kind === 'file_change' && item.fileChange && <div className="code-file-list">
                    {item.fileChange.schema === 'unknown' && <p>Unrecognized file change format</p>}
                    {item.fileChange.changes.map((change, index) => {
                        const key = `${item.itemId}#review:${index}`;
                        const reviewOpen = (choices ?? localReviews).get(key) ?? false;
                        return <section className="code-file-entry" key={index}>
                            <div><span className="code-file-kind">{change.kind}</span> {shortenPath(change.path, workingDir)}{change.movePath && ` → ${shortenPath(change.movePath, workingDir)}`}</div>
                            {change.patch === 'captured' ? <details className="code-file-review" open={reviewOpen} onToggle={event => {
                                const value = event.currentTarget.open;
                                if (value === reviewOpen) return;
                                if (onChoiceChange) onChoiceChange(key, value);
                                else setLocalReviews(previous => new Map(previous).set(key, value));
                                onLayoutChange?.(item.itemId);
                            }}><summary>Review patch</summary>{reviewOpen && <>{change.diff === '' && <span>Empty patch</span>}<pre className="code-file-diff">{change.diff ?? ''}</pre></>}</details>
                                : <p>Patch {change.patch === 'missing' ? 'unavailable' : change.patch}</p>}
                        </section>;
                    })}
                    {!!item.fileChange.omittedChanges && <p>{item.fileChange.omittedChanges} more files not shown</p>}
                </div>}
                {item.kind === 'file_change' && !item.fileChange && item.truncation?.reason.includes('file_change_limit') && <p>File change details unavailable</p>}
                {item.tool?.detail !== undefined && <p className="code-tool-text">{item.tool.detail}</p>}
                {toolBlocks.map(block => <section key={block.key} className="code-tool-section">
                    <div className="code-tool-section-head">
                        <span className="code-tool-section-label">{block.label}</span>
                        {block.copyable && <button type="button" className={`code-tool-copy${copied ? ' copied' : ''}`}
                            aria-label={`Copy ${block.label.toLowerCase()}`}
                            onClick={() => void copyText(block.content).then(result => { if (result.ok) markCopied(); })}>
                            {copied ? 'Copied' : 'Copy'}
                        </button>}
                    </div>
                    <pre className={block.className}>{block.content}</pre>
                </section>)}
                {item.text !== undefined && <pre className="code-tool-text">{item.text}</pre>}
                {running && item.tool?.output === undefined && item.tool?.detail === undefined
                    && <p className="code-tool-waiting">Waiting for output…</p>}
                {toolBodyOverflowing && <button type="button" className="code-tool-toggle" aria-expanded={showAll}
                    onClick={() => { setShowAll(value => !value); onLayoutChange?.(item.itemId); }}>{showAll ? 'Show less' : 'Show all'}</button>}
            </div>}
        </details> : reasoning ? <details className="code-thinking" open={open}
            onToggle={event => onExpandedChange?.(item.itemId, event.currentTarget.open)}>
            <summary className={`code-thinking-summary${item.status === 'running' ? ' code-tool-name-running' : ''}`}>{item.status === 'running' ? 'Thinking…' : 'Reasoning'}</summary>
            {open && <div className="code-thinking-text">{item.text}</div>}
        </details> : <>
            <span className="code-message-role">{label}{assistant && item.phase === 'commentary' ? ' · Commentary' : ''}
                {note && ` · ${unsent ? 'Sending' : note}`}
                {/* A follow-up no native result consumed before the turn ended. */}
                {user && !unsent && item.phase === 'unknown' && ' · Delivery not confirmed'}</span>
            <div className="code-message-text">{assistant ? <ItemMarkdown item={item} identity={`${sessionKey}:${item.itemId}`} onOpenLocalFile={onOpenLocalFile} />
                : <span className="code-plain-text">{item.text ?? item.permission?.title ?? ''}</span>}</div>
            {item.permission?.detail && <p className="code-plain-text">{item.permission.detail}</p>}
            {onRollback && user && !unsent && <button type="button" className="code-message-rollback"
                onClick={() => { if (window.confirm(CODE_ROLLBACK_CONFIRM)) onRollback(item.itemId); }}>Roll back conversation to here</button>}
        </>}
        {(assistant || reasoning) && (item.status === 'cancelled' || item.status === 'error') && <span className="code-partial-label">Partial output · {status}</span>}
        {item.truncation && <p className="code-truncation" role="note">Output truncated: {item.truncation.storedChars.toLocaleString()} of {item.truncation.sourceChars.toLocaleString()} characters retained.</p>}
    </article>;
}

export function CodeTranscript({ items, provider, sessionKey, workingDir, loading, hasOlderHistory, loadOlderHistory, permissionCount, onOpenLocalFile, working = false,
    rollbackRows, onRollback }: {
    items: CodeItem[]; provider: CodeProviderId; sessionKey: string; workingDir: string; loading: boolean; working?: boolean;
    hasOlderHistory: boolean; loadOlderHistory(): Promise<void>; permissionCount: number;
    onOpenLocalFile?: ((path: string) => void) | undefined;
    /** Opaque user row ids that may be rollback targets; the transcript never sees native ids. */
    rollbackRows?: ReadonlySet<string> | undefined;
    onRollback?: ((itemId: string) => void) | undefined;
}) {
    const transcriptRef = useRef<HTMLDivElement>(null);
    const visible = useMemo(() => items.filter(item => !HIDDEN_KINDS.has(item.kind)), [items]);
    const itemsRef = useRef(visible); itemsRef.current = visible;
    // What the reader chose, which is not the same as what is open: a failed
    // call opens itself, so "not in the map" and "the reader closed it" have to
    // be different states or the auto-open reopens it on the next render.
    // Scoped by session so the reserved pending-user id cannot carry one
    // session's disclosure into another, and bounded so a long-lived tab does
    // not accumulate ids for sessions it will never show again.
    const [openState, setOpenState] = useState(() => ({ key: sessionKey, rows: readTranscriptView(sessionKey).open }));
    let openRows = openState.rows;
    if (openState.key !== sessionKey) {
        openRows = readTranscriptView(sessionKey).open;
        setOpenState({ key: sessionKey, rows: openRows });
    }
    const [historyPending, setHistoryPending] = useState(false);
    const [historyError, setHistoryError] = useState<{ sessionKey: string; message: string } | null>(null);
    const historyGuard = useRef(false);
    const firstId = visible[0]?.itemId;
    // Disclosure changes geometry, not identity; remeasure the mounted row after commit.
    const getItemKey = useCallback((index: number) => {
        const item = itemsRef.current[index];
        if (!item) return `${sessionKey}:${index}`;
        return `${sessionKey}:${item.itemId}`;
    }, [sessionKey, firstId]);
    const estimateSize = useCallback((index: number) => {
        const item = itemsRef.current[index];
        const collapsible = item?.kind === 'tool_call' || item?.kind === 'file_change' || item?.kind === 'reasoning';
        // A collapsible row is one line until someone opens it. Estimating an
        // open row at one line is what makes the scrollbar disagree with the
        // content, so the estimate has to follow the disclosure.
        if (!collapsible) return 64 + Math.min(420, (item?.text?.length ?? 0) / 6);
        return item && isRowOpen(openRows, sessionKey, item) ? EXPANDED_ROW_PX : COLLAPSED_ROW_PX;
    }, [openRows, sessionKey]);
    const virtual = useCodeTranscriptVirtualRows({ count: visible.length, resetKey: sessionKey, scrollElementRef: transcriptRef, getItemKey, estimateSize });
    const { showJump, jumpToLatest } = useCodeTranscriptScroll({ items: visible, sessionKey, transcriptRef, virtual, hydrating: loading || !visible.length });
    const [layoutChanges, setLayoutChanges] = useState<{ key: string; ids: Set<string> }>({ key: sessionKey, ids: new Set() });
    const layoutChange = useCallback((itemId: string) => setLayoutChanges(current => ({ key: sessionKey, ids: new Set([...(current.key === sessionKey ? current.ids : []), itemId]) })), [sessionKey]);
    useLayoutEffect(() => {
        if (layoutChanges.key !== sessionKey || !layoutChanges.ids.size) return;
        for (const id of layoutChanges.ids) {
            const index = visible.findIndex(item => item.itemId === id);
            if (index >= 0) virtual.remeasure(index);
        }
        setLayoutChanges({ key: sessionKey, ids: new Set() });
    }, [layoutChanges, sessionKey, visible, virtual]);
    const setChoice = useCallback((key: string, open: boolean) => {
        const next = readTranscriptView(sessionKey).open;
        if (next.get(key) === open) return;
        next.delete(key); next.set(key, open);
        writeTranscriptView(sessionKey, { open: next });
        setOpenState(current => current.key === sessionKey ? { key: sessionKey, rows: readTranscriptView(sessionKey).open } : current);
    }, [sessionKey]);
    const setExpanded = useCallback((itemId: string, open: boolean) => {
        setChoice(`${sessionKey}:${itemId}`, open); layoutChange(itemId);
    }, [sessionKey, setChoice, layoutChange]);
    async function older() {
        if (historyGuard.current) return;
        historyGuard.current = true; setHistoryPending(true); setHistoryError(null);
        try { await loadOlderHistory(); }
        catch (err) { setHistoryError({ sessionKey, message: err instanceof Error ? err.message : String(err) }); }
        finally { historyGuard.current = false; setHistoryPending(false); }
    }
    function keyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
        const node = transcriptRef.current;
        if (!node) return;
        const page = Math.max(160, node.clientHeight * 0.78);
        if (['j', 'd', 'PageDown'].includes(event.key)) { event.preventDefault(); node.scrollBy({ top: page, behavior: 'auto' }); }
        else if (['k', 'u', 'PageUp'].includes(event.key)) { event.preventDefault(); node.scrollBy({ top: -page, behavior: 'auto' }); }
        else if (event.key === 'End') { event.preventDefault(); jumpToLatest(); }
        else if (event.key === 'Home') { event.preventDefault(); node.scrollTo({ top: 0, behavior: 'auto' }); }
    }
    return <>
        <div className="code-transcript-controls">
            {hasOlderHistory && <button type="button" disabled={historyPending || loading} onClick={() => void older()}>{historyPending ? 'Loading history…' : 'Load older history'}</button>}
            {showJump && <button type="button" onClick={jumpToLatest}>Jump to latest</button>}
            {permissionCount > 0 && <button type="button" onClick={() => document.getElementById('code-pending-permissions')?.focus()}>Jump to permissions ({permissionCount})</button>}
            {historyError?.sessionKey === sessionKey && <span className="code-action-error" role="alert">{historyError.message}</span>}
        </div>
        <div ref={transcriptRef} className="code-transcript" role="log" aria-label="Code transcript" aria-live="off" tabIndex={0} onKeyDown={keyboard}>
            {!visible.length ? <div className="code-transcript-empty"><p>{loading ? 'Loading conversation…' : 'Type a prompt below to start this conversation.'}</p>
                <p className="code-transcript-cwd">Workspace: {workingDir || 'not set'}</p></div>
                : <div className="code-transcript-virtual-spacer" style={{ height: virtual.totalSize }}>
                    {virtual.virtualItems.map(row => {
                        const item = visible[row.index];
                        return item ? <div key={row.key} ref={virtual.measureElement} className="code-transcript-virtual-row"
                            data-code-transcript-idx={row.index} style={{ transform: `translateY(${row.start}px)` }}>
                            <CodeTranscriptItem item={item} provider={provider} sessionKey={sessionKey}
                                workingDir={workingDir} onOpenLocalFile={onOpenLocalFile}
                                expanded={isRowOpen(openRows, sessionKey, item)}
                                onExpandedChange={setExpanded}
                                choices={openRows} onChoiceChange={setChoice} onLayoutChange={layoutChange}
                                onRollback={rollbackRows?.has(item.itemId) ? onRollback : undefined} />
                        </div> : null;
                    })}
                </div>}
            {/* From Send until the turn ends. A running tool or reasoning row already
                animates, so the line would only repeat it. */}
            {working && visible[visible.length - 1]?.status !== 'running'
                && <div className="code-transcript-working" role="status" aria-live="polite">
                    <span className="code-session-spinner" aria-hidden="true" />Working…</div>}
        </div>
    </>;
}
