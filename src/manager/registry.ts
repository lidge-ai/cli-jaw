import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';
import {
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
    MANAGED_INSTANCE_PORT_TO,
} from './constants.js';
import { dashboardPath, resolveDashboardHome } from './dashboard-home.js';
import { deriveProfiles, mergeProfiles } from './profiles.js';
import type { TelegramHubConfig, ThreadRoute } from './telegram-hub/types.js';
import type {
    DashboardDiffMode,
    DashboardDiffRootPolicy,
    DashboardDetailTab,
    DashboardInstance,
    DashboardProfile,
    DashboardProfileId,
    DashboardRegistry,
    DashboardRegistryInstance,
    DashboardRegistryPatch,
    DashboardRegistryStatus,
    DashboardRegistryUi,
    DashboardShortcutAction,
    DashboardShortcutKeymap,
    DashboardScanResult,
    DashboardSidebarMode,
    DashboardNotesAuthoringMode,
    DashboardNotesGraphSettings,
    DashboardNotesViewMode,
    DashboardUiTheme,
    DashboardLocale,
} from './types.js';

const REGISTRY_FILE = 'manager-instances.json';
const MIN_ACTIVITY_HEIGHT = 88;
const MAX_ACTIVITY_HEIGHT = 320;
const DEFAULT_ACTIVITY_HEIGHT = 150;
const MIN_NOTES_TREE_WIDTH = 220;
const MAX_NOTES_TREE_WIDTH = 420;
const DEFAULT_NOTES_TREE_WIDTH = 280;
const DETAIL_TABS: DashboardDetailTab[] = ['overview', 'preview', 'logs', 'settings'];
const UI_THEMES: DashboardUiTheme[] = ['auto', 'dark', 'light'];
const LOCALES: DashboardLocale[] = ['ko', 'en', 'zh', 'ja'];
const SIDEBAR_MODES: DashboardSidebarMode[] = ['instances', 'board', 'schedule', 'notes', 'reminders', 'settings'];
const NOTES_VIEW_MODES: DashboardNotesViewMode[] = ['raw', 'split', 'preview', 'settings', 'graph'];
const NOTES_AUTHORING_MODES: DashboardNotesAuthoringMode[] = ['plain', 'rich', 'wysiwyg'];
const NOTES_GRAPH_SECTIONS = ['filters', 'display', 'forces', 'groups'] as const;
const DIFF_ROOT_POLICIES: DashboardDiffRootPolicy[] = ['project-first', 'working-dir-first', 'manual'];
const DIFF_MODES: DashboardDiffMode[] = ['unstaged', 'staged', 'head', 'base'];
const SHORTCUT_ACTIONS: DashboardShortcutAction[] = [
    'toggleInstanceSettings',
    'focusInstances',
    'focusActiveSession',
    'focusNotes',
    'previousInstance',
    'nextInstance',
];

export const DEFAULT_DASHBOARD_SHORTCUT_KEYMAP: DashboardShortcutKeymap = {
    toggleInstanceSettings: 'Meta+,',
    focusInstances: 'Alt+I',
    focusActiveSession: 'Alt+P',
    focusNotes: 'Alt+N',
    previousInstance: 'Alt+K',
    nextInstance: 'Alt+J',
};

export const DEFAULT_DASHBOARD_NOTES_GRAPH_SETTINGS: DashboardNotesGraphSettings = {
    version: 1,
    panelOpen: true,
    collapsedSections: {},
    query: '',
    existingFilesOnly: false,
    showOrphans: true,
    showTags: true,
    showAttachments: false,
    focusSelected: false,
    focusDepth: 1,
    groupMode: 'query',
    groups: [],
    nodeSize: 1,
    linkDistance: 92,
    chargeStrength: -180,
    labelDensity: 0.6,
    showArrows: false,
    animate: true,
};

export type DashboardRegistryLoadResult = {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
};

type RegistryOptions = {
    path?: string;
    from?: number;
    count?: number;
};

type ApplyOptions = {
    showHidden?: boolean;
};

type StatusOptions = {
    dashboardHome?: string;
    migratedFrom?: string | null;
};

function legacyManagerHome(): string {
    const home = process.env["CLI_JAW_HOME"] || join(homedir(), '.cli-jaw');
    return resolveHomePath(home, homedir());
}

function legacyRegistryPath(): string {
    return join(legacyManagerHome(), REGISTRY_FILE);
}

export function dashboardRegistryPath(): string {
    return dashboardPath(REGISTRY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function validInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}

function readProfileId(value: unknown): DashboardProfileId | null {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : null;
}

function normalizeActivitySeenByPort(value: unknown): Record<string, string> {
    const input = isRecord(value) ? value : {};
    const seenByPort: Record<string, string> = {};
    for (const [key, seenAt] of Object.entries(input)) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (typeof seenAt !== 'string' || Number.isNaN(Date.parse(seenAt))) continue;
        seenByPort[String(port)] = seenAt;
    }
    return seenByPort;
}

function normalizeDiffPinnedRootByPort(value: unknown): Record<string, string> {
    const input = isRecord(value) ? value : {};
    const roots: Record<string, string> = {};
    for (const [key, root] of Object.entries(input)) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (typeof root !== 'string' || !root.trim()) continue;
        roots[String(port)] = root.trim().slice(0, 2048);
    }
    return roots;
}

function normalizeDiffRecentRepoRoots(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const root = item.trim().slice(0, 2048);
        if (!root || seen.has(root)) continue;
        seen.add(root);
        roots.push(root);
        if (roots.length >= 8) break;
    }
    return roots;
}

function normalizeShortcutChord(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim().replace(/\s+/g, '');
    if (!trimmed || trimmed.length > 40) return fallback;
    const parts = trimmed.split('+').filter(Boolean);
    if (parts.length === 0) return fallback;
    return parts.map(part => {
        const lower = part.toLowerCase();
        // Meta is the primary modifier (⌘ on macOS, Ctrl elsewhere); Win keeps
        // the physical Windows/Super key. The client resolves both at match time.
        if (lower === 'cmd' || lower === 'meta' || lower === 'command' || lower === 'mod') return 'Meta';
        if (lower === 'win' || lower === 'windows' || lower === 'super') return 'Win';
        if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
        if (lower === 'alt' || lower === 'option') return 'Alt';
        if (lower === 'shift') return 'Shift';
        if (lower.length === 1) return lower.toUpperCase();
        if (lower === 'arrowup') return 'ArrowUp';
        if (lower === 'arrowdown') return 'ArrowDown';
        if (lower === 'arrowleft') return 'ArrowLeft';
        if (lower === 'arrowright') return 'ArrowRight';
        return part;
    }).join('+');
}

function normalizeShortcutKeymap(value: unknown): DashboardShortcutKeymap {
    const input = isRecord(value) ? value : {};
    const keymap = { ...DEFAULT_DASHBOARD_SHORTCUT_KEYMAP };
    for (const action of SHORTCUT_ACTIONS) {
        keymap[action] = normalizeShortcutChord(input[action], DEFAULT_DASHBOARD_SHORTCUT_KEYMAP[action]);
    }
    return keymap;
}

function readGraphColor(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function normalizeNotesGraphSettings(value: unknown): DashboardNotesGraphSettings {
    const input = isRecord(value) ? value : {};
    const fallback = DEFAULT_DASHBOARD_NOTES_GRAPH_SETTINGS;
    const collapsedInput = isRecord(input["collapsedSections"]) ? input["collapsedSections"] : {};
    const collapsedSections: DashboardNotesGraphSettings["collapsedSections"] = {};
    for (const section of NOTES_GRAPH_SECTIONS) {
        if (typeof collapsedInput[section] === 'boolean') collapsedSections[section] = collapsedInput[section];
    }
    const groupsInput = Array.isArray(input["groups"]) ? input["groups"] : [];
    const groups = groupsInput.flatMap((candidate, index) => {
        if (!isRecord(candidate)) return [];
        const id = readString(candidate["id"]) ?? `group-${index + 1}`;
        const label = readString(candidate["label"]) ?? `Group ${index + 1}`;
        const query = readString(candidate["query"]) ?? '';
        if (!query) return [];
        return [{
            id,
            label,
            query: query.slice(0, 240),
            color: readGraphColor(candidate["color"], '#7c9cff'),
            enabled: typeof candidate["enabled"] === 'boolean' ? candidate["enabled"] : true,
        }];
    }).slice(0, 20);
    return {
        version: 1,
        panelOpen: typeof input["panelOpen"] === 'boolean' ? input["panelOpen"] : fallback.panelOpen,
        collapsedSections,
        query: typeof input["query"] === 'string' ? input["query"].trim().slice(0, 240) : fallback.query,
        existingFilesOnly: typeof input["existingFilesOnly"] === 'boolean' ? input["existingFilesOnly"] : fallback.existingFilesOnly,
        showOrphans: typeof input["showOrphans"] === 'boolean' ? input["showOrphans"] : fallback.showOrphans,
        showTags: typeof input["showTags"] === 'boolean' ? input["showTags"] : fallback.showTags,
        showAttachments: typeof input["showAttachments"] === 'boolean' ? input["showAttachments"] : fallback.showAttachments,
        focusSelected: typeof input["focusSelected"] === 'boolean' ? input["focusSelected"] : fallback.focusSelected,
        focusDepth: clampInt(input["focusDepth"], fallback.focusDepth, 1, 4),
        groupMode: input["groupMode"] === 'off' || input["groupMode"] === 'query' ? input["groupMode"] : fallback.groupMode,
        groups,
        nodeSize: clampNumber(input["nodeSize"], fallback.nodeSize, 0.6, 2),
        linkDistance: clampInt(input["linkDistance"], fallback.linkDistance, 40, 240),
        chargeStrength: clampInt(input["chargeStrength"], fallback.chargeStrength, -800, -20),
        labelDensity: clampNumber(input["labelDensity"], fallback.labelDensity, 0, 1),
        showArrows: typeof input["showArrows"] === 'boolean' ? input["showArrows"] : fallback.showArrows,
        animate: typeof input["animate"] === 'boolean' ? input["animate"] : fallback.animate,
    };
}

function defaultUi(): DashboardRegistryUi {
    return {
        selectedPort: null,
        selectedTab: 'overview',
        instanceSettingsOpen: false,
        sidebarCollapsed: false,
        activityDockCollapsed: false,
        activityDockHeight: DEFAULT_ACTIVITY_HEIGHT,
        activitySeenAt: null,
        activitySeenByPort: {},
        uiTheme: 'auto',
        locale: 'ko',
        sidebarMode: 'instances',
        notesSelectedPath: null,
        notesViewMode: 'split',
        notesAuthoringMode: 'plain',
        notesWordWrap: true,
        notesVimMode: false,
        notesTreeWidth: DEFAULT_NOTES_TREE_WIDTH,
        notesGraphSettings: { ...DEFAULT_DASHBOARD_NOTES_GRAPH_SETTINGS, collapsedSections: {}, groups: [] },
        showLatestActivityTitles: true,
        showInlineLabelEditor: true,
        showSidebarRuntimeLine: true,
        showSelectedRowActions: true,
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: { ...DEFAULT_DASHBOARD_SHORTCUT_KEYMAP },
        diffRootPolicy: 'project-first',
        diffPinnedRootByPort: {},
        diffRecentRepoRoots: [],
        diffDefaultMode: 'unstaged',
        diffBaseRef: 'HEAD',
        diffIncludeUntracked: true,
        rightFolderRootPath: null,
    };
}

export function defaultDashboardRegistry(options: RegistryOptions = {}): DashboardRegistry {
    const from = clampInt(options.from, MANAGED_INSTANCE_PORT_FROM, 1, 65535);
    const maxCount = Math.max(1, 65535 - from + 1);
    const count = clampInt(options.count, MANAGED_INSTANCE_PORT_COUNT, 1, Math.min(MANAGED_INSTANCE_PORT_COUNT, maxCount));
    return { scan: { from, count }, ui: defaultUi(), instances: {}, profiles: {}, activeProfileFilter: [], telegramHub: normalizeTelegramHub(undefined) };
}

function normalizeUi(value: unknown): DashboardRegistryUi {
    const input = isRecord(value) ? value : {};
    const fallback = defaultUi();
    const selectedPort = input["selectedPort"] == null
        ? null
        : clampInt(input["selectedPort"], 0, 1, 65535);
    const selectedTab = DETAIL_TABS.includes(input["selectedTab"] as DashboardDetailTab)
        ? input["selectedTab"] as DashboardDetailTab
        : fallback.selectedTab;
    const uiTheme = UI_THEMES.includes(input["uiTheme"] as DashboardUiTheme)
        ? input["uiTheme"] as DashboardUiTheme
        : fallback.uiTheme;
    const locale = LOCALES.includes(input["locale"] as DashboardLocale)
        ? input["locale"] as DashboardLocale
        : fallback.locale;
    const sidebarMode = SIDEBAR_MODES.includes(input["sidebarMode"] as DashboardSidebarMode)
        ? input["sidebarMode"] as DashboardSidebarMode
        : fallback.sidebarMode;
    const notesViewMode = NOTES_VIEW_MODES.includes(input["notesViewMode"] as DashboardNotesViewMode)
        ? input["notesViewMode"] as DashboardNotesViewMode
        : fallback.notesViewMode;
    const notesAuthoringMode = NOTES_AUTHORING_MODES.includes(input["notesAuthoringMode"] as DashboardNotesAuthoringMode)
        ? input["notesAuthoringMode"] as DashboardNotesAuthoringMode
        : fallback.notesAuthoringMode;
    const diffRootPolicy = DIFF_ROOT_POLICIES.includes(input["diffRootPolicy"] as DashboardDiffRootPolicy)
        ? input["diffRootPolicy"] as DashboardDiffRootPolicy
        : fallback.diffRootPolicy;
    const diffDefaultMode = DIFF_MODES.includes(input["diffDefaultMode"] as DashboardDiffMode)
        ? input["diffDefaultMode"] as DashboardDiffMode
        : fallback.diffDefaultMode;
    return {
        selectedPort,
        selectedTab,
        instanceSettingsOpen: typeof input["instanceSettingsOpen"] === 'boolean'
            ? input["instanceSettingsOpen"] : fallback.instanceSettingsOpen,
        sidebarCollapsed: typeof input["sidebarCollapsed"] === 'boolean' ? input["sidebarCollapsed"] : fallback.sidebarCollapsed,
        activityDockCollapsed: typeof input["activityDockCollapsed"] === 'boolean' ? input["activityDockCollapsed"] : fallback.activityDockCollapsed,
        activityDockHeight: clampInt(input["activityDockHeight"], fallback.activityDockHeight, MIN_ACTIVITY_HEIGHT, MAX_ACTIVITY_HEIGHT),
        activitySeenAt: typeof input["activitySeenAt"] === 'string' && !Number.isNaN(Date.parse(input["activitySeenAt"]))
            ? input["activitySeenAt"]
            : null,
        activitySeenByPort: normalizeActivitySeenByPort(input["activitySeenByPort"]),
        uiTheme,
        locale,
        sidebarMode,
        notesSelectedPath: typeof input["notesSelectedPath"] === 'string' && input["notesSelectedPath"].trim()
            ? input["notesSelectedPath"].trim()
            : null,
        notesViewMode,
        notesAuthoringMode,
        notesWordWrap: typeof input["notesWordWrap"] === 'boolean' ? input["notesWordWrap"] : fallback.notesWordWrap,
        notesVimMode: typeof input["notesVimMode"] === 'boolean' ? input["notesVimMode"] : fallback.notesVimMode,
        notesTreeWidth: clampInt(input["notesTreeWidth"], fallback.notesTreeWidth, MIN_NOTES_TREE_WIDTH, MAX_NOTES_TREE_WIDTH),
        notesGraphSettings: normalizeNotesGraphSettings(input["notesGraphSettings"]),
        showLatestActivityTitles: typeof input["showLatestActivityTitles"] === 'boolean' ? input["showLatestActivityTitles"] : fallback.showLatestActivityTitles,
        showInlineLabelEditor: typeof input["showInlineLabelEditor"] === 'boolean' ? input["showInlineLabelEditor"] : fallback.showInlineLabelEditor,
        showSidebarRuntimeLine: typeof input["showSidebarRuntimeLine"] === 'boolean' ? input["showSidebarRuntimeLine"] : fallback.showSidebarRuntimeLine,
        showSelectedRowActions: typeof input["showSelectedRowActions"] === 'boolean' ? input["showSelectedRowActions"] : fallback.showSelectedRowActions,
        dashboardShortcutsEnabled: typeof input["dashboardShortcutsEnabled"] === 'boolean' ? input["dashboardShortcutsEnabled"] : fallback.dashboardShortcutsEnabled,
        dashboardShortcutKeymap: normalizeShortcutKeymap(input["dashboardShortcutKeymap"]),
        diffRootPolicy,
        diffPinnedRootByPort: normalizeDiffPinnedRootByPort(input["diffPinnedRootByPort"]),
        diffRecentRepoRoots: normalizeDiffRecentRepoRoots(input["diffRecentRepoRoots"]),
        diffDefaultMode,
        diffBaseRef: readString(input["diffBaseRef"]) ?? fallback.diffBaseRef,
        diffIncludeUntracked: typeof input["diffIncludeUntracked"] === 'boolean' ? input["diffIncludeUntracked"] : fallback.diffIncludeUntracked,
        rightFolderRootPath: readString(input["rightFolderRootPath"]) ?? fallback.rightFolderRootPath,
        ...normalizePanelLayoutUi(input),
    };
}

const PANEL_TAB_KINDS = new Set(['files', 'diff', 'browser', 'design']);
const MAX_PANEL_TABS = 32;

/**
 * Preserve (with bounds) the desktop panel-layout fields written by the
 * Electron manager frontend. Without this passthrough the whitelist above
 * silently drops the right-sidebar tab model on every registry write, so tab
 * state never survives a manager restart.
 */
function normalizePanelLayoutUi(input: Record<string, unknown>): Partial<DashboardRegistryUi> {
    const out: Partial<DashboardRegistryUi> = {};
    if (typeof input["panelLayoutVersion"] === 'number' && Number.isInteger(input["panelLayoutVersion"])) {
        out.panelLayoutVersion = input["panelLayoutVersion"];
    }
    if (typeof input["rightPanelOpen"] === 'boolean') out.rightPanelOpen = input["rightPanelOpen"];
    if (typeof input["rightPanelWidth"] === 'number' && Number.isFinite(input["rightPanelWidth"])) {
        out.rightPanelWidth = Math.min(10000, Math.max(100, Math.round(input["rightPanelWidth"])));
    }
    if (Array.isArray(input["rightSidebarOpenTabs"])) {
        const tabs: Array<Record<string, unknown>> = [];
        for (const raw of input["rightSidebarOpenTabs"]) {
            if (!isRecord(raw)) continue;
            if (typeof raw["id"] !== 'string' || !PANEL_TAB_KINDS.has(String(raw["kind"]))) continue;
            const tab: Record<string, unknown> = {
                id: raw["id"].slice(0, 200),
                kind: raw["kind"],
                title: typeof raw["title"] === 'string' ? raw["title"].slice(0, 200) : '',
            };
            if (typeof raw["specificName"] === 'string') tab["specificName"] = raw["specificName"].slice(0, 200);
            if (typeof raw["sourceLabel"] === 'string') tab["sourceLabel"] = raw["sourceLabel"].slice(0, 2000);
            if (typeof raw["ordinal"] === 'number' && Number.isInteger(raw["ordinal"])) tab["ordinal"] = raw["ordinal"];
            if (raw["pinned"] === true) tab["pinned"] = true;
            for (const slot of ['files', 'browser', 'design'] as const) {
                if (isRecord(raw[slot])) tab[slot] = raw[slot];
            }
            tabs.push(tab);
            if (tabs.length >= MAX_PANEL_TABS) break;
        }
        out.rightSidebarOpenTabs = tabs;
    }
    if (typeof input["rightSidebarActiveTabId"] === 'string' || input["rightSidebarActiveTabId"] === null) {
        out.rightSidebarActiveTabId = input["rightSidebarActiveTabId"];
    }
    if (isRecord(input["rightSidebarNextOrdinalByKind"])) {
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(input["rightSidebarNextOrdinalByKind"])) {
            if (PANEL_TAB_KINDS.has(key) && typeof value === 'number' && Number.isInteger(value) && value > 0) next[key] = value;
        }
        out.rightSidebarNextOrdinalByKind = next;
    }
    const layout = input["fileFolderLayout"];
    if (isRecord(layout)
        && (layout["mode"] === 'split' || layout["mode"] === 'folder-only' || layout["mode"] === 'file-only')
        && typeof layout["splitRatio"] === 'number' && Number.isFinite(layout["splitRatio"])
        && typeof layout["lastSplitRatio"] === 'number' && Number.isFinite(layout["lastSplitRatio"])) {
        out.fileFolderLayout = {
            mode: layout["mode"],
            splitRatio: Math.max(0, Math.min(1, layout["splitRatio"])),
            lastSplitRatio: Math.max(0, Math.min(1, layout["lastSplitRatio"])),
        };
    }
    if (typeof input["bottomPanelOpen"] === 'boolean') out.bottomPanelOpen = input["bottomPanelOpen"];
    if (typeof input["bottomPanelHeight"] === 'number' && Number.isFinite(input["bottomPanelHeight"])) {
        out.bottomPanelHeight = Math.min(2000, Math.max(100, Math.round(input["bottomPanelHeight"])));
    }
    if (Array.isArray(input["bottomPanelTabs"])) {
        out.bottomPanelTabs = input["bottomPanelTabs"].filter((tab): tab is string => typeof tab === 'string').slice(0, 8);
    }
    if (typeof input["bottomPanelActiveTab"] === 'string' || input["bottomPanelActiveTab"] === null) {
        out.bottomPanelActiveTab = input["bottomPanelActiveTab"];
    }
    return out;
}

function normalizeInstance(value: unknown): DashboardRegistryInstance {
    const input = isRecord(value) ? value : {};
    return {
        label: readString(input["label"]),
        favorite: input["favorite"] === true,
        group: readString(input["group"]),
        hidden: input["hidden"] === true,
        notes: readString(input["notes"]),
    };
}

function normalizeProfile(key: string, value: unknown): Partial<DashboardProfile> | null {
    const profileId = readProfileId(key);
    const input = isRecord(value) ? value : {};
    if (!profileId) return null;
    const homePath = readString(input["homePath"]);
    if (!homePath && Object.keys(input).length > 0) return null;
    return stripUndefined({
        profileId,
        label: readString(input["label"]) || undefined,
        homePath: homePath || undefined,
        preferredPort: input["preferredPort"] == null ? undefined : clampInt(input["preferredPort"], 0, 1, 65535),
        serviceMode: ['unknown', 'ad-hoc', 'service', 'manager'].includes(String(input["serviceMode"]))
            ? input["serviceMode"] as DashboardProfile['serviceMode']
            : undefined,
        defaultCli: readString(input["defaultCli"]) || undefined,
        notes: readString(input["notes"]) || undefined,
        lastSeenAt: typeof input["lastSeenAt"] === 'string' && !Number.isNaN(Date.parse(input["lastSeenAt"])) ? input["lastSeenAt"] : undefined,
        pinned: typeof input["pinned"] === 'boolean' ? input["pinned"] : undefined,
        color: readString(input["color"]) || undefined,
    });
}

/** Normalize the telegramHub registry block (validates routes + port range). Exported for unit tests. */
export function normalizeTelegramHub(value: unknown): TelegramHubConfig {
    const input = isRecord(value) ? value : {};
    const rawRoutes = Array.isArray(input["routes"]) ? input["routes"] : [];
    const routes: ThreadRoute[] = [];
    for (const r of rawRoutes) {
        if (!isRecord(r)) continue;
        const chatId = readString(r["chatId"]);
        const threadId = readString(r["threadId"]);
        const port = Number(r["port"]);
        if (!chatId || !threadId
            || !Number.isInteger(port) || port < MANAGED_INSTANCE_PORT_FROM || port > MANAGED_INSTANCE_PORT_TO) continue;
        routes.push(stripUndefined({
            chatId, threadId, port,
            label: readString(r["label"]) || undefined,
            enabled: r["enabled"] !== false,
            systemPrompt: readString(r["systemPrompt"]) || undefined,
            model: readString(r["model"]) || undefined,
        }) as ThreadRoute);
    }
    const defaultPort = Number(input["defaultPort"]);
    return {
        enabled: input["enabled"] === true,
        token: readString(input["token"]) || '',
        chatId: readString(input["chatId"]) || '',
        defaultPort: Number.isInteger(defaultPort) && defaultPort >= MANAGED_INSTANCE_PORT_FROM && defaultPort <= MANAGED_INSTANCE_PORT_TO
            ? defaultPort : MANAGED_INSTANCE_PORT_FROM,
        routes,
    };
}

export function normalizeDashboardRegistry(value: unknown, options: RegistryOptions = {}): DashboardRegistry {
    const input = isRecord(value) ? value : {};
    const defaults = defaultDashboardRegistry(options);
    const scan = isRecord(input["scan"]) ? input["scan"] : {};
    const from = validInt(scan["from"], defaults.scan.from, 1, 65535);
    const count = clampInt(scan["count"], defaults.scan.count, 1, Math.min(MANAGED_INSTANCE_PORT_COUNT, 65535 - from + 1));
    const instances: Record<string, DashboardRegistryInstance> = {};
    const rawInstances = isRecord(input["instances"]) ? input["instances"] : {};
    const profiles: Record<string, Partial<DashboardProfile>> = {};
    const rawProfiles = isRecord(input["profiles"]) ? input["profiles"] : {};

    for (const [key, raw] of Object.entries(rawInstances)) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || raw == null) continue;
        instances[String(port)] = normalizeInstance(raw);
    }

    for (const [key, raw] of Object.entries(rawProfiles)) {
        if (raw == null) continue;
        const normalized = normalizeProfile(key, raw);
        if (normalized) profiles[key] = normalized;
    }

    const activeProfileFilter = Array.isArray(input["activeProfileFilter"])
        ? input["activeProfileFilter"].map(readProfileId).filter((value): value is DashboardProfileId => Boolean(value))
        : [];

    return { scan: { from, count }, ui: normalizeUi(input["ui"]), instances, profiles, activeProfileFilter, telegramHub: normalizeTelegramHub(input["telegramHub"]) };
}

function statusFor(path: string, loaded: boolean, error: string | null, registry: DashboardRegistry, options: StatusOptions = {}): DashboardRegistryStatus {
    return stripUndefined({
        path,
        loaded,
        error,
        ui: registry.ui,
        dashboardHome: options.dashboardHome,
        migratedFrom: options.migratedFrom ?? null,
    });
}

function readRegistryFile(path: string, options: RegistryOptions, statusOptions: StatusOptions = {}): DashboardRegistryLoadResult {
    try {
        const registry = normalizeDashboardRegistry(JSON.parse(readFileSync(path, 'utf8')), options);
        return { registry, status: statusFor(path, true, null, registry, statusOptions) };
    } catch (error) {
        const registry = defaultDashboardRegistry(options);
        return { registry, status: statusFor(path, false, (error as Error).message, registry, statusOptions) };
    }
}

function migrateLegacyRegistry(path: string, legacyPath: string, options: RegistryOptions, dashboardHome: string): DashboardRegistryLoadResult {
    try {
        const registry = normalizeDashboardRegistry(JSON.parse(readFileSync(legacyPath, 'utf8')), options);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
        return {
            registry,
            status: statusFor(path, true, null, registry, { dashboardHome, migratedFrom: legacyPath }),
        };
    } catch (error) {
        const registry = defaultDashboardRegistry(options);
        return {
            registry,
            status: statusFor(path, false, (error as Error).message, registry, { dashboardHome, migratedFrom: null }),
        };
    }
}

export function loadDashboardRegistry(options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const path = options.path || dashboardRegistryPath();
    if (options.path) {
        if (!existsSync(path)) {
            const registry = defaultDashboardRegistry(options);
            return { registry, status: statusFor(path, true, null, registry) };
        }
        return readRegistryFile(path, options);
    }

    const dashboardHome = resolveDashboardHome();
    if (!existsSync(path)) {
        const legacyPath = legacyRegistryPath();
        if (existsSync(legacyPath)) {
            return migrateLegacyRegistry(path, legacyPath, options, dashboardHome);
        }
        const registry = defaultDashboardRegistry(options);
        return { registry, status: statusFor(path, true, null, registry, { dashboardHome, migratedFrom: null }) };
    }

    return readRegistryFile(path, options, { dashboardHome, migratedFrom: null });
}

export function saveDashboardRegistry(registry: DashboardRegistry, options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const path = options.path || dashboardRegistryPath();
    const normalized = normalizeDashboardRegistry(registry, options);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
    const statusOptions = options.path
        ? {}
        : { dashboardHome: resolveDashboardHome(), migratedFrom: null };
    return { registry: normalized, status: statusFor(path, true, null, normalized, statusOptions) };
}

export function patchDashboardRegistry(patch: DashboardRegistryPatch, options: RegistryOptions = {}): DashboardRegistryLoadResult {
    const current = loadDashboardRegistry(options).registry;
    const next: DashboardRegistry = normalizeDashboardRegistry({
        scan: { ...current.scan, ...patch.scan },
        ui: { ...current.ui, ...patch.ui },
        instances: { ...current.instances },
        profiles: { ...current.profiles },
        activeProfileFilter: patch.activeProfileFilter ?? current.activeProfileFilter,
        telegramHub: patch.telegramHub ? { ...current.telegramHub, ...patch.telegramHub } : current.telegramHub,
    }, options);

    for (const [key, value] of Object.entries(patch.instances || {})) {
        const port = Number(key);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (value === null) {
            delete next.instances[String(port)];
            continue;
        }
        next.instances[String(port)] = normalizeInstance({ ...next.instances[String(port)], ...value });
    }

    for (const [key, value] of Object.entries(patch.profiles || {})) {
        const profileId = readProfileId(key);
        if (!profileId) continue;
        if (value === null) {
            delete next.profiles[profileId];
            continue;
        }
        const normalized = normalizeProfile(profileId, { ...next.profiles[profileId], ...value });
        if (normalized) next.profiles[profileId] = normalized;
    }

    return saveDashboardRegistry(next, options);
}

function overlayInstance(instance: DashboardInstance, registry: DashboardRegistry): DashboardInstance {
    const saved = registry.instances[String(instance.port)];
    return {
        ...instance,
        label: saved?.label || null,
        favorite: saved?.favorite === true,
        group: saved?.group || null,
        hidden: saved?.hidden === true,
    };
}

export function applyDashboardRegistry(result: DashboardScanResult, registry: DashboardRegistry, status: DashboardRegistryStatus, options: ApplyOptions = {}): DashboardScanResult {
    const derived = deriveProfiles(result.instances);
    const registryProfiles = Object.entries(registry.profiles)
        .map(([profileId, profile]) => materializeProfile(profileId, profile))
        .filter((profile): profile is DashboardProfile => Boolean(profile));
    const profiles = mergeProfiles(mergeProfiles(derived.profiles, registryProfiles), result.manager.profiles || []);
    const instances = derived.instances
        .map(instance => overlayInstance(instance, registry))
        .filter(instance => options.showHidden || !instance.hidden);

    return {
        manager: { ...result.manager, registry: status, profiles },
        instances,
    };
}

function materializeProfile(profileId: string, profile: Partial<DashboardProfile>): DashboardProfile | null {
    const normalizedId = readProfileId(profileId);
    if (!normalizedId || !profile.homePath) return null;
    return {
        profileId: normalizedId,
        label: readString(profile.label) || normalizedId,
        homePath: profile.homePath,
        preferredPort: profile.preferredPort ?? null,
        serviceMode: profile.serviceMode || 'unknown',
        defaultCli: profile.defaultCli || null,
        notes: profile.notes || null,
        lastSeenAt: profile.lastSeenAt || null,
        pinned: profile.pinned === true,
        color: profile.color || null,
    };
}
