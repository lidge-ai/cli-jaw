import { useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionInfo } from '../../../../src/code-mode/wire';
import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS, CODE_SESSION_LABELS, codeCanResume, codeSessionBusy } from './code-types';
import {
    CODE_ACTIVITY_BUCKET_LABELS, codeSessionAttention, codeSessionAttentionLabel, codeSessionUnread, codeWorkspaceName,
    groupCodeSessions, groupCodeSessionsByActivity, groupCodeSessionsByWorkspace,
} from './session-order';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, formatShortcut } from '../manager-shortcuts';

const NEW_SESSION_SHORTCUT = DEFAULT_MANAGER_SHORTCUT_KEYMAP.newCodeSession;

type CodeSidebarView = 'projects' | 'activity';
const SIDEBAR_VIEW_KEY = 'jaw.code.sidebarView';

function readSidebarView(): CodeSidebarView {
    try { return localStorage.getItem(SIDEBAR_VIEW_KEY) === 'activity' ? 'activity' : 'projects'; }
    catch { return 'projects'; }
}

function BellGlyph() {
    return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v2.3L3.3 10.6h9.4L11.5 8.3V6A3.5 3.5 0 0 0 8 2.5Z M6.6 12.4a1.5 1.5 0 0 0 2.8 0"
            fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>;
}

function SearchGlyph() {
    return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.2 10.2 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>;
}

function PlusGlyph() {
    return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>;
}

function SessionRow({ session: s, controller: c, view }: { session: CodeSessionInfo; controller: CodeControllerModel; view: CodeSidebarView }) {
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(s.title ?? '');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const guard = useRef(false);
    const selectButton = useRef<HTMLButtonElement>(null);
    const errorId = useId();
    const active = c.selectedId === s.sessionId;
    const busy = codeSessionBusy(s);
    const count = active && c.synced ? c.permissions.length : s.pendingPermissionCount;
    const attention = codeSessionAttention(count);
    const unread = !active && codeSessionUnread(s);
    async function action(run: () => Promise<void>, after?: () => void) {
        if (guard.current) return;
        guard.current = true; setPending(true); setError(null);
        try { await run(); after?.(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { guard.current = false; setPending(false); }
    }
    function finishRename() { setRenaming(false); selectButton.current?.focus(); }
    return <li className="code-session-row">
        <button ref={selectButton} type="button" className={`code-session-item${active ? ' active' : ''}`}
            aria-current={active ? 'true' : undefined} onClick={() => void action(() => c.selectSession(s.sessionId))}>
            <span className="code-session-cwd">
                {unread && <span className="code-session-unread-dot" role="img" aria-label="Unread" />}
                {s.title || 'Untitled session'}
            </span>
            {/* Projects view already names the workspace in the group heading. */}
            <span className="code-session-meta" title={s.cwd}>{view === 'activity'
                ? `${codeWorkspaceName(s.cwd)} · ${CODE_RUNTIME_LABELS[s.provider]}` : CODE_RUNTIME_LABELS[s.provider]}</span>
            {/* Ready is the common case and stays silent. A status on every row
                is a status on no row, and it costs the one session that is
                actually doing something its visibility. */}
            <span className={`code-session-status code-session-status-${s.status}`}
                data-quiet={s.status === 'idle' ? 'true' : undefined}>{CODE_SESSION_LABELS[s.status]}</span>
            <span className={`code-session-attention code-session-attention-${attention.kind}`}
                data-quiet={attention.kind === 'none' ? 'true' : undefined}>{codeSessionAttentionLabel(attention)}</span>
        </button>
        {renaming ? <form className="code-session-rename" onSubmit={event => {
            event.preventDefault(); if (title.trim()) void action(() => c.rename(s.sessionId, title.trim()), finishRename);
        }}>
            <input autoFocus aria-label="Session title" aria-describedby={error ? errorId : undefined} value={title} disabled={pending}
                onChange={event => setTitle(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Escape' && !pending) { event.preventDefault(); setTitle(s.title ?? ''); finishRename(); }
                }} />
            <button type="submit" disabled={pending || !title.trim()}>Save</button>
            <button type="button" disabled={pending} onClick={finishRename}>Cancel</button>
        </form> : <details className="code-session-actions" key={`${c.selectedId}:${s.sessionId}`}>
            <summary aria-label={`Actions for ${s.title || 'Untitled session'}`}>Actions</summary>
            <div>
                <button type="button" disabled={pending || busy} onClick={() => { setTitle(s.title ?? ''); setRenaming(true); }}>Rename</button>
                <button type="button" disabled={pending || busy} title={busy ? 'Stop before archiving' : undefined}
                    onClick={() => void action(() => c.archive(s.sessionId, s.archivedAt === null))}>{s.archivedAt === null ? 'Archive' : 'Restore'}</button>
                {codeCanResume(s) && <button type="button" disabled={pending || !active || !c.synced || c.pending}
                    title={!active ? 'Select this session to resume it' : 'Resume without resending a prompt'}
                    onClick={() => void action(c.resume)}>Resume</button>}
                {busy && <small>Stop before changing session metadata.</small>}
            </div>
        </details>}
        {pending && <span className="code-session-view-hint" role="status">Updating session…</span>}
        {error && <div id={errorId} className="code-session-list-error" role="alert">{error}</div>}
    </li>;
}

export function CodeSessionList({ controller: c, newSessionShortcut = NEW_SESSION_SHORTCUT }: { controller: CodeControllerModel; newSessionShortcut?: string | undefined }) {
    const [search, setSearch] = useState('');
    const [searching, setSearching] = useState(false);
    const searchInput = useRef<HTMLInputElement>(null);
    function toggleSearch() {
        // Closing clears the query so the list is never silently filtered by a hidden box.
        if (searching) { setSearching(false); setSearch(''); return; }
        setSearching(true);
        queueMicrotask(() => searchInput.current?.focus());
    }
    const draftBadgeId = useId();
    const [view, setViewState] = useState<CodeSidebarView>(readSidebarView);
    function setView(next: CodeSidebarView) {
        setViewState(next);
        try { localStorage.setItem(SIDEBAR_VIEW_KEY, next); } catch { /* storage unavailable: the choice lasts for this page */ }
    }
    const [error, setError] = useState<string | null>(null);
    const [paging, setPaging] = useState(false);
    const pagingRef = useRef(false);
    const visible = c.sessions.filter(s => `${s.title ?? ''} ${s.cwd} ${CODE_RUNTIME_LABELS[s.provider]}`.toLowerCase().includes(search.toLowerCase()));
    // Projects (the default) keeps rows in creation order under their workspace, so
    // answering a prompt never moves a row under the reader's cursor. Activity is the
    // reader's explicit choice: unread first, then last activity by day.
    const anyUnread = c.sessions.some(row => row.sessionId !== c.selectedId && codeSessionUnread(row));
    const live = visible.filter(row => row.archivedAt === null);
    const archived = visible.filter(row => row.archivedAt !== null);
    const groups: { key: string; title: string; cwd: string | null; sessions: CodeSessionInfo[] }[] = view === 'activity'
        ? groupCodeSessionsByActivity(live, Date.now(), c.selectedId).map(group => ({
            key: group.bucket, title: CODE_ACTIVITY_BUCKET_LABELS[group.bucket], cwd: null, sessions: group.sessions }))
        : groupCodeSessionsByWorkspace(live).map(group => ({ key: group.cwd, title: group.cwd, cwd: group.cwd, sessions: group.sessions }));
    if (archived.length) groups.push({ key: 'archived', title: 'Archived', cwd: null, sessions: groupCodeSessions(archived).flatMap(group => group.sessions) });
    // The chord resolves through the manager shortcut system (rebindable in
    // Settings); the runner re-broadcasts it here so Code mode can be absent
    // without the event reaching a dead handler.
    const newSession = c.newSession;
    useEffect(() => {
        function onShortcutAction(event: Event) {
            if ((event as CustomEvent<string>).detail === 'newCodeSession') newSession();
        }
        document.addEventListener('jaw:shortcut-action', onShortcutAction);
        return () => document.removeEventListener('jaw:shortcut-action', onShortcutAction);
    }, [newSession]);
    async function newInWorkspace(cwd: string) {
        c.newSession();
        // Silently retargeting a draft that holds unsent text or an unreconciled
        // send would move that content to another workspace; setSelection also
        // early-returns while the draft it is about to retarget is mid-operation.
        // Say why instead, each reason in its own words.
        if (c.hasUnsentDraft) {
            setError('Send or clear the current draft before choosing another workspace.');
            return;
        }
        // A busy *session* is not that case: newSession has already moved the
        // reader onto a fresh draft, so the + still retargets that draft.
        if (c.selectedId === null && c.pending) {
            setError('Wait for the current change to finish before choosing another workspace.');
            return;
        }
        setError(null);
        try { await c.setSelection({ cwd }); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }
    async function loadMore() {
        if (pagingRef.current) return;
        pagingRef.current = true; setPaging(true); setError(null);
        try { await c.loadMoreSessions(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { pagingRef.current = false; setPaging(false); }
    }
    return <nav className="code-session-list" aria-label="Code sessions">
        <button type="button" className={`code-session-new-primary${c.selectedId === null ? ' active' : ''}`}
            aria-current={c.selectedId === null ? 'true' : undefined}
            // The name is fixed so it survives the label, badge and chord
            // changes; the draft state therefore travels as a description.
            aria-label="New Code session"
            aria-describedby={c.hasUnsentDraft ? draftBadgeId : undefined}
            title={`Start a new session (${formatShortcut(newSessionShortcut)})`} onClick={c.newSession}>
            <PlusGlyph />
            <span className="code-session-new-label">New session</span>
            {c.hasUnsentDraft && <span id={draftBadgeId} className="code-session-draft-badge">Draft</span>}
            <kbd className="code-session-new-hint" aria-hidden="true">{formatShortcut(newSessionShortcut)}</kbd>
        </button>
        <div className="code-session-list-header">
            <span className="code-session-list-title">{view === 'activity' ? 'Recent activity' : 'Projects'}</span>
            <span className="code-session-header-actions">
            <button type="button" className={`code-session-header-btn code-session-search-btn${searching ? ' active' : ''}`}
                aria-pressed={searching} aria-label="Search sessions" title="Search sessions" onClick={toggleSearch}>
                <SearchGlyph />
            </button>
            <button type="button" className={`code-session-header-btn code-session-bell${view === 'activity' ? ' active' : ''}`}
                aria-pressed={view === 'activity'}
                aria-label={anyUnread ? 'Recent activity (unread sessions)' : 'Recent activity'}
                title={view === 'activity' ? 'Back to projects' : 'Recent activity'}
                onClick={() => setView(view === 'activity' ? 'projects' : 'activity')}>
                <BellGlyph />
                {anyUnread && <span className="code-session-unread-dot" aria-hidden="true" />}
            </button>
            </span>
        </div>
        {/* Projects already scopes by workspace, so the All / This cwd toggle is gone.
            Search and the archived switch live behind the search icon. */}
        {searching && <div className="code-session-search-row">
            <input ref={searchInput} className="code-session-search" type="search" aria-label="Search loaded sessions"
                placeholder="Search sessions…" value={search} onChange={event => setSearch(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); toggleSearch(); } }} />
            <button type="button" className={`code-session-archived-btn${c.filter.archived ? ' active' : ''}`}
                aria-pressed={c.filter.archived} title="Include archived sessions"
                onClick={() => c.setFilter({ ...c.filter, archived: !c.filter.archived })}>Archived</button>
        </div>}
        {c.loading && <div className="code-session-list-loading" role="status">Loading sessions…</div>}
        {groups.map(group => <section className="code-session-group" key={group.key}>
            {group.title && <h3 className={`code-session-group-title${group.key === 'priority' ? ' code-session-group-priority' : ''}`} title={group.title}>
                <span>{group.cwd !== null ? codeWorkspaceName(group.cwd) : group.title}</span>
                {group.cwd !== null && <button type="button" className="code-session-group-new"
                    aria-label={`New session in ${group.cwd}`} title={`New session in ${group.cwd}`}
                    onClick={() => void newInWorkspace(group.cwd!)}>+</button>}
            </h3>}
            <ul className="code-session-list-items">{group.sessions.map(s => <SessionRow key={s.sessionId} session={s} controller={c} view={view} />)}</ul>
        </section>)}
        {!c.loading && !visible.length && <p className="code-session-list-empty">{search ? 'No loaded sessions match. Clear search or load more.' : 'No sessions here. Start a new session above.'}</p>}
        {c.hasMoreSessions && <button type="button" className="code-inline-action" disabled={paging} onClick={() => void loadMore()}>{paging ? 'Loading…' : 'Load more sessions'}</button>}
        <button type="button" className="code-inline-action" onClick={() => { setError(null); void c.refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }}>Refresh sessions</button>
        {error && <div className="code-session-list-error" role="alert">{error}</div>}
    </nav>;
}
