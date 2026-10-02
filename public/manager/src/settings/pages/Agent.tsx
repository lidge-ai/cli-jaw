import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, SettingsClient, DirtyEntry } from '../types';
import {
    CLI_STATUS_POLL_HORIZON_MS,
    planCliStatusPoll,
} from '../cli-status-polling';
import {
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
    type SnapshotState,
} from './page-shell';
import { parsePermissionsValue, permissionsEditMode } from './Permissions';
import { AsideSelectionFields } from './components/AsideSelectionFields';
import { useAsideModels, asideSelectionError, isAsideAccount } from './components/aside-models';
import { RuntimeHeader } from './components/agent/RuntimeHeader';
import { PermissionQuickSection } from './components/agent/PermissionQuickSection';
import { FlushAgentSection } from './components/agent/FlushAgentSection';
import { AgentEmployeesSection } from './components/agent/AgentEmployeesSection';
import {
    metaFor,
    CLI_META,
    selectableRuntimeOptions,
    normalizeCliMetaRegistry,
    optionList,
    runtimeEffortFor,
    runtimeModelFor,
    coerceEffortForModel,
    effortChoicesForModel,
    type ActiveOverride,
    type CliMeta,
    type PerCliEntry,
} from './components/agent/agent-meta';
import {
    runtimeEmployeesEqual,
    runtimeEmployeesHaveErrors,
    unwrapRuntimeEmployees,
    type RuntimeEmployeeRecord,
    type RuntimeEmployeesResponse,
} from './components/agent/runtime-employees-helpers';
import {
    saveAgentRuntime,
    splitAgentSaveBundle,
    type AgentSettingsSnapshot,
} from './components/agent/agent-save';
import { SettingsRequestError } from '../settings-client';
import { describeError } from '../components/error-normalize';
import { describeCliProbeAvailability } from '../../../../js/features/settings-types';

export { splitAgentSaveBundle };

type AgentSnapshot = AgentSettingsSnapshot & {
    cli?: string;
    workingDir?: string;
    permissions?: 'auto' | string[] | unknown;
    perCli?: Record<string, PerCliEntry>;
    activeOverrides?: Record<string, ActiveOverride>;
    runtimeDefaultMigration?: {
        id: string;
        state: 'pending' | 'accepted' | 'kept' | 'already-codex-app';
        fromCli: string;
        toCli: 'codex-app';
    } | null;
};

type CliStatusInfo = {
    available: boolean | null;
    capabilityReady: boolean | null;
    checkedCapability: string;
    probeState: 'checking' | 'fresh' | 'stale' | 'failing' | 'unknown';
    probeError?: string;
    /** Server backoff deadline; used to time re-reads while `failing`. */
    nextRetryAt?: number;
};

export function CliProbeNotice({ status, exhausted = false }: {
    status: CliStatusInfo | undefined;
    exhausted?: boolean;
}) {
    if (exhausted) {
        return (
            <div className="settings-inline-notice" role="alert">
                상태 확인이 끝나지 않았습니다. 새로고침하거나 잠시 후 다시 확인하세요.
            </div>
        );
    }
    if (!status) return null;

    const presentation = describeCliProbeAvailability(status);
    if (presentation.kind === 'checking') {
        return <div className="settings-inline-notice" role="status" aria-live="polite">상태 확인 중</div>;
    }
    if (presentation.kind === 'unknown') {
        return <div className="settings-inline-notice" role="alert">{presentation.message}</div>;
    }
    if (presentation.kind === 'failing') {
        return (
            <div className="settings-inline-notice" role="alert">
                상태 확인 실패 (재시도 중)
                {status.probeError ? `: ${status.probeError}` : ''}
            </div>
        );
    }
    return null;
}

export function conflictSettingsFromError(error: unknown): AgentSnapshot | null {
    if (!(error instanceof SettingsRequestError) || error.status !== 409) return null;
    try {
        const payload = JSON.parse(error.detail) as { settings?: AgentSnapshot };
        return payload.settings ?? null;
    } catch {
        return null;
    }
}

type FlushSnapshot = {
    cli?: string;
    model?: string;
    [key: string]: unknown;
};

type RuntimeDraft = {
    cli: string;
    account: string;
    host: string;
    provider: string;
    model: string;
    effort: string;
    workingDir: string;
    // 'auto' | 'safe' | string[] when the stored policy is a known shape; the raw
    // stored value otherwise, so the editor can render it as invalid rather than
    // silently selecting Auto (#788).
    permissions: unknown;
};

const ownsAgentKey = (key: string) => ['cli', 'workingDir', 'permissions', 'runtimeEmployees', 'flushCli', 'flushModel', 'multiSession.midRunPolicy'].includes(key) || key.startsWith('activeOverrides.') || key.startsWith('perCli.');

export default function Agent({ port, instanceUrl, client, dirty, registerSave }: SettingsPageProps) {
    const instance = useMemo(() => ({ client, port, instanceUrl, dirty }), [client, port, instanceUrl, dirty]);
    const activeInstance = useRef<typeof instance | null>(null);
    const activeOperation = useRef<Promise<void> | null>(null);
    const metadataGeneration = useRef(0);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const snapshotClient = useMemo<SettingsClient>(() => ({ ...client,
        get: async <T,>(path: string, init?: RequestInit) => ({ instance, value: await client.get<AgentSnapshot>(path, init) }) as T,
    }), [client, instance]);
    const { state: boundState, refresh, setData: setBoundData } = usePageSnapshot<{ instance: typeof instance; value: AgentSnapshot }>(snapshotClient, '/api/settings');
    const state: SnapshotState<AgentSnapshot> = boundState.kind === 'ready'
        ? boundState.data.instance === instance ? { kind: 'ready', data: boundState.data.value } : { kind: 'loading' } : boundState;
    const setData = useCallback((value: AgentSnapshot) => setBoundData({ instance, value }), [instance, setBoundData]);
    const [draft, setDraft] = useState<RuntimeDraft>({
        cli: '',
        account: '',
        host: '',
        provider: '',
        model: '',
        effort: '',
        workingDir: '',
        permissions: 'auto',
    });
    const [flushOriginal, setFlushOriginal] = useState<FlushSnapshot>({});
    const [flushDraft, setFlushDraft] = useState<FlushSnapshot>({});
    const [flushLoading, setFlushLoading] = useState(true);
    const [flushError, setFlushError] = useState<string | null>(null);
    const [employeeOriginal, setEmployeeOriginal] = useState<RuntimeEmployeeRecord[]>([]);
    const [employeeDraft, setEmployeeDraft] = useState<RuntimeEmployeeRecord[]>([]);
    const [employeeLoading, setEmployeeLoading] = useState(true);
    const [employeeError, setEmployeeError] = useState<string | null>(null);
    const [cliMeta, setCliMeta] = useState<Record<string, CliMeta> | null>(null);
    const [cliStatus, setCliStatus] = useState<Record<string, CliStatusInfo>>({});
    const [migrationBusy, setMigrationBusy] = useState(false);
    const [migrationError, setMigrationError] = useState<string | null>(null);
    const [sessionMigrationBusy, setSessionMigrationBusy] = useState(false);
    const [sessionMigrationError, setSessionMigrationError] = useState<string | null>(null);

    const loadCliMeta = useCallback(async () => {
        const generation = ++metadataGeneration.current;
        try {
            const response = await client.get<{ data?: unknown } | Record<string, unknown>>('/api/cli-registry');
            if (activeInstance.current !== instance || generation !== metadataGeneration.current) return;
            const data = response && typeof response === 'object' && 'data' in response
                ? (response as { data?: unknown }).data
                : response;
            setCliMeta(normalizeCliMetaRegistry(data));
        } catch {
            if (activeInstance.current === instance && generation === metadataGeneration.current) setCliMeta(null);
        }
    }, [client, instance]);

    const aside = useAsideModels(client, instanceUrl, port, draft.account);
    const savedAside = state.kind === 'ready' ? state.data.perCli?.['aside'] : undefined;
    const asideModel = draft.cli === 'aside' ? draft.model : String(dirty.pending.get('activeOverrides.aside.model')?.value || savedAside?.model || '');
    const asideEffort = draft.cli === 'aside' ? draft.effort : String(dirty.pending.get('activeOverrides.aside.effort')?.value || savedAside?.effort || '');
    const asideError = draft.host !== 'local' ? 'Aside requires the local host.' : asideSelectionError(aside.inventory, asideModel, asideEffort);
    useEffect(() => {
        for (const [key, entry] of dirty.pending) {
            if (key.startsWith('perCli.aside.') || key.startsWith('activeOverrides.aside.') || (key === 'cli' && draft.cli === 'aside')) {
                const valid = !asideError;
                if (entry.valid !== valid) dirty.set(key, { ...entry, valid });
            }
        }
    }, [asideError, dirty, draft.cli]);
    useLayoutEffect(() => {
        activeInstance.current = instance; activeOperation.current = null; ++metadataGeneration.current;
        setSaving(false); setSaveError(null); setCliMeta(null);
        return () => { activeInstance.current = null; activeOperation.current = null; ++metadataGeneration.current; };
    }, [instance]);

    // Generation ref, same convention as Browser.tsx: clearing a timer does not
    // stop a request that is already in flight, and that response would
    // otherwise setState after unmount or after the user switched CLI.
    const cliStatusGenRef = useRef(0);
    const cliStatusRef = useRef<Record<string, CliStatusInfo>>({});
    const [cliStatusExhausted, setCliStatusExhausted] = useState(false);

    const loadCliStatus = useCallback(async (gen?: number) => {
        try {
            const next = await client.get<Record<string, CliStatusInfo>>('/api/cli-status');
            if (activeInstance.current !== instance || (gen !== undefined && gen !== cliStatusGenRef.current)) return;
            cliStatusRef.current = next;
            setCliStatus(next);
        } catch {
            if (activeInstance.current !== instance || (gen !== undefined && gen !== cliStatusGenRef.current)) return;
            cliStatusRef.current = {};
            setCliStatus({});
        }
    }, [client, instance]);

    const loadFlush = useCallback(async () => {
        setFlushLoading(true);
        setFlushError(null);
        try {
            const data = await client.get<FlushSnapshot>('/api/memory-files');
            if (activeInstance.current !== instance) return;
            const next = { cli: data.cli || '', model: data.model || '' };
            setFlushOriginal(next);
            setFlushDraft(next);
        } catch (err: unknown) {
            if (activeInstance.current !== instance) return;
            setFlushError(err instanceof Error ? err.message : String(err));
        } finally {
            if (activeInstance.current === instance) setFlushLoading(false);
        }
    }, [client, instance]);

    const loadEmployees = useCallback(async () => {
        setEmployeeLoading(true);
        setEmployeeError(null);
        try {
            const response = await client.get<RuntimeEmployeesResponse>('/api/employees');
            if (activeInstance.current !== instance) return;
            const rows = unwrapRuntimeEmployees(response);
            setEmployeeOriginal(rows);
            setEmployeeDraft(rows);
        } catch (err: unknown) {
            if (activeInstance.current !== instance) return;
            setEmployeeError(err instanceof Error ? err.message : String(err));
        } finally {
            if (activeInstance.current === instance) setEmployeeLoading(false);
        }
    }, [client, instance]);

    useEffect(() => {
        void loadCliMeta();
        void loadCliStatus();
        void loadFlush();
        void loadEmployees();
    }, [loadCliMeta, loadCliStatus, loadEmployees, loadFlush]);

    // #312: the server never pushes — CliStatusCache is demand-driven and has
    // no timer — so a probe still running at mount would leave the notice up
    // forever unless we ask again. Bounded by a wall-clock horizon AND a
    // request cap, neither of which resets on server responses.
    useEffect(() => {
        if (!draft.cli) return;
        const gen = cliStatusGenRef.current + 1;
        cliStatusGenRef.current = gen;
        setCliStatusExhausted(false);

        const deadline = Date.now() + CLI_STATUS_POLL_HORIZON_MS;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const tick = () => {
            if (gen !== cliStatusGenRef.current) return;
            const plan = planCliStatusPoll({
                snapshot: cliStatusRef.current,
                cli: draft.cli,
                attempts,
                now: Date.now(),
                deadline,
            });
            if (plan.kind === 'stop') return;
            if (plan.kind === 'exhausted') {
                setCliStatusExhausted(true);
                return;
            }
            timer = setTimeout(() => {
                if (gen !== cliStatusGenRef.current) return;
                // Only a real request consumes the cap; waiting out a server
                // backoff must not burn attempts.
                attempts += 1;
                void loadCliStatus(gen).then(() => {
                    if (gen === cliStatusGenRef.current) tick();
                });
            }, plan.delayMs);
        };
        tick();

        return () => {
            // Poison in-flight responses for this generation, then stop the timer.
            cliStatusGenRef.current = gen + 1;
            if (timer !== undefined) clearTimeout(timer);
        };
        // NOTE: cliStatus is deliberately NOT a dependency. Re-running this
        // effect on every response would reset the deadline and the attempt
        // counter, making both bounds unbounded in practice. The latest
        // snapshot is read through a ref instead.
    }, [draft.cli, loadCliStatus]);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const cliKeys = Object.keys(state.data.perCli || {});
        const cli = state.data.cli || cliKeys[0] || '';
        const permissions = parsePermissionsValue(state.data.permissions);
        const permissionsMode = permissionsEditMode(state.data.permissions);
        const meta = metaFor(cli, cliMeta);
        setDraft({
            cli,
            account: state.data.perCli?.['aside']?.account || '',
            host: state.data.perCli?.['aside']?.host || '',
            provider: state.data.perCli?.[cli]?.provider || meta.defaultProvider || '',
            model: runtimeModelFor(cli, state.data.perCli, state.data.activeOverrides),
            effort: runtimeEffortFor(cli, state.data.perCli, state.data.activeOverrides),
            workingDir: state.data.workingDir || '',
            // Preserve 'safe' rather than collapsing it: an untouched Safe instance must not
            // become Auto (YOLO) as a side effect of saving something unrelated on this page.
            // An unrecognized stored value stays in the draft as-is so the editor can show
            // a recoverable invalid state instead of silently selecting Auto (#788).
            permissions: permissionsMode === 'invalid' ? state.data.permissions
                : permissions.mode === 'custom' ? permissions.tokens
                : permissions.mode === 'safe' ? 'safe'
                : 'auto',
        });
    }, [state.kind === 'ready' ? state.data : null]);

    useEffect(() => () => {
        for (const key of Array.from(dirty.pending.keys())) if (ownsAgentKey(key)) dirty.remove(key);
    }, [dirty, instance]);

    const setEntry = useCallback((key: string, entry: DirtyEntry) => {
        if (activeInstance.current === instance && !activeOperation.current && ownsAgentKey(key)) dirty.set(key, entry);
    }, [dirty, instance]);

    const onSave = useCallback((): Promise<void> => {
        if (activeInstance.current !== instance) return Promise.resolve();
        if (activeOperation.current) return activeOperation.current;
        if ([...dirty.pending.keys()].some(key => key.startsWith('perCli.aside.') || key.startsWith('activeOverrides.aside.')) && asideError) return Promise.reject(new Error(asideError));
        const bundle = Object.fromEntries(Object.entries(dirty.saveBundle()).filter(([key]) => ownsAgentKey(key)));
        if (!Object.keys(bundle).length) return Promise.resolve();
        if ((draft.cli === 'aside' || Object.keys(bundle).some(key => key.startsWith('perCli.aside.') || key.startsWith('activeOverrides.aside.'))) && asideError)
            return Promise.reject(new Error(asideError));
        if ((Object.hasOwn(bundle, 'flushCli') || Object.hasOwn(bundle, 'flushModel')) && (flushDraft.cli || draft.cli) === 'aside') return Promise.reject(new Error('Aside cannot run memory flush.'));
        if (Object.hasOwn(bundle, 'perCli.aside.account')) {
            bundle['activeOverrides.aside.model'] ??= '';
            bundle['activeOverrides.aside.effort'] ??= '';
        }
        const submitted = new Map([...dirty.pending].filter(([key]) => Object.hasOwn(bundle, key)));
        setSaving(true); setSaveError(null);
        const operation = Promise.resolve().then(async () => {
            if (activeInstance.current !== instance) return;
            const freshSettings = await saveAgentRuntime({ client, bundle, employeeDraft, employeeOriginal });
            if (activeInstance.current !== instance) return;
            for (const [key, entry] of submitted) if (dirty.pending.get(key) === entry) dirty.remove(key);
            if (freshSettings) setData(freshSettings as AgentSnapshot);
            await refresh();
            await loadCliMeta();
            await loadFlush();
            await loadEmployees();
        }).catch(error => {
            if (activeInstance.current === instance) throw error;
        }).finally(() => {
            if (activeOperation.current === operation) activeOperation.current = null;
            if (activeInstance.current === instance) setSaving(false);
        });
        activeOperation.current = operation;
        return operation;
    }, [client, dirty, draft.cli, flushDraft.cli, asideError, instance, employeeDraft, employeeOriginal, loadCliMeta, loadEmployees, loadFlush, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    const settingsData = state.kind === 'ready' ? state.data : {};
    const perCli = settingsData.perCli || {};
    const activeOverrides = settingsData.activeOverrides || {};
    const cliOptions = useMemo(() => {
        const saved = selectableRuntimeOptions(Object.keys(perCli));
        return saved.length ? saved : selectableRuntimeOptions(Object.keys(cliMeta || CLI_META));
    }, [perCli, cliMeta]);
    const activeMeta = metaFor(draft.cli, cliMeta);
    const activeProvider = draft.provider || activeMeta.defaultProvider || activeMeta.providers?.[0] || '';
    const isPiRuntime = draft.cli === 'pi';
    const hasProviders = !isPiRuntime && (activeMeta.providers?.length ?? 0) > 0;
    const activeModelOptions = hasProviders
        ? optionList(activeMeta.modelsByProvider?.[activeProvider] || activeMeta.models, draft.model)
        : optionList(activeMeta.models, draft.model);
    const activeEffortOptions = hasProviders
        ? effortChoicesForModel(activeMeta, draft.model, activeMeta.effortsByProvider?.[activeProvider] || activeMeta.efforts, activeProvider)
        : effortChoicesForModel(activeMeta, draft.model);
    const workingDirError = draft.workingDir.trim() ? null : 'Required';

    const resolveMigration = useCallback(async (action: 'accept' | 'keep') => {
        setMigrationBusy(true);
        setMigrationError(null);
        try {
            const response = await client.post<AgentSnapshot | { data?: AgentSnapshot; settings?: AgentSnapshot }>(
                '/api/settings/runtime-default-migration',
                { action },
            );
            let next: AgentSnapshot;
            if ('settings' in response && response.settings) next = response.settings as AgentSnapshot;
            else if ('data' in response && response.data) next = response.data as AgentSnapshot;
            else next = response as AgentSnapshot;
            setData(next);
        } catch (error) {
            const conflictSettings = conflictSettingsFromError(error);
            if (conflictSettings) {
                setData(conflictSettings);
                return;
            }
            setMigrationError(describeError(error));
        } finally {
            setMigrationBusy(false);
        }
    }, [client, setData]);

    // Same shape, its own endpoint and its own busy state, because a v1 install has both
    // migrations pending and answering one must not look like answering the other.
    const resolveSessionMigration = useCallback(async (action: 'accept' | 'keep') => {
        setSessionMigrationBusy(true);
        setSessionMigrationError(null);
        try {
            const response = await client.post<AgentSnapshot | { data?: AgentSnapshot; settings?: AgentSnapshot }>(
                '/api/settings/multi-session-default-migration',
                { action },
            );
            let next: AgentSnapshot;
            if ('settings' in response && response.settings) next = response.settings as AgentSnapshot;
            else if ('data' in response && response.data) next = response.data as AgentSnapshot;
            else next = response as AgentSnapshot;
            setData(next);
        } catch (error) {
            const conflictSettings = conflictSettingsFromError(error);
            if (conflictSettings) {
                setData(conflictSettings);
                return;
            }
            setSessionMigrationError(describeError(error));
        } finally {
            setSessionMigrationBusy(false);
        }
    }, [client, setData]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    function resetActiveOverrideKeys(): void {
        for (const key of Array.from(dirty.pending.keys())) {
            if (key.startsWith('activeOverrides.') && !key.startsWith('activeOverrides.aside.')) dirty.remove(key);
        }
    }

    function setRuntimeDraft(next: RuntimeDraft): void {
        if (activeInstance.current === instance && !activeOperation.current) setDraft(next);
    }

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave().catch(error => { if (activeInstance.current === instance) setSaveError(describeError(error)); });
            }}
        >
            {saveError ? <PageError message={saveError} /> : null}
            <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {settingsData.runtimeDefaultMigration?.state === 'pending' ? (
                <div className="settings-inline-notice" role="status">
                    <strong>기본 런타임 변경 안내</strong>
                    <p>기존 선택은 유지됩니다. Codex App으로 전환하거나 현재 런타임을 계속 사용할 수 있습니다.</p>
                    <div className="settings-inline-actions">
                        <button type="button" className="settings-action settings-action-save" disabled={migrationBusy} onClick={() => void resolveMigration('accept')}>Codex App 사용</button>
                        <button type="button" className="settings-action settings-action-secondary" disabled={migrationBusy} onClick={() => void resolveMigration('keep')}>현재 런타임 유지</button>
                    </div>
                    {migrationError ? <span className="settings-field-error" role="alert">{migrationError}</span> : null}
                </div>
            ) : null}
            {(settingsData['multiSessionDefaultMigration'] as Record<string, unknown> | undefined)?.['state'] === 'pending' ? (
                <div className="settings-inline-notice" role="status">
                    <strong>다중 세션 안내</strong>
                    <p>대화 세션을 여러 개 열 수 있습니다. 켜면 동시 실행도 20으로 올라가서, 두 번째 세션이 첫 번째가 끝나기를 기다리지 않습니다. 지금 설정은 그대로 유지됩니다.</p>
                    <div className="settings-inline-actions">
                        <button type="button" className="settings-action settings-action-save" disabled={sessionMigrationBusy} onClick={() => void resolveSessionMigration('accept')}>다중 세션 켜기</button>
                        <button type="button" className="settings-action settings-action-secondary" disabled={sessionMigrationBusy} onClick={() => void resolveSessionMigration('keep')}>지금 설정 유지</button>
                    </div>
                    {sessionMigrationError ? <span className="settings-field-error" role="alert">{sessionMigrationError}</span> : null}
                </div>
            ) : null}
            <label
                className="settings-field settings-field-select"
                htmlFor="midrun-policy-select"
            >
                <span className="settings-field-label">실행 중 메시지 처리 (mid-run policy)</span>
                <select
                    id="midrun-policy-select"
                    value={String((settingsData['multiSession'] as { midRunPolicy?: string } | undefined)?.midRunPolicy || 'steer')}
                    onChange={(event) => {
                        const next = event.target.value;
                        setEntry('multiSession.midRunPolicy', {
                            value: next,
                            original: String((settingsData['multiSession'] as { midRunPolicy?: string } | undefined)?.midRunPolicy || 'steer'),
                            valid: true,
                        });
                    }}
                >
                    <option value="steer">steer (기본) — 실행 중 지시 변경</option>
                    <option value="followup">followup — 끝나면 순서대로 실행</option>
                    <option value="collect">collect — 모아서 한 번에 실행</option>
                    <option value="interrupt">interrupt — 현재 실행을 중단하고 즉시 실행</option>
                </select>
                <span className="settings-field-hint">
                    다중 세션이 켜져 있을 때 적용됩니다. codex-app은 같은 턴에 입력을 전달합니다. Cursor·Grok의 native 모드는 현재 요청의 취소와 정리가 끝난 뒤 같은 세션에 다시 요청합니다(cancel-reprompt). 그 외 런타임은 중단 후 새 실행으로 이어갑니다(kill-steer). 보존되는 맥락은 런타임에 따라 다릅니다. 끝난 뒤 실행하려면 followup을 선택하세요.
                </span>
            </label>
            <CliProbeNotice status={cliStatus[draft.cli]} exhausted={cliStatusExhausted} />
            <RuntimeHeader
                asideFields={draft.cli === 'aside' ? <AsideSelectionFields id="agent-aside" account={draft.account} host={draft.host}
                    model={draft.model} effort={draft.effort} inventory={aside.inventory} disabled={saving} refresh={aside.refresh}
                    onAccountChange={next => {
                        if (activeInstance.current !== instance || activeOperation.current) return;
                        setRuntimeDraft({ ...draft, account: next, host: 'local', model: perCli['aside']?.model || '', effort: perCli['aside']?.effort || '' });
                        setEntry('perCli.aside.account', { value: next, original: perCli['aside']?.account || '', valid: isAsideAccount(next) });
                        setEntry('perCli.aside.host', { value: 'local', original: perCli['aside']?.host || '', valid: true });
                        setEntry('activeOverrides.aside.model', { value: '', original: activeOverrides['aside']?.model || '', valid: true });
                        setEntry('activeOverrides.aside.effort', { value: '', original: activeOverrides['aside']?.effort || '', valid: true });
                    }}
                    onModelChange={next => {
                        if (activeInstance.current !== instance || activeOperation.current) return;
                        setRuntimeDraft({ ...draft, model: next });
                        setEntry('activeOverrides.aside.model', { value: next, original: dirty.pending.has('perCli.aside.account') ? '' : activeOverrides['aside']?.model || '', valid: true });
                    }}
                    onEffortChange={next => {
                        if (activeInstance.current !== instance || activeOperation.current) return;
                        const effort = next || 'default';
                        setRuntimeDraft({ ...draft, effort });
                        setEntry('activeOverrides.aside.effort', { value: effort, original: dirty.pending.has('perCli.aside.account') ? '' : activeOverrides['aside']?.effort || '', valid: true });
                    }} /> : null}
                cli={draft.cli}
                cliOptions={cliOptions}
                provider={activeProvider}
                providerOptions={isPiRuntime ? [] : (activeMeta.providers || [])}
                model={draft.model}
                modelOptions={activeModelOptions}
                effort={draft.effort}
                effortOptions={activeEffortOptions}
                workingDir={draft.workingDir}
                workingDirError={workingDirError}
                cliMeta={cliMeta}
                onCliChange={(next) => {
                    const nextMeta = metaFor(next, cliMeta);
                    const nextDraft = {
                        ...draft,
                        cli: next,
                        account: draft.account,
                        host: draft.host,
                        provider: perCli[next]?.provider || nextMeta.defaultProvider || '',
                        model: next === 'aside' && (dirty.pending.has('activeOverrides.aside.model') || dirty.pending.has('perCli.aside.account')) ? String(dirty.pending.get('activeOverrides.aside.model')?.value || perCli['aside']?.model || '') : runtimeModelFor(next, perCli, activeOverrides),
                        effort: next === 'aside' && (dirty.pending.has('activeOverrides.aside.effort') || dirty.pending.has('perCli.aside.account')) ? String(dirty.pending.get('activeOverrides.aside.effort')?.value || perCli['aside']?.effort || '') : runtimeEffortFor(next, perCli, activeOverrides),
                    };
                    resetActiveOverrideKeys();
                    setRuntimeDraft(nextDraft);
                    setEntry('cli', { value: next, original: settingsData.cli || '', valid: true });
                }}
                onProviderChange={(next) => {
                    const models = activeMeta.modelsByProvider?.[next] || [];
                    const efforts = activeMeta.effortsByProvider?.[next] || [];
                    const nextModel = models.includes(draft.model) ? draft.model : (models[0] || '');
                    // Resolve against the NEW provider+model pair: the same model
                    // id can allow different efforts per provider.
                    const nextEffort = coerceEffortForModel(activeMeta, nextModel, draft.effort, efforts, next);
                    setRuntimeDraft({ ...draft, provider: next, model: nextModel, effort: nextEffort });
                    setEntry(`perCli.${draft.cli}.provider`, {
                        value: next,
                        original: perCli[draft.cli]?.provider || activeMeta.defaultProvider || '',
                        valid: true,
                    });
                    setEntry(`activeOverrides.${draft.cli}.model`, {
                        value: nextModel,
                        original: runtimeModelFor(draft.cli, perCli, activeOverrides),
                        valid: nextModel.trim().length > 0,
                    });
                    setEntry(`activeOverrides.${draft.cli}.effort`, {
                        value: nextEffort,
                        original: runtimeEffortFor(draft.cli, perCli, activeOverrides),
                        valid: true,
                    });
                }}
                onModelChange={(next) => {
                    // Efforts are per-model on a live opencodex catalog, so a
                    // model switch can strand an effort the new model does not
                    // support — and that value would reach the wire verbatim.
                    const nextEffort = coerceEffortForModel(
                        activeMeta,
                        next,
                        draft.effort,
                        hasProviders ? (activeMeta.effortsByProvider?.[activeProvider] || activeMeta.efforts) : undefined,
                        hasProviders ? activeProvider : undefined,
                    );
                    setRuntimeDraft({ ...draft, model: next, effort: nextEffort });
                    setEntry(`activeOverrides.${draft.cli}.model`, {
                        value: next,
                        original: runtimeModelFor(draft.cli, perCli, activeOverrides),
                        valid: next.trim().length > 0,
                    });
                    if (nextEffort !== draft.effort) {
                        setEntry(`activeOverrides.${draft.cli}.effort`, {
                            value: nextEffort,
                            original: runtimeEffortFor(draft.cli, perCli, activeOverrides),
                            valid: true,
                        });
                    }
                }}
                onEffortChange={(next) => {
                    setRuntimeDraft({ ...draft, effort: next });
                    setEntry(`activeOverrides.${draft.cli}.effort`, {
                        value: next,
                        original: runtimeEffortFor(draft.cli, perCli, activeOverrides),
                        valid: true,
                    });
                }}
                onWorkingDirChange={(next) => {
                    setRuntimeDraft({ ...draft, workingDir: next });
                    setEntry('workingDir', {
                        value: next,
                        original: settingsData.workingDir || '',
                        valid: next.trim().length > 0,
                    });
                }}
            />
            <PermissionQuickSection
                value={draft.permissions}
                configuredValue={settingsData.permissions}
                onChange={(next) => {
                    setRuntimeDraft({ ...draft, permissions: next });
                    setEntry('permissions', {
                        value: next,
                        original: settingsData.permissions ?? 'auto',
                        valid: next === 'auto' || next === 'safe' || next.length > 0,
                    });
                }}
            />
            <FlushAgentSection
                activeCli={draft.cli}
                flushCli={flushDraft.cli || ''}
                flushModel={flushDraft.model || ''}
                cliOptions={cliOptions}
                cliMeta={cliMeta}
                modelOptions={optionList(metaFor(flushDraft.cli || draft.cli, cliMeta).models, flushDraft.model || '')}
                loading={flushLoading}
                error={flushError}
                onFlushCliChange={(next) => {
                    const model = next ? metaFor(next, cliMeta).models[0] || '' : '';
                    setFlushDraft({ cli: next, model });
                    setEntry('flushCli', { value: next, original: flushOriginal.cli || '', valid: next !== 'aside' && (next !== '' || draft.cli !== 'aside') });
                    setEntry('flushModel', { value: model, original: flushOriginal.model || '', valid: true });
                }}
                onFlushModelChange={(next) => {
                    setFlushDraft({ ...flushDraft, model: next });
                    setEntry('flushModel', { value: next, original: flushOriginal.model || '', valid: true });
                }}
            />
            <AgentEmployeesSection
                roster={employeeDraft}
                original={employeeOriginal}
                cliOptions={cliOptions.filter(cli => cli !== 'aside')}
                cliMeta={cliMeta}
                loading={employeeLoading}
                error={employeeError}
                onRosterChange={(next) => {
                    setEmployeeDraft(next);
                    if (runtimeEmployeesEqual(next, employeeOriginal)) {
                        dirty.remove('runtimeEmployees');
                        return;
                    }
                    dirty.set('runtimeEmployees', {
                        value: next,
                        original: employeeOriginal,
                        valid: !runtimeEmployeesHaveErrors(next),
                    });
                }}
            />
            </fieldset>
        </form>
    );
}
