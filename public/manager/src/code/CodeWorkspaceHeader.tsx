import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS, CODE_SESSION_LABELS } from './code-types';

export function CodeWorkspaceHeader({ controller: c }: { controller: CodeControllerModel }) {
    const cwd = c.session?.cwd ?? c.selection.cwd;
    const frozen = c.selectedId !== null || c.pending || c.creationUnknown || c.operation.kind !== 'idle';
    // Shared with CodeDraftEmptyState's picker so only one folder dialog can be open.
    const picking = c.workspacePicking;
    function pick() {
        if (frozen || picking) return;
        void c.pickWorkspace();
    }
    return <header className="code-workspace-header">
        <div className="code-session-header">
            <span className="code-session-title">{c.session?.title || (c.selectedId ? 'Untitled session' : 'New session draft')}</span>
            <span>{CODE_RUNTIME_LABELS[c.session?.provider ?? c.selection.provider]}</span>
            <span role="status">{c.session ? CODE_SESSION_LABELS[c.session.status] : c.creationUnknown ? 'Creation unconfirmed' : c.operation.kind === 'creating' ? 'Creating session' : 'Draft'}{c.session?.archivedAt !== null && c.session ? ' · Archived' : ''}</span>
        </div>
        <div className="code-workspace-primary">
            {frozen ? <span className="code-workspace-chip" title={cwd}>{cwd || 'Workspace not set'}</span>
                : <button type="button" className="code-workspace-picker" aria-label="Choose Code workspace" disabled={picking}
                    title={cwd || 'Choose a folder'} onClick={pick}>
                    <span className="code-workspace-picker-label">{picking ? 'Choosing folder…' : cwd || 'Choose workspace'}</span>
                </button>}
            {c.gitInfo?.isRepo && <>
                <span className="code-workspace-pill">{c.gitInfo.branch ?? 'detached'}{c.gitInfo.head ? ` · ${c.gitInfo.head}` : ''}</span>
                {c.gitInfo.status && <span className={`code-workspace-pill${c.gitInfo.status.dirty ? ' is-dirty' : ''}`}>
                    {c.gitInfo.status.dirty ? `${c.gitInfo.status.changed} changed · ${c.gitInfo.status.untracked} untracked` : 'clean'}
                </span>}
            </>}
        </div>
    </header>;
}
