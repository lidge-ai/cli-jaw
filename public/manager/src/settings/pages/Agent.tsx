import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import {
    CLI_STATUS_POLL_HORIZON_MS,
    planCliStatusPoll,
} from '../cli-status-polling';
import {
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { parsePermissionsValue } from './Permissions';
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
    provider: string;
    model: string;
    effort: string;
    workingDir: string;
    permissions: 'auto' | 'safe' | string[];
};

export default function Agent({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<AgentSnapshot>(client, '/api/settings');
    const [draft, setDraft] = useState<RuntimeDraft>({
        cli: '',
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
        try {
            const response = await client.get<{ data?: unknown } | Record<string, unknown>>('/api/cli-registry');
            const data = response && typeof response === 'object' && 'data' in response
                ? (response as { data?: unknown }).data
                : response;
            setCliMeta(normalizeCliMetaRegistry(data));
        } catch {
            setCliMeta(null);
        }
    }, [client]);

    // Generation ref, same convention as Browser.tsx: clearing a timer does not
    // stop a request that is already in flight, and that response would
    // otherwise setState after unmount or after the user switched CLI.
    const cliStatusGenRef = useRef(0);
    const cliStatusRef = useRef<Record<string, CliStatusInfo>>({});
    const [cliStatusExhausted, setCliStatusExhausted] = useState(false);

    const loadCliStatus = useCallback(async (gen?: number) => {
        try {
            const next = await client.get<Record<string, CliStatusInfo>>('/api/cli-status');
            if (gen !== undefined && gen !== cliStatusGenRef.current) return;
            cliStatusRef.current = next;
            setCliStatus(next);
        } catch {
            if (gen !== undefined && gen !== cliStatusGenRef.current) return;
            cliStatusRef.current = {};
            setCliStatus({});
        }
    }, [client]);

    const loadFlush = useCallback(async () => {
        setFlushLoading(true);
        setFlushError(null);
        try {
            const data = await client.get<FlushSnapshot>('/api/memory-files');
            const next = { cli: data.cli || '', model: data.model || '' };
            setFlushOriginal(next);
            setFlushDraft(next);
        } catch (err: unknown) {
            setFlushError(err instanceof Error ? err.message : String(err));
        } finally {
            setFlushLoading(false);
        }
    }, [client]);

    const loadEmployees = useCallback(async () => {
        setEmployeeLoading(true);
        setEmployeeError(null);
        try {
            const response = await client.get<RuntimeEmployeesResponse>('/api/employees');
            const rows = unwrapRuntimeEmployees(response);
            setEmployeeOriginal(rows);
            setEmployeeDraft(rows);
        } catch (err: unknown) {
            setEmployeeError(err instanceof Error ? err.message : String(err));
        } finally {
            setEmployeeLoading(false);
        }
    }, [client]);

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
        const meta = metaFor(cli, cliMeta);
        setDraft({
            cli,
            provider: state.data.perCli?.[cli]?.provider || meta.defaultProvider || '',
            model: runtimeModelFor(cli, state.data.perCli, state.data.activeOverrides),
            effort: runtimeEffortFor(cli, state.data.perCli, state.data.activeOverrides),
            workingDir: state.data.workingDir || '',
            // Preserve 'safe' rather than collapsing it: an untouched Safe instance must not
            // become Auto (YOLO) as a side effect of saving something unrelated on this page.
            permissions: permissions.mode === 'custom' ? permissions.tokens
                : permissions.mode === 'safe' ? 'safe' : 'auto',
        });
    }, [cliMeta, state]);

    useEffect(() => {
        return () => {
            for (const key of Array.from(dirty.pending.keys())) {
                if (
                    key === 'cli' ||
                    key === 'workingDir' ||
                    key === 'permissions' ||
                    key === 'runtimeEmployees' ||
                    key === 'flushCli' ||
                    key === 'flushModel' ||
                    key.startsWith('activeOverrides.')
                ) {
                    dirty.remove(key);
                }
            }
        };
    }, [dirty]);

    const setEntry = useCallback((key: string, entry: DirtyEntry) => dirty.set(key, entry), [dirty]);

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const freshSettings = await saveAgentRuntime({ client, bundle, employeeDraft, employeeOriginal });
        dirty.clear();
        if (freshSettings) setData(freshSettings as AgentSnapshot);
        await refresh();
        await loadCliMeta();
        await loadFlush();
        await loadEmployees();
    }, [client, dirty, employeeDraft, employeeOriginal, loadCliMeta, loadEmployees, loadFlush, refresh, setData]);

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
            if (key.startsWith('activeOverrides.')) dirty.remove(key);
        }
    }

    function setRuntimeDraft(next: RuntimeDraft): void {
        setDraft(next);
    }

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
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
                        provider: perCli[next]?.provider || nextMeta.defaultProvider || '',
                        model: runtimeModelFor(next, perCli, activeOverrides),
                        effort: runtimeEffortFor(next, perCli, activeOverrides),
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
                        valid: next === 'auto' || next.length > 0,
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
                    setEntry('flushCli', { value: next, original: flushOriginal.cli || '', valid: true });
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
                cliOptions={cliOptions}
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
        </form>
    );
}
