import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CodeControllerModel } from './code-controller-types';
import type { CodeCreateSessionRequest } from '../../../../src/code-mode/wire';
import { CODE_POLICY_DETAILS, CODE_POLICY_LABELS, CODE_RUNTIME_LABELS } from './code-types';
import type { CodeNotice } from './code-toasts';
import { CheckGlyph, ProviderGlyph } from './ProviderGlyph';
import { ContextUsageMeter } from './ContextUsageMeter';

type MenuOption<T extends string> = {
    value: T; label: string; detail?: string | undefined; disabled?: boolean; icon?: ReactNode;
};

/**
 * One dropup for every composer control.
 *
 * `triggerContent` replaces the label+value pair for icon-only controls; the
 * accessible name still comes from `label`, so an icon trigger is never
 * anonymous. `filterable` adds a search field, which the model menu needs
 * because a live Codex catalog can carry 28+ routed ids.
 */
export function CodeFooterMenu<T extends string>({ label, value, options, disabled, onChange, displayValue,
    triggerContent, filterable, filterPlaceholder, className, title }: {
    label: string; value: T; options: MenuOption<T>[]; disabled: boolean; onChange(value: T): void;
    displayValue?: string; triggerContent?: ReactNode; filterable?: boolean; filterPlaceholder?: string;
    className?: string; title?: string;
}) {
    const id = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const [position, setPosition] = useState<{ left: number; bottom: number | 'auto'; top?: number; width: number; maxHeight: number } | null>(null);
    const [query, setQuery] = useState('');
    const selected = options.find(option => option.value === value);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!filterable || !needle) return options;
        return options.filter(option => option.value.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle));
    }, [filterable, options, query]);
    function close(restore = true) { setPosition(null); setQuery(''); if (restore) triggerRef.current?.focus(); }
    function open() {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect || disabled) return;
        const width = Math.max(192, Math.min(filterable ? 340 : 260, window.innerWidth - 28));
        const above = Math.max(0, rect.top - 16);
        const below = Math.max(0, window.innerHeight - rect.bottom - 16);
        const common = { left: Math.max(14, Math.min(rect.left, window.innerWidth - width - 14)), width };
        setPosition(above >= below
            ? { ...common, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(288, above) }
            : { ...common, bottom: 'auto', top: rect.bottom + 8, maxHeight: Math.min(288, below) });
    }
    useEffect(() => {
        if (!position) return;
        // A filterable menu types first; otherwise land on the current choice so
        // arrow keys move relative to what is already selected.
        if (filterable) search.current?.focus();
        else {
            const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            const current = [...(buttons ?? [])].find(button => button.getAttribute('aria-selected') === 'true');
            (current ?? buttons?.[0])?.focus();
        }
        const outside = (event: PointerEvent) => {
            if (!menu.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close(false);
        };
        const resize = () => close(false);
        document.addEventListener('pointerdown', outside);
        window.addEventListener('resize', resize);
        return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
    }, [position, filterable]);
    useEffect(() => { if (disabled) { setPosition(null); setQuery(''); } }, [disabled]);
    function navigate(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        // Tab closes the menu but keeps its own meaning: restoring focus to the
        // trigger here would swallow the move and strand the user for one press.
        if (event.key === 'Tab') { close(false); return; }
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (buttons.length === 0) return;
        const current = buttons.findIndex(button => button === document.activeElement);
        let index: number;
        if (event.key === 'ArrowDown') index = (current + 1) % buttons.length;
        else if (event.key === 'ArrowUp') index = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = buttons.length - 1;
        else return;
        event.preventDefault(); buttons[index]?.focus();
    }
    const shown = selected?.label ?? displayValue ?? (value || 'not selected');
    const name = `${label}: ${shown}`;
    return <div className={`code-footer-menu${className ? ` ${className}` : ''}`}>
        <button ref={triggerRef} type="button" className={`code-footer-menu-trigger${triggerContent ? ' is-icon' : ''}`}
            aria-label={name} aria-haspopup="listbox" aria-expanded={Boolean(position)} aria-controls={position ? id : undefined}
            disabled={disabled} title={title ?? selected?.detail ?? name} onClick={() => position ? close() : open()}
            onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } }}>
            {triggerContent ?? <><span className="code-footer-label">{label}</span>
                <strong>{selected?.label ?? displayValue ?? (value || 'Not selected')}</strong></>}
        </button>
        {position && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="code-footer-dropup code-footer-floating"
            style={position} onKeyDown={navigate}>
            {filterable && <input ref={search} type="text" className="code-footer-filter" value={query}
                aria-label={`Filter ${label.toLowerCase()}`} placeholder={filterPlaceholder ?? 'Filter…'}
                onChange={event => setQuery(event.target.value)} />}
            <div className="code-footer-dropup-list">
                {visible.map(option => <button type="button" role="option" aria-selected={option.value === value}
                    key={option.value} disabled={option.disabled} className="code-footer-dropup-option"
                    title={option.detail ?? option.label}
                    onClick={() => { onChange(option.value); close(); }}>
                    {option.icon && <span className="code-footer-option-icon">{option.icon}</span>}
                    <span className="code-footer-option-text"><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
                    {option.value === value && <CheckGlyph />}
                </button>)}
                {visible.length === 0 && <p className="code-footer-dropup-empty" role="note">No match for “{query.trim()}”.</p>}
            </div>
        </div>, document.body)}
    </div>;
}

export function ComposerFooter({ controller: c, onNotice }: {
    controller: CodeControllerModel;
    onNotice?: ((notice: CodeNotice) => void) | undefined;
}) {
    const selection = c.selection;
    const provider = c.catalog?.providers.find(entry => entry.id === selection.provider);
    const capabilities = c.session?.capabilities ?? provider?.capabilities;
    // Claude switches permission modes live, so its menu follows today's catalog rather
    // than the snapshot a session was created with; other runtimes keep their snapshot.
    const permissionModes = (selection.provider === 'claude' ? provider?.capabilities : capabilities)?.permissionModes ?? [];
    const locked = c.selectedId !== null;
    const disabled = c.pending || c.busy || c.creationUnknown || c.operation.kind !== 'idle' || (locked && (!c.synced || c.session?.status !== 'idle' || c.session?.archivedAt !== null));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const guard = useRef(false);
    const noticeRef = useRef(onNotice); noticeRef.current = onNotice;
    // Announce the change, not the state. "Auto (YOLO)" as a permanent line
    // stops being read after the first time; the moment it is switched on is
    // the moment worth interrupting for. What the policy currently is stays
    // legible on the Permission control itself.
    useEffect(() => {
        if (selection.permissionMode !== 'auto') {
            // Leaving auto retires the warning immediately. A notice that
            // outlived the policy would be stating something false about what
            // the session is allowed to do.
            noticeRef.current?.({ id: 'code:permission-mode', clear: true });
            return;
        }
        // Derived from the current policy, not from a transition. The footer
        // remounts when the draft becomes a real session, and a transition
        // detector reads that remount as "no change" -- which deleted the
        // warning at the exact moment the session started acting on it.
        noticeRef.current?.({ id: 'code:permission-mode', variant: 'warning',
            message: 'Auto (YOLO): actions may run without approval.',
            durationMs: Number.POSITIVE_INFINITY });
    }, [selection.permissionMode]);
    async function change(patch: Partial<CodeCreateSessionRequest>) {
        if (disabled || guard.current) return;
        guard.current = true; setSaving(true); setError(null);
        try { await c.setSelection(patch); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { guard.current = false; setSaving(false); }
    }
    const controlsDisabled = disabled || saving;
    // A model may accept a narrower effort set than the provider union, so the
    // per-model set is preferred. An open session is additionally bound by the
    // capabilities it stored at creation -- the server checks both -- so offer
    // the intersection rather than a value the session would reject.
    const catalogEfforts = provider?.effortsByModel?.[selection.model] ?? capabilities?.efforts ?? [];
    const sessionEfforts = c.session?.capabilities.efforts;
    const modelEfforts = sessionEfforts
        ? catalogEfforts.filter(value => sessionEfforts.includes(value))
        : catalogEfforts;
    const models = provider?.models ?? [];
    return <>
        <div className="code-composer-footer">
            <CodeFooterMenu label="Runtime" value={selection.provider} className="code-footer-runtime"
                disabled={locked ? !c.catalog : controlsDisabled || !c.catalog}
                triggerContent={<ProviderGlyph provider={selection.provider} />}
                title={CODE_RUNTIME_LABELS[selection.provider]}
                options={(Object.keys(CODE_RUNTIME_LABELS) as Array<keyof typeof CODE_RUNTIME_LABELS>).map(id => {
                    const entry = c.catalog?.providers.find(p => p.id === id);
                    return { value: id, label: locked && id !== selection.provider ? `New ${CODE_RUNTIME_LABELS[id]} session` : CODE_RUNTIME_LABELS[id],
                        disabled: !entry?.available || (locked && id === selection.provider),
                        icon: <ProviderGlyph provider={id} />,
                        detail: entry?.reason ?? (entry?.available ? undefined : 'Availability unknown') };
                })} onChange={value => {
                    if (locked) void c.setSelection({ provider: value }).catch(err => setError(err instanceof Error ? err.message : String(err)));
                    else void change({ provider: value });
                }} />
            <CodeFooterMenu label="Permission" value={selection.permissionMode} displayValue={CODE_POLICY_LABELS[selection.permissionMode]}
                disabled={controlsDisabled || !capabilities?.permissions}
                options={permissionModes.map(value => ({ value, label: CODE_POLICY_LABELS[value], detail: CODE_POLICY_DETAILS[value] }))}
                onChange={value => void change({ permissionMode: value })} />
            <span className="code-composer-footer-spacer" aria-hidden="true" />
            <ContextUsageMeter usage={c.session?.contextUsage} />
            <CodeFooterMenu label="Model" value={selection.model} className="code-footer-model"
                disabled={controlsDisabled || models.length === 0} filterable filterPlaceholder="Filter models…"
                displayValue={selection.model || 'Select model'}
                options={models.map(value => ({ value, label: value }))}
                onChange={value => void change({ model: value })} />
            {modelEfforts.length > 0 && <CodeFooterMenu label="Effort" value={selection.effort ?? ''}
                className="code-footer-effort" displayValue={selection.effort ?? 'Default'}
                options={[{ value: '', label: 'Native default' }, ...modelEfforts.map(value => ({ value, label: value }))]}
                disabled={controlsDisabled} onChange={value => void change({ effort: value || null })} />}
            {selection.provider === 'claude' && <CodeFooterMenu label="Thinking" value={selection.thinking === false ? 'off' : 'on'}
                className="code-footer-thinking"
                options={[{ value: 'on', label: 'Thinking on', detail: 'Adaptive thinking with summaries' },
                    { value: 'off', label: 'Thinking off', detail: 'Answer without extended thinking' }]}
                disabled={controlsDisabled} onChange={value => void change({ thinking: value === 'on' })} />}
            {locked && <button type="button" className="code-inline-action" onClick={c.newSession}>New session</button>}
        </div>
        {models.length === 0 && provider?.available && <div className="code-selection-notice">This runtime published no models.
            <button type="button" className="code-inline-action" onClick={() => { void c.refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }}>Refresh catalog</button>
        </div>}
        {!provider?.available && <div className="code-selection-notice">{provider?.reason ?? 'Runtime availability has not been confirmed.'}
            <button type="button" className="code-inline-action" onClick={() => { void c.refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }}>Refresh availability</button>
        </div>}
        {(saving || c.operation.kind === 'patching') && <span role="status">Saving settings…</span>}
        {/* Stays inline. A failed setting change is something the reader has to
            act on -- the control reverted and this is the only account of why --
            and it must not leave on a timer before they have read it. */}
        {error && <div className="code-action-error" role="alert">{error}</div>}
    </>;
}
