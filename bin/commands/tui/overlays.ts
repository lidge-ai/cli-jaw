/**
 * TUI overlays: dismiss, autocomplete, resize, slash commands.
 */
import {
    clearOverlayBox, renderHelpOverlay, renderCommandPalette, renderChoiceSelector,
    renderBgtaskOverlay, formatBgtaskDuration, type BgtaskOverlayItem,
    clearAutocomplete, closeAutocomplete, resolveAutocompleteState,
    applyResolvedAutocompleteState, renderAutocomplete, popupTotalRows,
    makeSelectionKey, resetAutocompleteState,
} from '../../../src/cli/tui/overlay.js';
import { getPlainCommandDraft, getTrailingTextSegment } from '../../../src/cli/tui/composer.js';
import { findAtMentionMatch, listRepoFiles } from '../../../src/cli/tui/file-mention.js';
import { findSkillMentionMatch, listSkillMentionItems } from '../../../src/cli/tui/skill-mention.js';
import { clipTextToCols } from '../../../src/cli/tui/renderers.js';
import { tuiWrite } from './tui-io.js';
import { resolveShellLayout, setupScrollRegion, ensureSpaceBelow } from '../../../src/cli/tui/shell.js';
import { getCompletionItems } from '../../../src/cli/commands.js';
import { buildAppearanceRows, nextAppearancePatch } from '../../../src/cli/tui/settings-screen.js';
import { c, hrLine, getRows, type TuiContext } from './types.js';
import { showPrompt, redrawPromptLine, rebuildFooter } from './renderer.js';
import { refreshInfo, makeCliCommandCtx } from './api.js';
import { closeTuiActivityHistory } from './activity-history.js';

export function closeAutocompleteForCtx(ctx: TuiContext): void {
    const ac = ctx.store.autocomplete;
    if (ctx.displayMode === 'fullscreen') {
        resetAutocompleteState(ac);
        return;
    }
    closeAutocomplete(ac, (chunk) => tuiWrite(ctx, chunk));
}

function paletteRenderOpts(ctx: TuiContext) {
    const ov = ctx.store.overlay;
    return {
        write: (chunk: string) => tuiWrite(ctx, chunk),
        cols: process.stdout.columns || 80,
        rows: getRows(),
        dimCode: c.dim,
        resetCode: c.reset,
        filter: ov.paletteFilter,
        items: ov.paletteItems,
        selected: ov.paletteSelected,
    };
}

function selectorRenderOpts(ctx: TuiContext) {
    const sel = ctx.store.overlay.selector;
    return {
        write: (chunk: string) => tuiWrite(ctx, chunk),
        cols: process.stdout.columns || 80,
        rows: getRows(),
        dimCode: c.dim,
        resetCode: c.reset,
        title: sel.title,
        subtitle: sel.subtitle,
        filter: sel.filter,
        items: sel.filteredItems,
        selected: sel.selected,
    };
}

export function openHelpOverlay(ctx: TuiContext): void {
    const ov = ctx.store.overlay;
    ov.helpOpen = true;
    closeAutocompleteForCtx(ctx);
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    const cmds = getCompletionItems('/', 'cli');
    ctx.overlayBoxHeight = renderHelpOverlay(
        (chunk) => tuiWrite(ctx, chunk),
        process.stdout.columns || 80,
        getRows(),
        c.dim, c.reset,
        cmds,
    );
}

export function openCommandPalette(ctx: TuiContext): void {
    const ov = ctx.store.overlay;
    ov.paletteOpen = true;
    ov.paletteFilter = '';
    ov.paletteSelected = 0;
    ov.paletteItems = getCompletionItems('/', 'cli');
    closeAutocompleteForCtx(ctx);
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    ctx.overlayBoxHeight = renderCommandPalette(paletteRenderOpts(ctx));
}

export function refreshCommandPalette(ctx: TuiContext): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    ctx.overlayBoxHeight = renderCommandPalette(paletteRenderOpts(ctx));
}

export function openChoiceSelector(ctx: TuiContext, setup: () => void): void {
    setup();
    closeAutocompleteForCtx(ctx);
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    ctx.overlayBoxHeight = renderChoiceSelector(selectorRenderOpts(ctx));
}

export function openSettingsScreen(ctx: TuiContext): void {
    const ov = ctx.store.overlay;
    ov.settingsOpen = true;
    ov.settingsTab = 'appearance';
    ov.settingsSelected = 0;
    ov.settingsMessage = '';
    closeAutocompleteForCtx(ctx);
    void refreshInfo(ctx).finally(() => ctx.requestFrame?.());
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
    }
}

export async function applySettingsSelection(ctx: TuiContext): Promise<void> {
    const ov = ctx.store.overlay;
    const rows = buildAppearanceRows({
        settings: ctx.settingsSnapshot,
        tuiConfig: ctx.tuiConfig,
        footerPreview: ctx.footer,
    });
    const selected = Math.max(0, Math.min(ov.settingsSelected, rows.length - 1));
    ov.settingsSelected = selected;
    const row = rows[selected];
    if (!row) return;
    const patch = nextAppearancePatch(row, {
        settings: ctx.settingsSnapshot,
        tuiConfig: ctx.tuiConfig,
        footerPreview: ctx.footer,
    });
    if (!patch) {
        ov.settingsMessage = `${row.label} is read-only in this cycle`;
        ctx.requestFrame?.();
        return;
    }
    try {
        await makeCliCommandCtx(ctx).updateSettings(patch);
        const tuiPatch = patch['tui'];
        if (tuiPatch && typeof tuiPatch === 'object' && !Array.isArray(tuiPatch)) {
            ctx.tuiConfig = { ...ctx.tuiConfig, ...(tuiPatch as Record<string, unknown>) };
            if ((tuiPatch as Record<string, unknown>)['theme'] === 'dark' || (tuiPatch as Record<string, unknown>)['theme'] === 'light') {
                process.env['JAW_TUI_THEME'] = (tuiPatch as Record<string, string>)['theme'];
            }
        }
        const refreshed = await refreshInfo(ctx);
        rebuildFooter(ctx);
        ov.settingsMessage = refreshed ? `Saved ${row.label}` : `Saved ${row.label}; reopen settings to refresh`;
    } catch (error) {
        ov.settingsMessage = `Failed to save ${row.label}: ${error instanceof Error ? error.message : String(error)}`;
    }
    ctx.requestFrame?.();
}

export function refreshChoiceSelector(ctx: TuiContext): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    ctx.overlayBoxHeight = renderChoiceSelector(selectorRenderOpts(ctx));
}

function parseBgtaskTs(value: string | null | undefined): number {
    if (!value) return Number.NaN;
    return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function bgtaskElapsed(startedAt: string | null): string {
    const start = parseBgtaskTs(startedAt);
    if (!Number.isFinite(start)) return '';
    return formatBgtaskDuration(Math.max(0, Date.now() - start));
}

/** "2m30s ago" hint for terminal rows. */
function bgtaskAgo(completedAt: string | null | undefined): string {
    const done = parseBgtaskTs(completedAt);
    if (!Number.isFinite(done)) return '';
    return `${formatBgtaskDuration(Math.max(0, Date.now() - done))} ago`;
}

/** Ctrl+O — server-owned background tasks (bgtask). Fetches fresh state so the
 * overlay is accurate even if SSE events were missed; falls back to the last
 * ws-pushed snapshot when the API call fails. */
export async function openBgtaskOverlay(ctx: TuiContext): Promise<void> {
    const ov = ctx.store.overlay;
    ov.bgtaskOpen = true;
    closeAutocompleteForCtx(ctx);
    // Opening the panel acknowledges that the user saw the failure;
    // drop the `!` badge from the status bar.
    if (ctx.bgtaskAttention) {
        ctx.bgtaskAttention = false;
        rebuildFooter(ctx);
    }
    let items: BgtaskOverlayItem[] = ctx.bgtaskTasks.map((t) => ({
        id: t.id, kind: t.kind, status: 'running', elapsed: bgtaskElapsed(t.startedAt),
        sortKey: parseBgtaskTs(t.startedAt) || 0,
    }));
    try {
        const res = await fetch(`${ctx.apiUrl}/api/bgtask?limit=10`);
        if (res.ok) {
            const body = await res.json() as { tasks?: Array<{ id: string; kind: string; status: string; startedAt: string | null; completedAt?: string | null }> };
            if (Array.isArray(body.tasks)) {
                items = body.tasks
                    .filter((t) => t.status === 'running' || t.status === 'complete' || t.status === 'failed' || t.status === 'cancelled' || t.status === 'orphaned')
                    .slice(0, 10)
                    .map((t) => {
                        const running = t.status === 'running';
                        const ago = running ? '' : bgtaskAgo(t.completedAt);
                        const sortKey = parseBgtaskTs(running ? t.startedAt : (t.completedAt ?? t.startedAt)) || 0;
                        return {
                            id: t.id, kind: t.kind, status: t.status,
                            elapsed: running ? bgtaskElapsed(t.startedAt) : '',
                            ...(ago ? { ago } : {}),
                            sortKey,
                        };
                    });
            }
        }
    } catch { /* fall back to ws snapshot */ }
    if (!ov.bgtaskOpen) return; // dismissed while fetching
    // Shared with the fullscreen frame composer — it paints from this cache
    // instead of the running-only ws snapshot (which has no terminal rows).
    ctx.bgtaskOverlayItems = items;
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    ctx.overlayBoxHeight = renderBgtaskOverlay(
        (chunk) => tuiWrite(ctx, chunk),
        process.stdout.columns || 80,
        getRows(),
        c.dim, c.reset,
        items,
    );
}

export function dismissOverlay(ctx: TuiContext): void {
    const ov = ctx.store.overlay;
    if (!ov.helpOpen && !ov.paletteOpen && !ov.selector.open && !ov.bgtaskOpen && !ov.settingsOpen && !ov.activityHistory.open) return;
    if (ov.activityHistory.open) closeTuiActivityHistory(ctx);
    if (ctx.displayMode === 'fullscreen') {
        ov.helpOpen = false;
        ov.bgtaskOpen = false;
        ov.paletteOpen = false;
        ov.settingsOpen = false;
        ov.settingsTab = 'appearance';
        ov.settingsSelected = 0;
        ov.settingsMessage = '';
        ov.paletteFilter = '';
        ov.paletteSelected = 0;
        ov.paletteItems = [];
        ov.selector.open = false;
        ov.selector.commandName = '';
        ov.selector.filter = '';
        ov.selector.selected = 0;
        ov.selector.allItems = [];
        ov.selector.filteredItems = [];
        ctx.requestFrame?.();
        return;
    }
    if (ctx.overlayBoxHeight > 0) {
        clearOverlayBox(
            (chunk) => tuiWrite(ctx, chunk),
            process.stdout.columns || 80,
            getRows(),
            ctx.overlayBoxHeight,
        );
        ctx.overlayBoxHeight = 0;
    }
    ov.helpOpen = false;
    ov.bgtaskOpen = false;
    ov.paletteOpen = false;
    ov.settingsOpen = false;
    ov.settingsTab = 'appearance';
    ov.settingsSelected = 0;
    ov.settingsMessage = '';
    ov.paletteFilter = '';
    ov.paletteSelected = 0;
    ov.paletteItems = [];
    ov.selector.open = false;
    ov.selector.commandName = '';
    ov.selector.filter = '';
    ov.selector.selected = 0;
    ov.selector.allItems = [];
    ov.selector.filteredItems = [];
    setupScrollRegion(
        ctx.footer,
        `  ${c.dim}${hrLine()}${c.reset}`,
        resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes),
    );
    showPrompt(ctx);
    redrawPromptLine(ctx);
}

export function getMaxPopupRows(): number {
    return Math.max(0, getRows() - 3);
}

let autocompleteRedrawSeq = 0;

export async function redrawInputWithAutocomplete(ctx: TuiContext): Promise<void> {
    const requestSeq = ++autocompleteRedrawSeq;
    const ac = ctx.store.autocomplete;
    const prevItem = ac.items[ac.selected];
    const prevKey = makeSelectionKey(prevItem, ac.stage);
    const slashDraft = getPlainCommandDraft(ctx.store.composer);
    let next;
    if (slashDraft !== null && slashDraft.startsWith('/')) {
        next = await resolveAutocompleteState({
            draft: slashDraft,
            prevKey,
            maxPopupRows: getMaxPopupRows(),
            maxRowsCommand: ac.maxRowsCommand,
            maxRowsArgument: ac.maxRowsArgument,
        });
    } else {
        const trailing = getTrailingTextSegment(ctx.store.composer);
        const single = ctx.store.composer.segments.length === 1;
        // `@$jaw` matches both grammars; the older `@file` popup keeps priority.
        const mention = single ? findAtMentionMatch(trailing.text, ctx.store.composer.cursor) : null;
        const skillMention = single && !mention ? findSkillMentionMatch(trailing.text, ctx.store.composer.cursor) : null;
        if (mention || skillMention) {
            const items = mention ? listRepoFiles(ctx.chatCwd, mention.query) : listSkillMentionItems(skillMention!.query);
            const headerRows = 1;
            const maxItemRows = Math.max(0, getMaxPopupRows() - headerRows);
            const visibleRows = Math.min(ac.maxRowsArgument, items.length, maxItemRows);
            next = items.length && visibleRows > 0
                ? {
                    open: true,
                    stage: 'argument',
                    contextHeader: mention ? '@ files' : '$ skills',
                    items,
                    selected: Math.min(ac.selected, items.length - 1),
                    visibleRows,
                }
                : { open: false, items: [], selected: 0, visibleRows: 0 };
        } else {
            next = { open: false, items: [], selected: 0, visibleRows: 0 };
        }
    }

    if (requestSeq !== autocompleteRedrawSeq) return;

    if (ctx.displayMode === 'fullscreen') {
        applyResolvedAutocompleteState(ac, next);
        ctx.requestFrame?.();
        return;
    }

    clearAutocomplete(ac, (chunk) => tuiWrite(ctx, chunk));
    if (next.open) ensureSpaceBelow(popupTotalRows(next));
    redrawPromptLine(ctx);
    applyResolvedAutocompleteState(ac, next);
    renderAutocomplete(ac, {
        write: (chunk) => tuiWrite(ctx, chunk),
        columns: process.stdout.columns || 80,
        dimCode: c.dim,
        resetCode: c.reset,
        clipTextToCols,
    });
}

export function handleResize(ctx: TuiContext): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    setupScrollRegion(
        ctx.footer,
        `  ${c.dim}${hrLine()}${c.reset}`,
        resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes),
    );
    if (!ctx.inputActive || ctx.commandRunning) return;
    redrawInputWithAutocomplete(ctx);
}
