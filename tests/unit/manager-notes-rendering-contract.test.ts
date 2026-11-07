import { MARKDOWN_REMARK_PLUGINS } from '../../public/manager/src/notes/rendering/MarkdownRenderer';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
    buildWikiLinkLookup,
    invalidWikiLinkTarget,
    parseWikiLinkToken,
    splitChildrenWithWikiLinks,
    splitTextWithWikiLinks,
    wikiLinkDisplayText,
    wikiLinkReasonLabel,
} from '../../public/manager/src/notes/wiki-link-rendering';
import { splitPreviewFrontmatter } from '../../public/manager/src/notes/frontmatter-preview';
import type { NotesNoteLinkRef, NotesNoteMetadata } from '../../public/manager/src/notes/notes-types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

type WikiElementProps = {
    className?: string | undefined;
    href?: string | undefined;
    title?: string | undefined;
    children?: ReactNode;
    onClick?: ((event: { preventDefault: () => void }) => void) | undefined;
};

function noteLink(raw: string, target: string, overrides: Partial<NotesNoteLinkRef> = {}): NotesNoteLinkRef {
    return {
        sourcePath: 'source.md',
        raw,
        target,
        line: 1,
        column: 1,
        startOffset: 0,
        endOffset: raw.length,
        status: 'missing',
        ...overrides,
    };
}

function noteMetadata(path: string, title: string, overrides: Partial<NotesNoteMetadata> = {}): NotesNoteMetadata {
    return {
        path,
        title,
        aliases: [],
        tags: [],
        mtimeMs: 1,
        size: 1,
        revision: 'rev',
        ...overrides,
    };
}

function assertWikiElement(node: ReactNode): asserts node is ReactElement<WikiElementProps> {
    assert.ok(isValidElement<WikiElementProps>(node), 'wikilink segment must be a React element');
}

test('Notes rich markdown renderer files exist', () => {
    [
        'public/manager/src/notes/rendering/MarkdownRenderer.tsx',
        'public/manager/src/notes/rendering/CodeBlock.tsx',
        'public/manager/src/notes/rendering/MermaidBlock.tsx',
        'public/manager/src/notes/rendering/highlight-languages.ts',
        'public/manager/src/notes/rendering/markdown-render-security.ts',
    ].forEach(path => {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    });
});

test('MarkdownPreview delegates to the shared renderer', () => {
    const preview = read('public/manager/src/notes/MarkdownPreview.tsx');

    assert.ok(preview.includes("import { MarkdownRenderer } from './rendering/MarkdownRenderer';"),
        'MarkdownPreview must import the shared renderer');
    assert.ok(preview.includes('markdown={props.markdown}'),
        'MarkdownPreview must pass markdown content to the shared renderer');
    assert.ok(preview.includes('outgoing={props.outgoing}'),
        'MarkdownPreview must pass vault-index wikilinks to the shared renderer');
    assert.ok(preview.includes('notes={props.notes}'),
        'MarkdownPreview must pass vault notes to the shared renderer for client-side wikilink fallback');
    assert.ok(preview.includes('onWikiLinkNavigate={props.onWikiLinkNavigate}'),
        'MarkdownPreview must pass wikilink navigation to the shared renderer');
    assert.equal(preview.includes('ReactMarkdown'), false,
        'MarkdownPreview must not own a second ReactMarkdown pipeline');
});

test('MarkdownRenderer wires math, sanitize, safe links, and block routing', () => {
    const renderer = read('public/manager/src/notes/rendering/MarkdownRenderer.tsx');

    assert.ok(renderer.includes("import remarkBreaks from 'remark-breaks';"), 'remark-breaks must be wired so single newlines render as <br>');
    assert.ok(renderer.includes("import remarkGfm from 'remark-gfm';"), 'remark-gfm must be wired for task lists, tables, strikethrough, autolinks, and footnotes');
    assert.ok(renderer.includes("import remarkMath from 'remark-math';"), 'remark-math must be wired');
    assert.ok(renderer.includes("import rehypeKatex from 'rehype-katex';"), 'rehype-katex must be wired');
    assert.ok(renderer.includes("import rehypeSanitize from 'rehype-sanitize';"), 'rehype-sanitize must be wired');
    assert.deepEqual(MARKDOWN_REMARK_PLUGINS, [remarkGfm, remarkBreaks, remarkMath], 'GFM must run before breaks/math in ReactMarkdown');
    assert.ok(renderer.includes('[rehypeSanitize, markdownSanitizeSchema]'), 'sanitize schema must be passed before KaTeX');
    assert.ok(renderer.includes('rehypeKatex'), 'KaTeX renderer must be passed to ReactMarkdown');
    assert.ok(renderer.includes('skipHtml'), 'raw HTML must stay disabled');
    assert.ok(renderer.includes('urlTransform={safeMarkdownUrl}'), 'safe URL transform must stay active');
    assert.ok(renderer.includes('...anchorProps'), 'custom anchors must preserve safe GFM footnote data attributes');
    assert.equal(renderer.includes('rehypeRaw'), false, 'rehype-raw must not be introduced');
    assert.ok(renderer.includes("language === 'mermaid'"), 'Mermaid must be selected from language-mermaid fenced code');
    assert.ok(renderer.includes('<CodeBlock code={code} language={language} />'), 'code fences must route to CodeBlock');
    assert.ok(renderer.includes('<code className={className}>{children}</code>'), 'inline code must remain inline');
    assert.ok(renderer.includes('buildWikiLinkLookup(props.outgoing)'), 'MarkdownRenderer must derive wikilink lookup from vault-index outgoing links');
    assert.ok(renderer.includes('notes: props.notes'), 'MarkdownRenderer must pass vault notes into wikilink fallback context');
    assert.ok(renderer.includes('splitPreviewFrontmatter(props.markdown).body'), 'MarkdownRenderer must strip leading YAML frontmatter before rendering');
    assert.ok(renderer.includes('splitChildrenWithWikiLinks'), 'MarkdownRenderer must transform only supported text children for wikilinks');
    assert.ok(renderer.includes('onLocalFileOpen?: ((path: string) => void) | undefined'), 'MarkdownRenderer must expose local-file links as an opt-in callback');
    assert.ok(renderer.includes('splitChildrenWithLocalFileLinks'), 'MarkdownRenderer must local-linkify only after normal wikilink handling');
    assert.ok(renderer.includes("className: 'markdown-local-file-link'"), 'local file links must render as styled buttons, not unsafe file:// anchors');
    assert.ok(renderer.includes('onLocalFileOpen(clean)'), 'local file link activation must call the caller-owned open handler');
    assert.ok(renderer.includes("tableMode?: 'semantic' | 'linear' | undefined"), 'MarkdownRenderer must expose an opt-in table rendering mode');
    assert.ok(renderer.includes("if (props.tableMode === 'linear')"), 'linear table rendering must be opt-in only');
    assert.ok(renderer.includes("td: wikiTransform('td')"), 'default semantic table cells must keep Notes wikilink behavior');
    assert.ok(renderer.includes("th: wikiTransform('th')"), 'default semantic table headers must keep Notes wikilink behavior');
    assert.ok(renderer.includes('components.table ='), 'linear mode must override native table elements');
    assert.ok(renderer.includes('components.tr ='), 'linear mode must override native row elements');
    assert.ok(renderer.includes("components.th = linearCellTransform('th')"), 'linear mode must override native header cells');
    assert.ok(renderer.includes("components.td = linearCellTransform('td')"), 'linear mode must override native body cells');
    assert.ok(renderer.includes('role="list"'), 'linear mode must expose rows as a list, not a native table');
    assert.ok(renderer.includes('role="listitem"'), 'linear mode must expose table rows as linear list items');
    assert.ok(renderer.includes('countLinearTableColumns'), 'linear tables must derive a shared column count for grid alignment');
    assert.ok(renderer.includes('linearTableGridTemplate'), 'linear tables must provide a shared grid template for header/body alignment');
    assert.ok(renderer.includes("'--markdown-linear-table-grid'"), 'linear table grid template must be passed as a CSS custom property');
    assert.equal(read('public/manager/src/notes/MarkdownPreview.tsx').includes('onLocalFileOpen'), false, 'Notes preview must not open arbitrary local files');
});

test('preview strips leading YAML frontmatter without losing body wikilinks', () => {
    const withFrontmatter = splitPreviewFrontmatter('---\naliases: []\ntags: []\n---\n[[about-jaw]]\n');

    assert.equal(withFrontmatter.frontmatterRaw, '---\naliases: []\ntags: []\n---\n');
    assert.equal(withFrontmatter.body, '[[about-jaw]]\n');

    const withoutClosingFence = splitPreviewFrontmatter('---\naliases: []\n[[about-jaw]]');
    assert.equal(withoutClosingFence.frontmatterRaw, null);
    assert.equal(withoutClosingFence.body, '---\naliases: []\n[[about-jaw]]');

    const nonLeadingFence = splitPreviewFrontmatter('# Title\n---\n[[about-jaw]]');
    assert.equal(nonLeadingFence.frontmatterRaw, null);
    assert.equal(nonLeadingFence.body, '# Title\n---\n[[about-jaw]]');
});

test('wiki link text rendering follows vault-index resolution', () => {
    const lookup = buildWikiLinkLookup([
        noteLink('[[Target|Label]]', 'Target', { status: 'resolved', resolvedPath: 'notes/target.md', displayText: 'Label' }),
        noteLink('[[Target#Heading]]', 'Target', { status: 'resolved', resolvedPath: 'notes/target.md', heading: 'Heading' }),
        noteLink('[[Missing]]', 'Missing', { status: 'missing', reason: 'not_found' }),
    ]);
    const navigated: string[] = [];
    const segments = splitTextWithWikiLinks(
        'Open [[Target|Label]], [[Target#Heading]], and [[Missing]]',
        lookup,
        path => navigated.push(path),
    );

    assert.equal(segments.length, 6);

    const resolved = segments[1];
    assertWikiElement(resolved);
    assert.equal(resolved.props.className, 'notes-wikilink');
    assert.equal(resolved.props.href, '#notes%2Ftarget.md');
    assert.equal(resolved.props.children, 'Label');

    let prevented = false;
    resolved.props.onClick?.({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(navigated, ['notes/target.md']);

    const heading = segments[3];
    assertWikiElement(heading);
    assert.equal(heading.props.children, 'Target#Heading');

    const broken = segments[5];
    assertWikiElement(broken);
    assert.equal(broken.props.className, 'notes-wikilink is-broken');
    assert.equal(broken.props.title, 'No matching note');
    assert.equal(broken.props.children, 'Missing');
});

test('shared wikilink helpers preserve WYSIWYG and preview display labels', () => {
    const parsed = parseWikiLinkToken('[[Target#Heading|Readable label]]');
    assert.equal(parsed?.target, 'Target');
    assert.equal(parsed?.heading, 'Heading');
    assert.equal(parsed?.displayText, 'Readable label');

    const resolved = noteLink('[[Target#Heading|Readable label]]', 'Target', {
        status: 'resolved',
        resolvedPath: 'target.md',
        displayText: 'Readable label',
    });
    const broken = noteLink('[[Missing]]', 'Missing', { status: 'missing', reason: 'invalid_target' });

    assert.equal(wikiLinkDisplayText(resolved, resolved.raw), 'Readable label');
    assert.equal(wikiLinkDisplayText(broken, broken.raw), 'Missing');
    assert.equal(wikiLinkReasonLabel(broken), 'Invalid link target');
});

test('preview wikilink fallback resolves newly typed links from vault notes', () => {
    const notes = [
        noteMetadata('Projects/Project Alpha.md', 'Project Alpha', { aliases: ['Alpha'] }),
    ];
    const navigated: string[] = [];
    const transformed = splitChildrenWithWikiLinks('See [[Project Alpha]] and [[Alpha|A]]', {
        lookup: buildWikiLinkLookup([]),
        outgoing: [],
        notes,
        onNavigate: path => navigated.push(path),
    }, 'preview');

    assert.ok(Array.isArray(transformed), 'fallback transformation must split text into segments');
    assert.equal(transformed.length, 4);
    const resolved = transformed[1];
    assertWikiElement(resolved);
    assert.equal(resolved.props.className, 'notes-wikilink');
    assert.equal(resolved.props.href, '#Projects%2FProject%20Alpha.md');
    assert.equal(resolved.props.children, 'Project Alpha');
    resolved.props.onClick?.({ preventDefault: () => {} });
    assert.deepEqual(navigated, ['Projects/Project Alpha.md']);

    const alias = transformed[3];
    assertWikiElement(alias);
    assert.equal(alias.props.children, 'A');
});

test('shared wikilink parser matches backend escaped delimiters and invalid reserved paths', () => {
    const pipe = parseWikiLinkToken('[[foo\\|bar|Readable]]');
    assert.equal(pipe?.target, 'foo\\|bar');
    assert.equal(pipe?.displayText, 'Readable');

    const heading = parseWikiLinkToken('[[foo\\#bar#Heading]]');
    assert.equal(heading?.target, 'foo\\#bar');
    assert.equal(heading?.heading, 'Heading');

    assert.equal(invalidWikiLinkTarget('.assets/file'), true);
    assert.equal(invalidWikiLinkTarget('_templates/template'), true);
});

test('MermaidBlock uses component-owned strict Mermaid rendering without iframe', () => {
    const mermaid = read('public/manager/src/notes/rendering/MermaidBlock.tsx');

    assert.ok(mermaid.includes("await import('mermaid')"), 'Mermaid must stay lazy-loaded');
    assert.ok(mermaid.includes('getMermaidInitConfig'), 'Mermaid must use shared init config for theme/security parity');
    assert.ok(mermaid.includes('sanitizeMermaidSvg'), 'Mermaid SVG output must be sanitized before DOM insertion');
    assert.ok(mermaid.includes('mermaid.render'), 'MermaidBlock must render through the Mermaid API');
    assert.equal(mermaid.includes('<iframe'), false, 'MermaidBlock must not use iframe rendering');
    assert.ok(mermaid.includes("status: 'error'"), 'Mermaid render failures must stay local to the block');
});

test('MermaidBlock caches ready SVG output without flashing same-source renders back to loading', () => {
    const mermaid = read('public/manager/src/notes/rendering/MermaidBlock.tsx');

    assert.ok(mermaid.includes('renderedMermaidCache = new Map<string, MermaidReadyState>()'),
        'MermaidBlock must cache sanitized ready output');
    assert.ok(mermaid.includes("Extract<MermaidState, { status: 'ready' }>"),
        'cached ready values must share the final ready-state shape');
    assert.ok(mermaid.includes('sourceKey: string'),
        'Mermaid render state must track the source key used for cache safety');
    assert.ok(mermaid.includes('getMermaidCacheThemeKey()'),
        'cache key must include the active theme signature, not source text only');
    assert.ok(mermaid.includes('const themeKey = getMermaidCacheThemeKey();'),
        'theme key must be read during render so theme-only rerenders can invalidate Mermaid SVG cache keys');
    assert.ok(mermaid.includes('useMemo(() => `${themeKey}\\n${code}`, [code, themeKey])'),
        'Mermaid cache key must update when either source or active theme changes');
    assert.ok(mermaid.includes('useMemo(() => preprocessMermaid(props.code), [props.code])'),
        'preprocessed Mermaid source must be memoized before caching/rendering');
    assert.ok(mermaid.includes('current.status === \'ready\' && current.sourceKey === sourceKey'),
        'same-source ready state must not be forced back to loading');
    assert.ok(mermaid.includes('rememberRenderedMermaid(sourceKey, ready)'),
        'successful renders must populate the output cache');
});

test('CodeBlock uses highlight.js core with curated language aliases and safe fallback', () => {
    const codeBlock = read('public/manager/src/notes/rendering/CodeBlock.tsx');
    const highlight = read('public/manager/src/notes/rendering/highlight-languages.ts');

    assert.ok(highlight.includes("import hljs from 'highlight.js/lib/core';"), 'highlight.js core import must be used');
    [
        "'javascript'", "'js'", "'typescript'", "'ts'", "'python'", "'py'", "'bash'", "'shell'", "'sh'",
        "'json'", "'css'", "'xml'", "'html'", "'markdown'", "'md'", "'yaml'", "'yml'", "'sql'",
        "'rust'", "'rs'", "'go'", "'java'", "'cpp'", "'c'", "'diff'", "'plaintext'", "'text'",
    ].forEach(alias => {
        assert.ok(highlight.includes(alias), `language alias ${alias} must be registered`);
    });
    assert.ok(highlight.includes('hljs.getLanguage(normalized)'), 'unknown languages must be checked before highlight');
    assert.ok(highlight.includes('highlighted: false'), 'unknown languages must fall back safely');
    assert.ok(codeBlock.includes("import { copyText } from '../../clipboard/copy-text';"), 'copy button must use the shared clipboard helper');
    assert.ok(codeBlock.includes('await copyText(props.code)'), 'copy button must copy source text through the shared helper');
});

test('Notes app imports KaTeX CSS and notes CSS owns rich preview styling', () => {
    const main = read('public/manager/src/main.tsx');
    const css = read('public/manager/src/manager-notes.css');

    assert.ok(main.includes("import 'katex/dist/katex.min.css';"), 'KaTeX CSS must be imported');
    assert.ok(css.includes('.notes-code-block'), 'Notes CSS must style code blocks');
    assert.ok(css.includes('.notes-code-rendered'), 'Notes CSS must style WYSIWYG rendered code blocks');
    assert.ok(css.includes(':where(.notes-code-block, .notes-code-rendered) .hljs-keyword'),
        'Preview and WYSIWYG code blocks must share highlight token colors');
    assert.ok(css.includes('.task-list-item'), 'Notes CSS must style rendered GFM task lists');
    assert.ok(css.includes('li[data-item-type="task"]'), 'Notes CSS must style Milkdown GFM task list items');
    assert.ok(css.includes('.notes-preview table'), 'Notes CSS must style rendered GFM tables');
    assert.ok(css.includes('[data-footnotes]'), 'Notes CSS must style rendered GFM footnotes');
    assert.ok(css.includes('.notes-mermaid-block'), 'Notes CSS must style Mermaid blocks');
    assert.ok(css.includes('.katex-display'), 'Notes CSS must handle KaTeX display overflow');
});
