// ── One-time render event delegations ──
import { ensureTableActionDelegation } from './table-actions.js';
import { ensureCodeCopyDelegation } from './code-copy.js';
import { ensureDiagramActionDelegation } from './svg-actions.js';
import { ensureFilePathDelegation } from './file-links.js';
import { ensureElicitationDelegation } from '../features/elicitation.js';
import { ensureComposeBlockDelegation } from './compose-block.js';
import { ensureDataframeDelegation } from './dataframe.js';

let inlineImageErrorDelegationReady = false;

// DOMPurify strips inline onerror handlers, so broken inline images fall back
// through a document-level capture listener ('error' does not bubble).
function ensureInlineImageErrorDelegation(): void {
    if (inlineImageErrorDelegationReady) return;
    inlineImageErrorDelegationReady = true;
    document.addEventListener('error', (event: Event) => {
        const target = event.target;
        if (
            !(target instanceof HTMLElement)
            || target.tagName !== 'IMG'
            || !target.classList.contains('chat-inline-img')
        ) return;

        const alt = target.getAttribute('alt')?.trim() || '';
        const placeholder = document.createElement('div');
        placeholder.className = 'chat-inline-img-error';
        placeholder.setAttribute('role', 'status');
        placeholder.textContent = alt ? `Image unavailable: ${alt}` : 'Image unavailable';
        target.replaceWith(placeholder);
    }, true);
}

export function ensureRenderDelegations(): void {
    ensureInlineImageErrorDelegation();
    ensureCodeCopyDelegation();
    ensureTableActionDelegation();
    ensureDiagramActionDelegation();
    ensureFilePathDelegation();
    ensureElicitationDelegation();
    ensureComposeBlockDelegation();
    ensureDataframeDelegation();
}
