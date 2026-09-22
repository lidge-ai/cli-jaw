// ─── Runtime Handlers ─────────────────────────────────
import { sessionScopeMeta } from './session-scope-meta.js';
// Extracted from handlers.ts for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { applyCodexModelsToChoices, resolveOpenCodexCodexModels } from './opencodex-models.js';
import { t } from '../core/i18n.js';
import { detectCli, settings } from '../core/config.js';
import { getSession } from '../core/db.js';
import { resolveMainCli, type MainSessionRecord } from '../core/main-session.js';
import { isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';
import { beginSteerInput } from '../agent/steer-input-guard.js';

async function safeCall<T>(
    fn: (() => Promise<T> | T) | undefined | null,
    fallback: T | null = null,
): Promise<T | null> {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch (err: unknown) {
        if (process.env["DEBUG"]) console.warn('[commands:safeCall]', (err as Error).message);
        return fallback;
    }
}

export async function memoryHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'status') {
        const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
        const routing = status?.["routing"] as { searchRead?: string; save?: string } | undefined;
        const lines = [
            `🧠 Memory`,
            `State: ${status?.["state"] || '-'}`,
            `Storage: ${status?.["storageRoot"] || '-'}`,
            `Search/Read: ${routing?.searchRead || 'basic'}`,
            `Save: ${routing?.save || 'basic'}`,
            `Indexed files: ${status?.["indexedFiles"] || 0}`,
            `Indexed chunks: ${status?.["indexedChunks"] || 0}`,
        ];
        return { ok: true, text: lines.join('\n') };
    }
    if (sub === 'bootstrap') {
        const result = await ctx.bootstrapMemory?.({
            importCore: true,
            importMarkdown: true,
            importKv: true,
            importClaudeSession: true,
        }) as { root?: string; counts?: Record<string, number> } | undefined;
        return {
            ok: true,
            text: [
                '🧠 Memory bootstrap completed',
                `Root: ${result?.root || '-'}`,
                `Imported core=${result?.counts?.["core"] || 0}, markdown=${result?.counts?.["markdown"] || 0}, kv=${result?.counts?.["kv"] || 0}, claude=${result?.counts?.["claude"] || 0}`,
            ].join('\n'),
        };
    }
    if (sub === 'reindex') {
        const result = await ctx.reindexMemory?.() as { totalFiles?: number; totalChunks?: number } | undefined;
        return {
            ok: true,
            text: [
                '🧠 Memory reindex completed',
                `Files: ${result?.totalFiles || 0}`,
                `Chunks: ${result?.totalChunks || 0}`,
            ].join('\n'),
        };
    }
    if (sub === 'embed') {
        try {
            const { DASHBOARD_DEFAULT_PORT } = await import('../manager/constants.js');
            const port = Number(process.env['DASHBOARD_PORT']) || Number(DASHBOARD_DEFAULT_PORT);
            const action = String(args[1] || 'status').toLowerCase();
            const url = `http://127.0.0.1:${port}/api/dashboard/memory`;
            if (action === 'status' || action === 'state') {
                const res = await fetch(`${url}/embed-state`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) return { ok: false, text: `Embed state request failed: HTTP ${res.status}` };
                const body = await res.json() as { ok: boolean; status: Record<string, unknown> };
                const s = body.status || {};
                return {
                    ok: true,
                    text: [
                        `🔍 Embedding: ${s['state'] || 'OFF'}`,
                        `Mode: ${s['mode'] || '-'}  Provider: ${s['provider'] || '-'}/${s['model'] || '-'}`,
                        `Chunks: ${s['indexedChunks'] || 0}  DB: ${Number(s['dbSizeBytes'] || 0) > 0 ? ((Number(s['dbSizeBytes'])) / 1024 / 1024).toFixed(1) + ' MB' : '-'}`,
                        `Last sync: ${s['lastSyncAt'] || 'never'}`,
                        s['fallback'] ? `Fallback: ${s['reason']}` : '',
                    ].filter(Boolean).join('\n'),
                };
            }
            if (action === 'estimate') {
                const res = await fetch(`${url}/embed-estimate`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) return { ok: false, text: `Estimate request failed: HTTP ${res.status}` };
                const e = await res.json() as Record<string, unknown>;
                return {
                    ok: true,
                    text: `📊 ${e['totalChunks']} chunks · ${e['batches']} batches · ~${Math.ceil(Number(e['estimatedSeconds']))}s · $${Number(e['estimatedCost'] || 0).toFixed(4)}`,
                };
            }
            return { ok: false, text: 'Usage: /memory embed [status|estimate]' };
        } catch (err) {
            return { ok: false, text: `❌ Embed: ${(err as Error).message}` };
        }
    }
    if (sub === 'flush') {
        try {
            const { triggerMemoryFlushForCurrentSession } = await import('../agent/memory-flush-controller.js');
            // The manual path stays single-session: someone asking to flush THIS
            // conversation means this one. Only the automatic flush merges.
            const outcome = await triggerMemoryFlushForCurrentSession();
            if (outcome === 'locked') return { ok: false, text: '🧠 A memory flush is already running; try again shortly.' };
            if (outcome === 'insufficient') return { ok: true, text: '🧠 Nothing new to summarise yet.' };
            return { ok: true, text: '🧠 Memory flush triggered.' };
        } catch (err) {
            return { ok: false, text: `❌ Flush failed: ${(err as Error).message}` };
        }
    }
    if (sub === 'adv') {
        const action = String(args[1] || 'status').toLowerCase();
        if (action === 'on') {
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: `🧠 Memory is integrated by default.\nState: ${status?.["state"] || 'not_initialized'}`,
            };
        }
        if (action === 'off') {
            return { ok: true, text: '🧠 Memory can no longer be turned off as a separate mode.' };
        }
        if (action === 'init') {
            const created = await ctx.initMemoryRuntime?.() as { root?: string } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: `🧠 Memory initialized\nRoot: ${created?.root || status?.["storageRoot"] || '-'}\nState: ${status?.["state"] || 'configured'}`,
            };
        }
        if (action === 'bootstrap') {
            const result = await ctx.bootstrapMemory?.({
                importCore: true,
                importMarkdown: true,
                importKv: true,
                importClaudeSession: true,
            }) as { root?: string; counts?: Record<string, number> } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: [
                    '🧠 Memory bootstrap completed',
                    `Root: ${result?.root || status?.["storageRoot"] || '-'}`,
                    `Imported core=${result?.counts?.["core"] || 0}, markdown=${result?.counts?.["markdown"] || 0}, kv=${result?.counts?.["kv"] || 0}, claude=${result?.counts?.["claude"] || 0}`,
                    `Import status: ${status?.["importStatus"] || '-'}`,
                ].join('\n'),
            };
        }
        if (action === 'reindex') {
            const result = await ctx.reindexMemory?.() as { totalFiles?: number; totalChunks?: number } | undefined;
            const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
            return {
                ok: true,
                text: [
                    '🧠 Memory reindex completed',
                    `Files: ${result?.totalFiles || status?.["indexedFiles"] || 0}`,
                    `Chunks: ${result?.totalChunks || status?.["indexedChunks"] || 0}`,
                    `State: ${status?.["indexState"] || '-'}`,
                ].join('\n'),
            };
        }
        const status = await ctx.getMemoryStatus?.() as Record<string, unknown> | undefined;
        const routing = status?.["routing"] as { searchRead?: string; save?: string } | undefined;
        const importedCounts = status?.["importedCounts"] as Record<string, number> | undefined;
        const lines = [
            `🧠 Memory: ${status?.["enabled"] ? 'ON' : 'OFF'}`,
            `State: ${status?.["state"] || '-'}`,
            `Storage: ${status?.["storageRoot"] || '-'}`,
            `Routing(search/read): ${routing?.searchRead || 'basic'}`,
            `Routing(save): ${routing?.save || 'basic'}`,
            `Indexed files: ${status?.["indexedFiles"] || 0}`,
            `Indexed chunks: ${status?.["indexedChunks"] || 0}`,
            `Imported core/markdown/kv/claude: ${importedCounts?.["core"] || 0}/${importedCounts?.["markdown"] || 0}/${importedCounts?.["kv"] || 0}/${importedCounts?.["claude"] || 0}`,
        ];
        return { ok: true, text: lines.join('\n') };
    }
    if (!args.length || (args.length === 1 && args[0]!.toLowerCase() === 'list')) {
        const files = await ctx.listMemory() as Array<{ path: string; size: number }> | undefined;
        if (!files?.length) return { ok: true, text: t('cmd.memory.empty', {}, L) };
        const lines = files.slice(0, 20).map((f) => `- ${f.path} (${f.size}b)`);
        return { ok: true, text: `🧠 memory files (${files.length})\n${lines.join('\n')}` };
    }
    const query = args.join(' ').trim();
    const result = await ctx.searchMemory(query);
    const text = String(result || '(no results)');
    const MAX = 3000;
    return { ok: true, text: text.length > MAX ? text.slice(0, MAX) + '\n...(truncated)' : text };
}

export async function browserHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'tabs') {
        const d = await ctx.getBrowserTabs() as { tabs?: Array<{ title?: string; url?: string }> };
        const tabs = d?.tabs || [];
        if (!tabs.length) return { ok: true, text: t('cmd.browser.noTabs', {}, L) };
        const lines = tabs.slice(0, 10).map((tab, i: number) => `${i + 1}. ${tab.title || '(untitled)'}\n   ${tab.url || ''}`);
        return { ok: true, text: lines.join('\n') };
    }
    if (sub !== 'status') return { ok: false, text: 'Usage: /browser [status|tabs]' };
    const d = await ctx.getBrowserStatus() as unknown as { running?: boolean; tabs?: unknown[]; tabCount?: number; cdpUrl?: string };
    const running = d?.running ? 'running' : 'stopped';
    const tabCount = d?.tabs?.length ?? d?.tabCount ?? '-';
    return { ok: true, text: `🌐 Browser: ${running}\nTabs: ${tabCount}\nCDP: ${d?.cdpUrl || '-'}` };
}

export async function promptHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const d = await ctx.getPrompt() as { content?: string };
    const content = d?.content || '';
    if (!content.trim()) return { ok: true, text: '(empty prompt)' };
    const lines = content.trim().split('\n');
    const preview = lines.slice(0, 20).join('\n');
    const suffix = lines.length > 20 ? '\n...(truncated)' : '';
    return { ok: true, text: `${preview}${suffix}` };
}

export async function quitHandler(): Promise<SlashResult> {
    return { ok: true, code: 'exit', text: 'Bye!' };
}

export async function fileHandler(): Promise<SlashResult> {
    return { ok: false, text: 'Usage: /file <path> [caption]' };
}

export async function steerHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const prompt = args.join(' ').trim();
    if (!prompt) {
        return { ok: false, type: 'error', text: t('cmd.steer.noPrompt', {}, L) };
    }
    const steerMainCli = resolveMainCli(null, settings, getSession() as MainSessionRecord | undefined);
    if (isRetiredCliSelection(steerMainCli)) {
        return { ok: false, type: 'error', text: retiredRuntimeDiagnostic(steerMainCli) };
    }
    const { currentSessionScope } = await import('../core/session-context.js');
    const scopeKey = currentSessionScope()?.scope ?? 'default';
    const { isAgentBusy, killActiveAgent, waitForMainProcessEnd, waitForExitSettled, getSteerWaitMsForActiveAgent, canSteerAgent, steerAgent } = await import('../agent/spawn.js');
    if (!isAgentBusy(scopeKey)) {
        return { ok: false, type: 'error', text: t('cmd.steer.noAgent', {}, L) };
    }

    const iface = ctx.interface || 'cli';

    // Prefer an owning runtime hook: Codex App in-band steer or native cancel-reprompt.
    // A typed no-start queues once; a fatal/indeterminate dispatch propagates without resend.
    if (canSteerAgent(scopeKey)) {
        const inputGuard = beginSteerInput(scopeKey);
        try {
            const outcome = await steerAgent(scopeKey, prompt, iface, sessionScopeMeta());
            if (outcome === 'retired') {
                const retiredCli = resolveMainCli(null, settings, getSession() as MainSessionRecord | undefined);
                return { ok: false, type: 'error',
                    text: isRetiredCliSelection(retiredCli) ? retiredRuntimeDiagnostic(retiredCli) : 'retired_runtime' };
            }
            if (outcome === 'steered' || outcome === 'new-run') {
                return { ok: true, type: 'steer', text: t('cmd.steer.started', {}, L) };
            }
            if (outcome === 'cancelled') return { ok: true, type: 'success', text: 'Pending steer cancelled.' };
            const { submitMessage } = await import('../orchestrator/gateway.js');
            if (inputGuard.isCancelled()) return { ok: true, type: 'success', text: 'Pending steer cancelled.' };
            submitMessage(prompt, { origin: iface, ...sessionScopeMeta(), midRunPolicy: 'followup' });
            return { ok: true, type: 'success', text: 'Steer unavailable for the current turn — message queued as follow-up.' };
        } finally { inputGuard.release(); }
    }

    // Kill running agent (or cancel retry timer) and wait for clean exit
    // Snapshot before the kill: the interrupted partial-output row is the first
    // ⏹️-tagged assistant message above this mark (second-resolution created_at
    // comparisons are not race-safe).
    const { getMaxMessageId, getSteerSalvageAfter } = await import('../core/db.js');
    const steerSessionId = sessionScopeMeta().chatSessionId
        || (await import('../core/chat-sessions.js')).getActiveChatSession();
    const maxIdBeforeKill = getMaxMessageId(steerSessionId);
    const steerWaitMs = getSteerWaitMsForActiveAgent(scopeKey);
    killActiveAgent(scopeKey, 'steer');
    await waitForMainProcessEnd(scopeKey, steerWaitMs);
    // killActiveAgent drops the scope's map entry synchronously, so the wait above
    // can return before the exit handler has saved the interrupted partial output.
    await waitForExitSettled(scopeKey);
    const salvage = getSteerSalvageAfter(steerSessionId, maxIdBeforeKill);
    const steerContext = salvage ? salvage.replace(/^⏹️ \[interrupted\]\s*/, '') : undefined;

    // Remote interfaces: clear stale session before re-orchestrate
    if (iface === 'telegram' || iface === 'discord' || iface === 'slack') {
        if (typeof ctx.clearSession === 'function') {
            await ctx.clearSession();
        }
        return { ok: true, type: 'steer', text: t('cmd.steer.started', {}, L), steerPrompt: prompt, ...(steerContext ? { steerContext } : {}) };
    }

    // Web/CLI: fire orchestration directly via submitMessage
    const { submitMessage } = await import('../orchestrator/gateway.js');
    // Same session carry-through as the other slash handlers: steering a run
    // must land in the lane that run belongs to.
    submitMessage(prompt, { origin: iface as 'cli' | 'web' | 'telegram' | 'discord' | 'slack', ...sessionScopeMeta(), ...(steerContext ? { _steerContext: steerContext } : {}) });
    return { ok: true, type: 'success', text: t('cmd.steer.started', {}, L) };
}

export async function queueHandler(): Promise<SlashResult> {
    // Fallback only: the interactive listing/actions live in the TUI intercept
    // (bin/commands/tui/queue-command.ts) — a non-intercepting surface just
    // gets usage. Web manages the queue via the pending-queue row buttons.
    return { ok: true, text: 'Usage: /queue [steer|drop <n>] — interactive in the chat TUI (jaw chat)' };
}

/** Display labels for /forward's target channel. */
const FORWARD_CHANNEL_LABELS: Record<string, string> = {
    discord: 'Discord',
    telegram: 'Telegram',
    slack: 'Slack',
};

export async function forwardHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const iface = ctx.interface || 'cli';
    const remote = iface === 'discord' ? 'discord'
        : iface === 'telegram' ? 'telegram'
        : iface === 'slack' ? 'slack'
        : null;
    // Determine which channel's forwardAll to modify
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    const channelKey = remote || ((settings?.["channel"] as string | undefined) || 'telegram');
    const arg = args[0]?.toLowerCase();
    if (arg === 'on' || arg === 'off') {
        const val = arg === 'on';
        const patch = { [channelKey]: { forwardAll: val } };
        const r = await ctx.updateSettings(patch) as SlashResult;
        if (!r?.ok) return { ok: false, text: r?.text || 'Failed' };
        const label = FORWARD_CHANNEL_LABELS[channelKey] || 'Telegram';
        return { text: `📡 ${label} forwarding: ${val ? 'ON (all)' : 'OFF (channel only)'}` };
    }
    const dc = settings?.["discord"] as { forwardAll?: boolean } | undefined;
    const tg = settings?.["telegram"] as { forwardAll?: boolean } | undefined;
    const sl = settings?.["slack"] as { forwardAll?: boolean } | undefined;
    const current = channelKey === 'discord' ? dc?.forwardAll !== false
        : channelKey === 'slack' ? sl?.forwardAll !== false
        : tg?.forwardAll !== false;
    const label = FORWARD_CHANNEL_LABELS[channelKey] || 'Telegram';
    return { text: `📡 ${label} forwarding: ${current ? 'ON (all)' : 'OFF (channel only)'}\nUsage: /forward on|off` };
}

export async function fallbackHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };
    const available = Object.keys((settings["perCli"] as Record<string, unknown> | undefined) || {})
        .filter((cli) => !isRetiredCliSelection(cli));
    const retiredArg = args.map((a) => a.toLowerCase()).find(isRetiredCliSelection);
    if (retiredArg) {
        return { ok: false, text: `${retiredRuntimeDiagnostic(retiredArg)}: Select an available runtime: ${available.join(', ')}` };
    }

    if (!args.length) {
        const fb = (settings["fallbackOrder"] as string[] | undefined) || [];
        return {
            ok: true, type: 'info',
            text: fb.length
                ? `⚡ Fallback: ${fb.join(' → ')}`
                : t('cmd.fallback.inactive', { available: available.join(', ') }, L),
        };
    }

    if (args[0] === 'off' || args[0] === 'none') {
        const r = await ctx.updateSettings({ fallbackOrder: [] }) as SlashResult;
        if (r?.ok === false) return r;
        return { ok: true, text: t('cmd.fallback.off', {}, L) };
    }

    const order = args.filter((a) => available.includes(a.toLowerCase())).map((a) => a.toLowerCase());
    if (!order.length) {
        return { ok: false, text: t('cmd.fallback.invalidCli', { available: available.join(', ') }, L) };
    }

    const r = await ctx.updateSettings({ fallbackOrder: order }) as SlashResult;
    if (r?.ok === false) return r;
    return { ok: true, text: t('cmd.fallback.set', { order: order.join(' → ') }, L) };
}

export async function flushHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const activeCli = (settings["cli"] as string | undefined) || 'claude';
    const memSettings = settings["memory"] as { cli?: string; model?: string } | undefined;
    const perCli = settings["perCli"] as Record<string, { model?: string }> | undefined;
    const currentFlushCli = memSettings?.cli || activeCli;
    const currentFlushModel = memSettings?.model
        || perCli?.[currentFlushCli]?.model || 'default';

    if (!args.length) {
        const isDefault = !memSettings?.cli && !memSettings?.model;
        const suffix = isDefault ? ` (active ${activeCli} 사용)` : '';
        return { ok: true, text: t('cmd.flush.current', { cli: currentFlushCli, model: currentFlushModel }, L) + suffix };
    }

    const first = args[0]!.toLowerCase();

    // /flush off|reset
    if (first === 'off' || first === 'reset') {
        const mem = { ...(memSettings || {}), cli: '', model: '' };
        const r = await ctx.updateSettings({ memory: mem }) as SlashResult;
        if (r?.ok === false) return r;
        return { ok: true, text: t('cmd.flush.reset', {}, L) };
    }
    if (isRetiredCliSelection(first)) {
        return { ok: false, text: `${retiredRuntimeDiagnostic(first)}: Select an available runtime: ${[...CLI_KEYS].join(', ')}` };
    }

    const cliKeys = [...CLI_KEYS] as readonly string[];
    let newCli: string;
    let newModel: string;

    if (cliKeys.includes(first)) {
        // /flush <cli> [model]
        newCli = first;
        newModel = args.slice(1).join(' ').trim() || 'default';
    } else {
        // /flush <model> — auto-detect CLI from registry
        const modelName = args.join(' ').trim();
        const modelKey = modelName.toLowerCase();

        // Hints for inferring the claude CLI from a bare model name
        const LEGACY_MODEL_CLI_HINTS: Record<string, string> = {
            // New short aliases (canonical)
            'opus': 'claude',
            'sonnet': 'claude',
            'sonnet[1m]': 'claude',
            'haiku': 'claude',
            // Legacy full IDs (preserved for backward compat)
            'claude-fable-5': 'claude',
            'claude-fable-5[1m]': 'claude',
            'claude-sonnet-4-6': 'claude',
            'claude-opus-5': 'claude',
            'claude-opus-5-5': 'claude',
            'claude-opus-5-5[1m]': 'claude',
            'claude-opus-5[1m]': 'claude',
            'claude-opus-4-8': 'claude',
            'claude-opus-4-8[1m]': 'claude',
            'claude-opus-4-6': 'claude',
            'claude-sonnet-4-6[1m]': 'claude',
            'claude-opus-4-6[1m]': 'claude',
            'claude-haiku-4-5-20251001': 'claude',
        };

        const hintedCli = LEGACY_MODEL_CLI_HINTS[modelName];
        if (hintedCli) {
            newCli = hintedCli;
            newModel = modelName;
        } else {
            const matchedClis: string[] = [];
            const modelChoicesByCli = applyCodexModelsToChoices(buildModelChoicesByCli(), await resolveOpenCodexCodexModels());
            for (const [cli, models] of Object.entries(modelChoicesByCli)) {
                if ((models as string[]).some(m => m.toLowerCase() === modelKey)) {
                    matchedClis.push(cli);
                }
            }

            // Filter by available CLIs
            const availableClis = matchedClis.filter(c => detectCli(c).available);

            if (availableClis.length > 0) {
                newCli = availableClis[0]!;
                newModel = modelName;
            } else if (matchedClis.length > 0) {
                return {
                    ok: false,
                    text: t('cmd.flush.cliUnavailable', { cli: matchedClis.join(', '), model: modelName }, L),
                };
            } else {
                newCli = currentFlushCli;
                newModel = modelName;
            }
        }
    }

    // Validate target CLI is available
    if (!detectCli(newCli).available) {
        return {
            ok: false,
            text: t('cmd.flush.cliUnavailable', { cli: newCli, model: newModel }, L),
        };
    }

    const mem = { ...(memSettings || {}), cli: newCli, model: newModel };
    const r = await ctx.updateSettings({ memory: mem }) as SlashResult;
    if (r?.ok === false) return r;
    return { ok: true, text: t('cmd.flush.changed', { cli: newCli, model: newModel }, L) };
}

// ─── IDE Handler ─────────────────────────────────────

export async function ideHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'pop') return { ok: true, code: 'ide_pop_toggle', text: t('cmd.ide.popToggled', {}, L) };
    if (sub === 'on') return { ok: true, code: 'ide_on', text: t('cmd.ide.toggled', {}, L) };
    if (sub === 'off') return { ok: true, code: 'ide_off', text: t('cmd.ide.toggled', {}, L) };
    if (sub === '') return { ok: true, code: 'ide_toggle', text: t('cmd.ide.toggled', {}, L) };
    return { ok: false, text: t('cmd.ide.usage', {}, L) };
}

export async function orchestrateHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const { getState, setState, resetState, canTransition, getStatePrompt, getCtx } = await import('../orchestrator/state-machine.js');
    const { resolveOrcScope } = await import('../orchestrator/scope.js');
    type OrcStateName = 'IDLE' | 'I' | 'P' | 'A' | 'B' | 'C' | 'D';

    // Phase 58: --force overrides audit/verification gates by setting userApproved.
    const force = args.includes('--force');
    const positional = args.filter(a => !a.startsWith('--'));
    const target = (positional[0] || 'P').toUpperCase();

    const origin = ctx?.interface || 'web';
    const scope = resolveOrcScope({ origin, workingDir: settings["workingDir"] || null });

    if (target === 'STATUS') {
        const current = getState(scope);
        const currentCtx = getCtx(scope);
        return {
            ok: true,
            text: [
                `State: ${current}`,
                `Scope: ${scope}`,
                `Audit: ${currentCtx?.auditStatus || 'none'}`,
                `Verification: ${currentCtx?.verificationStatus || 'none'}`,
                `User approved: ${currentCtx?.userApproved ? 'yes' : 'no'}`,
                `Plan: ${currentCtx?.plan ? 'present' : 'none'}`,
                `Worklog: ${currentCtx?.worklogPath || 'none'}`,
            ].join('\n'),
        };
    }

    if (target === 'RESET') {
        resetState(scope);
        return { ok: true, text: '✅ State → IDLE (reset)' };
    }

    const valid: OrcStateName[] = ['I', 'P', 'A', 'B', 'C', 'D'];
    if (!valid.includes(target as OrcStateName)) {
        return { ok: false, text: `Invalid state: ${target}. Must be one of: I, P, A, B, C, D, status, reset` };
    }

    const current = getState(scope);
    const t = target as OrcStateName;
    const currentCtx = getCtx(scope);
    // Phase 58/59: User-issued slash transitions are explicit approval for gate checks.
    const userInitiated = true;
    const hasExplicitApproval = force || userInitiated;
    const gateCtx = hasExplicitApproval && currentCtx ? { ...currentCtx, userApproved: true } : currentCtx;
    if (hasExplicitApproval && currentCtx) {
        setState(current, gateCtx, scope);
    }
    const gate = canTransition(current, t, gateCtx);
    if (!gate.ok) {
        return { ok: false, text: `Cannot transition: ${gate.reason}\nCurrent server state: ${current}` };
    }

    if (t === 'D') {
        setState(t, undefined, scope, 'Done');
        resetState(scope);
        try {
            const { drainPending } = await import('../memory/heartbeat.js');
            await drainPending();
        } catch {} // best-effort: heartbeat drain must not block D transition
        return { ok: true, text: '✅ State → D (Done) → IDLE' };
    }

    if (t === 'P') {
        setState(t, { originalPrompt: '', workingDir: settings["workingDir"] || null, plan: null, workerResults: [], origin }, scope, 'P');
    } else {
        setState(t, undefined, scope, t);
    }
    const statePrompt = getStatePrompt(t);
    const summary = statePrompt.split('\n')[0] || '';
    return { ok: true, text: `✅ State → ${getState(scope)}${summary ? `\n${summary}` : ''}` };
}
