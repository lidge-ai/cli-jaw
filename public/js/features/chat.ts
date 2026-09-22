// ── Chat Feature ──
import { state } from '../state.js';
import { addMessage, addSystemMsg } from '../ui.js';
import { getPreferredLocale } from '../locale.js';
import { t } from './i18n.js';
import * as slashCmd from './slash-commands.js';
import { api, apiJson, apiFire, getAuthToken, API_BASE } from '../api.js';
import { escapeHtml, cancelPostRender } from '../render.js';
import { getVirtualScroll } from '../virtual-scroll.js';
import { clearCache, upsertMessage } from './idb-cache.js';
import { ICONS } from '../icons.js';
import { clearUnreadResponses } from './attention-badge.js';
import { syncOrchestrateSnapshot } from '../ws.js';
import { waitForSettingsSaveIdle } from './settings-core.js';
import { tryCommandInfo } from './command-info.js';
import { isChatNearBottom, markFollowingBottom, reconcileChatBottomAfterLayout } from './chat-scroll.js';
import { copyText } from './copy-text.js';
import { isLocalPreviewRelayOrigin, previewParentOrigin } from '../preview-parent-origin.js';
import { canSendFromCurrentView, showReadOnlySwitchAffordance, withCurrentSessionBody } from './session-hub.js';
import { mediaKindFromPath, type MediaKind } from '../../../lib/media-kind.js';

let activeObjectURLs: string[] = [];

interface UnknownCommandRecovery {
    kind: 'slash-command-original';
    commandName: string;
    args: string[];
    originalText: string;
    suggestedCommands?: string[];
}

interface CommandResult {
    code?: string;
    text?: string;
    type?: string;
    steerPrompt?: string;
    originalText?: string;
    recovery?: UnknownCommandRecovery;
}
interface MessageResult { queued?: boolean; pending?: number; continued?: boolean; noPendingContinue?: boolean; error?: string; queuedId?: string; }
type MessagePostResult = { ok: boolean; status: number; data: MessageResult; viaRelay?: boolean };
type PreviewSendRelayResult = MessagePostResult & {
    type?: unknown;
    requestId?: unknown;
    error?: string;
};

const PREVIEW_SEND_RELAY_TIMEOUT_MS = 8_000;

function getCommandTimeoutMs(text: string): number {
    // Native compaction can take materially longer than the default command round-trip.
    return /^\/compact(?:\s|$)/i.test(String(text || '').trim()) ? 5 * 60 * 1000 : 10_000;
}

// 첨부 프롬프트는 파일 종류를 유지해야 한다. 고정 "파일" 문구만 쓰면 이미지를
// 올려도 에이전트가 Read 도구로 열려다 실패한다.
const ATTACHMENT_KEY: Record<MediaKind, string> = {
    image: 'chat.file.sentImage',
    video: 'chat.file.sentVideo',
    file: 'chat.file.sent',
};

function attachmentLine(path: string): string {
    return t(ATTACHMENT_KEY[mediaKindFromPath(path)], { path });
}

function buildAttachmentPrompt(paths: string[], text = ''): string {
    const prompt = paths.map(attachmentLine).join('\n');
    return text ? `${prompt}${t('chat.file.sentWithMsg', { text })}` : prompt;
}

function buildSlashCommandAttachmentText(text: string, paths: string[]): string {
    const fileContext = paths.map(attachmentLine).join('\n');
    return fileContext ? `${text}\n\n${fileContext}` : text;
}

function sendPreviewMessageViaParent(prompt: string): Promise<MessagePostResult | null> {
    const targetOrigin = previewParentOrigin();
    if (!targetOrigin) return Promise.resolve(null);
    return new Promise(resolve => {
        const requestId = `preview-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let settled = false;
        const cleanup = () => {
            window.removeEventListener('message', onMessage);
            window.clearTimeout(timeout);
        };
        const settle = (result: MessagePostResult | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== window.parent) return;
            if (!isLocalPreviewRelayOrigin(event.origin)) return;
            const data = event.data as PreviewSendRelayResult | null;
            if (!data || data.type !== 'jaw-preview-send-result' || data.requestId !== requestId) return;
            settle({
                ok: !!data.ok,
                status: Number.isInteger(data.status) ? data.status : (data.ok ? 200 : 502),
                data: data.data || (data.error ? { error: data.error } : {}),
                viaRelay: true,
            });
        };
        const timeout = window.setTimeout(() => settle(null), PREVIEW_SEND_RELAY_TIMEOUT_MS);
        window.addEventListener('message', onMessage);
        try {
            // The session travels with the relay too. Without it the manager forwards a
            // bare prompt and the instance writes to whichever session is globally
            // active, which is not the one this preview is showing (072 §1.1).
            window.parent.postMessage(
                withCurrentSessionBody({ type: 'jaw-preview-send-message', requestId, prompt }),
                targetOrigin,
            );
        } catch {
            settle(null);
        }
    });
}

async function postChatMessage(prompt: string): Promise<MessagePostResult> {
    const relayed = await sendPreviewMessageViaParent(prompt);
    if (relayed?.ok) return relayed;
    try {
        const res = await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withCurrentSessionBody({ prompt })),
        });
        const data: MessageResult = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    } catch (error) {
        return { ok: false, status: 0, data: { error: (error as Error).message } };
    }
}

async function postSlashCommand(text: string): Promise<{ ok: boolean; status: number; result: CommandResult }> {
    let signal: AbortSignal; let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = getCommandTimeoutMs(text);
    if (typeof AbortSignal?.timeout === 'function') {
        signal = AbortSignal.timeout(timeoutMs);
    } else {
        const ac = new AbortController();
        signal = ac.signal;
        timer = setTimeout(() => ac.abort(), timeoutMs);
    }
    const locale = getPreferredLocale();
    const token = await getAuthToken();
    const res = await fetch(`${API_BASE}/api/command`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept-Language': locale,
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(withCurrentSessionBody({ text, locale })),
        signal,
    });
    if (timer) clearTimeout(timer);
    const result: CommandResult = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, result };
}

async function handleSlashCommandResponse(
    originalText: string,
    response: { ok: boolean; status: number; result: CommandResult },
    fallbackToMessage?: () => Promise<void>,
): Promise<void> {
    const result = response.result;
    // not_command → fall through to normal chat
    if (result?.code === 'not_command') {
        if (fallbackToMessage) {
            await fallbackToMessage();
            return;
        }
        addMessage('user', originalText);
        upsertMessage({ role: 'user', content: originalText, timestamp: Date.now() });
        await apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt: originalText }));
        return;
    }
    if (!response.ok && !result?.text) throw new Error(`HTTP ${response.status}`);
    if (result?.code === 'clear_screen') {
        cancelPostRender();
        getVirtualScroll().clear();
        const chatEl = document.getElementById('chatMessages');
        if (chatEl) chatEl.innerHTML = '';
    }
    if (result?.text || result?.recovery) addSystemMsg(renderCommandRecovery(result), '', result.type);
    if (result?.steerPrompt) {
        await apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt: result.steerPrompt }));
    }
}


function renderCommandRecovery(result: CommandResult): string {
    const recovery = result.recovery;
    if (!recovery?.originalText) return result.text ? escapeHtml(result.text) : '';
    const suggestions = (recovery.suggestedCommands || []).slice(0, 5);
    const suggestionHtml = suggestions.length
        ? `<div class="cmd-recovery-suggestions">${suggestions.map(s => `<code>${escapeHtml(s)}</code>`).join(' ')}</div>`
        : '';
    const original = escapeHtml(recovery.originalText);
    const body = result.text ? `<div>${escapeHtml(result.text)}</div>` : '';
    return `${body}
        <div class="cmd-recovery" data-cmd-recovery>
            <div class="cmd-recovery-label">${escapeHtml(t('cmd.recovery.originalPrompt'))}</div>
            <pre class="cmd-recovery-text">${original}</pre>
            ${suggestionHtml}
            <div class="cmd-recovery-actions">
                <button type="button" class="cmd-recovery-btn" data-cmd-recovery-action="reinsert" data-cmd-text="${original}">${escapeHtml(t('cmd.artifact.action.reinsert'))}</button>
                <button type="button" class="cmd-recovery-btn" data-cmd-recovery-action="copy" data-cmd-text="${original}">${escapeHtml(t('cmd.artifact.action.copy'))}</button>
            </div>
        </div>`;
}

document.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement | null;
    const btn = target?.closest('[data-cmd-recovery-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset['cmdRecoveryAction'] || '';
    const text = btn.dataset['cmdText'] || '';
    if (!text) return;
    if (action === 'reinsert') {
        const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
        if (!input) return;
        input.value = text;
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    if (action === 'copy') {
        await copyText(text);
    }
});

// In-flight guard: prevents double-send from rapid clicks / Enter-bursts while the
// POST to /api/message is outstanding. Server-side dedup in gateway.ts is the
// second line of defense.
let __chatSending = false;

export type SendSource = 'button' | 'enter' | 'cmd-execute';

export async function sendMessage(source: SendSource = 'enter'): Promise<void> {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const btn = document.getElementById('btnSend');
    if (!input || !btn) return;

    const submittedRawText = input.value;
    const text = submittedRawText.trim();
    // A stop-mode button click is not a message send, so it carries no command
    // text and the read-only guard must judge it on its own. Every other path —
    // including an ordinary button click on `/switch 1` — must pass the text,
    // or the escape commands that let a user leave a read-only session would be
    // rejected through the button while still working via Enter.
    const isStopClick = source === 'button' && btn.classList.contains('stop-mode');
    if (!canSendFromCurrentView(isStopClick ? '' : text)) {
        showReadOnlySwitchAffordance();
        return;
    }

    // Stop-mode click policy:
    //  - any stop-mode button click  → fire /api/stop and return.
    //    /api/stop stops this session's run when the tab names one, and every
    //    run otherwise, which is the user's intent ("실제로 정지가 안돼").
    //    The early `return` preserves typed text and attachments — typing is
    //    never auto-steered into the just-killed run.
    //  - Enter key and slash-command execute do NOT enter this branch
    //    (source !== 'button'), so they keep their normal behavior even
    //    while the agent is busy.
    // Source param (vs old document.activeElement === btn): activeElement is
    // unreliable inside an iframe whose parent has focus, so the explicit
    // SendSource keeps detection deterministic across cross-frame clicks.
    const stopByExplicitButton = source === 'button';
    if (btn.classList.contains('stop-mode') && stopByExplicitButton) {
        // On /:seq this stops only that session. Elsewhere the body carries no
        // session and the server falls back to stopping everything, which is what
        // the single-session view has always done.
        apiFire('/api/stop', 'POST', withCurrentSessionBody({}));
        return;
    }

    // Double-submit guard: if a previous send is still in flight, drop this call.
    if (__chatSending) return;

    if (!text && !state.attachedFiles.length) return;
    clearUnreadResponses();

    // A settings write can keep this submission behind the save barrier while the
    // user keeps composing. String equality alone is insufficient here: A -> B -> A
    // is still a newer draft and must survive. Track real input events for this
    // submission and retain the exact textarea identity in case the view replaces it.
    let inputEditRevision = 0;
    const submittedInputEditRevision = inputEditRevision;
    const trackInputEdit = () => { inputEditRevision++; };
    input.addEventListener('input', trackInputEdit);
    const clearSubmittedInput = () => {
        const currentInput = document.getElementById('chatInput');
        if (currentInput !== input
            || input.value !== submittedRawText
            || inputEditRevision !== submittedInputEditRevision) return;
        input.value = '';
        resetInputHeight();
    };

    // Mark in-flight AND disable send button for visual feedback.
    __chatSending = true;
    const sendBtn = btn as HTMLButtonElement;
    const prevDisabled = sendBtn.disabled;
    sendBtn.disabled = true;
    try {
        await waitForSettingsSaveIdle();

        // File paths like /Users/junny/... or /tmp/foo — not commands
        const afterSlash = text.slice(1).trim();
        const firstToken = afterSlash.split(/\s+/)[0] || '';
        const isFilePath = firstToken.includes('/') || firstToken.includes('\\');
        const isSlashCommand = text.startsWith('/') && !isFilePath;

        if (isSlashCommand && !state.attachedFiles.length) {
            clearSubmittedInput();
            slashCmd.close();
            if (tryCommandInfo(text)) return;
            try {
                await handleSlashCommandResponse(text, await postSlashCommand(text));
            } catch (err) {
                addSystemMsg(t('chat.cmd.fail', { msg: (err as Error).message }), '', 'error');
            } finally {
                syncOrchestrateSnapshot('command').catch(() => {});
            }
            return;
        }

        if (state.attachedFiles.length) {
            const names = state.attachedFiles.map((f: File) => f.name).join(', ');
            const displayMsg = `📎 [${names}] ${text}`;
            addMessage('user', displayMsg);
            upsertMessage({ role: 'user', content: displayMsg, timestamp: Date.now() });
            clearSubmittedInput();
            try {
                // Upload all files in parallel
                const paths = await Promise.all(state.attachedFiles.map((f: File) => uploadFile(f)));
                const prompt = buildAttachmentPrompt(paths, text);
                clearAttachedFiles();
                if (isSlashCommand) {
                    slashCmd.close();
                    try {
                        const commandText = buildSlashCommandAttachmentText(text, paths);
                        const commandResponse = await postSlashCommand(commandText);
                        await handleSlashCommandResponse(commandText, commandResponse, async () => {
                            await apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt }));
                        });
                    } catch (err) {
                        addSystemMsg(t('chat.cmd.fail', { msg: (err as Error).message }), '', 'error');
                    } finally {
                        syncOrchestrateSnapshot('command').catch(() => {});
                    }
                    return;
                }
                await apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt }));
            } catch (err) {
                addSystemMsg(t('chat.file.uploadFail', { msg: (err as Error).message }));
                clearAttachedFiles();
            }
        } else {
            // Option A (no-optimistic): clear the input immediately for snappy
            // feedback, but wait for the backend response before rendering any
            // chat bubble. Eliminates every duplicate-bubble class of bug
            // (WS-vs-HTTP race, VS stored-HTML capture, mounted reindex, etc.)
            // because we only addMessage when we know for sure what happened.
            clearSubmittedInput();
            const result = await postChatMessage(text);
            const data = result.data;
            // Server-side 5s dedup returns 409 with reason='duplicate'.
            if (result.status === 409 && data.error === 'duplicate') {
                return;
            }
            if (!result.ok) {
                addSystemMsg(`${ICONS.error} ${escapeHtml(data.error || t('chat.requestFail', { status: result.status }))}`, '', 'error');
                return;
            }
            if (data.queued) {
                // Queued — pending-queue panel owns the visual; nothing in chat yet.
                // The fromQueue broadcast (processQueue / steer route) renders the
                // bubble when the message actually starts running.
                const { updateQueueBadge } = await import('../ui.js');
                updateQueueBadge(data.pending || 1);
            } else if (result.viaRelay) {
                // Preview relay: the manager POSTs with external:true, so the
                // SSE new_message handler renders this bubble. Rendering here
                // too would duplicate it.
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                if (data.continued) addSystemMsg(t('chat.continue'));
                reconcileChatBottomAfterLayout(true);
            } else if (data.noPendingContinue) {
                // No system copy here: orchestrateContinue() emits the single
                // user-facing no-pending response through orchestrate_done.
                addMessage('user', text);
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                reconcileChatBottomAfterLayout(true);
            } else if (data.continued) {
                addMessage('user', text);
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                addSystemMsg(t('chat.continue'));
                reconcileChatBottomAfterLayout(true);
            } else {
                // started: backend already inserted the row; render now.
                addMessage('user', text);
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                reconcileChatBottomAfterLayout(true);
            }
        }
    } finally {
        input.removeEventListener('input', trackInputEdit);
        __chatSending = false;
        sendBtn.disabled = prevDisabled;
    }
}

export function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage('enter'); }
}

async function uploadFile(file: File): Promise<string> {
    const res = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name) },
        body: file,
    });
    if (!res.ok) throw new Error('upload failed');
    const data = await res.json();
    return data.path;
}

export function attachFiles(files: File[]): void {
    for (const file of files) {
        if (state.attachedFiles.some(f => f.name === file.name)) continue;
        state.attachedFiles.push(file);
    }
    renderFilePreview();
    (document.getElementById('chatInput') as HTMLTextAreaElement | null)?.focus();
}

export function removeAttachedFile(index: number): void {
    state.attachedFiles.splice(index, 1);
    renderFilePreview();
}

export function clearAttachedFiles(): void {
    activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    activeObjectURLs = [];
    state.attachedFiles = [];
    renderFilePreview();
    const fi = document.getElementById('fileInput') as HTMLInputElement | null;
    if (fi) fi.value = '';
}

function renderFilePreview(): void {
    const preview = document.getElementById('filePreview');
    const listEl = document.getElementById('filePreviewList');
    if (!preview) return;
    // Revoke all previous object URLs before creating new ones
    activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    activeObjectURLs = [];
    if (!state.attachedFiles.length) {
        preview.classList.remove('visible');
        if (listEl) listEl.innerHTML = '';
        return;
    }
    preview.classList.add('visible');
    if (!listEl) return;
    listEl.innerHTML = state.attachedFiles.map((f: File, i: number) => {
        const size = (f.size / 1024).toFixed(1);
        const isImg = f.type.startsWith('image/');
        let thumb = '';
        if (isImg) {
            const url = URL.createObjectURL(f);
            activeObjectURLs.push(url);
            thumb = `<img src="${url}" class="file-chip-thumb" alt="">`;
        }
        return `<div class="file-chip">
            ${thumb}
            <span class="file-chip-name">${ICONS.paperclip} ${escapeHtml(f.name)} (${size}KB)</span>
            <button class="file-chip-remove" data-file-idx="${i}" title="Remove">${ICONS.close}</button>
        </div>`;
    }).join('');
}

export async function clearChat(): Promise<void> {
    // UI-only clear — do NOT call /api/clear (it deletes DB messages)
    cancelPostRender();
    getVirtualScroll().clear();
    const chatEl = document.getElementById('chatMessages');
    if (chatEl) chatEl.innerHTML = '';
    const { cleanupToolActivity } = await import('../ui.js');
    cleanupToolActivity();
    clearCache().catch(() => {});
    clearUnreadResponses();
}

// ── Auto-resize textarea (RAF-batched to avoid blocking input) ──
let resizeRaf = 0;
function autoResize(el: HTMLTextAreaElement): void {
    if (resizeRaf) return;
    const shouldFollowBottom = isChatNearBottom();
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
        if (shouldFollowBottom) {
            const c = document.getElementById('chatMessages');
            if (c) { c.scrollTop = c.scrollHeight; markFollowingBottom(); }
        }
    });
}

export function initAutoResize(): void {
    const el = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    if (el) el.addEventListener('input', () => autoResize(el));
}

export function resetInputHeight(): void {
    const el = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const shouldFollowBottom = isChatNearBottom();
    if (el) el.style.height = 'auto';
    if (shouldFollowBottom) {
        const c = document.getElementById('chatMessages');
        if (c) { c.scrollTop = c.scrollHeight; markFollowingBottom(); }
    }
}

export function initDragDrop(): void {
    const chatArea = document.querySelector('.chat-area');
    const overlay = document.getElementById('dragOverlay');
    if (!chatArea || !overlay) return;
    let dragCounter = 0;

    chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('visible');
    });
    chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
    });
    chatArea.addEventListener('dragover', (e) => e.preventDefault());
    chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('visible');
        const de = e as DragEvent;
        const files = [...(de.dataTransfer?.files || [])];
        if (files.length) attachFiles(files);
    });

    (document.getElementById('fileInput') as HTMLInputElement | null)?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const files = [...(target.files || [])];
        if (files.length) attachFiles(files);
        target.value = '';
    });

    // ── Clipboard paste (Cmd+V) ──
    document.addEventListener('paste', (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const item of items) {
            if (item.kind !== 'file') continue;
            const blob = item.getAsFile();
            if (!blob) continue;
            if (!blob.name || blob.name === 'image.png') {
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const ext = blob.type.split('/')[1] || 'png';
                const named = new File([blob], `pasted-${ts}.${ext}`, { type: blob.type });
                files.push(named);
            } else {
                files.push(blob);
            }
        }
        if (files.length) {
            e.preventDefault();
            attachFiles(files);
        }
    });
}

/** Upload recorded voice blob, combine with pending text/files, send unified message */
export async function sendVoiceToServer(blob: Blob, ext: string, mime: string): Promise<void> {
    if (!canSendFromCurrentView()) {
        showReadOnlySwitchAffordance();
        return;
    }
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const pendingText = input?.value.trim() || '';
    const pendingFiles = [...state.attachedFiles];

    // Build user-facing display message
    const displayParts: string[] = [t('chat.voice.label')];
    if (pendingFiles.length) displayParts.push(`📎 [${pendingFiles.map(f => f.name).join(', ')}]`);
    if (pendingText) displayParts.push(pendingText);
    addMessage('user', displayParts.join(' '));
    upsertMessage({ role: 'user', content: displayParts.join(' '), timestamp: Date.now() });

    // Clear input immediately
    if (input && pendingText) { input.value = ''; resetInputHeight(); }
    if (pendingFiles.length) clearAttachedFiles();

    try {
        // Step 1: STT only (no submitMessage on server)
        const sttRes = await fetch(`${API_BASE}/api/voice`, {
            method: 'POST',
            headers: {
                'Content-Type': mime,
                'X-Voice-Ext': ext,
                'X-STT-Only': 'true',
            },
            body: blob,
        });
        if (!sttRes.ok) {
            const data = await sttRes.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${sttRes.status}`);
        }
        const sttResult = await sttRes.json().catch(() => null);
        if (!sttResult?.text) throw new Error('Empty STT result');

        addSystemMsg(`${ICONS.mic} STT (${escapeHtml(sttResult.engine || '')}, ${sttResult.elapsed?.toFixed(1)}s): "${escapeHtml(sttResult.text.slice(0, 100))}"`, '', 'info');

        // Step 2: Upload pending files (if any)
        let filePaths: string[] = [];
        if (pendingFiles.length) {
            filePaths = await Promise.all(pendingFiles.map(f => uploadFile(f)));
        }

        // Step 3: Build combined prompt and send via /api/message
        const promptParts: string[] = [];
        for (const p of filePaths) {
            promptParts.push(attachmentLine(p));
        }
        promptParts.push(`🎤 ${sttResult.text}`);
        if (pendingText) promptParts.push(pendingText);

        await apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt: promptParts.join('\n') }));
    } catch (err) {
        addSystemMsg(t('voice.sttFail', { msg: (err as Error).message }), '', 'error');
    }
}
