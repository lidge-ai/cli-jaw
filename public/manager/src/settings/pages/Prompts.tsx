// Phase 8 — Prompts page: system prompt body + per-template editor.
//
// The system prompt is a free-form string at `/api/prompt`. Templates are
// returned as a flat list with an optional grouping tree from
// `/api/prompt-templates`. We bind two synthetic dirty keys:
//   • `prompt.system` — system prompt body
//   • `prompt.template.<id>` — the active template body
//
// Each save target writes to its own endpoint, so onSave routes through
// both endpoints sequentially. Switching the template selector while the
// current draft is dirty prompts before discarding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import {
    PageError,
    PageLoading,
    PageOffline,
    SettingsNote,
    SettingsSection,
    StatusBadge,
    usePageSnapshot,
} from './page-shell';

type PromptResponse = { content?: string };

type Template = {
    id: string;
    filename?: string;
    content: string;
};

type TemplateTreeGroup = {
    id: string;
    label: string;
    emoji?: string;
    children: string[];
};

type TemplatesResponse = {
    templates?: Template[];
    tree?: TemplateTreeGroup[];
};

const SYSTEM_KEY = 'prompt.system';

export function templateDirtyKey(id: string): string {
    return `prompt.template.${id}`;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────

export function flattenTemplates(payload: TemplatesResponse | null | undefined): Template[] {
    if (!payload || !Array.isArray(payload.templates)) return [];
    return payload.templates.filter(
        (t): t is Template =>
            !!t && typeof t.id === 'string' && typeof t.content === 'string',
    );
}

export function buildTemplateOptions(payload: TemplatesResponse | null | undefined): Array<{
    value: string;
    label: string;
}> {
    const flat = flattenTemplates(payload);
    const tree = payload?.tree;
    const out: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();

    if (Array.isArray(tree)) {
        for (const group of tree) {
            if (!group || !Array.isArray(group.children)) continue;
            for (const id of group.children) {
                if (seen.has(id)) continue;
                const t = flat.find((x) => x.id === id);
                if (!t) continue;
                const prefix = group.emoji ? `${group.emoji} ${group.label} · ` : `${group.label} · `;
                out.push({ value: t.id, label: `${prefix}${t.id}` });
                seen.add(id);
            }
        }
    }
    for (const t of flat) {
        if (seen.has(t.id)) continue;
        out.push({ value: t.id, label: t.id });
        seen.add(t.id);
    }
    return out;
}

export function findTemplate(
    payload: TemplatesResponse | null | undefined,
    id: string,
): Template | null {
    return flattenTemplates(payload).find((t) => t.id === id) ?? null;
}

// ─── Page component ──────────────────────────────────────────────────

export default function Prompts({ port, client, dirty, registerSave }: SettingsPageProps) {
    const promptSnap = usePageSnapshot<PromptResponse>(client, '/api/prompt');
    const templatesSnap = usePageSnapshot<TemplatesResponse>(client, '/api/prompt-templates');

    const [systemDraft, setSystemDraft] = useState<string>('');
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
    const [templateDraft, setTemplateDraft] = useState<string>('');

    const originalSystem = useMemo(
        () => (promptSnap.state.kind === 'ready' ? promptSnap.state.data?.content ?? '' : ''),
        [promptSnap.state],
    );
    const templates = useMemo(
        () => (templatesSnap.state.kind === 'ready' ? templatesSnap.state.data : null),
        [templatesSnap.state],
    );
    const options = useMemo(() => buildTemplateOptions(templates), [templates]);

    // Track the keys we've touched so unmount cleanup is precise.
    const touchedTemplateKeysRef = useRef<Set<string>>(new Set());

    // Seed system draft once snapshot is ready.
    useEffect(() => {
        if (promptSnap.state.kind === 'ready') {
            setSystemDraft(promptSnap.state.data?.content ?? '');
        }
    }, [promptSnap.state]);

    // Seed template selection on first load.
    useEffect(() => {
        if (!templates || activeTemplateId !== null) return;
        const flat = flattenTemplates(templates);
        if (flat.length === 0) return;
        const first = options[0]?.value ?? flat[0]!.id;
        setActiveTemplateId(first);
        const t = findTemplate(templates, first);
        setTemplateDraft(t?.content ?? '');
    }, [templates, options, activeTemplateId]);

    // Cleanup all dirty keys on unmount.
    useEffect(() => {
        return () => {
            dirty.remove(SYSTEM_KEY);
            for (const key of touchedTemplateKeysRef.current) {
                dirty.remove(key);
            }
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => {
            dirty.set(key, entry);
            touchedTemplateKeysRef.current.add(key);
        },
        [dirty],
    );

    const onSystemChange = useCallback(
        (next: string) => {
            setSystemDraft(next);
            dirty.set(SYSTEM_KEY, {
                value: next,
                original: originalSystem,
                valid: true,
            });
        },
        [dirty, originalSystem],
    );

    const onTemplateBodyChange = useCallback(
        (next: string) => {
            if (!activeTemplateId) return;
            setTemplateDraft(next);
            const original = findTemplate(templates, activeTemplateId)?.content ?? '';
            setEntry(templateDirtyKey(activeTemplateId), {
                value: next,
                original,
                valid: true,
            });
        },
        [activeTemplateId, setEntry, templates],
    );

    const onSelectTemplate = useCallback(
        (nextId: string) => {
            if (!activeTemplateId || nextId === activeTemplateId) return;
            const currentKey = templateDirtyKey(activeTemplateId);
            const currentEntry = dirty.pending.get(currentKey);
            // Hot-edit edge: switching while dirty would silently drop the in-
            // progress edit. Confirm or keep the dirty state, but always swap
            // visible body to reflect the new template's saved content.
            if (currentEntry) {
                if (
                    typeof window !== 'undefined' &&
                    !window.confirm(
                        `You have unsaved edits to "${activeTemplateId}". Switching will keep them pending — Save will write all dirty templates.`,
                    )
                ) {
                    return;
                }
            }
            setActiveTemplateId(nextId);
            // If the new template already has a pending edit, surface that draft.
            const newKey = templateDirtyKey(nextId);
            const pendingNew = dirty.pending.get(newKey);
            const fresh = findTemplate(templates, nextId)?.content ?? '';
            setTemplateDraft(
                pendingNew && typeof pendingNew.value === 'string'
                    ? (pendingNew.value as string)
                    : fresh,
            );
        },
        [activeTemplateId, dirty, templates],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        const writes: Array<Promise<unknown>> = [];
        if (SYSTEM_KEY in bundle) {
            writes.push(client.put('/api/prompt', { content: bundle[SYSTEM_KEY] }));
        }
        for (const [key, value] of Object.entries(bundle)) {
            if (!key.startsWith('prompt.template.')) continue;
            const id = key.slice('prompt.template.'.length);
            writes.push(client.put(`/api/prompt-templates/${id}`, { content: value }));
        }
        if (writes.length === 0) return;
        // Run sequentially so backend `regenerateB()` runs against the latest
        // committed state in order. /api/prompt-templates/:id mutates files
        // and clears caches; parallelism would race the regenerate.
        for (const w of writes) {
            await w;
        }
        dirty.clear();
        touchedTemplateKeysRef.current.clear();
        await Promise.all([promptSnap.refresh(), templatesSnap.refresh()]);
    }, [client, dirty, promptSnap, templatesSnap]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (promptSnap.state.kind === 'loading' || templatesSnap.state.kind === 'loading') {
        return <PageLoading />;
    }
    if (promptSnap.state.kind === 'offline' || templatesSnap.state.kind === 'offline') {
        return <PageOffline port={port} />;
    }
    if (promptSnap.state.kind === 'error') return <PageError message={promptSnap.state.message} />;
    if (templatesSnap.state.kind === 'error') {
        return <PageError message={templatesSnap.state.message} />;
    }

    const flatList = flattenTemplates(templates);
    const activeTemplateOriginal = activeTemplateId
        ? findTemplate(templates, activeTemplateId)?.content ?? ''
        : '';
    const templateBodyDirty =
        activeTemplateId !== null && templateDraft !== activeTemplateOriginal;

    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="System prompt"
                hint="The agent's a2/system prompt. Saved to a2.md; regenerates the merged b prompt."
            >
                <label className="settings-field settings-field-text" htmlFor="prompt-system-body">
                    <span className="settings-field-label">a2.md</span>
                    <textarea
                        id="prompt-system-body"
                        style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                        value={systemDraft}
                        rows={14}
                        spellCheck={false}
                        onChange={(event) => onSystemChange(event.target.value)}
                    />
                </label>
                {systemDraft !== originalSystem && (
                    <SettingsNote>
                        <StatusBadge tone="warn">Unsaved</StatusBadge>{' '}
                        Pending edits to a2.md.
                    </SettingsNote>
                )}
            </SettingsSection>

            <SettingsSection
                title="Templates"
                hint="Edit individual prompt template bodies. Saving regenerates b automatically."
            >
                {flatList.length === 0 ? (
                    <SettingsNote>
                        No templates returned by /api/prompt-templates.
                    </SettingsNote>
                ) : (
                    <>
                        <label
                            className="settings-field settings-field-select"
                            htmlFor="prompt-template-select"
                        >
                            <span className="settings-field-label">Template</span>
                            <select
                                id="prompt-template-select"
                                value={activeTemplateId ?? ''}
                                onChange={(event) => onSelectTemplate(event.target.value)}
                            >
                                {options.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label
                            className="settings-field settings-field-text"
                            htmlFor="prompt-template-body"
                        >
                            <span className="settings-field-label">
                                {activeTemplateId
                                    ? `${activeTemplateId}.md`
                                    : 'Template body'}
                            </span>
                            <textarea
                                id="prompt-template-body"
                                style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                                value={templateDraft}
                                rows={16}
                                spellCheck={false}
                                disabled={!activeTemplateId}
                                onChange={(event) => onTemplateBodyChange(event.target.value)}
                            />
                        </label>
                        {templateBodyDirty && (
                            <SettingsNote>
                                <StatusBadge tone="warn">Unsaved</StatusBadge>{' '}
                                Pending edits to {activeTemplateId}.md.
                            </SettingsNote>
                        )}
                    </>
                )}
            </SettingsSection>
        </form>
    );
}
