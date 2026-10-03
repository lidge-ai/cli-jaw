import { promises as fs } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { DEFAULT_EXCLUDES, DEFAULT_MAX_FILE_SIZE_BYTES } from './constants.js';
import { languageFromPath } from './renderer.js';
import { estimateTokens } from './token-estimator.js';
import type { ContextPackInput, ExcludedContextFile, SelectedContextFile } from './types.js';

const MAX_GLOB_OPENING_DELIMITERS = 32;

interface ContextPatternSet {
    include: string[];
    exclude: string[];
}

type ReadContextFileResult =
    | { ok: true; file: SelectedContextFile }
    | { ok: false; excluded: ExcludedContextFile };

export async function buildContextPack(input: ContextPackInput = {}): Promise<{
    files: SelectedContextFile[];
    excluded: ExcludedContextFile[];
    warnings: string[];
}> {
    const cwd = resolve(input.cwd || process.cwd());
    const patterns = await collectPatterns(input);
    if (patterns.include.length === 0) {
        throw new Error('context files required. Pass --context-from-files or --context-file.');
    }
    const exclude = [...DEFAULT_EXCLUDES, ...patterns.exclude, ...(input.contextExclude || [])];
    const paths = await expandContextPaths(patterns.include, exclude, cwd);
    const maxFileSize = Number(input.maxFileSize || DEFAULT_MAX_FILE_SIZE_BYTES);
    const files: SelectedContextFile[] = [];
    const excluded: ExcludedContextFile[] = [];
    const warnings: string[] = [];

    for (const path of paths) {
        const selected = await readContextFile(path, cwd, maxFileSize, input.strict === true);
        if (selected.ok) files.push(selected.file);
        else excluded.push(selected.excluded);
    }
    if (files.length === 0) warnings.push('no context files included');
    return { files, excluded, warnings };
}

export async function collectPatterns(input: ContextPackInput = {}): Promise<ContextPatternSet> {
    const include = normalizeList(input.contextFromFiles);
    const exclude: string[] = [];
    for (const value of [...include]) {
        if (!value.startsWith('!')) continue;
        exclude.push(value.slice(1));
        include.splice(include.indexOf(value), 1);
    }

    if (input.contextFile) {
        const content = await fs.readFile(resolve(input.cwd || process.cwd(), input.contextFile), 'utf8');
        const parsed = parseContextFile(content);
        include.push(...parsed.include);
        exclude.push(...parsed.exclude);
    }

    return { include: unique(include), exclude: unique(exclude) };
}

export async function expandContextPaths(
    includePatterns: string[] = [],
    excludePatterns: string[] = [],
    cwd = process.cwd(),
): Promise<string[]> {
    const literals: string[] = [];
    const globs: string[] = [];

    for (const pattern of includePatterns) {
        const absolute = resolve(cwd, pattern);
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat) {
            if (stat.isSymbolicLink()) throw new Error(`context path is a symlink and is not allowed: ${pattern}`);
            if (stat.isDirectory()) globs.push(`${toPosix(relative(cwd, absolute))}/**/*`);
            else if (stat.isFile()) literals.push(absolute);
            else throw new Error(`context path is not a regular file or directory: ${pattern}`);
            continue;
        }
        if (looksLikeGlob(pattern)) globs.push(pattern);
        else throw new Error(`context path not found: ${pattern}`);
    }

    if (globs.length) {
        for (const pattern of globs) assertBoundedGlobPattern(pattern);
        for (const pattern of excludePatterns) assertBoundedGlobPattern(pattern);
    }

    const globbed = globs.length
        ? await fg(globs, {
            cwd,
            absolute: true,
            onlyFiles: true,
            followSymbolicLinks: false,
            ignore: excludePatterns,
            dot: true,
        })
        : [];

    return unique([...literals, ...globbed])
        .map(path => resolve(path))
        .sort((a, b) => toPosix(relative(cwd, a)).localeCompare(toPosix(relative(cwd, b))));
}

function assertBoundedGlobPattern(pattern: string): void {
    // GHSA-vfj7-8cjw-p6xm: braces recursively walks both brace and paren nodes.
    // Count all raw openers, including escaped ones; apparent closers inside
    // escapes, quotes or character classes cannot safely reduce AST depth.
    let openers = 0;
    for (const char of pattern) {
        if (char !== '{' && char !== '(') continue;
        if (++openers > MAX_GLOB_OPENING_DELIMITERS) {
            throw new Error(`context glob pattern exceeds ${MAX_GLOB_OPENING_DELIMITERS} opening delimiters`);
        }
    }
}

export async function readContextFile(
    path: string,
    cwd = process.cwd(),
    maxFileSize = DEFAULT_MAX_FILE_SIZE_BYTES,
    strict = false,
): Promise<ReadContextFileResult> {
    const stat = await fs.lstat(path);
    const relativePath = toPosix(relative(cwd, path));
    if (stat.isSymbolicLink()) return excluded(path, relativePath, 'symlink-not-allowed');
    if (!stat.isFile()) return excluded(path, relativePath, 'not-a-regular-file');
    if (stat.size > maxFileSize) {
        if (strict) throw new Error(`context file exceeds max size: ${relativePath} (${stat.size}/${maxFileSize} bytes)`);
        return excluded(path, relativePath, 'max-file-size-exceeded', stat.size);
    }

    const buffer = await fs.readFile(path);
    if (isBinaryLike(buffer)) return excluded(path, relativePath, 'binary-or-non-text', stat.size);
    const content = buffer.toString('utf8');
    return {
        ok: true,
        file: {
            path,
            relativePath,
            sizeBytes: stat.size,
            estimatedTokens: estimateTokens(content, 1),
            language: languageFromPath(relativePath),
            content,
        },
    };
}

function parseContextFile(content: string): ContextPatternSet {
    const include: string[] = [];
    const exclude: string[] = [];
    const trimmed = String(content || '').trim();
    if (!trimmed) return { include, exclude };
    if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        include.push(...normalizeList(parsed["include"] || parsed["files"] || parsed["contextFromFiles"]));
        exclude.push(...normalizeList(parsed["exclude"] || parsed["contextExclude"]));
        return { include, exclude };
    }
    for (const line of trimmed.split(/\r?\n/)) {
        const value = line.trim();
        if (!value || value.startsWith('#')) continue;
        if (value.startsWith('!')) exclude.push(value.slice(1));
        else include.push(value);
    }
    return { include, exclude };
}

function excluded(path: string, relativePath: string, reason: string, sizeBytes?: number): ReadContextFileResult {
    return { ok: false, excluded: { path, relativePath, reason, ...(sizeBytes ? { sizeBytes } : {}) } };
}

function normalizeList(value: unknown): string[] {
    if (!value) return [];
    return (Array.isArray(value) ? value : [value])
        .flatMap(item => String(item || '').split(','))
        .map(item => item.trim())
        .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

function looksLikeGlob(value = ''): boolean {
    return /[*?[\]{}()!]/.test(value);
}

function toPosix(value = ''): string {
    return String(value).split(sep).join('/');
}

function isBinaryLike(buffer: Buffer): boolean {
    if (buffer.includes(0)) return true;
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
    return sample.includes('\uFFFD');
}
