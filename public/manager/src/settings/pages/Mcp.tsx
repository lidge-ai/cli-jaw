import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps } from '../types';
import { JsonEditorField } from '../fields';
import {
    PageError,
    PageLoading,
    PageOffline,
    SettingsActions,
    SettingsNote,
    SettingsSection,
    SettingsToolbar,
    StatusBadge,
    usePageSnapshot,
} from './page-shell';
import { McpServerCard } from './components/McpServerCard';
import {
    countInstallBundleCandidates,
    findDuplicateNames,
    getServerTag,
    makeEmptyServer,
    newServerName,
    normalizeMcpConfig,
    toPersistShape,
    validateServer,
    type McpConfig,
    type McpServer,
} from './mcp-helpers';

const DIRTY_KEY = 'mcp.config';

type ActionResult =
    | { kind: 'idle' }
    | { kind: 'pending'; label: string }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string };

type SyncResultsPayload = {
    ok?: boolean;
    results?: unknown;
    synced?: unknown;
    servers?: unknown;
};

type ModalTab = 'active' | 'add';
type AddSubTab = 'local' | 'remote';

export default function Mcp({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<unknown>(client, '/api/mcp');
    const [draft, setDraft] = useState<McpConfig>({ servers: {} });
    const [order, setOrder] = useState<string[]>([]);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [advancedValid, setAdvancedValid] = useState(true);
    const [actionState, setActionState] = useState<ActionResult>({ kind: 'idle' });
    const actionRunIdRef = useRef(0);

    const [modalOpen, setModalOpen] = useState(false);
    const [modalTab, setModalTab] = useState<ModalTab>('active');
    const [addSubTab, setAddSubTab] = useState<AddSubTab>('local');
    const [addName, setAddName] = useState('');
    const [addCommand, setAddCommand] = useState('');
    const [addArgs, setAddArgs] = useState('');
    const [addEnv, setAddEnv] = useState('');
    const [addUrl, setAddUrl] = useState('');
    const [addHeaders, setAddHeaders] = useState('');
    const [addError, setAddError] = useState<string | null>(null);
    const [addPending, setAddPending] = useState(false);

    const original = useMemo<McpConfig>(
        () => (state.kind === 'ready' ? normalizeMcpConfig(state.data) : { servers: {} }),
        [state],
    );

    useEffect(() => {
        if (state.kind === 'ready') {
            const normalized = normalizeMcpConfig(state.data);
            setDraft(normalized);
            setOrder(Object.keys(normalized.servers));
        }
    }, [state]);

    useEffect(() => {
        return () => { dirty.remove(DIRTY_KEY); };
    }, [dirty]);

    const names = useMemo(() => Object.keys(draft.servers), [draft]);
    const duplicates = useMemo(() => findDuplicateNames(names), [names]);
    const validations = useMemo(() => {
        return names.map((name) => ({
            name,
            result: validateServer(name, draft.servers[name] ?? makeEmptyServer()),
        }));
    }, [draft, names]);
    const hasFieldErrors = validations.some((v) => v.result.kind === 'invalid');
    const hasDupes = duplicates.size > 0;
    const isValid = !hasFieldErrors && !hasDupes && advancedValid;
    const bundleCandidates = useMemo(
        () => countInstallBundleCandidates(draft.servers),
        [draft],
    );

    const writeDirty = useCallback(
        (next: McpConfig, valid: boolean) => {
            dirty.set(DIRTY_KEY, {
                value: toPersistShape(next),
                original: toPersistShape(original),
                valid,
            });
        },
        [dirty, original],
    );

    const updateDraft = useCallback(
        (next: McpConfig, nextOrder?: string[]) => {
            setDraft(next);
            if (nextOrder) setOrder(nextOrder);
            const ns = nextOrder ?? Object.keys(next.servers);
            const dupes = findDuplicateNames(ns);
            const fieldOk = ns.every(
                (n) => validateServer(n, next.servers[n] ?? makeEmptyServer()).kind === 'ok',
            );
            writeDirty(next, fieldOk && dupes.size === 0 && advancedValid);
        },
        [advancedValid, writeDirty],
    );

    const onRenameServer = useCallback(
        (oldName: string, nextName: string) => {
            if (oldName === nextName) return;
            const nextOrder = order.map((n) => (n === oldName ? nextName : n));
            const nextServers: Record<string, McpServer> = {};
            for (const n of nextOrder) {
                if (n === nextName) {
                    nextServers[n] = draft.servers[oldName] ?? makeEmptyServer();
                } else {
                    nextServers[n] = draft.servers[n] ?? makeEmptyServer();
                }
            }
            updateDraft({ ...draft, servers: nextServers }, nextOrder);
        },
        [draft, order, updateDraft],
    );

    const onChangeServer = useCallback(
        (name: string, next: McpServer) => {
            updateDraft(
                { ...draft, servers: { ...draft.servers, [name]: next } },
                order,
            );
        },
        [draft, order, updateDraft],
    );

    const onRemoveServer = useCallback(
        (name: string) => {
            const nextServers = { ...draft.servers };
            delete nextServers[name];
            const nextOrder = order.filter((n) => n !== name);
            updateDraft({ ...draft, servers: nextServers }, nextOrder);
        },
        [draft, order, updateDraft],
    );

    const onAddServer = useCallback(() => {
        const name = newServerName(order);
        updateDraft(
            { ...draft, servers: { ...draft.servers, [name]: makeEmptyServer() } },
            [...order, name],
        );
    }, [draft, order, updateDraft]);

    const onAdvancedChange = useCallback(
        (next: unknown, valid: boolean) => {
            setAdvancedValid(valid);
            if (!valid) {
                writeDirty(draft, false);
                return;
            }
            if (next && typeof next === 'object' && !Array.isArray(next)) {
                const normalized = normalizeMcpConfig(next);
                setDraft(normalized);
                setOrder(Object.keys(normalized.servers));
                const dupes = findDuplicateNames(Object.keys(normalized.servers));
                const fieldOk = Object.entries(normalized.servers).every(
                    ([n, srv]) => validateServer(n, srv).kind === 'ok',
                );
                writeDirty(normalized, fieldOk && dupes.size === 0);
            }
        },
        [draft, writeDirty],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (!(DIRTY_KEY in bundle)) return;
        const body = bundle[DIRTY_KEY];
        const updated = await client.put<unknown>('/api/mcp', body);
        dirty.clear();
        const fresh = await client.get<unknown>('/api/mcp').catch(() => updated);
        const normalized = normalizeMcpConfig(fresh);
        setDraft(normalized);
        setOrder(Object.keys(normalized.servers));
        setData(fresh);
        await refresh();
    }, [client, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const runAction = useCallback(
        async (label: string, path: string) => {
            if (dirty.isDirty()) {
                if (
                    typeof window !== 'undefined' &&
                    !window.confirm(
                        `You have unsaved MCP edits. ${label} will use the on-disk config, not your unsaved changes. Continue?`,
                    )
                ) { return; }
            }
            const runId = actionRunIdRef.current + 1;
            actionRunIdRef.current = runId;
            setActionState({ kind: 'pending', label });
            try {
                const result = await client.post<SyncResultsPayload>(path, {});
                if (actionRunIdRef.current !== runId) return;
                setActionState({
                    kind: 'success',
                    message: `${label} succeeded${result?.servers ? `: ${JSON.stringify(result.servers)}` : ''}`,
                });
            } catch (err: unknown) {
                if (actionRunIdRef.current !== runId) return;
                setActionState({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        },
        [client, dirty],
    );

    const resetAddForm = useCallback(() => {
        setAddName('');
        setAddCommand('');
        setAddArgs('');
        setAddEnv('');
        setAddUrl('');
        setAddHeaders('');
        setAddError(null);
        setAddPending(false);
    }, []);

    const openModal = useCallback(() => {
        setModalTab('active');
        resetAddForm();
        setModalOpen(true);
    }, [resetAddForm]);

    const closeModal = useCallback(() => {
        setModalOpen(false);
        resetAddForm();
    }, [resetAddForm]);

    const handleAddAndSync = useCallback(async () => {
        const name = addName.trim() || newServerName(Object.keys(original.servers));
        const server: McpServer = addSubTab === 'remote'
            ? { url: addUrl.trim(), ...(addHeaders.trim() ? { headers: parseSimpleKV(addHeaders) } : {}) }
            : {
                command: addCommand.trim(),
                ...(addArgs.trim() ? { args: addArgs.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean) } : {}),
                ...(addEnv.trim() ? { env: parseSimpleKV(addEnv) } : {}),
            };

        const validation = validateServer(name, server);
        if (validation.kind === 'invalid') {
            setAddError(validation.reason);
            return;
        }
        if (original.servers[name]) {
            setAddError(`Server "${name}" already exists.`);
            return;
        }

        setAddPending(true);
        setAddError(null);

        try {
            const merged: McpConfig = {
                ...original,
                servers: { ...original.servers, [name]: server },
            };
            await client.put<unknown>('/api/mcp', toPersistShape(merged));
            await client.post<unknown>('/api/mcp/sync', {});
            dirty.clear();
            const fresh = await client.get<unknown>('/api/mcp').catch(() => merged);
            const normalized = normalizeMcpConfig(fresh);
            setDraft(normalized);
            setOrder(Object.keys(normalized.servers));
            setData(fresh);
            await refresh();
            closeModal();
        } catch (err: unknown) {
            setAddError(err instanceof Error ? err.message : String(err));
            setAddPending(false);
        }
    }, [addName, addSubTab, addUrl, addHeaders, addCommand, addArgs, addEnv, original, client, dirty, refresh, setData, closeModal]);

    const handleRemoveFromModal = useCallback(async (name: string) => {
        const nextServers = { ...original.servers };
        delete nextServers[name];
        const merged: McpConfig = { ...original, servers: nextServers };
        try {
            await client.put<unknown>('/api/mcp', toPersistShape(merged));
            await client.post<unknown>('/api/mcp/sync', {});
            dirty.clear();
            const fresh = await client.get<unknown>('/api/mcp').catch(() => merged);
            const normalized = normalizeMcpConfig(fresh);
            setDraft(normalized);
            setOrder(Object.keys(normalized.servers));
            setData(fresh);
            await refresh();
        } catch (err: unknown) {
            setActionState({
                kind: 'error',
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }, [original, client, dirty, refresh, setData]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const dupeNames = Array.from(duplicates).sort();

    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="MCP servers"
                hint="Edit each server's command/args/env. Save writes back to mcp.json; Sync pushes the saved config to all CLIs."
            >
                {order.length === 0 && (
                    <SettingsNote>
                        No servers configured. Add one or run <code>Reset to defaults</code>.
                    </SettingsNote>
                )}
                {order.map((name) => {
                    const srv = draft.servers[name] ?? makeEmptyServer();
                    const lower = name.toLowerCase();
                    const isDupe = duplicates.has(lower);
                    const validation = validateServer(name, srv);
                    const error = isDupe
                        ? 'Duplicate server name (case-insensitive).'
                        : validation.kind === 'invalid'
                            ? validation.reason
                            : null;
                    return (
                        <McpServerCard
                            key={name}
                            name={name}
                            server={srv}
                            onRename={(next) => onRenameServer(name, next)}
                            onChange={(next) => onChangeServer(name, next)}
                            onRemove={() => onRemoveServer(name)}
                            nameError={error}
                        />
                    );
                })}
                {hasDupes && (
                    <SettingsNote tone="error" role="alert">
                        Duplicate server name{dupeNames.length === 1 ? '' : 's'}: {dupeNames.join(', ')}.
                        Saving is blocked until names are unique.
                    </SettingsNote>
                )}
                {hasFieldErrors && !hasDupes && (
                    <SettingsNote tone="error" role="alert">
                        Some servers have errors (missing command/URL or invalid name).
                        Saving is blocked until they are fixed.
                    </SettingsNote>
                )}
            </SettingsSection>

            <SettingsSection
                title="Actions"
                hint="These act on the saved config. Save edits first if you want them included."
            >
                <SettingsActions
                    status={
                        actionState.kind === 'pending' ? (
                            <span role="status">{actionState.label}…</span>
                        ) : actionState.kind === 'success' ? (
                            <span role="status">{actionState.message}</span>
                        ) : undefined
                    }
                >
                    <button
                        type="button"
                        className="settings-action"
                        onClick={openModal}
                    >
                        + Add, Set MCP
                    </button>
                    <button
                        type="button"
                        className="settings-action"
                        disabled={actionState.kind === 'pending'}
                        onClick={() => void runAction('Sync to all CLIs', '/api/mcp/sync')}
                    >
                        Sync to all CLIs
                    </button>
                    <button
                        type="button"
                        className="settings-action"
                        disabled={actionState.kind === 'pending' || bundleCandidates === 0}
                        onClick={() => void runAction('Install bundle', '/api/mcp/install')}
                    >
                        Install bundle ({bundleCandidates})
                    </button>
                    <button
                        type="button"
                        className="settings-action settings-action-danger"
                        disabled={actionState.kind === 'pending'}
                        onClick={() => {
                            if (
                                typeof window !== 'undefined' &&
                                !window.confirm(
                                    'Reset MCP config to defaults? Your custom servers will be removed.',
                                )
                            ) { return; }
                            void runAction('Reset to defaults', '/api/mcp/reset');
                        }}
                    >
                        Reset to defaults
                    </button>
                </SettingsActions>
                {actionState.kind === 'error' && (
                    <SettingsNote tone="error" role="alert">{actionState.message}</SettingsNote>
                )}
            </SettingsSection>

            <SettingsSection
                title="Advanced (raw JSON)"
                hint="Edit the entire config object. Useful for fields not surfaced in the structured editor."
            >
                <button
                    type="button"
                    className="settings-action"
                    onClick={() => setShowAdvanced((v) => !v)}
                    aria-expanded={showAdvanced}
                >
                    {showAdvanced ? 'Hide raw JSON' : 'Show raw JSON'}
                </button>
                {showAdvanced && (
                    <JsonEditorField
                        id="mcp-raw"
                        label="mcp.json"
                        value={toPersistShape(draft)}
                        rows={16}
                        onChange={onAdvancedChange}
                    />
                )}
                {!isValid && (
                    <SettingsNote>
                        Save is disabled while validation errors are present.
                    </SettingsNote>
                )}
            </SettingsSection>

            {modalOpen && (
                <div
                    className="settings-memory-modal settings-pi-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="MCP Server Management"
                    onClick={closeModal}
                >
                    <div
                        className="settings-memory-modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <header className="settings-memory-modal-header">
                            <h3>MCP servers</h3>
                            <button
                                type="button"
                                className="settings-action"
                                onClick={closeModal}
                            >
                                Close
                            </button>
                        </header>

                        <SettingsToolbar>
                            <button
                                type="button"
                                aria-pressed={modalTab === 'active'}
                                className="settings-action"
                                onClick={() => setModalTab('active')}
                            >
                                Active Servers
                            </button>
                            <button
                                type="button"
                                aria-pressed={modalTab === 'add'}
                                className="settings-action"
                                onClick={() => { setModalTab('add'); resetAddForm(); }}
                            >
                                Add New
                            </button>
                        </SettingsToolbar>

                        {modalTab === 'active' && (
                            <>
                                {Object.keys(original.servers).length === 0 && (
                                    <SettingsNote>No active MCP servers.</SettingsNote>
                                )}
                                {Object.entries(original.servers).map(([name, srv]) => {
                                    const tag = getServerTag(srv);
                                    return (
                                        <SettingsActions
                                            key={name}
                                            status={
                                                <>
                                                    <strong>{name}</strong>{' '}
                                                    <code>
                                                        {srv.url || [srv.command, ...(srv.args || [])].filter(Boolean).join(' ')}
                                                    </code>{' '}
                                                    {tag ? <StatusBadge tone="neutral">{tag}</StatusBadge> : null}
                                                </>
                                            }
                                        >
                                            <button
                                                type="button"
                                                className="settings-action settings-action-danger"
                                                onClick={() => void handleRemoveFromModal(name)}
                                            >
                                                Remove
                                            </button>
                                        </SettingsActions>
                                    );
                                })}
                            </>
                        )}

                        {modalTab === 'add' && (
                            <>
                                <SettingsToolbar>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={addSubTab === 'local'}
                                        className={`settings-action${addSubTab === 'local' ? ' settings-action-save' : ''}`}
                                        onClick={() => setAddSubTab('local')}
                                    >
                                        Local
                                    </button>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={addSubTab === 'remote'}
                                        className={`settings-action${addSubTab === 'remote' ? ' settings-action-save' : ''}`}
                                        onClick={() => setAddSubTab('remote')}
                                    >
                                        Remote
                                    </button>
                                </SettingsToolbar>

                                <label className="settings-field settings-field-text">
                                    <span className="settings-field-label">Name</span>
                                    <input
                                        type="text"
                                        value={addName}
                                        placeholder="my-server"
                                        spellCheck={false}
                                        onChange={(e) => setAddName(e.target.value)}
                                    />
                                </label>

                                {addSubTab === 'local' ? (
                                    <>
                                        <label className="settings-field settings-field-text">
                                            <span className="settings-field-label">Command</span>
                                            <input
                                                type="text"
                                                value={addCommand}
                                                placeholder="npx"
                                                spellCheck={false}
                                                onChange={(e) => setAddCommand(e.target.value)}
                                            />
                                        </label>
                                        <label className="settings-field settings-field-text">
                                            <span className="settings-field-label">Args (one per line)</span>
                                            <textarea
                                                value={addArgs}
                                                rows={3}
                                                spellCheck={false}
                                                placeholder="-y&#10;@upstash/context7-mcp"
                                                onChange={(e) => setAddArgs(e.target.value)}
                                            />
                                        </label>
                                        <label className="settings-field settings-field-text">
                                            <span className="settings-field-label">Env (KEY=value per line)</span>
                                            <textarea
                                                value={addEnv}
                                                rows={2}
                                                spellCheck={false}
                                                onChange={(e) => setAddEnv(e.target.value)}
                                            />
                                        </label>
                                    </>
                                ) : (
                                    <>
                                        <label className="settings-field settings-field-text">
                                            <span className="settings-field-label">URL</span>
                                            <input
                                                type="text"
                                                value={addUrl}
                                                placeholder="https://mcp.example.com/sse"
                                                spellCheck={false}
                                                onChange={(e) => setAddUrl(e.target.value)}
                                            />
                                        </label>
                                        <label className="settings-field settings-field-text">
                                            <span className="settings-field-label">Headers (KEY=value per line)</span>
                                            <textarea
                                                value={addHeaders}
                                                rows={2}
                                                spellCheck={false}
                                                onChange={(e) => setAddHeaders(e.target.value)}
                                            />
                                        </label>
                                    </>
                                )}

                                {addError && (
                                    <SettingsNote tone="error" role="alert">{addError}</SettingsNote>
                                )}

                                <SettingsActions>
                                    <button
                                        type="button"
                                        className="settings-action"
                                        onClick={closeModal}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="settings-action settings-action-save"
                                        disabled={addPending}
                                        onClick={() => void handleAddAndSync()}
                                    >
                                        {addPending ? 'Adding…' : 'Add & Sync'}
                                    </button>
                                </SettingsActions>
                            </>
                        )}
                    </div>
                </div>
            )}
        </form>
    );
}

function parseSimpleKV(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        out[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
    return out;
}
