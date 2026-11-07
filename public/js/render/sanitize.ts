// ── XSS sanitization helpers ──
import { getDOMPurify } from '../sanitizer.js';

function purifier() {
    return getDOMPurify();
}

// Strip dangerous CSS constructs from <style> tags while preserving safe rules.
// Blocks @import (external stylesheet injection), @font-face (font fingerprinting),
// and external url() references (resource loading / cookie exfiltration).
// Internal fragment refs like url(#gradient) are preserved via negative lookahead.
function sanitizeCssInStyleTags(html: string): string {
    // Fast path: no <style> tag → nothing to strip. Avoids a full div
    // innerHTML parse + serialize round-trip on every markdown render
    //. False positives (literal "<style"
    // in text) just take the slow path harmlessly.
    if (!/<style/i.test(html)) return html;
    const div = document.createElement('div');
    div.innerHTML = html;
    for (const style of div.querySelectorAll('style')) {
        let css = style.textContent || '';
        css = css.replace(/@import\b[^;]*;?/gi, '/* stripped */');
        css = css.replace(/@font-face\s*\{[^}]*\}/gi, '/* stripped */');
        css = css.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
        style.textContent = css;
    }
    return div.innerHTML;
}

// Mermaid SVG sanitizer — SVG-only profile (no HTML tags).
// Mermaid is configured with htmlLabels:false so labels use SVG <text>,
// not <foreignObject> + HTML. This avoids DOMPurify namespace issues.
export function sanitizeMermaidSvg(svg: string): string {
    const clean = purifier().sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: [
            'script', 'iframe', 'object', 'embed', 'form', 'input',
            'foreignObject', 'animate', 'set', 'animateTransform', 'animateMotion',
        ],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur',
                      'background'],
        ADD_ATTR: ['dominant-baseline'],
    });
    return sanitizeCssInStyleTags(clean);
}

// ── XSS sanitization (hardened — allows <style> with CSS filtering) ──
export function sanitizeHtml(html: string): string {
    const clean = purifier().sanitize(html, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
        FORCE_BODY: true,
        FORBID_TAGS: [
            'script', 'iframe', 'object', 'embed', 'form', 'input',
            // SVG security: block animation + foreignObject (script injection vectors)
            'foreignObject', 'animate', 'set', 'animateTransform', 'animateMotion',
        ],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur',
                      'background'],  // legacy HTML attr that triggers remote fetch
        ADD_TAGS: ['use', 'style'],
        ADD_ATTR: ['aria-hidden', 'xmlns', 'viewBox', 'role', 'aria-label',
                   'data-jaw-svg', 'data-jaw-kind', 'data-mermaid-code-raw',
                   'data-elicitation-kind', 'data-elicitation-spec', 'data-elicitation-hydrated',
                   'data-search-results-kind', 'data-search-results-spec', 'data-search-results-hydrated',
                   'data-compose-block-kind', 'data-compose-block-spec', 'data-compose-block-hydrated',
                   'data-dataframe-kind', 'data-dataframe-spec', 'data-dataframe-hydrated',
                   'data-chart-json-kind', 'data-chart-json-spec', 'data-chart-json-hydrated',
                   'data-widget-id', 'data-table-model', 'data-table-key',
                   'href', 'xlink:href', 'dominant-baseline'],
    });
    return sanitizeCssInStyleTags(clean);
}
