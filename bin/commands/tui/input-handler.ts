import {
    appendNewlineToComposer, appendTextToComposer, backspaceComposer,
    clearComposer, flattenComposerForSubmit, getComposerDisplayText,
    getPlainCommandDraft, getTrailingTextSegment, setBracketedPaste,
    moveCursorLeft, moveCursorRight, moveCursorWordLeft, moveCursorWordRight,
    moveCursorHome, moveCursorEnd, deleteForwardComposer,
    killToStartComposer, killWordComposer, yankComposer, undoComposer,
    insertAtMention, setComposerText,
} from '../../../src/cli/tui/composer.js';
import { classifyKeyAction } from '../../../src/cli/tui/keymap.js';
import { findAtMentionMatch } from '../../../src/cli/tui/file-mention.js';
import { findSkillMentionMatch } from '../../../src/cli/tui/skill-mention.js';
import { openExternalEditor } from '../../../src/cli/tui/editor.js';
import { renderAutocomplete, filterSelectorItems, syncAutocompleteWindow } from '../../../src/cli/tui/overlay.js';
import { clipTextToCols } from '../../../src/cli/tui/renderers.js';
import { tuiWrite } from './tui-io.js';
import { cleanupScrollRegion, resolveShellLayout } from '../../../src/cli/tui/shell.js';
import { parseCommand } from '../../../src/cli/commands.js';
import { getCompletionItems } from '../../../src/cli/commands.js';
import { appendUserItem } from '../../../src/cli/tui/transcript.js';
import { buildAppearanceRows } from '../../../src/cli/tui/settings-screen.js';
import { captureFileSet } from '../../../src/ide/diff.js';
import fs from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { c, getRows, ESC_WAIT_MS, type TuiContext } from './types.js';
import { openPromptBlock, reopenPromptLine, redrawPromptLine, renderBlockSeparator, clearPromptBlock, computeComposerVisualRows } from './renderer.js';
import { openBgtaskOverlay, dismissOverlay, redrawInputWithAutocomplete, openHelpOverlay, openCommandPalette, refreshCommandPalette, refreshChoiceSelector, closeAutocompleteForCtx, applySettingsSelection } from './overlays.js';
import { runSlashCommand } from './slash-command-runner.js';
import { appendFullscreenStatus, isFullscreen, requestFullscreenFrame } from './fullscreen-feedback.js';
import { closeTuiActivityHistory } from './activity-history.js';

function refreshAutocompleteNav(ctx: TuiContext): void {
    const ac = ctx.store.autocomplete;
    syncAutocompleteWindow(ac);
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    renderAutocomplete(ac, {
        write: (chunk) => tuiWrite(ctx, chunk),
        columns: process.stdout.columns || 80,
        dimCode: c.dim, resetCode: c.reset, clipTextToCols,
    });
}

function applyFileMentionPick(ctx: TuiContext, relPath: string): void {
    const composer = ctx.store.composer;
    const trailing = getTrailingTextSegment(composer);
    const mention = findAtMentionMatch(trailing.text, composer.cursor);
    if (!mention) return;
    insertAtMention(composer, mention.replaceStart, relPath);
    closeAutocompleteForCtx(ctx);
    redrawPromptLine(ctx);
}

function applySkillMentionPick(ctx: TuiContext, id: string): void {
    const composer = ctx.store.composer;
    const trailing = getTrailingTextSegment(composer);
    const mention = findSkillMentionMatch(trailing.text, composer.cursor);
    if (!mention) return;
    insertAtMention(composer, mention.replaceStart, id, '$');
    closeAutocompleteForCtx(ctx);
    redrawPromptLine(ctx);
}

async function openComposerInExternalEditor(ctx: TuiContext): Promise<void> {
    const composer = ctx.store.composer;
    const draft = flattenComposerForSubmit(composer);
    closeAutocompleteForCtx(ctx);
    setBracketedPaste(false);
    process.stdin.setRawMode(false);
    process.stdout.write('\n');
    const edited = openExternalEditor(draft);
    process.stdin.setRawMode(true);
    setBracketedPaste(true);
    clearComposer(composer);
    if (edited) setComposerText(composer, edited);
    redrawInputWithAutocomplete(ctx);
}

export function flushPendingEscape(ctx: TuiContext): void {
    ctx.escPending = false;
    ctx.escTimer = null;
    const ov = ctx.store.overlay;
    if (ctx.store.activityPasteDrain.active) return;
    if (ov.activityHistory.open) { closeTuiActivityHistory(ctx); return; }
    if (ov.helpOpen || ov.paletteOpen || ov.selector.open || ov.bgtaskOpen || ov.settingsOpen) {
        dismissOverlay(ctx);
        return;
    }
    const ac = ctx.store.autocomplete;
    if (ac.open) {
        closeAutocompleteForCtx(ctx);
        redrawPromptLine(ctx);
        return;
    }
    // Stop on ESC whenever a turn is streaming, even if the composer is open \u2014
    // typing mid-stream flips inputActive and used to turn ESC into a no-op
    //. Composer text is
    // preserved so an interrupted steer draft is not lost.
    if (!ctx.inputActive || ctx.streaming) {
        // A live stream must stay stoppable even while a slash command is in
        // flight (e.g. /steer awaits up to 45s server-side) — only block the
        // stop when there is no stream to stop.
        if (ctx.commandRunning && !ctx.streaming) return;
        sendStopForStreaming(ctx);
    }
}

function sendStopForStreaming(ctx: TuiContext): void {
    const composerWasOpen = ctx.inputActive;
    ctx.ws.send(JSON.stringify({ type: 'stop' }));
    ctx.inputActive = true;
    if (isFullscreen(ctx)) {
        appendFullscreenStatus(ctx, 'stopped');
        return;
    }
    console.log(`\n  ${c.yellow}\u25A0 stopped${c.reset}`);
    if (composerWasOpen) redrawPromptLine(ctx);
    else openPromptBlock(ctx);
}

export function handleKeyInput(ctx: TuiContext, rawKey: string): void {
    let key = rawKey;
    if (ctx.escPending) {
        if (ctx.escTimer) clearTimeout(ctx.escTimer);
        ctx.escTimer = null;
        ctx.escPending = false;
        if (!key.startsWith('\x1b')) key = `\x1b${key}`;
    }

    const action = classifyKeyAction(key);
    if (action === 'escape-alone') {
        ctx.escPending = true;
        ctx.escTimer = setTimeout(() => flushPendingEscape(ctx), ESC_WAIT_MS);
        return;
    }

    const ov = ctx.store.overlay;
    const ac = ctx.store.autocomplete;
    const composer = ctx.store.composer;
    const panes = ctx.store.panes;

    // Option+Enter → insert newline
    if (action === 'option-enter') {
        if (ctx.commandRunning) return;
        if (!ctx.inputActive) {
            ctx.inputActive = true;
            openPromptBlock(ctx);
        }
        appendNewlineToComposer(composer);
        redrawInputWithAutocomplete(ctx);
        return;
    }

    // Help overlay: ? when input is empty
    if (action === 'printable' && key === '?' && !ac.open && !ov.paletteOpen) {
        const draft = getPlainCommandDraft(composer);
        if (draft === '' || draft === null) {
            if (ov.helpOpen) {
                dismissOverlay(ctx);
                return;
            }
            openHelpOverlay(ctx);
            return;
        }
    }

    // Dismiss help on any key that isn't ?
    if (ov.helpOpen) {
        dismissOverlay(ctx);
    }

    // Background tasks overlay: Ctrl+O
    if (action === 'ctrl-o' && !ov.helpOpen && !ov.paletteOpen && !ov.selector.open && !ov.settingsOpen) {
        if (ov.bgtaskOpen) {
            dismissOverlay(ctx);
            return;
        }
        void openBgtaskOverlay(ctx);
        return;
    }

    // Command palette: Ctrl+K
    if (action === 'ctrl-k' && !ov.helpOpen && !ov.settingsOpen) {
        if (ov.paletteOpen) {
            dismissOverlay(ctx);
            return;
        }
        openCommandPalette(ctx);
        return;
    }

    // Palette input handling
    if (ov.paletteOpen) {
        if (action === 'arrow-up') {
            ov.paletteSelected = Math.max(0, ov.paletteSelected - 1);
        } else if (action === 'arrow-down') {
            ov.paletteSelected = Math.min(ov.paletteItems.length - 1, ov.paletteSelected + 1);
        } else if (action === 'enter') {
            const picked = ov.paletteItems[ov.paletteSelected];
            dismissOverlay(ctx);
            if (picked) {
                clearComposer(composer);
                appendTextToComposer(composer, `/${picked.name}`);
                handleKeyInput(ctx, '\r');
            }
            return;
        } else if (action === 'backspace') {
            ov.paletteFilter = ov.paletteFilter.slice(0, -1);
            ov.paletteItems = getCompletionItems('/' + ov.paletteFilter, 'cli');
            ov.paletteSelected = Math.min(ov.paletteSelected, Math.max(0, ov.paletteItems.length - 1));
        } else if (action === 'printable') {
            ov.paletteFilter += key;
            ov.paletteItems = getCompletionItems('/' + ov.paletteFilter, 'cli');
            ov.paletteSelected = Math.min(ov.paletteSelected, Math.max(0, ov.paletteItems.length - 1));
        } else {
            return;
        }
        refreshCommandPalette(ctx);
        return;
    }

    if (ov.settingsOpen) {
        const rows = buildAppearanceRows({
            settings: ctx.settingsSnapshot,
            tuiConfig: ctx.tuiConfig,
            footerPreview: ctx.footer,
        });
        const max = Math.max(0, rows.length - 1);
        if (action === 'arrow-up') {
            ov.settingsSelected = Math.max(0, ov.settingsSelected - 1);
            ov.settingsMessage = '';
        } else if (action === 'arrow-down') {
            ov.settingsSelected = Math.min(max, ov.settingsSelected + 1);
            ov.settingsMessage = '';
        } else if (action === 'home') {
            ov.settingsSelected = 0;
            ov.settingsMessage = '';
        } else if (action === 'end') {
            ov.settingsSelected = max;
            ov.settingsMessage = '';
        } else if (action === 'enter' || (action === 'printable' && key === ' ')) {
            void applySettingsSelection(ctx);
            return;
        } else {
            return;
        }
        ctx.requestFrame?.();
        return;
    }

    // Choice selector input handling
    if (ov.selector.open) {
        const sel = ov.selector;
        const itemCount = sel.filteredItems.length;
        if (action === 'arrow-up') {
            if (itemCount > 0) sel.selected = Math.max(0, sel.selected - 1);
        } else if (action === 'arrow-down') {
            if (itemCount > 0) sel.selected = Math.min(itemCount - 1, sel.selected + 1);
        } else if (action === 'enter') {
            if (itemCount === 0) return;
            const picked = sel.filteredItems[sel.selected];
            const cmdName = sel.commandName;
            dismissOverlay(ctx);
            if (picked) {
                clearComposer(composer);
                appendTextToComposer(composer, `/${cmdName} ${picked.value}`);
                handleKeyInput(ctx, '\r');
            }
            return;
        } else if (action === 'backspace') {
            sel.filter = sel.filter.slice(0, -1);
            sel.filteredItems = filterSelectorItems(sel.allItems, sel.filter);
            sel.selected = Math.min(sel.selected, Math.max(0, sel.filteredItems.length - 1));
        } else if (action === 'printable') {
            sel.filter += key;
            sel.filteredItems = filterSelectorItems(sel.allItems, sel.filter);
            sel.selected = Math.min(sel.selected, Math.max(0, sel.filteredItems.length - 1));
        } else {
            return;
        }
        refreshChoiceSelector(ctx);
        return;
    }

    // ─── Autocomplete navigation ─────────────
    if (ac.open && action === 'arrow-up') {
        ac.selected = Math.max(0, ac.selected - 1);
        if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'arrow-down') {
        const maxIdx = ac.items.length - 1;
        ac.selected = Math.min(maxIdx, ac.selected + 1);
        if (ac.selected >= ac.windowStart + ac.visibleRows) {
            ac.windowStart = ac.selected - ac.visibleRows + 1;
        }
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'page-up') {
        const step = Math.max(1, ac.visibleRows);
        ac.selected = Math.max(0, ac.selected - step);
        if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'page-down') {
        const step = Math.max(1, ac.visibleRows);
        const maxIdx = ac.items.length - 1;
        ac.selected = Math.min(maxIdx, ac.selected + step);
        if (ac.selected >= ac.windowStart + ac.visibleRows) {
            ac.windowStart = ac.selected - ac.visibleRows + 1;
        }
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'home') {
        ac.selected = 0;
        ac.windowStart = 0;
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'end') {
        ac.selected = Math.max(0, ac.items.length - 1);
        if (ac.selected >= ac.windowStart + ac.visibleRows) {
            ac.windowStart = ac.selected - ac.visibleRows + 1;
        }
        refreshAutocompleteNav(ctx);
        return;
    }
    if (ac.open && action === 'tab') {
        const picked = ac.items[ac.selected];
        const pickedStage = ac.stage;
        if (picked) {
            if (pickedStage === 'argument' && picked.kind === 'file-mention') {
                applyFileMentionPick(ctx, picked.name);
                return;
            }
            if (pickedStage === 'argument' && picked.kind === 'skill-mention') {
                applySkillMentionPick(ctx, picked.name);
                return;
            }
            clearComposer(composer);
            if (pickedStage === 'argument') {
                appendTextToComposer(composer, picked.insertText || `/${picked.command || ''} ${picked.name}`.trim());
            } else {
                appendTextToComposer(composer, `/${picked.name}${picked.args ? ' ' : ''}`);
            }
            closeAutocompleteForCtx(ctx);
            redrawPromptLine(ctx);
        }
        return;
    }

    // ─── Enter: submit ───────────────────────
    if (action === 'enter') {
        if (ac.open) {
            const picked = ac.items[ac.selected];
            const pickedStage = ac.stage;
            const currentDraft = getPlainCommandDraft(composer);
            closeAutocompleteForCtx(ctx);
            if (picked) {
                if (pickedStage === 'argument' && picked.kind === 'file-mention') {
                    applyFileMentionPick(ctx, picked.name);
                    return;
                }
                if (pickedStage === 'argument' && picked.kind === 'skill-mention') {
                    applySkillMentionPick(ctx, picked.name);
                    return;
                }
                const commandQuery = currentDraft?.startsWith('/')
                    ? currentDraft.slice(1).trim().toLowerCase()
                    : '';
                if (pickedStage !== 'argument' && commandQuery && !picked.name.toLowerCase().startsWith(commandQuery)) {
                    // Ignore stale async autocomplete results and submit the current composer text.
                } else {
                    clearComposer(composer);
                    if (pickedStage === 'argument') {
                        appendTextToComposer(composer, picked.insertText || `/${picked.command || ''} ${picked.name}`.trim());
                        redrawPromptLine(ctx);
                        return;
                    }
                    if (picked.args) {
                        appendTextToComposer(composer, `/${picked.name} `);
                        redrawPromptLine(ctx);
                        return;
                    }
                    appendTextToComposer(composer, `/${picked.name}`);
                }
            }
        }
        // Backslash continuation
        const trailing = getTrailingTextSegment(composer);
        if (trailing.text.endsWith('\\')) {
            trailing.text = trailing.text.slice(0, -1);
            appendNewlineToComposer(composer);
            redrawInputWithAutocomplete(ctx);
            return;
        }
        const draft = getPlainCommandDraft(composer);
        const displayText = getComposerDisplayText(composer);
        const text = flattenComposerForSubmit(composer).trim();
        const visualRows = computeComposerVisualRows(
            displayText,
            process.stdout.columns || 80,
            ctx.promptPrefix,
        );
        clearComposer(composer);
        closeAutocompleteForCtx(ctx);
        if (!isFullscreen(ctx)) {
            clearPromptBlock(ctx, Math.max(ctx.prevLineCount, visualRows));
        }

        if (!text) {
            ctx.inputActive = true;
            if (isFullscreen(ctx)) requestFullscreenFrame(ctx);
            else reopenPromptLine(ctx);
            return;
        }
        // /file command
        if (draft !== null && text.startsWith('/file ')) {
            if (!isFullscreen(ctx)) renderBlockSeparator();
            appendUserItem(ctx.store.transcript, displayText.trim(), text);
            requestFullscreenFrame(ctx);
            const parts = text.slice(6).trim().split(/\s+/);
            const fp = resolvePath(parts[0]!);
            const caption = parts.slice(1).join(' ');
            if (!fs.existsSync(fp)) {
                ctx.inputActive = true;
                if (isFullscreen(ctx)) {
                    appendFullscreenStatus(ctx, `\uD30C\uC77C \uC5C6\uC74C: ${fp}`);
                } else {
                    console.log(`  ${c.red}\uD30C\uC77C \uC5C6\uC74C: ${fp}${c.reset}`);
                    openPromptBlock(ctx);
                }
                return;
            }
            const prompt = `[\uC0AC\uC6A9\uC790\uAC00 \uD30C\uC77C\uC744 \uBCF4\uB0C8\uC2B5\uB2C8\uB2E4: ${fp}]\n\uC774 \uD30C\uC77C\uC744 Read \uB3C4\uAD6C\uB85C \uC77D\uACE0 \uBD84\uC11D\uD574\uC8FC\uC138\uC694.${caption ? `\n\n\uC0AC\uC6A9\uC790 \uBA54\uC2DC\uC9C0: ${caption}` : ''}`;
            if (ctx.ideEnabled && ctx.isGit) {
                ctx.preFileSetQueue.push(captureFileSet(ctx.chatCwd));
            }
            ctx.ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
            ctx.inputActive = false;
            requestFullscreenFrame(ctx);
            return;
        }
        const parsed = draft !== null ? parseCommand(text) : null;
        if (parsed) {
            ctx.inputActive = false;
            ctx.commandRunning = true;
            requestFullscreenFrame(ctx);
            void runSlashCommand(ctx, parsed);
            return;
        }
        if (!isFullscreen(ctx)) renderBlockSeparator();
        appendUserItem(ctx.store.transcript, displayText.trim(), text);
        requestFullscreenFrame(ctx);
        if (ctx.ideEnabled && ctx.isGit) {
            ctx.preFileSetQueue.push(captureFileSet(ctx.chatCwd));
        }
        ctx.ws.send(JSON.stringify({ type: 'send_message', text }));
        ctx.inputActive = false;
        requestFullscreenFrame(ctx);
    } else if (action === 'backspace') {
        backspaceComposer(composer);
        redrawInputWithAutocomplete(ctx);
    } else if (action === 'ctrl-c') {
        // While a turn is streaming, Ctrl+C stops the agent (same as ESC) even
        // with the composer open \u2014 it used to exit the whole TUI in that state.
        // Exit stays on Ctrl+C when idle.
        if (!ctx.inputActive || ctx.streaming) {
            if (ctx.commandRunning && !ctx.streaming) return;
            sendStopForStreaming(ctx);
        } else {
            cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
            console.log(`\n  ${c.dim}Bye! \uD83E\uDD88${c.reset}\n`);
            setBracketedPaste(false);
            ctx.ws.close();
            process.stdin.setRawMode(false);
            process.exit(0);
        }
    } else if (action === 'ctrl-u') {
        if (getTrailingTextSegment(composer).text.length > 0) {
            killToStartComposer(composer);
        } else {
            clearComposer(composer);
        }
        redrawInputWithAutocomplete(ctx);
    } else if (action === 'ctrl-w') {
        killWordComposer(composer);
        redrawInputWithAutocomplete(ctx);
    } else if (action === 'ctrl-y') {
        yankComposer(composer);
        redrawInputWithAutocomplete(ctx);
    } else if (action === 'ctrl-_') {
        undoComposer(composer);
        redrawInputWithAutocomplete(ctx);
    } else if (action === 'delete') {
        if (ctx.inputActive) { deleteForwardComposer(composer); redrawPromptLine(ctx); }
    } else if (action === 'ctrl-x') {
        ctx.editorChordPending = true;
    } else if (ctx.editorChordPending) {
        ctx.editorChordPending = false;
        if (action === 'ctrl-e') {
            void openComposerInExternalEditor(ctx);
            return;
        }
    } else if (action === 'arrow-left') {
        if (ctx.inputActive) { moveCursorLeft(composer); redrawPromptLine(ctx); }
    } else if (action === 'arrow-right') {
        if (ctx.inputActive) { moveCursorRight(composer); redrawPromptLine(ctx); }
    } else if (action === 'word-left') {
        if (ctx.inputActive) { moveCursorWordLeft(composer); redrawPromptLine(ctx); }
    } else if (action === 'word-right') {
        if (ctx.inputActive) { moveCursorWordRight(composer); redrawPromptLine(ctx); }
    } else if (action === 'home') {
        if (ctx.inputActive) { moveCursorHome(composer); redrawPromptLine(ctx); }
    } else if (action === 'end') {
        if (ctx.inputActive) { moveCursorEnd(composer); redrawPromptLine(ctx); }
    } else if (action === 'printable') {
        if (!ctx.inputActive) {
            if (ctx.commandRunning) return;
            ctx.inputActive = true;
            openPromptBlock(ctx);
        }
        appendTextToComposer(composer, key);
        redrawInputWithAutocomplete(ctx);
    }
}
