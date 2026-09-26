import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { MicGlyph, SendGlyph, StopGlyph } from './ProviderGlyph';
import { useDictation } from './use-dictation';

type CodeComposerProps = {
    inputText: string;
    canSend: boolean;
    busy: boolean;
    canStop: boolean;
    stopping: boolean;
    pending: boolean;
    /** A busy Claude turn takes a follow-up: Send follow-up renders beside Stop. */
    followUp?: boolean;
    /** The running turn already has its one follow-up. */
    followUpSent?: boolean;
    /** A follow-up is in flight. */
    steering?: boolean;
    /** What the pending operation is doing, when it is not a send. */
    pendingLabel?: string;
    readOnly: boolean;
    autoFocus?: boolean;
    onInputChange: (text: string) => void;
    onSubmit: () => Promise<void>;
    onStop: () => Promise<void>;
};

export function CodeComposer(props: CodeComposerProps) {
    const composing = useRef(false);
    const sending = useRef(false);
    const cancelling = useRef(false);
    const [error, setError] = useState<string | null>(null);
    // Dictated text is appended to the draft, never sent on its own.
    const appendDictation = useCallback((text: string) => {
        const current = props.inputText;
        props.onInputChange(current ? `${current.replace(/\s+$/, '')} ${text}` : text);
    }, [props.inputText, props.onInputChange]);
    const dictation = useDictation(appendDictation, props.readOnly);
    async function submit() {
        if (!props.canSend || !props.inputText.trim() || sending.current) return;
        sending.current = true;
        setError(null);
        try { await props.onSubmit(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { sending.current = false; }
    }
    async function stop() {
        if (!props.canStop || cancelling.current) return;
        cancelling.current = true;
        setError(null);
        try { await props.onStop(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { cancelling.current = false; }
    }
    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            void submit();
        }
    }
    return <div className="code-composer">
        <div className="code-composer-input-shell">
            <textarea className="code-composer-input" aria-label="Code prompt" value={props.inputText}
                autoFocus={props.autoFocus}
                onChange={event => props.onInputChange(event.target.value)} onKeyDown={handleKeyDown}
                onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                placeholder={props.followUpSent ? 'This turn already has its follow-up. Draft the next message…'
                    : props.followUp ? 'Send a follow-up while this turn runs…'
                    : props.busy ? 'Draft a follow-up while this turn runs…' : 'Describe a task or ask a question…'}
                rows={2} readOnly={props.readOnly} />
            <span className="code-composer-hint">Enter to send · Shift+Enter for a new line</span>
        </div>
        <div className="code-composer-actions">
            <button type="button" className={`code-composer-icon-button${dictation.status === 'recording' ? ' is-recording' : ''}`}
                aria-label={dictation.status === 'recording' ? 'Stop dictation' : 'Dictation'}
                aria-pressed={dictation.status === 'recording'}
                disabled={dictation.status === 'unsupported' || dictation.status === 'transcribing' || props.readOnly}
                title={dictation.reason} onClick={dictation.toggle}>
                <MicGlyph muted={dictation.status === 'unsupported'} />
            </button>
            {props.busy && <button type="button" className="code-composer-send code-composer-stop" aria-label="Stop current turn"
                title={props.stopping ? 'Stopping' : 'Stop current turn'}
                disabled={!props.canStop || props.stopping} onClick={() => void stop()}><StopGlyph /></button>}
            {(!props.busy || props.followUp) && <button type="button" className="code-composer-send"
                aria-label={props.busy ? 'Send follow-up' : 'Send prompt'}
                title={props.steering ? 'Sending follow-up' : props.pending ? 'Sending' : props.busy ? 'Send follow-up' : 'Send prompt'}
                disabled={!props.canSend || !props.inputText.trim()} onClick={() => void submit()}><SendGlyph /></button>}
        </div>
        {/* An icon button cannot announce progress on its own. */}
        {(props.stopping || props.steering || props.pending || dictation.status === 'recording' || dictation.status === 'transcribing') &&
            <span className="code-composer-status" role="status">
                {props.stopping ? 'Stopping…' : props.steering ? 'Sending follow-up…' : props.pending ? props.pendingLabel ?? 'Sending…'
                    : dictation.status === 'recording' ? 'Recording…' : 'Transcribing…'}</span>}
        {(error || dictation.error) && <div className="code-action-error" role="alert">{error ?? dictation.error}</div>}
    </div>;
}
