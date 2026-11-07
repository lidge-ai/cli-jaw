// ── Markdown rendering pipeline ──
import { marked, Renderer, type Tokens } from 'marked';
import { t } from '../features/i18n.js';
import { fixCjkPunctuationBoundary } from '../cjk-fix.js';
import { shieldCodeFenceSvg, unshieldCodeFenceSvg, extractTopLevelSvg } from '../diagram/types.js';
import { escapeHtml, stripOrchestration } from './html.js';
import { shieldMath, unshieldMath, type MathBlock } from './math.js';
import { classicTableModel, renderTableActionsBlock } from './table-actions.js';
import { sanitizeHtml } from './sanitize.js';
import { unshieldSvgBlocks } from './svg-actions.js';
import { highlightCode, ensureHighlightLanguages } from './highlight.js';
import { schedulePostRender } from './post-render.js';
import { ensureRenderDelegations } from './delegations.js';
import { API_BASE } from '../api.js';
import { renderElicitationPlaceholder } from '../features/elicitation.js';
import { renderSearchResultsPlaceholder } from './search-results.js';
import { renderComposeBlockPlaceholder } from './compose-block.js';
import { isUnifiedDiff, renderDiffViewer } from './diff-viewer.js';
import { renderDataframePlaceholder } from './dataframe.js';
import { renderChartJsonPlaceholder } from './chart-json.js';
import { hasIncompleteStructuredFence } from '../../../src/shared/structured-fence.js';

// ── marked.js configuration (ES module — always available) ──
let markedReady = false;
let renderContextIsStreaming = false;
let renderContextMessageStreaming = false;
let renderContextMathBlocks: MathBlock[] = [];

const STRUCTURED_FENCE_LANGS = [
    'elicitation',
    'choice-buttons',
    'search-results',
    'compose-block',
    'dataframe',
    'chart-json',
];
const STRUCTURED_LIST_FENCE_RE = new RegExp(
    `^([ \\t]{0,3})([-*+]|\\d+[.)])[ \\t]+(\`{3,}|~{3,})(${STRUCTURED_FENCE_LANGS.join('|')})([^\\n]*)$`,
    'gim',
);

function unwrapListPrefixedStructuredFences(text: string): string {
    return text.replace(STRUCTURED_LIST_FENCE_RE, '$1$3$4$5');
}

function renderCodeBlock(text: string, lang?: string): string {
    const highlighted = highlightCode(text, lang);
    const langDisplay = lang ? escapeHtml(lang) : '';
    const copyLabel = t('code.copy') || 'Copy';
    return `<div class="code-block"><div class="code-header"><span class="code-lang">${langDisplay}</span><button class="code-copy-btn" type="button" aria-label="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</button></div><pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre></div>`;
}

function parseDiagramFileWidgetId(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed) as { id?: unknown };
            return typeof parsed.id === 'string' ? parsed.id.trim() : '';
        } catch {
            return '';
        }
    }
    return trimmed;
}

function ensureMarked(): boolean {
    if (markedReady) return true;

    const renderer = new Renderer();

    renderer.table = function (token: Tokens.Table) {
        const html = Renderer.prototype.table.call(this, token);
        return renderContextMessageStreaming ? html : renderTableActionsBlock(html, classicTableModel(token, renderContextMathBlocks));
    };

    // Code blocks: highlight.js + mermaid + diagram-html + elicitation detection
    renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
        const normalizedLang = lang?.trim().toLowerCase();
        if (normalizedLang === 'mermaid') {
            // Phase 127-F1: store raw source in data attribute, render a skeleton
            // placeholder so users never see raw Mermaid syntax while the diagram loads.
            const encodedCode = encodeURIComponent(text);
            return `<div class="mermaid-container mermaid-pending" data-mermaid-code-raw="${encodedCode}" role="status" aria-label="Diagram loading">
                <div class="mermaid-skeleton">
                    <div class="mermaid-skeleton-spinner"></div>
                    <div class="mermaid-skeleton-text">Rendering diagram…</div>
                </div>
            </div>`;
        }
        // diagram-html: encode as base64, Phase 2 activateWidgets() inflates to sandboxed iframe
        if (normalizedLang === 'diagram-html') {
            const encoded = btoa(unescape(encodeURIComponent(text)));
            return `<div class="diagram-widget-pending" data-diagram-html="${encoded}"
                role="status" aria-label="Interactive widget loading">
                <div class="diagram-spinner"></div>
            </div>`;
        }
        if (normalizedLang === 'diagram-file') {
            const widgetId = parseDiagramFileWidgetId(text);
            if (!widgetId) return renderCodeBlock(text, lang);
            return `<div class="diagram-widget-pending" data-widget-id="${escapeHtml(widgetId)}"
                role="status" aria-label="Interactive widget loading">
                <div class="diagram-spinner"></div>
            </div>`;
        }
        if (normalizedLang === 'elicitation' || normalizedLang === 'choice-buttons') {
            if (renderContextIsStreaming) return renderCodeBlock(text, lang);
            return renderElicitationPlaceholder(text, normalizedLang);
        }
        if (normalizedLang === 'search-results') {
            if (renderContextIsStreaming) return renderCodeBlock(text, lang);
            return renderSearchResultsPlaceholder(text);
        }
        if (normalizedLang === 'compose-block') {
            if (renderContextIsStreaming) return renderCodeBlock(text, lang);
            return renderComposeBlockPlaceholder(text);
        }
        if (normalizedLang === 'dataframe') {
            if (renderContextIsStreaming) return renderCodeBlock(text, lang);
            return renderDataframePlaceholder(text);
        }
        if (normalizedLang === 'chart-json') {
            if (renderContextIsStreaming) return renderCodeBlock(text, lang);
            return renderChartJsonPlaceholder(text);
        }
        if (normalizedLang === 'diff' || (!normalizedLang && isUnifiedDiff(text))) {
            return renderDiffViewer(text);
        }
        return renderCodeBlock(text, lang);
    };

    // Inline media: keep uploads on /media; guard other absolute local paths via /api/image.
    renderer.image = function ({ href, title, text }: { href: string; title?: string | null; text: string }) {
        if (!href) return '';
        let src: string;
        if (href.includes('/uploads/')) {
            src = `${API_BASE}/media/${encodeURIComponent(href.split('/').pop()!)}`;
        } else if (href.startsWith('/')) {
            src = `${API_BASE}/api/image?path=${encodeURIComponent(href)}`;
        } else {
            src = escapeHtml(href);
        }
        const alt = escapeHtml(text || '');
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        const ext = (href.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
        if (['mp4', 'webm', 'mov', 'ogg'].includes(ext)) {
            return `<video src="${src}" controls class="chat-inline-video" preload="metadata"${titleAttr}></video>`;
        }
        return `<img src="${src}" alt="${alt}" class="chat-inline-img" loading="lazy"${titleAttr} />`;
    };

    renderer.link = function ({ href, title, text }: { href: string; title?: string | null; text: string }) {
        const safeHref = escapeHtml(href || '');
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    };

    marked.setOptions({
        renderer,
        gfm: true,
        breaks: false,
    });

    markedReady = true;
    return true;
}

export function renderMarkdown(text: string, isStreaming = false): string {
    const rawCleaned = stripOrchestration(text);
    if (!rawCleaned) return '<em class="text-dim orchestrate-placeholder">' + escapeHtml(t('orchestrator.dispatching')) + '</em>';
    const cleaned = unwrapListPrefixedStructuredFences(rawCleaned).replace(/\n{3,}/g, '\n\n');
    const structuredFenceIncomplete = hasIncompleteStructuredFence(cleaned);

    const { text: fenceShielded, fences } = shieldCodeFenceSvg(cleaned);
    const { text: svgShielded, blocks: svgBlocks } = extractTopLevelSvg(fenceShielded, isStreaming);
    const restored = unshieldCodeFenceSvg(svgShielded, fences);
    const { text: shielded, blocks: mathBlocks } = shieldMath(restored);

    ensureHighlightLanguages();
    ensureMarked();
    const fixed = fixCjkPunctuationBoundary(shielded);
    let html = '';
    renderContextIsStreaming = isStreaming || structuredFenceIncomplete;
    renderContextMessageStreaming = isStreaming;
    renderContextMathBlocks = mathBlocks;
    try {
        html = marked.parse(fixed) as string;
    } finally {
        renderContextIsStreaming = false;
        renderContextMessageStreaming = false;
        renderContextMathBlocks = [];
    }
    html = html.replace(/<table/g, '<div class="table-wrapper"><table').replace(/<\/table>/g, '</table></div>');
    html = unshieldMath(html, mathBlocks, isStreaming);
    html = sanitizeHtml(html);
    html = unshieldSvgBlocks(html, svgBlocks);

    if (!isStreaming) {
        schedulePostRender();
    }
    ensureRenderDelegations();

    return html;
}
