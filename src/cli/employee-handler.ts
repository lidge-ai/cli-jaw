// ─── /employee subcommand handler ────────────────────
// Extracted from handlers.ts for 500-line compliance.

import { listEmployees } from '../core/employees.js';
import type { EmployeeListing } from '../core/employees.js';
import { db, clearEmployeeSession } from '../core/db.js';
import { settings, saveSettings } from '../core/config.js';
import { broadcast } from '../core/bus.js';
import { isRetiredCliSelection, retiredRuntimeDiagnostic } from '../types/cli-engine.js';
import { regenerateB } from '../prompt/builder.js';
import { CLI_KEYS } from './registry.js';
import { t } from '../core/i18n.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';

async function findByName(name: string): Promise<EmployeeListing | null> {
    return (await listEmployees()).find(e => e.name.toLowerCase() === name.toLowerCase()) ?? null;
}

async function updateField(
    emp: EmployeeListing, field: 'model' | 'cli', value: string,
): Promise<{ ok: boolean; error?: string }> {
    if (emp.source === 'static') {
        if (field === 'cli') return { ok: false, error: 'static employees cannot change CLI' };
        const overrides = (settings['staticEmployees'] as Record<string, { model?: string }>) || {};
        overrides[emp.name] = { ...overrides[emp.name], model: value };
        (settings as Record<string, unknown>)['staticEmployees'] = overrides;
        saveSettings(settings);
        if (emp.id) clearEmployeeSession.run(emp.id);
    } else {
        db.prepare(`UPDATE employees SET ${field} = ? WHERE id = ?`).run(value, emp.id);
        if (emp.id) clearEmployeeSession.run(emp.id);
    }
    const updated = await findByName(emp.name);
    if (updated) broadcast('agent_updated', updated as unknown as Record<string, unknown>);
    regenerateB();
    return { ok: true };
}

export async function employeeHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();

    if (!sub || sub === 'list') {
        const list = await listEmployees();
        if (!list.length) return { ok: true, text: t('cmd.employee.empty', {}, L) };
        const lines = list.map(e => {
            const tag = e.source === 'static' ? ' _(static)_' : '';
            return `• **${e.name}** — cli: ${e.cli}, model: ${e.model || 'default'}, role: ${e.role || '-'}${tag}`;
        });
        return { ok: true, text: lines.join('\n') };
    }

    if (sub === 'info') {
        const name = args.slice(1).join(' ').trim();
        if (!name) return { ok: false, text: t('cmd.employee.infoUsage', {}, L) };
        const emp = await findByName(name);
        if (!emp) return { ok: false, text: t('cmd.employee.notFound', { name }, L) };
        const lines = [
            `**${emp.name}** (${emp.source})`,
            `cli: ${emp.cli}`,
            `model: ${emp.model || 'default'}`,
            `role: ${emp.role || '-'}`,
        ];
        if (emp.skills?.length) lines.push(`skills: ${emp.skills.join(', ')}`);
        const platforms = emp.runtimeHints?.supportedPlatforms;
        if (platforms?.length) lines.push(`supports: ${platforms.join(', ')}`);
        return { ok: true, text: lines.join('\n') };
    }

    if (sub === 'model') {
        const name = args[1]?.trim();
        const model = args.slice(2).join(' ').trim();
        if (!name || !model) return { ok: false, text: t('cmd.employee.modelUsage', {}, L) };
        const emp = await findByName(name);
        if (!emp) return { ok: false, text: t('cmd.employee.notFound', { name }, L) };
        const result = await updateField(emp, 'model', model);
        if (!result.ok) return { ok: false, text: result.error! };
        return { ok: true, text: t('cmd.employee.modelChanged', { name: emp.name, model }, L) };
    }

    if (sub === 'cli') {
        const name = args[1]?.trim();
        const cli = args[2]?.trim();
        if (!name || !cli) return { ok: false, text: t('cmd.employee.cliUsage', {}, L) };
        if (cli === 'aside') return { ok: false, text: 'Aside supports main sessions only.' };
        if (isRetiredCliSelection(cli)) {
            return { ok: false, text: `${retiredRuntimeDiagnostic(cli)}: Select an available runtime: ${CLI_KEYS.join(', ')}` };
        }
        if (!CLI_KEYS.includes(cli as typeof CLI_KEYS[number])) {
            return { ok: false, text: t('cmd.employee.cliUnknown', { cli, available: CLI_KEYS.join(', ') }, L) };
        }
        const emp = await findByName(name);
        if (!emp) return { ok: false, text: t('cmd.employee.notFound', { name }, L) };
        const result = await updateField(emp, 'cli', cli);
        if (!result.ok) return { ok: false, text: result.error! };
        return { ok: true, text: t('cmd.employee.cliChanged', { name: emp.name, cli }, L) };
    }

    if (sub === 'reset') {
        if (typeof ctx.resetEmployees !== 'function') {
            return { ok: false, text: t('cmd.employee.resetUnavailable', {}, L) };
        }
        const result = await ctx.resetEmployees() as { seeded?: number } | undefined;
        const seeded = Number.isFinite(result?.seeded) ? result!.seeded : '?';
        return { ok: true, text: t('cmd.employee.resetDone', { count: seeded }, L) };
    }

    if (sub === 'sessions-reset' || sub === 'session-reset' || sub === 'reset-sessions') {
        if (typeof ctx.resetEmployeeSessions !== 'function') {
            return { ok: false, text: t('cmd.employee.sessionsResetUnavailable', {}, L) };
        }
        const result = await ctx.resetEmployeeSessions() as { cleared?: number } | undefined;
        const count = Number.isFinite(result?.cleared) ? result!.cleared : '?';
        return { ok: true, text: t('cmd.employee.sessionsResetDone', { count }, L) };
    }

    return { ok: false, text: t('cmd.employee.usage', {}, L) };
}
