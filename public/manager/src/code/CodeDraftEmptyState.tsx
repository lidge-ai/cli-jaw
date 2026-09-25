import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS } from './code-types';
import { recentCodeWorkspaces } from './code-recent-workspaces';

/**
 * What a fresh draft looks like before its first prompt. Modelled on ZCode's
 * ConversationDraftEmptyState and T3 Code's NoActiveThreadState: the workspace
 * is the decision that gates everything else, so it is the one prominent
 * control; the suggested prompts only fill the composer, they never send.
 */
const SUGGESTED_PROMPTS: readonly string[] = [
    'Explain this codebase',
    'Find and fix a bug',
    'Write tests for the module I name',
    'Review uncommitted changes',
];

export function CodeDraftEmptyState({ controller: c }: { controller: CodeControllerModel }) {
    const cwd = c.selection.cwd;
    // Same freeze rule as CodeWorkspaceHeader: once creation is in flight the
    // draft belongs to it, and an unconfirmed create must not be edited around.
    const frozen = c.selectedId !== null || c.pending || c.creationUnknown || c.operation.kind !== 'idle';
    // Shared with the header picker so only one folder dialog can be open.
    const picking = c.workspacePicking;
    // Exclude the current cwd before the cap; otherwise it silently eats a slot.
    const recents = recentCodeWorkspaces(c.sessions.filter(session => session.cwd !== cwd));
    function pick() {
        if (frozen || picking) return;
        void c.pickWorkspace();
    }
    function useWorkspace(dir: string) {
        if (frozen) return;
        void c.setSelection({ cwd: dir });
    }
    return <section className="code-draft-empty" aria-label="New session draft">
        <h2 className="code-draft-empty-title">New session</h2>
        {frozen ? <span className="code-workspace-chip" title={cwd}>{cwd || 'Workspace not set'}</span>
            : <button type="button" className="code-workspace-picker code-draft-empty-picker" aria-label="Choose Code workspace"
                disabled={picking} title={cwd || 'Choose a folder'} onClick={pick}>
                <span className="code-workspace-picker-label">{picking ? 'Choosing folder…' : cwd || 'Choose workspace'}</span>
            </button>}
        <p className="code-draft-empty-selection">
            {CODE_RUNTIME_LABELS[c.selection.provider]} · {c.selection.model || 'No model selected'}
        </p>
        {recents.length > 0 && <div className="code-draft-recents">
            <span className="code-draft-recents-label">Recent workspaces</span>
            {recents.map(dir => <button type="button" key={dir} className="code-draft-recent" title={dir}
                disabled={frozen} onClick={() => useWorkspace(dir)}>{dir}</button>)}
        </div>}
        {!c.input.trim() && <div className="code-draft-prompts">
            {SUGGESTED_PROMPTS.map(text => <button type="button" key={text} className="code-draft-prompt"
                disabled={frozen} onClick={() => c.setInput(text)}>{text}</button>)}
        </div>}
    </section>;
}
