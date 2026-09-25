import { useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionInfo } from '../../../../src/code-mode/wire';
import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS, CODE_SESSION_LABELS, codeCanResume, codeSessionBusy } from './code-types';
import { codeSessionAttention, codeSessionAttentionLabel, groupCodeSessions } from './session-order';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, formatShortcut } from '../manager-shortcuts';

const NEW_SESSION_SHORTCUT = DEFAULT_MANAGER_SHORTCUT_KEYMAP.newCodeSession;

function PlusGlyph() {
    return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>;
}

function SessionRow({ session: s, controller: c }: { session: CodeSessionInfo; controller: CodeControllerModel }) {
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
            <span className="code-session-cwd">{s.title || 'Untitled session'}</span>
            <span className="code-session-meta" title={s.cwd}>{CODE_RUNTIME_LABELS[s.provider]} · {s.cwd}</span>
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

export function CodeSessionList({ controller: c }: { controller: CodeControllerModel }) {
    const [search, setSearch] = useState('');
    const [grouped, setGrouped] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [paging, setPaging] = useState(false);
    const pagingRef = useRef(false);
    const visible = c.sessions.filter(s => `${s.title ?? ''} ${s.cwd} ${CODE_RUNTIME_LABELS[s.provider]}`.toLowerCase().includes(search.toLowerCase()));
    // Two orderings, deliberately: by workspace when the reader asks for it,
    // otherwise by lifecycle. Neither uses last activity, so answering a prompt
    // in one session does not move it under the reader's cursor -- which is
    // what the server's own last-used ordering would do.
    const groups = grouped
        ? [...visible.reduce((map, s) => {
            const rows = map.get(s.cwd) ?? []; rows.push(s); map.set(s.cwd, rows); return map;
        }, new Map<string, CodeSessionInfo[]>())].map(([cwd, sessions]) => ({ title: cwd, key: cwd, cwd, sessions }))
        : groupCodeSessions(visible).map(group => ({
            key: group.section,
            title: group.section === 'archived' ? 'Archived' : '',
            cwd: null,
            sessions: group.sessions,
        }));
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
            title={`Start a new session (${formatShortcut(NEW_SESSION_SHORTCUT)})`} onClick={c.newSession}>
            <PlusGlyph />
            <span className="code-session-new-label">New session</span>
            {c.hasUnsentDraft && <span className="code-session-draft-badge">Draft</span>}
            <kbd className="code-session-new-hint">{formatShortcut(NEW_SESSION_SHORTCUT)}</kbd>
        </button>
        <div className="code-session-list-header"><span className="code-session-list-title">Sessions</span></div>
        <div className="code-session-view-toggle" aria-label="Session view">
            <button type="button" aria-pressed={c.filter.scope === 'all'} className={`code-session-view-btn${c.filter.scope === 'all' ? ' active' : ''}`}
                onClick={() => c.setFilter({ ...c.filter, scope: 'all' })}>All</button>
            <button type="button" aria-pressed={c.filter.scope === 'cwd'} className={`code-session-view-btn${c.filter.scope === 'cwd' ? ' active' : ''}`}
                onClick={() => c.setFilter({ ...c.filter, scope: 'cwd' })}>This cwd</button>
            <button type="button" aria-pressed={grouped} className={`code-session-view-btn${grouped ? ' active' : ''}`} onClick={() => setGrouped(!grouped)}>Group</button>
        </div>
        <label className="code-session-archive-filter"><input type="checkbox" checked={c.filter.archived}
            onChange={event => c.setFilter({ ...c.filter, archived: event.target.checked })} />Archived</label>
        <input className="code-session-search" type="search" aria-label="Search loaded sessions" placeholder="Search loaded sessions…"
            value={search} onChange={event => setSearch(event.target.value)} />
        {c.loading && <div className="code-session-list-loading" role="status">Loading sessions…</div>}
        {groups.map(group => <section className="code-session-group" key={group.key}>
            {group.title && <h3 className="code-session-group-title" title={group.title}>
                <span>{group.title}</span>
                {group.cwd !== null && <button type="button" className="code-session-group-new"
                    aria-label={`New session in ${group.cwd}`} title={`New session in ${group.cwd}`}
                    onClick={() => void newInWorkspace(group.cwd!)}>+</button>}
            </h3>}
            <ul className="code-session-list-items">{group.sessions.map(s => <SessionRow key={s.sessionId} session={s} controller={c} />)}</ul>
        </section>)}
        {!c.loading && !visible.length && <p className="code-session-list-empty">{search ? 'No loaded sessions match. Clear search or load more.' : 'No sessions here. Start a new session above.'}</p>}
        {c.hasMoreSessions && <button type="button" className="code-inline-action" disabled={paging} onClick={() => void loadMore()}>{paging ? 'Loading…' : 'Load more sessions'}</button>}
        <button type="button" className="code-inline-action" onClick={() => { setError(null); void c.refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }}>Refresh sessions</button>
        {error && <div className="code-session-list-error" role="alert">{error}</div>}
    </nav>;
}
