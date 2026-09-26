import { useCallback, useRef, useState } from 'react';
import type { CodeControllerModel } from './code-controller-types';
import { CodeComposer } from './CodeComposer';
import { ComposerFooter } from './ComposerFooter';
import { CodeDraftEmptyState } from './CodeDraftEmptyState';
import { CodePermissionQueue } from './CodePermissionQueue';
import { CodeTranscript } from './CodeTranscript';
import { CodeToastHost } from './CodeToastHost';
import { applyCodeNotice, dismissCodeToast, type CodeNotice, type CodeToast } from './code-toasts';
import { CodeWorkspaceHeader } from './CodeWorkspaceHeader';
import { codeCanResume } from './code-types';

type Props = { controller: CodeControllerModel; endpointKey: string; onOpenLocalFile?: ((path: string) => void) | undefined };
export function CodeWorkbench({ controller: c, endpointKey, onOpenLocalFile }: Props) {
    const sessionKey = `${endpointKey}:${c.selectedId ?? 'new'}`;
    const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);
    const [retrying, setRetrying] = useState<string | null>(null);
    const retryGuard = useRef(new Set<string>());
    const [toasts, setToasts] = useState<readonly CodeToast[]>([]);
    // Notices are not cleared on a session change. The one notice that exists
    // is derived from the current policy and re-raised by the footer on every
    // mount, so wiping the stack here would delete it at the moment a draft
    // becomes a running session -- exactly when it matters most.
    const notify = useCallback((notice: CodeNotice) => {
        setToasts(current => applyCodeNotice(current, notice));
    }, []);
    const dismiss = useCallback((id: string) => setToasts(current => dismissCodeToast(current, id)), []);
    const archived = c.session?.archivedAt != null;
    const stopping = c.session?.status === 'stopping' || c.operation.kind === 'stopping';
    const busy = c.busy || c.working || stopping || c.session?.status === 'starting' || c.session?.status === 'streaming';
    const provider = c.catalog?.providers.find(p => p.id === c.selection.provider);
    const unknownSend = c.operation.kind === 'unknown-send';
    // A streaming Claude turn takes one follow-up beside Stop; any other busy session offers Stop only.
    const canSend = !c.steering && (c.followUp ? !stopping && !c.pending && !archived && c.operation.kind === 'idle'
        : !busy && !c.pending && !c.creationUnknown && !archived && c.operation.kind === 'idle' && !!provider?.available
        && !!c.selection.cwd.trim() && !!c.selection.model.trim()
        // A suspended or recoverably failed session can be sent to: send attaches it first.
        && (c.selectedId === null || (c.synced && (c.session?.status === 'idle' || (!!c.session && codeCanResume(c.session))))));
    const canStop = !!c.session?.turnId && c.session.capabilities.interrupt && busy && !stopping;
    const canResume = !!c.session && codeCanResume(c.session) && c.synced && !c.pending && !unknownSend;
    const error = c.operation.error || c.error || (actionError?.key === sessionKey ? actionError.message : null);
    const terminal = [...c.items].reverse().find(item => item.kind === 'turn_cancelled' || item.kind === 'turn_failed' || item.kind === 'turn_completed');
    const failedInput = terminal && terminal.kind !== 'turn_completed'
        ? c.items.find(item => item.kind === 'user_message' && item.turnId === terminal.turnId)?.text : undefined;
    function perform(action: () => Promise<void>) {
        setActionError(null);
        void action().catch(err => setActionError({ key: sessionKey, message: err instanceof Error ? err.message : String(err) }));
    }
    async function retry() {
        if (!c.canRetrySameSend || retryGuard.current.has(sessionKey)) return;
        retryGuard.current.add(sessionKey); setRetrying(sessionKey); setActionError(null);
        try { await c.retrySameSend(); }
        catch (err) { setActionError({ key: sessionKey, message: err instanceof Error ? err.message : String(err) }); }
        finally { retryGuard.current.delete(sessionKey); setRetrying(current => current === sessionKey ? null : current); }
    }
    return <div className="code-canvas-main">
        <CodeWorkspaceHeader key={sessionKey} controller={c} />
        {(c.transport !== 'connected' || (c.selectedId !== null && !c.synced)) && <section className={`code-transport-status is-${c.transport}`} role="status">
            {c.transport === 'reconnecting' ? 'Live updates reconnecting. History may be out of date.'
                : c.transport === 'disconnected' ? 'Live updates disconnected. History may be out of date.' : 'Updating conversation…'}
            <button type="button" onClick={() => perform(c.refresh)}>Refresh</button>
        </section>}
        {error && <section className="code-recovery-strip" role="alert"><p>{error}</p>
            <button type="button" onClick={() => perform(c.refresh)}>Refresh session</button>
            <button type="button" onClick={() => { c.clearError(); setActionError(null); }}>Dismiss</button>
        </section>}
        {c.creationUnknown && <section className="code-recovery-strip" aria-label="Unconfirmed session creation">
            <strong>Session creation not confirmed</strong>
            <p>The original session may still exist.</p>
            <p>Your draft and choices are kept. Press Send when you are ready to create another session.</p>
            <button type="button" onClick={c.startAnotherSession}>Start another session</button>
        </section>}
        {unknownSend && <section className="code-recovery-strip"
            aria-label={c.resendRequired ? 'Send not started' : 'Unconfirmed send'}>
            <strong>{c.resendRequired ? 'Send did not start' : 'Send outcome not confirmed'}</strong>
            {/* Once the server has spent the key, acceptance is no longer unknown,
                so this must stop offering the weaker, hedged explanation. */}
            <p>{c.resendRequired
                ? 'The original attempt ended on the server without running. Retry sends this as a new message.'
                : 'Retry uses the original request. It may submit it if the server has not already accepted it.'}</p>
            <pre className="code-retry-preview" aria-label="Original prompt">{c.retryText}</pre>
            <button type="button" disabled={!c.canRetrySameSend || retrying === sessionKey} onClick={() => void retry()}>
                {retrying === sessionKey
                    ? (c.resendRequired ? 'Sending as a new message…' : 'Retrying original send…')
                    : (c.resendRequired ? 'Send as a new message' : 'Retry same send')}</button>
        </section>}
        {archived ? <section className="code-recovery-strip"><span>Archived · Read-only history</span>
            <button type="button" disabled={!c.synced || c.pending} onClick={() => { const id = c.selectedId; if (id) perform(() => c.archive(id, false)); }}>Restore session</button>
        </section> : c.session && (c.session.status === 'failed' || c.session.status === 'suspended') && <section className="code-recovery-strip" role="status">
            <p>{c.session.error?.message ?? 'Native session suspended.'}</p>
            {canResume ? <button type="button" onClick={() => perform(c.resume)}>Resume session</button>
                : <><span>{c.session.resume.reason ?? 'Resume is not currently available.'}</span><button type="button" onClick={c.newSession}>New session</button></>}
        </section>}
        {/* Directly above the transcript, so a notice sits over the conversation
            rather than over the workspace header and its picker. */}
        <CodeToastHost toasts={toasts} onDismiss={dismiss} />
        {c.selectedId === null && c.items.length === 0
            ? <CodeDraftEmptyState controller={c} />
            : <CodeTranscript items={c.items} provider={c.session?.provider ?? c.selection.provider} sessionKey={sessionKey}
                workingDir={c.session?.cwd ?? c.selection.cwd} loading={c.loading} hasOlderHistory={c.hasOlderHistory}
                loadOlderHistory={c.loadOlderHistory} permissionCount={c.permissions.length} onOpenLocalFile={onOpenLocalFile}
                working={c.working} />}
        <CodePermissionQueue permissions={c.permissions} operations={c.permissionOperations} session={c.session} synced={c.synced} onAnswer={c.answer} />
        <div className="code-composer-dock">
            {failedInput !== undefined && !busy && !archived && <div className="code-input-recovery">
                <button type="button" disabled={!!c.input || unknownSend} title={c.input ? 'Keep or clear your current draft before restoring the submitted prompt' : undefined}
                    onClick={() => c.setInput(failedInput)}>Restore submitted prompt</button>
                <span>Restores text for editing without sending.</span>
            </div>}
            <div className="code-composer-surface" aria-label="Code composer controls">
                <CodeComposer key={`composer:${sessionKey}`} inputText={c.input} canSend={canSend} busy={busy} canStop={canStop} stopping={stopping}
                    pending={c.pending} followUp={c.followUp} steering={c.steering} readOnly={archived} autoFocus={c.selectedId === null} onInputChange={c.setInput} onSubmit={c.send} onStop={c.stop} />
                <ComposerFooter key={`footer:${sessionKey}`} controller={c} onNotice={notify} />
            </div>
        </div>
    </div>;
}
