import {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type {
    SettingsCategoryId,
    SettingsPageProps,
    DirtyStore,
    SaveHandler,
    SettingsClient, SettingsScope, ManagerSettingsContext,
} from './types';
import { SETTINGS_REGISTRY, entriesForScopes } from './settings-registry';
import { normalizeDashboardLocale } from './pages/manager/shared';
import { SettingsSidebar } from './SettingsSidebar';
import { createDirtyStore } from './dirty-store';
import { createSettingsClient } from './settings-client';
import { SaveBar } from './components/SaveBar';
import { Toast, type ToastShape } from './components/Toast';
import { useSaveShortcut } from './components/useSaveShortcut';
import { describeError } from './components/error-normalize';

const PAGE_REGISTRY = Object.fromEntries(SETTINGS_REGISTRY.map(entry =>
    [entry.id, lazy(entry.load)])) as Record<SettingsCategoryId, LazyExoticComponent<ComponentType<SettingsPageProps>>>;

type Props = {
    port?: number | null;
    instanceUrl?: string | null;
    onDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
    manager?: ManagerSettingsContext;
    client?: SettingsClient;
    scopes?: readonly SettingsScope[];
    initialId?: SettingsCategoryId;
    onBack?: (() => void) | undefined;
    pageTitle?: string;
    pageBadge?: string;
};

function useDirtyStore(): DirtyStore {
    const ref = useRef<DirtyStore | null>(null);
    if (ref.current === null) ref.current = createDirtyStore();
    return ref.current;
}

function useDirtyFlag(store: DirtyStore): boolean {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.isDirty(), [store]),
        useCallback(() => false, []),
    );
}

function usePendingCount(store: DirtyStore): number {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.pending.size, [store]),
        useCallback(() => 0, []),
    );
}

export function SettingsShell({ port = null, instanceUrl = null, onDirtyChange, onSaved,
    manager, client: suppliedClient, scopes: requestedScopes, initialId, onBack, pageTitle, pageBadge }: Props) {
    const scopes = requestedScopes ?? (manager ? ['instance', 'manager'] as const : ['instance'] as const);
    const scopeKey = scopes.join(':');
    const [activeId, setActiveId] = useState<SettingsCategoryId>(initialId ?? (scopes.includes('instance') ? 'agent' : 'manager-display'));
    const [discardRevision, setDiscardRevision] = useState(0);
    const dirty = useDirtyStore();
    const isDirty = useDirtyFlag(dirty);
    const pendingCount = usePendingCount(dirty);
    const hasInstance = port !== null && instanceUrl !== null;
    const locale = normalizeDashboardLocale(manager?.ui.locale ?? document.documentElement.lang);
    const proxyClient = useMemo(() => port === null ? null : createSettingsClient(port), [port]);
    const unavailableClient: SettingsClient = useMemo(() => {
        const reject = async (): Promise<never> => { throw new Error('No selected instance'); };
        return { url: () => { throw new Error('No selected instance'); }, get: reject, put: reject, post: reject, delete: reject };
    }, []);
    const client = suppliedClient ?? proxyClient ?? unavailableClient;
    const available = entriesForScopes(scopes, hasInstance, locale).filter(entry => entry.scope !== 'manager' || manager);
    const selected = available.find(entry => entry.id === activeId) ?? available[0];
    const Page = selected ? PAGE_REGISTRY[selected.id] : null;
    const owner = useMemo(() => ({}), [port, instanceUrl, client, scopeKey, Boolean(manager)]);
    const registration = useMemo(() => ({}), [owner, selected?.id, discardRevision]);
    const activeEpochRef = useRef<object>(owner);
    const activeSaveRef = useRef<object | null>(null);
    const saveHandlerRef = useRef<{ owner: object; handler: SaveHandler } | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [toast, setToast] = useState<ToastShape | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const registerSave = useCallback((handler: SaveHandler | null) => {
        if (activeEpochRef.current !== owner) return;
        if (handler) saveHandlerRef.current = { owner: registration, handler };
        else if (saveHandlerRef.current?.owner === registration) saveHandlerRef.current = null;
    }, [owner, registration]);

    useLayoutEffect(() => {
        activeEpochRef.current = owner;
        activeSaveRef.current = null;
        dirty.clear();
        saveHandlerRef.current = null;
        setSaving(false);
        setSaveError(null);
        setToast(null);
        return () => {
            if (activeEpochRef.current === owner) {
                activeEpochRef.current = {};
                activeSaveRef.current = null;
            }
        };
    }, [owner, dirty]);

    useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
    useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

    const onSelect = (next: SettingsCategoryId) => {
        if (next === selected?.id || !available.some(entry => entry.id === next) || activeSaveRef.current) return;
        if (dirty.isDirty() && !window.confirm('Discard unsaved changes?')) return;
        dirty.clear();
        setSaveError(null);
        setToast(null);
        saveHandlerRef.current = null;
        setActiveId(next);
    };
    const onDiscard = () => {
        if (activeSaveRef.current) return;
        dirty.clear();
        setSaveError(null);
        setDiscardRevision(value => value + 1);
    };
    const onSave = useCallback(async () => {
        if (activeSaveRef.current) return;
        const handler = saveHandlerRef.current?.handler;
        setSaveError(null);
        if (!handler) {
            setSaveError('No save handler is available for this page.');
            return;
        }
        const epoch = activeEpochRef.current, operation = {};
        activeSaveRef.current = operation;
        setSaving(true);
        const current = () => activeSaveRef.current === operation && activeEpochRef.current === epoch;
        try {
            await handler();
            if (!current()) return;
            onSaved?.();
            setToast({ kind: 'ok', message: 'Saved.' });
        } catch (err: unknown) {
            if (!current()) return;
            const message = describeError(err);
            setSaveError(message);
            setToast({ kind: 'err', message: `Failed: ${message}` });
        } finally {
            if (current()) { activeSaveRef.current = null; setSaving(false); }
        }
    }, [onSaved]);

    const requestBack = () => {
        if (activeSaveRef.current) return;
        // The host owns close/port dirty confirmation; category navigation stays here.
        onBack?.();
    };
    useSaveShortcut({ enabled: isDirty && !saving, containerRef, onSave: () => { void onSave(); } });
    return (
        <div className="settings-shell-host"><div className="settings-shell" ref={containerRef}
            onKeyDown={event => {
                if (!onBack || event.key !== 'Escape' || event.defaultPrevented) return;
                if ((event.target as Element).closest('[role="dialog"], dialog, [role="listbox"]')) return;
                event.preventDefault(); event.stopPropagation(); requestBack();
            }}>
            <SettingsSidebar scopes={manager ? scopes : scopes.filter(scope => scope !== 'manager')}
                hasInstance={hasInstance} locale={locale} activeId={selected?.id ?? activeId} onSelect={onSelect} onBack={onBack ? requestBack : undefined} />
            <section className="settings-page" aria-label={pageTitle ?? selected?.label ?? 'Settings'}>
                <main className="settings-page-main">
                <header className="settings-page-heading">
                    <h2>{pageTitle ?? selected?.label ?? 'Settings'}</h2>
                    <span className="settings-page-badge">{pageBadge ?? (selected?.scope === 'manager' ? 'Manager' : 'Instance')}</span>
                </header>
                <Suspense fallback={<div className="settings-loading">Loading…</div>}>
                    {Page ? <Page key={`${selected!.id}:${port}:${scopeKey}:${discardRevision}`}
                        port={port ?? 0} instanceUrl={instanceUrl ?? ''} {...(manager ? { manager } : {})}
                        client={client} dirty={dirty} registerSave={registerSave} />
                        : <div role="alert">Settings unavailable</div>}
                </Suspense>
                <SaveBar isDirty={isDirty} saving={saving} pendingCount={pendingCount} error={saveError}
                    onDiscard={onDiscard} onSave={() => void onSave()} />
                {toast ? <Toast kind={toast.kind} message={toast.message} onDismiss={() => setToast(null)} /> : null}
                </main>
            </section>
        </div></div>
    );
}
