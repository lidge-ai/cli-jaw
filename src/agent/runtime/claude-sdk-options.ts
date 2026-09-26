import { isAbsolute } from 'node:path';
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface PreparedClaudeOptions {
    cwd: string;
    binary: string;
    env: NodeJS.ProcessEnv;
    model: string;
    systemPrompt: string;
    resumeSessionId?: string;
    permissions: 'auto' | 'safe';
    effort?: Options['effort'];
    fastMode: boolean;
    /** Code only: the exact SDK permission mode. Jaw-shaped inputs omit it and keep auto/safe. */
    sdkMode?: PermissionMode;
    /** Code only: approval cards may offer "Allow for this session". */
    sessionGrants?: boolean;
    /** Code only: lets a later live switch to bypassPermissions be legal; it does not skip prompts by itself. */
    allowDangerouslySkipPermissions?: boolean;
    /** Code only: adaptive summarized thinking on/off. Jaw-shaped inputs omit it. */
    thinking?: boolean;
}

const PREPARED_KEYS = new Set([
    'cwd', 'binary', 'env', 'model', 'systemPrompt', 'resumeSessionId', 'permissions', 'effort', 'fastMode',
    'sdkMode', 'sessionGrants', 'allowDangerouslySkipPermissions', 'thinking',
]);
const SDK_MODES: ReadonlySet<PermissionMode> = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);
const EFFORTS: ReadonlySet<Options['effort']> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function validString(value: unknown, allowEmpty = false): value is string {
    return typeof value === 'string' && !value.includes('\0')
        && (allowEmpty && value === '' || value.trim().length > 0);
}

function snapshotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid Claude SDK env');
    const entries = Object.entries(env);
    for (const [key, value] of entries) {
        if (!key || /[=\0]/.test(key)
            || value !== undefined && (typeof value !== 'string' || value.includes('\0'))) {
            throw new Error('Invalid Claude SDK env');
        }
    }
    return Object.fromEntries(entries);
}

function validatePrepared(input: PreparedClaudeOptions): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !PREPARED_KEYS.has(key))) {
        throw new Error('Invalid Claude SDK options');
    }
    if (!validString(input.cwd) || !isAbsolute(input.cwd)) throw new Error('Invalid Claude SDK cwd');
    // Detected absolute paths and PATH-resolved command names are both spawnable forms.
    if (!validString(input.binary)) throw new Error('Invalid Claude SDK binary');
    if (input.permissions !== 'auto' && input.permissions !== 'safe') {
        throw new Error('Invalid Claude SDK permissions');
    }
    if (input.sdkMode !== undefined) {
        if (!SDK_MODES.has(input.sdkMode)) throw new Error('Invalid Claude SDK permission mode');
        // The coarse gate and the exact mode must agree about bypass.
        if ((input.sdkMode === 'bypassPermissions') !== (input.permissions === 'auto')) {
            throw new Error('Invalid Claude SDK permission mode');
        }
    }
    if (input.sessionGrants !== undefined && typeof input.sessionGrants !== 'boolean') throw new Error('Invalid Claude SDK sessionGrants');
    if (input.allowDangerouslySkipPermissions !== undefined && typeof input.allowDangerouslySkipPermissions !== 'boolean') {
        throw new Error('Invalid Claude SDK allowDangerouslySkipPermissions');
    }
    if (input.effort !== undefined && !EFFORTS.has(input.effort)) throw new Error('Invalid Claude SDK effort');
    if (typeof input.fastMode !== 'boolean') throw new Error('Invalid Claude SDK fastMode');
    if (input.thinking !== undefined && typeof input.thinking !== 'boolean') throw new Error('Invalid Claude SDK thinking');
    if (!validString(input.model, true)) throw new Error('Invalid Claude SDK model');
    // Prompt bytes are preserved; whitespace-only prompts are also valid append content.
    if (typeof input.systemPrompt !== 'string' || input.systemPrompt.includes('\0')) {
        throw new Error('Invalid Claude SDK systemPrompt');
    }
    if (input.resumeSessionId !== undefined && !validString(input.resumeSessionId)) {
        throw new Error('Invalid Claude SDK resumeSessionId');
    }
}

/**
 * Thinking on = adaptive with summarized display, off = disabled; both set the matching
 * session flags. Omitted (jaw) adds nothing, so the jaw options object is unchanged.
 */
function claudeThinkingOptions(thinking: boolean | undefined, fastMode: boolean): Pick<Options, 'thinking' | 'settings'> {
    const settings: NonNullable<Options['settings']> = {
        ...(fastMode ? { fastMode: true } : {}),
        ...(thinking === undefined ? {} : { alwaysThinkingEnabled: thinking, showThinkingSummaries: thinking }),
    };
    return {
        ...(thinking === true ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(thinking === false ? { thinking: { type: 'disabled' } } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
    };
}

/** Translate a prepared snapshot only: no configuration, credential or process reads. */
export function buildClaudeSdkOptions(input: PreparedClaudeOptions): Options {
    validatePrepared(input);
    const env = snapshotEnv(input.env);
    return {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: input.binary,
        env,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPrompt },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        maxTurns: 500,
        permissionMode: input.sdkMode ?? (input.permissions === 'auto' ? 'bypassPermissions' : 'default'),
        ...(input.permissions === 'auto' || input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true } : {}),
        ...(input.model && input.model !== 'default' ? { model: input.model } : {}),
        // Match Claude print/resume args: medium leaves the provider's configured effort intact.
        ...(input.effort !== undefined && input.effort !== 'medium' ? { effort: input.effort } : {}),
        ...claudeThinkingOptions(input.thinking, input.fastMode),
        ...(input.resumeSessionId !== undefined ? { resume: input.resumeSessionId } : {}),
    };
}
