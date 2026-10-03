import type { ComponentType, LazyExoticComponent } from 'react';

import type { DashboardRegistryUi } from '../types';
import type { DashboardActivityTitleSupport } from '../dashboard-settings/activity-title-support';
export type SettingsScope = 'instance' | 'manager';
export type ManagerSettingsContext = {
    ui: DashboardRegistryUi;
    titleSupport: DashboardActivityTitleSupport;
    onUiPatch: (patch: Partial<DashboardRegistryUi>) => void;
};

export type SettingsCategoryId =
    | 'manager-display' | 'manager-activity' | 'manager-developer' | 'manager-embedding'
    | 'agent'
    | 'profile'
    | 'display'
    | 'model'
    | 'channels-telegram'
    | 'channels-discord'
    | 'channels-slack'
    | 'speech'
    | 'heartbeat'
    | 'memory'
    | 'employees'
    | 'network'
    | 'permissions'
    | 'prompts'
    | 'mcp'
    | 'browser'
    | 'dashboard-meta'
    | 'telegram-hub'
    | 'advanced-export';

export type SettingsCategoryGroup =
    | 'runtime'
    | 'identity'
    | 'mcp'
    | 'channels'
    | 'automation'
    | 'integrations'
    | 'network-security'
    | 'advanced';

export type SettingsCategory = {
    id: SettingsCategoryId;
    label: string;
    group: SettingsCategoryGroup;
    page: LazyExoticComponent<ComponentType<SettingsPageProps>>;
};

export type SaveHandler = () => Promise<void>;

export type SettingsPageProps = {
    manager?: ManagerSettingsContext;
    port: number;
    instanceUrl: string;
    client: SettingsClient;
    dirty: DirtyStore;
    /**
     * Phase 2+: a page may register a save handler. The shell exposes a single
     * Save/Discard action row driven by the dirty store; when the user clicks
     * Save, the registered handler is invoked. Pages must call
     * `registerSave(null)` on unmount to release the slot.
     */
    registerSave?: (handler: SaveHandler | null) => void;
};

export type SettingsClient = {
    url(path: string): string;
    get<T>(path: string, init?: RequestInit): Promise<T>;
    put<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
    post<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
    delete<T>(path: string, init?: RequestInit): Promise<T>;
};

export type DirtyEntry = {
    value: unknown;
    original: unknown;
    valid: boolean;
};

export type DirtyStore = {
    pending: Map<string, DirtyEntry>;
    isDirty(): boolean;
    set(key: string, entry: DirtyEntry): void;
    remove(key: string): void;
    clear(): void;
    saveBundle(): Record<string, unknown>;
    subscribe(listener: () => void): () => void;
};
