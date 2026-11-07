import { Children, createElement, isValidElement, memo, useMemo } from 'react';
import type { MouseEvent } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { Pluggable, PluggableList } from 'unified';
import type { TableModel } from '../../../../../src/shared/markdown-table';
import { MarkdownTableActionsContext, MarkdownTableFrame } from './MarkdownTableActions';
import { remarkCollectTableModels } from './markdown-table-model';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeBlock } from './CodeBlock';
import { MermaidBlock } from './MermaidBlock';
import {
    isSafeExternalHref,
    markdownSanitizeSchema,
    notesImageSrc,
    safeMarkdownUrl,
} from './markdown-render-security';
import { buildWikiLinkLookup, splitChildrenWithWikiLinks, type WikiLinkContext } from '../wiki-link-rendering';
import { splitPreviewFrontmatter } from '../frontmatter-preview';
import type { NotesNoteLinkRef, NotesNoteMetadata } from '../notes-types';

export const MARKDOWN_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkBreaks, remarkMath];

type MarkdownRendererProps = {
    markdown: string;
    outgoing?: NotesNoteLinkRef[] | undefined;
    notes?: readonly NotesNoteMetadata[] | undefined;
    onWikiLinkNavigate?: ((path: string) => void) | undefined;
    onLocalFileOpen?: ((path: string) => void) | undefined;
    tableMode?: 'semantic' | 'linear' | undefined;
    tableActions?: boolean | undefined;
};

type MarkdownAnchorProps = ComponentProps<'a'> & {
    node?: unknown;
};

type WikiContainerTag =
    | 'p'
    | 'li'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6'
    | 'blockquote'
    | 'td'
    | 'th'
    | 'em'
    | 'strong'
    | 'del';

type WikiContainerProps = {
    children?: ReactNode;
    className?: string | undefined;
    id?: string | undefined;
    style?: CSSProperties | undefined;
    node?: unknown;
};

type LinearTableContainerProps = {
    children?: ReactNode;
    className?: string | undefined;
    style?: CSSProperties | undefined;
    node?: { position?: { start: { offset?: number | undefined } } | undefined } | undefined;
};

type LinearTableCellProps = LinearTableContainerProps & {
    align?: string | undefined;
};

type LinearTableNodeProps = {
    children?: ReactNode;
    node?: { tagName?: string | undefined } | undefined;
};

function mergeClassName(base: string, className?: string): string {
    return className ? `${base} ${className}` : base;
}

function countLinearTableColumns(children: ReactNode): number {
    let maxColumns = 0;
    const visit = (node: ReactNode): void => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (!isValidElement<LinearTableNodeProps>(node)) return;
        if (node.props.node?.tagName === 'tr') {
            maxColumns = Math.max(maxColumns, Children.count(node.props.children));
        }
        Children.forEach(node.props.children, visit);
    };
    Children.forEach(children, visit);
    return Math.max(1, maxColumns);
}

function linearTableGridTemplate(columnCount: number): string {
    if (columnCount <= 1) return 'minmax(0, 1fr)';
    if (columnCount === 2) return 'max-content minmax(16rem, 1fr)';
    if (columnCount === 3) return 'max-content minmax(12rem, .45fr) minmax(18rem, 1fr)';
    return `max-content repeat(${columnCount - 1}, minmax(12rem, 1fr))`;
}

function textFromNode(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textFromNode).join('');
    if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
    return '';
}

function languageFromCodeNode(node: ReactNode): string {
    if (!isValidElement<{ className?: string }>(node)) return 'text';
    const className = node.props.className ?? '';
    const match = className.match(/language-([^\s]+)/);
    return match?.[1] ?? 'text';
}

const NOOP_NAVIGATE = (_path: string): void => {};
const LOCAL_FILE_PATH_RE_G = /(?:~\/[^\s)`\]"'<>]+|\/(?:Users|home|tmp|var|opt|private)\/[^\s)`\]"'<>]+)/g;
const TRAILING_PATH_PUNCT_RE = /[.,!?:;]+$/;

function isLocalFilePathCandidate(path: string): boolean {
    return path.startsWith('~/') || /^\/(?:Users|home|tmp|var|opt|private)\//.test(path);
}

function localPathLabel(path: string): string {
    const basename = path.split('/').pop() || path;
    return /\.\w{1,10}$/.test(basename) ? basename : path;
}

function splitTextWithLocalFileLinks(
    text: string,
    onLocalFileOpen: ((path: string) => void) | undefined,
    keyPrefix: string,
): ReactNode[] {
    if (!text || !onLocalFileOpen) return [text];
    LOCAL_FILE_PATH_RE_G.lastIndex = 0;
    const out: ReactNode[] = [];
    let cursor = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = LOCAL_FILE_PATH_RE_G.exec(text)) !== null) {
        const raw = match[0];
        const clean = raw.replace(TRAILING_PATH_PUNCT_RE, '');
        if (!isLocalFilePathCandidate(clean)) continue;
        if (match.index > cursor) out.push(text.slice(cursor, match.index));
        const trailing = raw.slice(clean.length);
        out.push(
            createElement(
                'button',
                {
                    key: `${keyPrefix}-lf-${index++}`,
                    type: 'button',
                    className: 'markdown-local-file-link',
                    title: clean,
                    onClick: (event: MouseEvent<HTMLButtonElement>) => {
                        event.preventDefault();
                        onLocalFileOpen(clean);
                    },
                },
                localPathLabel(clean),
            ),
        );
        if (trailing) out.push(trailing);
        cursor = match.index + raw.length;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
}

function splitChildrenWithLocalFileLinks(
    children: ReactNode,
    onLocalFileOpen: ((path: string) => void) | undefined,
    keyPrefix: string,
): ReactNode {
    if (!onLocalFileOpen) return children;
    const out: ReactNode[] = [];
    let stringIndex = 0;
    Children.forEach(children, (child, i) => {
        if (typeof child === 'string') {
            const segments = splitTextWithLocalFileLinks(child, onLocalFileOpen, `${keyPrefix}-${stringIndex++}-${i}`);
            for (const seg of segments) out.push(seg);
            return;
        }
        out.push(child);
    });
    return out;
}

function MarkdownRendererImpl(props: MarkdownRendererProps) {
    const renderedMarkdown = useMemo(
        () => splitPreviewFrontmatter(props.markdown).body,
        [props.markdown],
    );

    const tableActionsCapable = props.tableActions !== undefined;
    const tableModels = useMemo(() => new Map<number, TableModel>(), [renderedMarkdown]);
    const remarkPlugins = useMemo<PluggableList>(() => tableActionsCapable
        ? [...MARKDOWN_REMARK_PLUGINS, [remarkCollectTableModels, tableModels] as Pluggable]
        : [...MARKDOWN_REMARK_PLUGINS], [tableActionsCapable, tableModels]);

    const wikiCtx = useMemo<WikiLinkContext>(() => ({
        lookup: buildWikiLinkLookup(props.outgoing),
        outgoing: props.outgoing,
        notes: props.notes,
        onNavigate: props.onWikiLinkNavigate ?? NOOP_NAVIGATE,
    }), [props.outgoing, props.notes, props.onWikiLinkNavigate]);

    // D1: this whole block used to run in the render body, minting ~20 fresh
    // component identities per render. React keys reconciliation off element
    // type identity, so new types mean unmount + remount of the entire rendered
    // subtree — on every streaming token, for the full accumulated text.
    const components = useMemo<Components>(() => {
    const inlineTransform = (children: ReactNode, keyPrefix: string): ReactNode => {
        const withWikiLinks = splitChildrenWithWikiLinks(children, wikiCtx, keyPrefix);
        return splitChildrenWithLocalFileLinks(withWikiLinks, props.onLocalFileOpen, keyPrefix);
    };

    const wikiTransform = (tag: WikiContainerTag) => (containerProps: WikiContainerProps) => {
        const { children, node: _node, className, id, style } = containerProps;
        const transformed = inlineTransform(children, tag);
        return createElement(tag, { className, id, style }, transformed);
    };

    const linearCellTransform = (tag: 'td' | 'th') => (cellProps: LinearTableCellProps) => {
        const { children, node: _node, className, style, align } = cellProps;
        const transformed = inlineTransform(children, tag);
        return (
            <span
                className={mergeClassName(`markdown-linear-table-cell markdown-linear-table-${tag}`, className)}
                style={style}
                data-align={align || undefined}
            >
                {transformed}
            </span>
        );
    };

    const components: Components = {
        a: ({ href, children, node: _node, ...anchorProps }: MarkdownAnchorProps) => {
            const safeHref = typeof href === 'string' && isSafeExternalHref(href) ? href : undefined;
            const external = Boolean(safeHref && /^https?:\/\//i.test(safeHref));
            return (
                <a
                    {...anchorProps}
                    href={safeHref}
                    target={external ? '_blank' : undefined}
                    rel={external ? 'noreferrer noopener' : undefined}
                >
                    {children}
                </a>
            );
        },
        code: ({ className, children }: ComponentProps<'code'>) => (
            <code className={className}>{children}</code>
        ),
        pre: ({ children }) => {
            const language = languageFromCodeNode(children);
            const code = textFromNode(children).replace(/\n$/, '');
            if (language === 'mermaid') return <MermaidBlock code={code} />;
            return <CodeBlock code={code} language={language} />;
        },
        img: ({ src, alt, ...imageProps }: ComponentProps<'img'>) => {
            const safeSrc = typeof src === 'string' ? notesImageSrc(src) : '';
            if (!safeSrc) return null;
            if (safeSrc.endsWith('.pdf')) {
                return <iframe src={safeSrc} title={alt ?? 'PDF embed'} className="notes-pdf-embed" />;
            }
            return <img {...imageProps} src={safeSrc} alt={alt ?? ''} loading="lazy" />;
        },
        p: wikiTransform('p'),
        li: wikiTransform('li'),
        h1: wikiTransform('h1'),
        h2: wikiTransform('h2'),
        h3: wikiTransform('h3'),
        h4: wikiTransform('h4'),
        h5: wikiTransform('h5'),
        h6: wikiTransform('h6'),
        blockquote: wikiTransform('blockquote'),
        td: wikiTransform('td'),
        th: wikiTransform('th'),
        em: wikiTransform('em'),
        strong: wikiTransform('strong'),
        del: wikiTransform('del'),
    };

    if (props.tableMode === 'linear') {
        components.table = ({ children, node, className, style }: LinearTableContainerProps) => {
            const tableStyle = {
                ...style,
                '--markdown-linear-table-grid': linearTableGridTemplate(countLinearTableColumns(children)),
            } as CSSProperties;
            const table = (
                <div className={mergeClassName('markdown-linear-table', className)} style={tableStyle} role="list">
                    {children}
                </div>
            );
            return tableActionsCapable ? <MarkdownTableFrame offset={node?.position?.start.offset}>{table}</MarkdownTableFrame> : table;
        };
        components.thead = ({ children, node: _node, className, style }: LinearTableContainerProps) => (
            <div className={mergeClassName('markdown-linear-table-head', className)} style={style}>
                {children}
            </div>
        );
        components.tbody = ({ children, node: _node, className, style }: LinearTableContainerProps) => (
            <div className={mergeClassName('markdown-linear-table-body', className)} style={style}>
                {children}
            </div>
        );
        components.tr = ({ children, node: _node, className, style }: LinearTableContainerProps) => (
            <div className={mergeClassName('markdown-linear-table-row', className)} style={style} role="listitem">
                {children}
            </div>
        );
        components.th = linearCellTransform('th');
        components.td = linearCellTransform('td');
    } else if (tableActionsCapable) {
        components.table = ({ node, children, ...tableProps }) => (
            <MarkdownTableFrame offset={node?.position?.start.offset}><table {...tableProps}>{children}</table></MarkdownTableFrame>
        );
    }
        return components;
    }, [wikiCtx, props.onLocalFileOpen, props.tableMode, tableActionsCapable]);

    return (
        <MarkdownTableActionsContext.Provider value={{ ready: props.tableActions === true, models: tableModels }}>
        <ReactMarkdown
            skipHtml
            urlTransform={safeMarkdownUrl}
            remarkPlugins={remarkPlugins}
            rehypePlugins={[
                [rehypeSanitize, markdownSanitizeSchema],
                rehypeKatex,
            ]}
            components={components}
        >
            {renderedMarkdown}
        </ReactMarkdown>
        </MarkdownTableActionsContext.Provider>
    );
}

// D1: memo so an unchanged past message is not re-rendered when a sibling
// updates. Default shallow compare is correct here — every prop is either a
// primitive or a reference the caller already keeps stable.
export const MarkdownRenderer = memo(MarkdownRendererImpl);
