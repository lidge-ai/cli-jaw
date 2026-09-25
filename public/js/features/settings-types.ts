// ── Settings Type Definitions ──

import type { RuntimeTransport } from '../../../src/shared/runtime-contract.js';
import type { PresentationMode } from '../../../src/shared/presentation.js';

export interface PerCliConfig { provider?: string; model?: string; effort?: string; transport?: RuntimeTransport; fastMode?: boolean; }
export interface TelegramConfig { enabled?: boolean; token?: string; allowedChatIds?: number[]; forwardAll?: boolean; mentionOnly?: boolean; }
export interface DiscordConfig { enabled?: boolean; token?: string; guildId?: string; channelIds?: string[]; forwardAll?: boolean; allowBots?: boolean; mentionOnly?: boolean; }
// Slack needs TWO distinctly-scoped tokens: the bot token drives the Web API,
// the app-level token opens the Socket Mode connection for inbound events.
export interface SlackConfig { enabled?: boolean; botToken?: string; appToken?: string; teamId?: string; channelIds?: string[]; forwardAll?: boolean; allowBots?: boolean; mentionOnly?: boolean; replyInThread?: boolean; attachPort?: string; }
export interface QuotaWindow {
    label: string;
    percent: number;
    resetsAt?: string | number | null;
    modelId?: string;
    precision?: 'binary';
    status?: 'available' | 'exhausted';
}
export function resolveQuotaWindowDisplay(window: QuotaWindow): { percent: number | null; text: string } {
    if (window.precision === 'binary') {
        return {
            percent: null,
            text: window.status === 'exhausted' ? 'Exhausted' : 'Available',
        };
    }
    const percent = Math.max(0, Math.min(100, Math.round(window.percent)));
    return { percent, text: `${percent}%` };
}
export interface QuotaEntry {
    account?: { email?: string; type?: string; plan?: string; tier?: string };
    windows?: QuotaWindow[];
    authenticated?: boolean;
    error?: boolean;
    reason?: string;
    quotaCapable?: boolean;
    quotaSource?: string;
    sessionUsageCapable?: boolean;
    displayTier?: string;
    delegatedProvider?: string;
    billing?: { usedUsd?: number; limitUsd?: number; percent?: number; periodEnd?: string };
    sessionUsage?: {
        contextTokensUsed?: number | null;
        contextWindowTokens?: number | null;
        contextWindowUsage?: number | null;
        primaryModelId?: string | null;
        turnCount?: number | null;
    };
}
export interface PiProfileView { id: string; label: string; mode: string; endpoint: string; apiKind?: string; apiKeySet?: boolean; apiKeyLast4?: string; model: string; }
export interface PiSettingsView { defaultProfileId: string; profiles: PiProfileView[]; discoveredModels?: Record<string, string[]>; }
export interface RuntimeDefaultMigration {
    id: 'codex-app-default-v2';
    state: 'pending' | 'accepted' | 'kept' | 'already-codex-app';
    fromCli: string;
    toCli: 'codex-app';
}
export interface MultiSessionDefaultMigration {
    id: 'multi-session-default-v3';
    state: 'pending' | 'accepted' | 'kept' | 'already-enabled';
}
export interface CliStatusInfo {
    available: boolean | null;
    binaryInstalled: boolean | null;
    capabilityReady: boolean | null;
    authenticated: boolean | null;
    path: string | null;
    source: string;
    checkedCapability: string;
    probeState: 'checking' | 'fresh' | 'stale' | 'failing' | 'unknown';
    reason?: string;
    /** Underlying probe error, present while `failing` or `unknown`. */
    probeError?: string;
    probeFailures?: number;
    nextRetryAt?: number;
    /**
     * Last native runtime that failed before acquiring a lease, present only
     * while the row's transport is still native. Deliberately separate from
     * `probeError`: that is cached binary/auth/probe evidence with its own
     * backoff, this is a live per-turn start failure.
     */
    lastStartFailure?: { code: string; at: number };
}
export function describeCliProbe(info: CliStatusInfo): 'checking' | 'unknown' | 'probe-failing' | 'capability-failed' | 'stale' | 'ready' | 'unavailable' {
    if (info.probeState === 'checking') return 'checking';
    if (info.probeState === 'unknown') return 'unknown';
    // Ahead of every other branch: while probes keep failing we know nothing
    // current about the runtime, so a preserved snapshot must not be rendered
    // as ready or merely stale (#277).
    if (info.probeState === 'failing') return 'probe-failing';
    if (info.binaryInstalled === true && info.capabilityReady === false) return 'capability-failed';
    if (info.probeState === 'stale') return 'stale';
    return info.available === true && info.capabilityReady !== false ? 'ready' : 'unavailable';
}

export type CliProbeAvailabilityPresentation = {
    kind: 'checking' | 'unknown' | 'failing' | 'none';
    message: string | null;
    allowRemediation: boolean;
};

/** Status-only presentation shared by legacy and Manager settings surfaces. */
export function describeCliProbeAvailability(
    info: Pick<CliStatusInfo, 'probeState' | 'probeError'>,
): CliProbeAvailabilityPresentation {
    if (info.probeState === 'checking') {
        return { kind: 'checking', message: 'Checking status', allowRemediation: false };
    }
    if (info.probeState === 'unknown') {
        return {
            kind: 'unknown',
            message: `Probe unavailable${info.probeError ? `: ${info.probeError}` : ''}`,
            allowRemediation: false,
        };
    }
    if (info.probeState === 'failing') {
        return {
            kind: 'failing',
            message: `Status check failed (retrying)${info.probeError ? `: ${info.probeError}` : ''}`,
            allowRemediation: false,
        };
    }
    return { kind: 'none', message: null, allowRemediation: true };
}
export function shouldHydrateRuntimeMigrationResponse(status: number): boolean {
    return status >= 200 && status < 300 || status === 409;
}

/**
 * A selected transport that cannot start looks identical to one that works, so
 * the code the runtime raised is shown as-is (#658). It is one
 * provider-independent identifier by construction, never provider text, and it
 * says nothing about probe readiness, so it never sets `allowRemediation`.
 */
export function describeNativeStartFailure(
    info: Pick<CliStatusInfo, 'lastStartFailure'>,
): { code: string; message: string } | null {
    const code = info.lastStartFailure?.code;
    if (!code) return null;
    return { code, message: `Native runtime failed to start: ${code}` };
}
export interface MessagingConfig {
    enabledChannels?: ('telegram' | 'discord' | 'slack')[];
    homeChannel?: 'telegram' | 'discord' | 'slack';
}

export interface SettingsData {
    presentation?: { mode?: PresentationMode };
    cli: string; workingDir: string; permissions: string; locale?: string; showReasoning?: boolean;
    perCli?: Record<string, PerCliConfig>;
    activeOverrides?: Record<string, PerCliConfig>;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    slack?: SlackConfig;
    slackEnvironmentVariables?: string[];
    telegramEnvironmentVariables?: string[];
    discordEnvironmentVariables?: string[];
    /** @deprecated Use messaging.homeChannel (response alias). */
    channel?: 'telegram' | 'discord' | 'slack';
    messaging?: MessagingConfig;
    fallbackOrder?: string[];
    memory?: { cli?: string };
    projectDirs?: string[] | null;
    stt?: { engine?: string; geminiKeySet?: boolean; geminiKeyLast4?: string; geminiModel?: string; whisperModel?: string; openaiKeySet?: boolean; openaiKeyLast4?: string };
    pi?: PiSettingsView;
    settingsSchemaVersion?: number;
    runtimeDefaultMigration?: RuntimeDefaultMigration | null;
    multiSessionDefaultMigration?: MultiSessionDefaultMigration | null;
    multiSession?: {
        enabled?: boolean;
        /** Mid-run message policy; server normalizes every invalid value to 'steer'. */
        midRunPolicy?: 'steer' | 'followup' | 'collect' | 'interrupt';
    };
}
