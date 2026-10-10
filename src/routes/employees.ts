import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import crypto from 'crypto';
import { ok } from '../http/response.js';
import { broadcast } from '../core/bus.js';
import { db, insertEmployee, deleteEmployee } from '../core/db.js';
import { regenerateB } from '../prompt/builder.js';
import { resolveCliDefaultModel } from '../cli/opencodex-models.js';
import {
    clearEmployeeSessionIfResumeKeyChanged,
    type EmployeeResumeKeyLike,
    resetEmployeeSessions,
    seedDefaultEmployees,
    listEmployees,
    findStaticEmployee,
} from '../core/employees.js';
import { settings, saveSettings } from '../core/config.js';

// Static employee IDs look like `static:<name>` — routes use this prefix to
// branch between DB CRUD and settings-backed override storage.
const STATIC_ID_PREFIX = 'static:';
function parseStaticId(id: string): string | null {
    return id.startsWith(STATIC_ID_PREFIX) ? id.slice(STATIC_ID_PREFIX.length) : null;
}

export function registerEmployeeRoutes(app: Express, requireAuth: AuthMiddleware): void {
    // Returns merged [static first, then DB]. Static entries carry `id: static:<name>`
    // so the frontend can round-trip edits through PUT.
    app.get('/api/employees', async (_, res) => ok(res, await listEmployees()));

    app.post('/api/employees', requireAuth, async (req, res) => {
        const id = crypto.randomUUID();
        const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
        if (cli === 'aside') { res.status(400).json({ error: 'aside_main_only' }); return; }
        const nextModel = (!model || model === 'default')
            ? await resolveCliDefaultModel(cli)
            : model;
        insertEmployee.run(id, name, cli, nextModel, role);
        const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Record<string, any>;
        broadcast('agent_added', emp);
        regenerateB();
        res.json(emp);
    });

    app.post('/api/employees/sessions/reset', requireAuth, (_req, res) => {
        const result = resetEmployeeSessions();
        res.json({ ok: true, ...result });
    });

    app.put('/api/employees/:id', requireAuth, async (req, res) => {
        const updates = req.body || {};
        if (updates.cli === 'aside') { res.status(400).json({ error: 'aside_main_only' }); return; }
        const employeeId = String(req.params["id"] || '');
        const staticSlug = parseStaticId(employeeId);

        // Static employees: only `model` is mutable; CLI and name are locked to the
        // registry definition. Overrides persist in settings.staticEmployees[Name].
        if (staticSlug) {
            const spec = findStaticEmployee(staticSlug);
            if (!spec) {
                res.status(404).json({ error: 'unknown static employee' });
                return;
            }
            const newModel = typeof updates.model === 'string' ? updates.model : null;
            if (!newModel) {
                res.status(400).json({ error: 'static employees only allow model updates' });
                return;
            }
            const before = {
                cli: spec.cli,
                model: ((settings["staticEmployees"] as Record<string, { model?: string }> | undefined)?.[spec.name])?.model
                    ?? spec.model
                    ?? 'default',
            };
            const overrides = (settings["staticEmployees"] as Record<string, { model?: string }>) || {};
            overrides[spec.name] = { ...overrides[spec.name], model: newModel };
            settings["staticEmployees"] = overrides;
            saveSettings(settings);
            clearEmployeeSessionIfResumeKeyChanged(employeeId, before, { cli: spec.cli, model: newModel });
            const merged = (await listEmployees()).find(e => e.id === employeeId);
            if (merged) broadcast('agent_updated', merged as Record<string, any>);
            regenerateB();
            res.json(merged);
            return;
        }

        const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as EmployeeResumeKeyLike | undefined;
        const allowed = ['name', 'cli', 'model', 'role', 'status'];
        const keys = Object.keys(updates).filter(k => allowed.includes(k));
        const sets = keys.map(k => `${k} = ?`);
        if (sets.length === 0) {
            res.status(400).json({ error: 'no valid fields' });
            return;
        }
        const vals = keys.map(k => (updates as Record<string, any>)[k]);
        db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals, employeeId);
        const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as Record<string, any>;
        clearEmployeeSessionIfResumeKeyChanged(employeeId, before, emp);
        broadcast('agent_updated', emp);
        regenerateB();
        res.json(emp);
    });

    app.delete('/api/employees/:id', requireAuth, (req, res) => {
        const employeeId = String(req.params["id"] || '');
        // Static employees cannot be deleted (they're baked into the binary) —
        // reject explicitly so the frontend can show the correct UX.
        if (parseStaticId(employeeId)) {
            res.status(400).json({ error: 'static employees cannot be deleted' });
            return;
        }
        const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as EmployeeResumeKeyLike | undefined;
        deleteEmployee.run(employeeId);
        clearEmployeeSessionIfResumeKeyChanged(employeeId, before, { cli: '', model: '' });
        broadcast('agent_deleted', { id: employeeId });
        regenerateB();
        res.json({ ok: true });
    });

    // Employee reset — delete all + re-seed 5 defaults
    app.post('/api/employees/reset', requireAuth, async (_req, res) => {
        const { seeded } = await seedDefaultEmployees({ reset: true, notify: true });
        res.json({ ok: true, seeded });
    });
}
