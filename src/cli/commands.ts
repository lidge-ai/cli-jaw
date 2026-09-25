// ─── Slash Commands Registry + Dispatcher ───────────────────────────────
// Handlers extracted to commands-handlers.js for 500-line compliance.

import { t } from '../core/i18n.js';
import { resolveSkillId } from '../../lib/mcp/skills-aliases.js';
import {
    unknownCommand, unsupportedCommand, normalizeResult,
    statusHandler, modelHandler, cliHandler, skillHandler, employeeHandler,
    thoughtHandler,
    clearHandler, purgeHandler, resetHandler, versionHandler, mcpHandler, memoryHandler,
    browserHandler, promptHandler, quitHandler, fileHandler, fallbackHandler,
    steerHandler, flushHandler, forwardHandler, ideHandler, orchestrateHandler,
    compactHandler,
    modelArgumentCompletions, cliArgumentCompletions, skillArgumentCompletions,
    employeeArgumentCompletions, browserArgumentCompletions, fallbackArgumentCompletions,
    flushArgumentCompletions,
} from './handlers.js';
import { projectHandler } from './handlers-project.js';
import { taskHandler } from './handlers-task.js';
import { newSessionHandler, switchSessionHandler, sessionsListHandler, forkSessionHandler } from './handlers/session-handlers.js';
import { remoteStopHandler, remoteQueueHandler, remoteApproveHandler, remoteDenyHandler } from './handlers/remote-session-commands.js';
import { searchWorkflowHandler } from './handlers-search.js';
import {
    planWorkflowHandler,
    interviewWorkflowHandler,
    deliberateWorkflowHandler,
    planAuditWorkflowHandler,
    goalWorkflowHandler,
    goalplanHandler,
    gdHandler,
    teamWorkflowHandler,
    reviewWorkflowHandler,
} from './handlers-workflows.js';
import { buildUnknownCommandArtifact, saveWorkflowArtifact } from '../workflows/artifacts.js';
import type { CliCommandContext } from './command-context.js';
import type {
    SlashCommand, SlashChoice, SlashResult, ParsedSlashCommand, CompletionCtx,
} from './types.js';
import { userErrorText } from '../messaging/redact.js';

const CATEGORY_ORDER = ['session', 'workflow', 'model', 'tools', 'skills', 'cli'];
const CATEGORY_LABEL: Record<string, string> = {
    session: 'Session',
    workflow: 'Workflow',
    model: 'Model',
    tools: 'Tools',
    skills: 'Skills',
    cli: 'CLI',
};

function sortCommands(list: SlashCommand[]): SlashCommand[] {
    return [...list].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.category || 'tools');
        const bi = CATEGORY_ORDER.indexOf(b.category || 'tools');
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
    });
}

function displayUsage(cmd: SlashCommand): string {
    return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`;
}

function toChoiceKey(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeArgumentCandidate(entry: SlashChoice | string | null | undefined): SlashChoice | null {
    if (typeof entry === 'string') {
        const value = entry.trim();
        if (!value) return null;
        return { value, label: '' };
    }
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as unknown as Record<string, unknown>;
    const value = String(e["value"] ?? e["name"] ?? '').trim();
    if (!value) return null;
    const label = String(e["label"] ?? e["desc"] ?? '').trim();
    return { value, label };
}

function dedupeChoices(list: Array<SlashChoice | null>): SlashChoice[] {
    const out: SlashChoice[] = [];
    const seen = new Set<string>();
    for (const entry of list || []) {
        if (!entry) continue;
        const key = toChoiceKey(entry.value ?? entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        let prev = i - 1;
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j]!;
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
            prev = tmp;
        }
    }
    return dp[n]!;
}

function scoreToken(value: string, query: string): number {
    const target = toChoiceKey(value);
    const q = toChoiceKey(query);
    if (!q) return 0;
    if (!target) return -1;
    if (target === q) return 100;
    if (target.startsWith(q)) return 60;
    if (target.includes(q)) return 30;
    const dist = levenshtein(target, q);
    if (dist <= 2 && q.length >= 2) return Math.max(10, 30 - dist * 10);
    return -1;
}

function categoryIndex(category: string | undefined): number {
    const idx = CATEGORY_ORDER.indexOf(category || 'tools');
    return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

function scoreCommandCandidate(cmd: SlashCommand, query: string): number {
    const q = toChoiceKey(query);
    if (!q) return 0;
    let score = scoreToken(cmd.name, q);
    for (const alias of (cmd.aliases || [])) {
        const aliasScore = scoreToken(alias, q);
        if (aliasScore > score) score = aliasScore - 5;
    }
    return score;
}

function suggestCommandNames(query: string): string[] {
    const q = String(query || '').trim().toLowerCase();
    const ranked = COMMANDS
        .filter(c => !c.hidden)
        .map(cmd => ({ cmd, score: scoreCommandCandidate(cmd, q) }))
        .filter(({ score }) => score >= 0)
        .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
        .slice(0, 5)
        .map(({ cmd }) => `/${cmd.name}`);
    if (ranked.length) return ranked;
    const fallback = ['help', 'plan', 'interview', 'deliberate', 'planaudit'];
    const available = new Set(COMMANDS.filter(c => !c.hidden).map(c => c.name));
    return fallback.filter(name => available.has(name)).map(name => `/${name}`);
}

async function readSettingsSnapshot(ctx: { [k: string]: unknown }): Promise<unknown> {
    let settingsSnapshot: unknown = (ctx as { settings?: unknown }).settings;
    const getSettings = (ctx as { getSettings?: () => unknown }).getSettings;
    if (!settingsSnapshot && typeof getSettings === 'function') {
        try {
            settingsSnapshot = await getSettings();
        } catch {
            settingsSnapshot = undefined;
        }
    }
    return settingsSnapshot;
}

async function persistWorkflowArtifactResult(result: SlashResult, ctx: { [k: string]: unknown }): Promise<SlashResult> {
    if (!result?.artifact || result.artifact.storage.mode !== 'jaw-home-cache') return result;
    const settingsSnapshot = await readSettingsSnapshot(ctx);
    return {
        ...result,
        artifact: saveWorkflowArtifact(result.artifact, settingsSnapshot),
    };
}

function scoreArgumentCandidate(item: SlashChoice, query: string): number {
    const base = scoreToken(item.value, query);
    if (base >= 0) return base;
    const labelScore = scoreToken(item.label || '', query);
    if (labelScore >= 0) return Math.max(10, labelScore - 10);
    return -1;
}

function findCommand(name: string): SlashCommand | undefined {
    const key = (name || '').toLowerCase();
    return COMMANDS.find(c => c.name === key || (c.aliases || []).includes(key));
}

// ─── helpHandler (kept here — needs COMMANDS/findCommand/sortCommands) ──

async function helpHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const iface = ctx.interface || 'cli';
    const L = ctx.locale || 'ko';
    if (args[0]) {
        const targetName = String(args[0]).replace(/^\//, '');
        const target: SlashCommand | undefined = findCommand(targetName);
        if (!target) return unknownCommand(targetName, L);
        const desc = target.descKey ? t(target.descKey, {}, L) : target.desc;
        const lines: string[] = [
            `${displayUsage(target)} — ${desc}`,
            `interfaces: ${target.interfaces.join(', ')}`,
        ];
        if (target.helpDetailKey) {
            const detail = t(target.helpDetailKey, {}, L);
            if (detail !== target.helpDetailKey) lines.push('', detail);
        }
        return { ok: true, type: 'info', text: lines.join('\n') };
    }

    const available = sortCommands(COMMANDS.filter(c => isVisibleOnSurface(c, iface)));
    const byCategory = new Map<string, SlashCommand[]>();
    for (const cmd of available) {
        const cat = cmd.category || 'tools';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(cmd);
    }

    const lines = [t('cmd.helpTitle', {}, L)];
    for (const cat of CATEGORY_ORDER) {
        const cmds = byCategory.get(cat);
        if (!cmds?.length) continue;
        lines.push(`\n[${(CATEGORY_LABEL as Record<string, string>)[cat] || cat}]`);
        for (const cmd of cmds) {
            const desc = cmd.descKey ? t(cmd.descKey, {}, L) : cmd.desc;
            lines.push(`- ${displayUsage(cmd)} — ${desc}`);
        }
    }
    lines.push('\n' + t('cmd.helpDetail', {}, L));
    return { ok: true, type: 'info', text: lines.join('\n') };
}

// ─── COMMANDS Registry ───────────────────────────────

/**
 * Completion/help visibility: an explicit per-command capability map (same
 * precedence rule as command-contract/catalog.ts) wins over the interfaces
 * array. Lets a server-executed command the TUI forwards (e.g. /steer) surface
 * in CLI completion while executeCommand's `interfaces` gate keeps refusing
 * local execution — the process boundary is the gate, not invisibility.
 */
function isVisibleOnSurface(cmd: SlashCommand, iface: string): boolean {
    if (cmd.hidden) return false;
    const cap = cmd.capability?.[iface];
    if (cap !== undefined) return cap !== 'hidden' && cap !== 'blocked';
    return cmd.interfaces.includes(iface);
}

export const COMMANDS: SlashCommand[] = [
    { name: 'help', aliases: ['h'], descKey: 'cmd.help.desc', tgDescKey: 'cmd.help.tg_desc', desc: 'Command list', args: '[command]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: helpHandler },
    { name: 'commands', aliases: ['cmd'], descKey: '', desc: 'Open command palette', category: 'session', interfaces: ['cli'], handler: async () => ({ code: 'open_palette' }) },
    { name: 'settings', desc: 'Open settings', category: 'cli', interfaces: ['cli'], handler: async () => ({ ok: true, code: 'open_settings', text: 'Settings are available in fullscreen TUI.' }) },
    { name: 'status', descKey: 'cmd.status.desc', tgDescKey: 'cmd.status.tg_desc', desc: 'Current status', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: statusHandler },
    { name: 'clear', descKey: 'cmd.clear.desc', tgDescKey: 'cmd.clear.tg_desc', desc: 'Clear screen', args: '[all]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: clearHandler },
    { name: 'purge', descKey: 'cmd.purge.desc', tgDescKey: 'cmd.purge.tg_desc', desc: 'Purge conversation and memory', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: purgeHandler },
    { name: 'compact', descKey: 'cmd.compact.desc', tgDescKey: 'cmd.compact.tg_desc', desc: 'Compact conversation context', args: '[instructions]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: compactHandler },
    { name: 'reset', descKey: 'cmd.reset.desc', desc: 'Full reset', args: '[confirm]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: resetHandler },
    { name: 'plan', descKey: 'cmd.workflow.plan.desc', tgDescKey: 'cmd.workflow.plan.tg_desc', desc: 'Explain cli-jaw PABCD planning flow', args: '[request|status|copy]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'planning', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'request-or-subcommand', required: false, kind: 'text' }] }, handler: planWorkflowHandler },
    { name: 'interview', descKey: 'cmd.workflow.interview.desc', tgDescKey: 'cmd.workflow.interview.tg_desc', desc: 'Clarify requirements before planning', args: '<request>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'requirements', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'request', required: true, kind: 'text' }] }, handler: interviewWorkflowHandler },
    { name: 'deliberate', descKey: 'cmd.workflow.deliberate.desc', tgDescKey: 'cmd.workflow.deliberate.tg_desc', desc: 'Plan with planner, architect, and critic roles', args: '<request-or-plan>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'planning', risk: 'low', output: 'plan', workflowArgs: [{ name: 'request-or-plan', required: true, kind: 'text' }] }, handler: deliberateWorkflowHandler },
    { name: 'planaudit', descKey: 'cmd.workflow.planAudit.desc', tgDescKey: 'cmd.workflow.planAudit.tg_desc', desc: 'Create a read-only employee audit task', args: '[plan]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'audit', risk: 'medium', output: 'dispatch', workflowArgs: [{ name: 'plan', required: false, kind: 'text' }] }, handler: planAuditWorkflowHandler },
    { name: 'review', tgDescKey: 'cmd.workflow.review.tg_desc', desc: 'Project-dir code review', args: '[focus] [--fix] [--dispatch]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'quality', risk: 'low', output: 'report', workflowArgs: [{ name: 'focus', required: false, kind: 'text' }] }, handler: reviewWorkflowHandler },
    { name: 'search', descKey: 'cmd.workflow.search.desc', tgDescKey: 'cmd.workflow.search.tg_desc', desc: 'Route search through the search skill', args: '<query>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'requirements', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'query', required: true, kind: 'text' }] }, handler: searchWorkflowHandler },
    { name: 'goal', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'Persistent goal and bounded run workflow', args: '<objective> | plan [hint] | refine <objective> | [status|run|done|cancel|pause|resume|clear|reset|history]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'objective-or-subcommand', required: false, kind: 'text' }] }, handler: goalWorkflowHandler },
    { name: 'goalplan', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'AI-driven goal planning (alias for /goal plan)', args: '[hint]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'hint', required: false, kind: 'text' }] }, handler: goalplanHandler },
    { name: 'gd', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'Force-complete active goal (alias for /goal done --force)', args: '[note]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'note', required: false, kind: 'text' }] }, handler: gdHandler },
    { name: 'team', descKey: 'cmd.workflow.team.desc', tgDescKey: 'cmd.workflow.team.tg_desc', desc: 'Parallel team orchestration', args: '[plan|audit|status|collect|stop] [args...]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], workflow: { kind: 'workflow', phase: 'execution', risk: 'medium', output: 'dispatch', workflowArgs: [{ name: 'subcommand', required: true, kind: 'text' }] }, handler: teamWorkflowHandler },
    { name: 'model', descKey: 'cmd.model.desc', tgDescKey: 'cmd.model.tg_desc', desc: 'View/change model', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: modelArgumentCompletions, handler: modelHandler },
    { name: 'cli', descKey: 'cmd.cli.desc', tgDescKey: 'cmd.cli.tg_desc', desc: 'View/change CLI', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: cliArgumentCompletions, handler: cliHandler },
    { name: 'fallback', descKey: 'cmd.fallback.desc', tgDescKey: 'cmd.fallback.tg_desc', desc: 'Set fallback order', args: '[cli1 cli2...|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: fallbackArgumentCompletions, handler: fallbackHandler },
    { name: 'forward', descKey: 'cmd.forward.desc', tgDescKey: 'cmd.forward.tg_desc', desc: 'Toggle forwarding (on/off)', args: '[on|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: forwardHandler },
    { name: 'thought', desc: 'Toggle Gemini thought visibility', args: '[on|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: thoughtHandler },
    { name: 'flush', descKey: 'cmd.flush.desc', tgDescKey: 'cmd.flush.tg_desc', desc: 'Set flush model', args: '[cli] [model] | off', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: flushArgumentCompletions, handler: flushHandler },
    { name: 'version', descKey: 'cmd.version.desc', tgDescKey: 'cmd.version.tg_desc', desc: 'Version/CLI status', category: 'cli', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: versionHandler },
    { name: 'skill', descKey: 'cmd.skill.desc', tgDescKey: 'cmd.skill.tg_desc', desc: 'Skill list/reset', args: '[list [--inactive]|reset]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: skillArgumentCompletions, handler: skillHandler },
    { name: 'employee', descKey: 'cmd.employee.desc', desc: 'Manage employees', args: '[list|info|model|cli|reset|sessions-reset] [...]', helpDetailKey: 'cmd.employee.helpDetail', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: employeeArgumentCompletions, handler: employeeHandler },
    { name: 'mcp', descKey: 'cmd.mcp.desc', desc: 'MCP list/sync/install', args: '[sync|install]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: mcpHandler },
    { name: 'memory', descKey: 'cmd.memory.desc', desc: 'Memory search/list', args: '[query]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: memoryHandler },
    { name: 'browser', descKey: 'cmd.browser.desc', tgDescKey: 'cmd.browser.tg_desc', desc: 'Browser status/tabs', args: '[status|tabs]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], getArgumentCompletions: browserArgumentCompletions, handler: browserHandler },
    { name: 'prompt', descKey: 'cmd.prompt.desc', desc: 'View system prompt', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: promptHandler },
    { name: 'quit', aliases: ['q', 'exit'], descKey: 'cmd.quit.desc', desc: 'Quit process', category: 'cli', interfaces: ['cli'], handler: quitHandler },
    { name: 'file', descKey: 'cmd.file.desc', desc: 'Attach file', args: '<path> [caption]', category: 'cli', interfaces: ['cli'], hidden: true, handler: fileHandler },
    // steer: interfaces excludes 'cli' on purpose (process boundary — STR-001);
    // the TUI/simple-mode intercept forwards it to POST /api/message. The
    // explicit capability map surfaces it in CLI completion/help anyway.
    { name: 'steer', descKey: 'cmd.steer.desc', tgDescKey: 'cmd.steer.tg_desc', desc: 'Interrupt agent and redirect', args: '<prompt>', category: 'session', interfaces: ['web', 'telegram', 'discord', 'slack'], capability: { cli: 'full', web: 'full', telegram: 'full', discord: 'full', slack: 'full', cmdline: 'hidden' }, handler: steerHandler },
    // queue: TUI-only surface — the real work happens in the TUI intercept
    // (bin/commands/tui/queue-command.ts) against the existing
    // /api/orchestrate/queue/:id routes; this handler is the usage fallback.
    { name: 'queue', descKey: '', desc: 'List/manage queued messages', args: '[list|drop <n>]', category: 'session', interfaces: ['cli', 'telegram', 'discord', 'slack'], capability: { cli: 'full', web: 'hidden', telegram: 'full', discord: 'full', slack: 'full', cmdline: 'hidden' }, handler: remoteQueueHandler },
    { name: 'stop', descKey: '', desc: 'Stop the current conversation run', category: 'session', interfaces: ['telegram', 'discord', 'slack'], capability: { cli: 'hidden', web: 'hidden', telegram: 'full', discord: 'full', slack: 'full', cmdline: 'hidden' }, handler: remoteStopHandler },
    { name: 'approve', descKey: '', desc: 'Approve a pending dispatch', args: '<jti> <digest>', category: 'session', interfaces: ['telegram', 'discord', 'slack'], capability: { cli: 'hidden', web: 'hidden', telegram: 'full', discord: 'full', slack: 'full', cmdline: 'hidden' }, handler: remoteApproveHandler },
    { name: 'deny', descKey: '', desc: 'Deny a pending dispatch', args: '<jti> <digest>', category: 'session', interfaces: ['telegram', 'discord', 'slack'], capability: { cli: 'hidden', web: 'hidden', telegram: 'full', discord: 'full', slack: 'full', cmdline: 'hidden' }, handler: remoteDenyHandler },
    { name: 'ide', descKey: 'cmd.ide.desc', desc: 'IDE diff view', args: '[pop|on|off]', category: 'tools', interfaces: ['cli'], handler: ideHandler },
    { name: 'orchestrate', aliases: ['pabcd'], descKey: '', desc: 'Enter PABCD orchestration', args: '[I|P|A|B|C|D|status|reset] [--attest <json>]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: orchestrateHandler },
    { name: 'project', aliases: ['proj'], descKey: '', desc: 'Manage project workspace directories', args: '[set|reset|clear|list] [paths...]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: projectHandler },
    { name: 'task', descKey: '', desc: 'Task checklist', args: '[add|edit|done|start|assign|cancel|list|clear] [args...]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: taskHandler },
    { name: 'new', descKey: '', desc: 'New chat session', args: '[label]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: newSessionHandler },
    { name: 'switch', aliases: ['sw'], descKey: '', desc: 'Switch session', args: '<seq>', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: switchSessionHandler },
    { name: 'sessions', aliases: ['ss'], descKey: '', desc: 'List sessions', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: sessionsListHandler },
    { name: 'fork', descKey: '', desc: 'Fork current session', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord', 'slack'], handler: forkSessionHandler },
    // ── Runtime controls and session tools ──
    { name: 'effort', desc: 'Set reasoning effort level (accepted values depend on the active CLI and model)', args: '[level]', category: 'model', interfaces: ['cli', 'web'], handler: effortHandler },
    { name: 'fast', desc: 'Toggle fast/priority mode', category: 'model', interfaces: ['cli', 'web'], handler: fastHandler },
    { name: 'context', desc: 'Show token usage and context stats', category: 'session', interfaces: ['cli', 'web'], handler: contextHandler },
    { name: 'tools', desc: 'List active tools', category: 'tools', interfaces: ['cli', 'web'], handler: toolsHandler },
    { name: 'redraw', desc: 'Force TUI redraw', category: 'cli', interfaces: ['cli'], handler: async () => ({ code: 'redraw' }) },
    { name: 'retry', desc: 'Retry last message', category: 'session', interfaces: ['cli', 'web'], handler: async () => ({ code: 'retry' }) },
    { name: 'export', desc: 'Export session transcript', args: '[markdown|json]', category: 'session', interfaces: ['cli', 'web'], handler: exportHandler },
    { name: 'resume', desc: 'Resume a previous session', args: '[id]', category: 'session', interfaces: ['cli', 'web'], handler: resumeHandler },
    { name: 'hotkeys', desc: 'Show keyboard shortcuts', category: 'cli', interfaces: ['cli'], handler: async () => ({ code: 'show_help' }) },
];

// ─── Tokenizer ───────────────────────────────────────

function tokenizeArgs(body: string): string[] {
    const tokens: string[] = [];
    let current = '', inQuote: string | null = null;
    for (const ch of body) {
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; continue; }
            current += ch;
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (/\s/.test(ch)) {
            if (current) { tokens.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

// ─── Dispatch ────────────────────────────────────────

export function parseCommand(text: string): ParsedSlashCommand {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const body = text.slice(1).trim();
    if (!body) {
        const help = findCommand('help');
        if (!help) return null;
        return { type: 'known', cmd: help, args: [], name: 'help', rawText: text };
    }
    // File paths like /users/junny/... or /tmp/foo — not commands
    const firstToken = body.split(/\s+/)[0] || '';
    if (firstToken.includes('/') || firstToken.includes('\\')) return null;
    // Numeric shortcut: /N → switch to session #N
    if (/^\d+$/.test(firstToken)) {
        const switchCmd = findCommand('switch');
        if (switchCmd) return { type: 'known', cmd: switchCmd, args: [firstToken], name: 'switch', rawText: text };
    }
    const parts = tokenizeArgs(body);
    const name = (parts.shift() || '').toLowerCase();
    if (name.startsWith('skill:')) {
        // Hidden compatibility alias: skills are picked with `$skill-id` now and
        // `/` lists only slash commands, but `/skill:<id>` keeps executing.
        // `/skill:browser` still reaches `jaw-browser` for one major version.
        const skillId = resolveSkillId(name.slice(6));
        if (!skillId) return { type: 'unknown', name, args: parts, rawText: text };
        return { type: 'skill', skillId, name, args: parts, rawText: text };
    }
    const cmd = findCommand(name);
    if (!cmd) return { type: 'unknown', name, args: parts, rawText: text };
    return { type: 'known', cmd, args: parts, name, rawText: text };
}

export async function executeCommand(parsed: ParsedSlashCommand, ctx: { interface?: string; locale?: string; [k: string]: unknown }): Promise<SlashResult | null> {
    const L = ctx?.locale || 'ko';
    if (!parsed) return null;
    if (parsed.type === 'skill') {
        const { executeSkillCommand } = await import('./handlers-skill-invoke.js');
        return executeSkillCommand(parsed.skillId, parsed.args, ctx as unknown as CliCommandContext);
    }
    if (parsed.type === 'unknown') {
        const recovery = {
            args: parsed.args || [],
            originalText: parsed.rawText || `/${parsed.name}${parsed.args?.length ? ` ${parsed.args.join(' ')}` : ''}`,
            suggestedCommands: suggestCommandNames(parsed.name),
        };
        const result = unknownCommand(parsed.name, L, recovery);
        result.artifact = buildUnknownCommandArtifact(result.recovery!, L, await readSettingsSnapshot(ctx));
        return persistWorkflowArtifactResult(result, ctx);
    }
    const iface = ctx.interface || 'cli';
    if (!parsed.cmd.interfaces.includes(iface)) {
        return unsupportedCommand(parsed.cmd, iface, L);
    }
    // Readonly enforcement: if command is readonly on this interface and args are supplied (write attempt), block
    if (iface && parsed.args?.length > 0) {
        const { getCommandCatalog, CAPABILITY } = await import('../command-contract/catalog.js');
        const catalogCmd = getCommandCatalog().find((c: SlashCommand) => c.name === parsed.cmd.name);
        const cap = (catalogCmd as { capability?: Record<string, string> } | undefined)?.capability;
        if (cap?.[iface] === CAPABILITY.readonly) {
            return {
                ok: false,
                code: 'readonly',
                text: t('cmd.unsupported', { name: parsed.cmd.name, iface }, L),
            };
        }
    }
    try {
        const handler = parsed.cmd.handler as (args: string[], ctx: CliCommandContext) => unknown;
        const commandCtx = { ...ctx, rawText: parsed.rawText };
        return persistWorkflowArtifactResult(
            normalizeResult(await handler(parsed.args || [], commandCtx as unknown as CliCommandContext)),
            commandCtx,
        );
    } catch (err: unknown) {
        // This message is serialized three ways at once: an /api/command
        // response body, a Telegram reply, and a Discord reply. A handler that
        // touches a vendor API can put the token in it.
        const msg = userErrorText(err);
        return {
            ok: false,
            code: 'command_error',
            text: t('cmd.error', { name: parsed.cmd.name, msg }, L),
        };
    }
}

// ─── Completions ─────────────────────────────────────

export function getCompletions(partial: string, iface: string = 'cli'): string[] {
    const prefix = (partial || '').startsWith('/')
        ? (partial || '').toLowerCase()
        : '/' + String(partial || '').toLowerCase();
    return getCompletionItems(prefix, iface)
        .map(c => `/${c.name}`);
}

export interface CommandCompletionItem {
    kind: 'command';
    name: string;
    desc: string;
    args: string;
    category: string;
    workflow?: SlashCommand['workflow'];
    insertText: string;
}

export function getCompletionItems(partial: string, iface: string = 'cli', locale: string = 'ko'): CommandCompletionItem[] {
    const query = String(partial || '').replace(/^\//, '').trim().toLowerCase();

    type CompletionSource = { name: string; desc: string; args: string; category: string; workflow?: SlashCommand['workflow'] };

    const builtinItems: CompletionSource[] = COMMANDS
        .filter(c => isVisibleOnSurface(c, iface))
        .map(cmd => ({
            name: cmd.name,
            desc: (cmd.descKey ? t(cmd.descKey, {}, locale) : cmd.desc) || '',
            args: cmd.args || '',
            category: cmd.category || 'tools',
            workflow: cmd.workflow,
        }));

    // Active skills are not slash commands: they are picked with `$skill-id`
    // (src/shared/skill-mention.ts), so `/` completions list commands only.
    return builtinItems
        .map(item => ({ item, score: scoreCompletionSource(item.name, item.desc, query) }))
        .filter(({ score }) => !query || score >= 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const catDiff = categoryIndex(a.item.category) - categoryIndex(b.item.category);
            if (catDiff !== 0) return catDiff;
            return a.item.name.localeCompare(b.item.name);
        })
        .map(({ item }) => ({
            kind: 'command' as const,
            name: item.name,
            desc: item.desc,
            args: item.args,
            category: item.category,
            workflow: item.workflow,
            insertText: `/${item.name} `,
        }));
}

function scoreCompletionSource(name: string, desc: string, query: string): number {
    if (!query) return 0;
    const n = name.toLowerCase();
    if (n === query) return 100;
    if (n.startsWith(query)) return 60;
    if (n.includes(query)) return 30;
    const parts = n.split(/[-:]/);
    if (parts.some(p => p.startsWith(query))) return 40;
    if ((desc || '').toLowerCase().includes(query)) return 15;
    if (query.length >= 2 && levenshtein(n, query) <= 2) return 10;
    return -1;
}

export interface ArgumentCompletionItem {
    kind: 'argument';
    name: string;
    desc: string;
    args: string;
    category: string;
    command: string;
    commandDesc: string;
    insertText: string;
}

export async function getArgumentCompletionItems(
    commandName: string,
    partial: string = '',
    iface: string = 'cli',
    argv: string[] = [],
    ctx: { settings?: { perCli?: Record<string, unknown>; cli?: string }; locale?: string } = {},
): Promise<ArgumentCompletionItem[]> {
    const cmd = findCommand(commandName);
    if (!cmd || cmd.hidden) return [];
    if (!cmd.interfaces.includes(iface)) return [];
    if (typeof cmd.getArgumentCompletions !== 'function') return [];

    let candidates: SlashChoice[];
    try {
        const result = await Promise.resolve(cmd.getArgumentCompletions(ctx as CompletionCtx, argv, partial));
        candidates = (Array.isArray(result) ? result : []) as SlashChoice[];
    } catch (err: unknown) {
        if (process.env["DEBUG"]) console.warn('[commands:argComplete]', (err as Error).message);
        return [];
    }
    const normalized = dedupeChoices(candidates.map(normalizeArgumentCandidate));
    const query = String(partial || '').trim().toLowerCase();

    return normalized
        .map((entry, idx) => ({ entry, idx, score: scoreArgumentCandidate(entry, query) }))
        .filter(({ score }) => !query || score >= 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.idx !== b.idx) return a.idx - b.idx;
            return a.entry.value.localeCompare(b.entry.value);
        })
        .map(({ entry }) => ({
            kind: 'argument' as const,
            name: entry.value,
            desc: entry.label || '',
            args: '',
            category: cmd.category || 'tools',
            command: cmd.name,
            commandDesc: cmd.desc || '',
            insertText: `/${cmd.name} ${entry.value}`,
        }));
}

// ── Phase 9-10 handlers ──────────────────────────────

async function safeCall<T>(fn: (() => Promise<T> | T) | undefined | null, fallback: T | null = null): Promise<T | null> {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

/**
 * Reasoning-effort levels accepted by one CLI, narrowed to the model when the
 * runtime advertises a per-model set.
 *
 * Codex/codex-app take their set from a live opencodex catalog, where each model
 * differs (`gpt-5.6-sol` reaches `ultra`, `gpt-5.6-luna` stops at `max`, routed
 * models take none). Everything else uses its static registry list, because no
 * other runtime exposes a per-model effort source.
 */
export async function resolveEffortLevelsForCli(cli: string, model: string): Promise<string[]> {
    if (cli === 'codex' || cli === 'codex-app') {
        try {
            const { resolveOpenCodexCodexModelsDetailed } = await import('./opencodex-models.js');
            const { entries } = await resolveOpenCodexCodexModelsDetailed();
            const entry = entries.find((e) => e.id === model);
            if (entry) return [...entry.efforts];
        } catch { /* fall through to the static registry list */ }
    }
    const { CLI_REGISTRY } = await import('./registry.js');
    return [...(CLI_REGISTRY[cli as keyof typeof CLI_REGISTRY]?.efforts || [])];
}

async function effortHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const settings = await safeCall(ctx.getSettings, null) as Record<string, unknown> | null;
    if (!settings) return { ok: false, text: 'Could not load settings.' };

    const cli = (settings['cli'] as string | undefined) || 'claude';
    const perCli = (settings['perCli'] as Record<string, Record<string, unknown>> | undefined) || {};
    const activeOverrides = (settings['activeOverrides'] as Record<string, Record<string, unknown>> | undefined) || {};
    const model = String(activeOverrides[cli]?.['model'] ?? perCli[cli]?.['model'] ?? '').trim();

    // The accepted set is per CLI and, for Codex, per MODEL: a live opencodex
    // advertises `ultra` for gpt-5.6-sol but stops at `max` for gpt-5.6-luna,
    // and routed models take no effort at all. A hardcoded list both hid
    // `xhigh`/`ultra` and rejected them outright.
    const levels = await resolveEffortLevelsForCli(cli, model);
    const current = String(activeOverrides[cli]?.['effort'] ?? perCli[cli]?.['effort'] ?? '') || '(none)';

    if (!levels.length) {
        return { ok: true, text: `${cli}${model ? ` / ${model}` : ''} does not accept a reasoning effort.` };
    }
    if (!args.length) {
        return { text: `Reasoning effort for ${cli}${model ? ` / ${model}` : ''}: ${current}. Options: ${['off', ...levels].join(', ')}. Usage: /effort <level>` };
    }

    const level = args[0]!.toLowerCase();
    // `off` clears the override rather than reaching the wire as a literal.
    const nextEffort = level === 'off' ? '' : level;
    if (nextEffort && !levels.includes(nextEffort)) {
        return { text: `Unknown level "${args[0]}" for ${cli}${model ? ` / ${model}` : ''}. Options: ${['off', ...levels].join(', ')}` };
    }

    // Write where the runtime actually reads it (src/agent/spawn.ts reads
    // activeOverrides[cli].effort -> perCli[cli].effort). A top-level `effort`
    // key is persisted but never consumed.
    const patch = {
        perCli: { ...perCli, [cli]: { ...(perCli[cli] || {}), effort: nextEffort } },
        activeOverrides: { ...activeOverrides, [cli]: { ...(activeOverrides[cli] || {}), effort: nextEffort } },
    };
    const updateResult = await ctx.updateSettings(patch) as SlashResult;
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: `Reasoning effort set to ${nextEffort || 'off'} for ${cli}${model ? ` / ${model}` : ''}.` };
}

async function fastHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
        const data = r.ok ? (await r.json()) as Record<string, unknown> : {};
        const current = (data as Record<string, unknown>)['serviceTier'] === 'priority';
        await fetch(`${apiUrl}/api/settings`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serviceTier: current ? 'none' : 'priority' }),
            signal: AbortSignal.timeout(3000),
        });
        return { ok: true, text: current ? 'Fast mode disabled.' : 'Fast mode enabled.' };
    } catch {
        return { text: 'Failed to toggle fast mode.' };
    }
}

async function contextHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/session`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const data = (await r.json()) as Record<string, unknown>;
            const session = (data as Record<string, unknown>)['data'] as Record<string, unknown> || data;
            return { text: `Context: model=${session['model'] || 'default'}, messages=${session['messageCount'] || '?'}` };
        }
    } catch { /* fallback */ }
    return { text: 'Context stats: use /status for current token usage.' };
}

async function toolsHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const data = (await r.json()) as Record<string, unknown>;
            const cli = (data as Record<string, unknown>)['cli'] as string || 'codex';
            return { text: `Active CLI: ${cli}. Tools: Bash, Read, Edit, Write + configured MCP servers.` };
        }
    } catch { /* fallback */ }
    return { text: 'Active tools: Bash, Read, Edit, Write + MCP tools (if configured).' };
}

async function exportHandler(args: string[]): Promise<SlashResult> {
    const fmt = args[0] || 'markdown';
    return { text: `Export format: ${fmt}. (Export endpoint not yet wired — coming in next update)` };
}

async function resumeHandler(args: string[]): Promise<SlashResult> {
    if (args.length) return { text: `Resuming session ${args[0]}...`, code: 'resume_session' };
    return { code: 'open_session_selector' };
}

// ── Fix: effort/fast handlers must write to server settings ──
// The handlers above are stubs. Proper implementation requires
// POST /api/settings with the effort/fast value. Adding API call:
