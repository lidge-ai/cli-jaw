import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { settings, JAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile, deriveCdpPort, DEFAULT_PORT, resolveFlushEvery } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { resolveSkillId } from '../../lib/mcp/skills-aliases.js';
import { getEmployees } from '../core/db.js';
import { getActiveChatSession, listChatSessions } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { memoryFlushCounter } from '../agent/spawn.js';
import { describeHeartbeatSchedule, normalizeHeartbeatSchedule } from '../memory/heartbeat-schedule.js';
import { buildTaskSnapshot, hasSoulFile, loadProfileSummary, loadSoulSummary } from '../memory/runtime.js';
import { readHostToolchain, renderHostToolchainSection } from '../memory/host-toolchain.js';
import { buildMemoryInjection } from '../memory/injection.js';
import { loadAndRender, loadTemplate, renderTemplate, parseWorkerContexts, clearTemplateCache } from './template-loader.js';
import { findStaticEmployee } from '../core/employees.js';
import { dedupeSkillDirEntries } from '../../lib/mcp/skills-utils.js';
import { getEmployeeMcpToolSummary } from '../agent/mcp-passthrough.js';
import { buildInjectionBlock as buildRuntimeContextBlock } from './runtime-context.js';
import { buildPrePromptContextHook } from './context-hooks.js';
import { buildDigestPromptBlock } from '../wiki/prompt.js';
import { invalidateSkillCommandsCache, registerSkillLoader } from '../core/skill-cache.js';
import { log } from '../core/logger.js';

const promptCache = new Map();

/**
 * Character budget for soul.md inside generated AGENTS.md (#300).
 *
 * Large enough to retain the reported 3.4 KB production soul, including safety
 * rules near its tail, while still bounding a file that AGENTS.md injects on
 * every turn. loadSoulSummary() adds an explicit marker when this is exceeded.
 */
const SOUL_DISK_BUDGET = 6000;

function getRepoBundledSkillPath(...parts: string[]): string {
    return join(process.cwd(), ...parts);
}

function findFirstExistingPath(paths: string[]): string | null {
    return paths.find(p => fs.existsSync(p)) || null;
}

function findSkillPath(skillName: string): string | null {
    // Canonical id first, then the caller's spelling — a legacy name still
    // resolves, and a reference-only skill is unaffected.
    const canonical = resolveSkillId(skillName);
    const names = canonical === skillName ? [skillName] : [canonical, skillName];
    return findFirstExistingPath(names.flatMap(n => [
        join(SKILLS_DIR, n, 'SKILL.md'),
        join(SKILLS_REF_DIR, n, 'SKILL.md'),
        getRepoBundledSkillPath('skills', n, 'SKILL.md'),
        getRepoBundledSkillPath('skills_ref', n, 'SKILL.md'),
    ]));
}

function normalizeSkillDescription(description: unknown): string {
    return String(description || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ');
}

function normalizeSkillMetadataList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    const raw = String(value || '').trim();
    if (!raw) return [];
    const unwrapped = raw.replace(/^\[/, '').replace(/\]$/, '');
    return unwrapped.split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseTopLevelSkillMetadataList(content: string, field: string): string[] {
    const inlineMatch = content.match(new RegExp(`^${field}:[ \\t]*(.+)$`, 'm'));
    if (inlineMatch?.[1]) return normalizeSkillMetadataList(inlineMatch[1]);
    const yamlMatch = content.match(new RegExp(`^${field}:[ \\t]*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, 'm'));
    if (yamlMatch?.[1]) {
        return yamlMatch[1]
            .split('\n')
            .map(line => line.replace(/^\s+-\s*/, '').replace(/^["']|["']$/g, '').trim())
            .filter(Boolean);
    }
    return [];
}

function parseSkillMetadataObject(content: string): Record<string, unknown> {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    const source = frontmatter?.[1] || content;
    const metadataMatch = source.match(/^metadata:\s*\n([\s\S]*)$/m);
    if (!metadataMatch?.[1]) return {};
    let raw = metadataMatch[1];
    const nextTopLevelKey = raw.search(/\n[A-Za-z0-9_-]+:\s*/);
    if (nextTopLevelKey >= 0) raw = raw.slice(0, nextTopLevelKey);
    try {
        const parsed = JSON.parse(raw.trim());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function parseSkillMetadataList(content: string, field: string): string[] {
    const topLevel = parseTopLevelSkillMetadataList(content, field);
    const metadata = parseSkillMetadataObject(content);
    const nested = normalizeSkillMetadataList(metadata[field]);
    return [...new Set([...topLevel, ...nested])];
}

function formatSkillRoutingMetadata(skill: { keywords?: unknown; triggers?: unknown }): string {
    const keywords = normalizeSkillMetadataList(skill.keywords);
    const triggers = normalizeSkillMetadataList(skill.triggers);
    const parts = [];
    if (keywords.length) parts.push(`keywords: ${keywords.join(', ')}`);
    if (triggers.length) parts.push(`triggers: ${triggers.join(', ')}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

function readSkillMetadata(skillName: string, skillPath: string | null): { name: string; description: string; keywords: string[]; triggers: string[]; capabilities: string[]; references: string[] } {
    if (!skillPath || !fs.existsSync(skillPath)) return { name: skillName, description: '', keywords: [], triggers: [], capabilities: [], references: [] };
    try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const nameMatch = content.match(/^name:\s*(.+)/m);
        const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m);
        return {
            name: nameMatch?.[1]?.trim() || skillName,
            description: normalizeSkillDescription(descMatch?.[1]),
            keywords: parseSkillMetadataList(content, 'keywords'),
            triggers: parseSkillMetadataList(content, 'triggers'),
            capabilities: parseSkillMetadataList(content, 'capabilities'),
            references: parseSkillMetadataList(content, 'references'),
        };
    } catch {
        return { name: skillName, description: '', keywords: [], triggers: [], capabilities: [], references: [] };
    }
}

export function formatSkillListItem(skill: { id: string; name?: string; description?: string; keywords?: unknown; triggers?: unknown }): string {
    const name = String(skill.name || skill.id).trim();
    const label = name && name !== skill.id ? `${name} (${skill.id})` : skill.id;
    const description = normalizeSkillDescription(skill.description);
    const routing = formatSkillRoutingMetadata(skill);
    return description ? `- ${label} — ${description}${routing}` : `- ${label}${routing}`;
}

function formatSkillPath(skillName: string, skillPath: string | null): string {
    if (!skillPath) return `${skillName}: unavailable`;
    const meta = readSkillMetadata(skillName, skillPath);
    const label = meta.name && meta.name !== skillName ? `${meta.name} (${skillName})` : skillName;
    return meta.description
        ? `${label}: ${skillPath} — ${meta.description}${formatSkillRoutingMetadata(meta)}`
        : `${label}: ${skillPath}${formatSkillRoutingMetadata(meta)}`;
}

// ─── Legacy A1 Source Hashes ─────────────────────────
// MD5 hashes of source templates (unrendered) for every historical pre-hash version.
// Used to identify known stock files during pre-hash migration.
const KNOWN_A1_SOURCE_HASHES = new Set([
    'b95f7d3d22cb79bd9be5bac577b68a9f', // 9d60b47 initial
    '9bbc1632e610cd3f764028ec6eb2c05d', // 1ea5aa6 heartbeat
    '70ff952b074ad95f6a6f1f40f59bde09', // c359545 memory
    '546d162f31b8a42008f815cbe928a434', // ecc958a sub-agent
    '2e2a3de20b9803bec3c7843ab2859ace', // 4b92441 browser
    'e0e1d2495f2859382b61bf0a816943ad', // 4f5e91a discord
]);

// ─── Migration Helpers ───────────────────────────────

function normalizeRenderedContent(content: string): string {
    // Server-URL replacement must precede the bare CDP-number replacement so
    // that `127.0.0.1:<port>` is captured as a unit before `<cdpPort>` can
    // collide with it when the two values happen to share a substring.
    const serverPort = String(process.env["PORT"] || settings["port"] || DEFAULT_PORT);
    return content
        .replaceAll(JAW_HOME, '{{JAW_HOME}}')
        .replaceAll(`127.0.0.1:${serverPort}`, '127.0.0.1:{{SERVER_PORT}}')
        .replaceAll(String(deriveCdpPort()), '{{CDP_PORT}}');
}

type LegacyA1MigrationAction = 'adopt-current-template' | 'preserve-custom-file';

export function resolveLegacyA1Migration(opts: {
    normalizedFileHash: string;
    currentSourceHash: string;
    knownSourceHashes: Set<string>;
}): LegacyA1MigrationAction {
    if (opts.normalizedFileHash === opts.currentSourceHash) return 'adopt-current-template';
    if (opts.knownSourceHashes.has(opts.normalizedFileHash)) return 'adopt-current-template';
    return 'preserve-custom-file';
}

// ─── Skill Loading ───────────────────────────────────

/** Read all active skills from JAW_HOME/skills/ */
export function loadActiveSkills() {
    try {
        if (!fs.existsSync(SKILLS_DIR)) return [];
        // Alias links share a real path with the skill they point at; counting both
        // would list one skill twice in the prompt (#446).
        return dedupeSkillDirEntries(SKILLS_DIR)
            .map(name => {
                const mdPath = join(SKILLS_DIR, name, 'SKILL.md');
                if (!fs.existsSync(mdPath)) return null;
                const content = fs.readFileSync(mdPath, 'utf8');
                const nameMatch = content.match(/^name:\s*(.+)/m);
                const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m);
                return {
                    id: name,
                    name: nameMatch?.[1]?.trim() || name,
                    description: descMatch?.[1]?.trim() || '',
                    keywords: parseSkillMetadataList(content, 'keywords'),
                    triggers: parseSkillMetadataList(content, 'triggers'),
                    content,
                };
            })
            .filter(Boolean);
    } catch { return []; }
}

registerSkillLoader(() => (loadActiveSkills() || []).filter(Boolean).map(s => ({
    id: s!.id, name: s!.name, description: s!.description, content: s!.content,
})));

/** Read skills_ref registry.json */
export function loadSkillRegistry() {
    try {
        const regPath = join(SKILLS_REF_DIR, 'registry.json');
        if (!fs.existsSync(regPath)) return [];
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        return Object.entries(reg.skills || {}).map(([id, s]: [string, any]) => ({ id, ...s }));
    } catch { return []; }
}

/** Get merged skill list (active + ref) for API */
export function getMergedSkills() {
    const active = loadActiveSkills();
    const activeIds = new Set(active.map(s => s!.id));
    const ref = loadSkillRegistry();
    const merged = [];

    // Active skills (from skills/)
    for (const s of active) {
        const refInfo = ref.find(r => r.id === s!.id);
        merged.push({
            id: s!.id,
            name: refInfo?.name || s!.name,
            name_ko: refInfo?.name_ko || undefined,
            name_en: refInfo?.name_en || undefined,
            emoji: refInfo?.emoji || '🔧',
            category: refInfo?.category || 'installed',
            description: refInfo?.description || s!.description,
            desc_ko: refInfo?.desc_ko || undefined,
            desc_en: refInfo?.desc_en || undefined,
            requires: refInfo?.requires || null,
            install: refInfo?.install || null,
            enabled: true,
            source: activeIds.has(s!.id) && ref.find(r => r.id === s!.id) ? 'both' : 'active',
        });
    }

    // Ref-only skills (not yet activated)
    for (const s of ref) {
        if (!activeIds.has(s.id)) {
            merged.push({
                ...s,
                enabled: false,
                source: 'ref',
            });
        }
    }
    return merged;
}

// ─── Prompt Templates ────────────────────────────────

/** Template variables shared across templates */
function getTemplateVars(): Record<string, string> {
    // DIAGRAM_CAPABILITIES/REFERENCES vars removed (#prompt-cache): the A-1
    // diagram section now defers that detail to the skill's MUST-READ body.
    return {
        JAW_HOME,
        CDP_PORT: String(deriveCdpPort()),
        SERVER_PORT: String(process.env["PORT"] || settings["port"] || DEFAULT_PORT),
    };
}

/** Render A1 system prompt from template */
function getA1Content(): string {
    return loadAndRender('a1-system.md', getTemplateVars());
}

/** A2 default content (no dynamic vars) */
function getA2Default(): string {
    return loadTemplate('a2-default.md');
}

/** Heartbeat default content (no dynamic vars) */
function getHeartbeatDefault(): string {
    return loadTemplate('heartbeat-default.md');
}

// ─── Paths ───────────────────────────────────────────

export const A1_PATH = join(PROMPTS_DIR, 'A-1.md');
export const A2_PATH = join(PROMPTS_DIR, 'A-2.md');
export const HEARTBEAT_PATH = join(PROMPTS_DIR, 'HEARTBEAT.md');

const DESKTOP_CONTROL_ANCHOR_OPEN = '<!-- anchor:desktop-control -->';
const DESKTOP_CONTROL_ANCHOR_CLOSE = '<!-- /anchor:desktop-control -->';
const DASHBOARD_CONNECTOR_ANCHOR_OPEN = '<!-- anchor:dashboard-connector-intent -->';
const DASHBOARD_CONNECTOR_ANCHOR_CLOSE = '<!-- /anchor:dashboard-connector-intent -->';
const SESSION_POLL_ANCHOR_OPEN = '<!-- anchor:session-poll -->';
const SESSION_POLL_ANCHOR_CLOSE = '<!-- /anchor:session-poll -->';
const DESKTOP_CONTROL_INTENT_RE = /(?:\$?computer-use|\bdesktop\b|\bbrowser\b|\bcdp\b|\burl\b|\bui[\s-]*qa\b|브라우저|화면|스크린샷)/iu;
// Proper-noun app names: word-bounded and case-sensitive so that "release notes",
// "keyword", or "search" do not read as Notes / Word / Arc and pull in the 8K block.
// Excel / Word / PowerPoint are deliberately absent: those names almost always
// mean a FILE to produce (the officecli path), not an app to drive.
const DESKTOP_APP_NAME_RE = /\b(?:Finder|System Settings|Chrome|Safari|Microsoft Edge|Firefox|Arc|Spotify|Slack|Discord|Telegram|Calendar|Reminders|Notes)\b/u;
const DESKTOP_SKILL_METADATA_RE = /(?:desktop|browser|computer-use|\bcdp\b|브라우저|화면|스크린샷)/iu;

export function shouldIncludeDesktopControlSection(currentPrompt: string, activeCli?: string | null): boolean {
    const prompt = String(currentPrompt || '').trim();
    const routingText = `${prompt}\n${activeCli || ''}`;
    if (DESKTOP_CONTROL_INTENT_RE.test(routingText) || DESKTOP_APP_NAME_RE.test(routingText)) return true;

    const normalizedPrompt = prompt.toLowerCase();
    try {
        return loadActiveSkills().some(skill => {
            if (!skill) return false;
            const metadata = [
                skill.id,
                skill.name,
                skill.description,
                ...skill.keywords,
                ...skill.triggers,
            ].join(' ');
            if (!DESKTOP_SKILL_METADATA_RE.test(metadata)) return false;
            return [skill.id, skill.name].some(name => {
                const routedName = String(name || '').trim().toLowerCase();
                return routedName.length > 0
                    && (normalizedPrompt.includes(routedName) || normalizedPrompt.includes(`$${routedName}`));
            });
        });
    } catch {
        return false;
    }
}

function omitDesktopControlSection(a1: string): string {
    const topology = findAnchorTopology(a1, DESKTOP_CONTROL_ANCHOR_OPEN, DESKTOP_CONTROL_ANCHOR_CLOSE);
    const block = extractAnchorBlock(a1, DESKTOP_CONTROL_ANCHOR_OPEN, DESKTOP_CONTROL_ANCHOR_CLOSE);
    if (topology.kind !== 'single' || !block) return a1;
    return `${a1.slice(0, topology.start).trimEnd()}\n\n${a1.slice(topology.end).trimStart()}`;
}

function extractAnchorBlock(rendered: string, open: string, close: string): string | null {
    const start = rendered.indexOf(open);
    const end = rendered.indexOf(close);
    if (start === -1 || end === -1 || end <= start) return null;
    return rendered.slice(start, end + close.length);
}

function appendAnchorIfMissing(
    fileContent: string,
    rendered: string,
    open: string,
    close: string,
): string | null {
    if (fileContent.includes(open)) return null;
    const block = extractAnchorBlock(rendered, open, close);
    if (!block) return null;
    const sep = fileContent.endsWith('\n') ? '\n' : '\n\n';
    return fileContent + sep + block + '\n';
}

/**
 * Normalized MD5s of every desktop-control anchor block cli-jaw has shipped.
 * A user file whose block matches one of these was NOT edited inside the
 * markers, so replacing it destroys nothing. Anything else is treated as
 * user-authored and is preserved. Same pattern as KNOWN_A1_SOURCE_HASHES.
 *
 * To add the block you are about to replace, print its hash first: build, then
 * load hashAnchorBlock from the built builder module and hand it the slice of
 * src/prompt/templates/a1-system.md between the two desktop-control anchor
 * markers (inclusive). The test pins the currently-shipped template block so
 * this list cannot silently go stale.
 */
const KNOWN_DESKTOP_CONTROL_ANCHOR_HASHES = new Set<string>([
    // 4ef0bc51 — the macOS-only contract shipped through v2.2.19, replaced by
    // the darwin/win32 split in #308. This is the block installed users have.
    '0a819e06ac3e0b7f5b10eae6bc388eef',
    // v2.4.x — the darwin/win32 block, before active skill ids moved to jaw-*.
    // Without this, an install carrying the current stock block reads as
    // user-edited and keeps pointing at skill paths that no longer exist.
    '9158b57a4c1aeab8f50c347c8500da34',
]);

export function hashAnchorBlock(block: string): string {
    return createHash('md5').update(normalizeRenderedContent(block)).digest('hex');
}

type AnchorTopology =
    | { kind: 'absent' }
    | { kind: 'single'; start: number; end: number }
    | { kind: 'malformed' };

/**
 * The old helpers looked only at the FIRST open and FIRST close marker, so a
 * file with a dangling open, a reversed pair, or two blocks could be neither
 * safely replaced nor safely appended. Count both tokens and demand exactly
 * one correctly-ordered pair before touching anything.
 */
export function findAnchorTopology(content: string, open: string, close: string): AnchorTopology {
    const opens: number[] = [];
    const closes: number[] = [];
    for (let i = content.indexOf(open); i !== -1; i = content.indexOf(open, i + open.length)) opens.push(i);
    for (let i = content.indexOf(close); i !== -1; i = content.indexOf(close, i + close.length)) closes.push(i);
    // The close marker (`<!-- /anchor:x -->`) does not contain the open marker
    // as a substring, so the two counts are independent.
    if (opens.length === 0 && closes.length === 0) return { kind: 'absent' };
    if (opens.length !== 1 || closes.length !== 1) return { kind: 'malformed' };
    const start = opens[0]!;
    const end = closes[0]!;
    if (end <= start) return { kind: 'malformed' };
    return { kind: 'single', start, end: end + close.length };
}

export type AnchorUpsertResult =
    | { action: 'appended'; content: string }
    | { action: 'replaced'; content: string }
    | { action: 'preserved-user-edit' }
    | { action: 'preserved-malformed' }
    | { action: 'unchanged' };

/**
 * Bring a user-edited A-1 up to the current desktop-control contract without
 * ever discarding text the user wrote. Replacement happens only when the
 * existing block is byte-for-byte one we shipped.
 */
export function upsertKnownAnchorBlock(
    fileContent: string,
    rendered: string,
    open: string,
    close: string,
    knownHashes: Set<string>,
): AnchorUpsertResult {
    const block = extractAnchorBlock(rendered, open, close);
    if (!block) return { action: 'unchanged' };
    const topology = findAnchorTopology(fileContent, open, close);
    if (topology.kind === 'malformed') return { action: 'preserved-malformed' };
    if (topology.kind === 'absent') {
        const sep = fileContent.endsWith('\n') ? '\n' : '\n\n';
        return { action: 'appended', content: fileContent + sep + block + '\n' };
    }
    const existing = fileContent.slice(topology.start, topology.end);
    if (existing === block) return { action: 'unchanged' };
    if (!knownHashes.has(hashAnchorBlock(existing))) return { action: 'preserved-user-edit' };
    return {
        action: 'replaced',
        content: fileContent.slice(0, topology.start) + block + fileContent.slice(topology.end),
    };
}

/**
 * Applies the upsert to A-1 text and logs why. Returns updated text, or null
 * when nothing may be written.
 */
function migrateDesktopControlAnchor(fileContent: string, rendered: string): string | null {
    const result = upsertKnownAnchorBlock(
        fileContent,
        rendered,
        DESKTOP_CONTROL_ANCHOR_OPEN,
        DESKTOP_CONTROL_ANCHOR_CLOSE,
        KNOWN_DESKTOP_CONTROL_ANCHOR_HASHES,
    );
    switch (result.action) {
        case 'appended':
            log.info('[prompt] A-1.md: appended desktop-control anchor (user edits preserved)');
            return result.content;
        case 'replaced':
            log.info('[prompt] A-1.md: updated desktop-control anchor to the current contract');
            return result.content;
        case 'preserved-user-edit':
            log.warn('[prompt] A-1.md: desktop-control anchor was edited locally — left as-is. '
                + 'It may predate the current platform contract (e.g. Windows Computer Use).');
            return null;
        case 'preserved-malformed':
            log.warn('[prompt] A-1.md: desktop-control anchor markers are malformed or duplicated — '
                + 'left as-is. Fix the markers to receive contract updates.');
            return null;
        default:
            return null;
    }
}

function ensureDashboardConnectorAnchor(fileContent: string, rendered: string): string | null {
    return appendAnchorIfMissing(
        fileContent,
        rendered,
        DASHBOARD_CONNECTOR_ANCHOR_OPEN,
        DASHBOARD_CONNECTOR_ANCHOR_CLOSE,
    );
}

/**
 * Stock session-poll blocks a correction is allowed to replace.
 *
 * Append-only was not enough. The block states how a turn must call Agent/Bash,
 * and twice the shipped wording contradicted the native runtime: first it said to
 * call them WITHOUT run_in_background while the hook refused anything but `false`;
 * then it demanded `false` after background tasks were disabled at the source and
 * the field no longer existed in the Agent schema. The runtime now refuses only a
 * present, non-false flag and still ends the turn when a task is backgrounded.
 * Every install already carrying that block would have kept it forever, because
 * the anchor was only ever added when missing. Replacement stays limited to
 * blocks this project shipped; anything else is user-authored and preserved.
 */
export const KNOWN_SESSION_POLL_ANCHOR_HASHES = new Set<string>([
    // Shipped through v2.17.53 — "Call Agent/Bash WITHOUT run_in_background",
    // which produced denied Agent calls and turn-killing background Bash.
    'c15c336d5ca8c566e207fb46ceb6f82b',
    // Shipped until the foreground hook accepted an omitted flag — "Omitting the
    // option is NOT the same as foreground", which the model could not satisfy once
    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS removed the field from the Agent schema.
    'b1169a69917f314d92cc8f93e3b65ec9',
]);

function migrateSessionPollAnchor(fileContent: string, rendered: string): string | null {
    const result = upsertKnownAnchorBlock(
        fileContent,
        rendered,
        SESSION_POLL_ANCHOR_OPEN,
        SESSION_POLL_ANCHOR_CLOSE,
        KNOWN_SESSION_POLL_ANCHOR_HASHES,
    );
    switch (result.action) {
        case 'appended':
            log.info('[prompt] A-1.md: appended session-poll anchor (user edits preserved)');
            return result.content;
        case 'replaced':
            log.info('[prompt] A-1.md: updated session-poll anchor to the current contract');
            return result.content;
        case 'preserved-user-edit':
            log.warn('[prompt] A-1.md: session-poll anchor was edited locally — left as-is. '
                + 'It may still tell the model to call Agent/Bash without run_in_background.');
            return null;
        case 'preserved-malformed':
            log.warn('[prompt] A-1.md: session-poll anchor markers are malformed or duplicated — '
                + 'left as-is. Fix the markers to receive contract updates.');
            return null;
        default:
            return null;
    }
}

// ─── Initialize prompt files ─────────────────────────

export function initPromptFiles() {
    const a1Content = getA1Content();
    const hashPath = A1_PATH + '.hash';
    const currentHash = createHash('md5').update(a1Content).digest('hex');

    if (!fs.existsSync(A1_PATH)) {
        // First install
        fs.writeFileSync(A1_PATH, a1Content);
        fs.writeFileSync(hashPath, currentHash);
    } else if (fs.existsSync(hashPath)) {
        const savedHash = fs.readFileSync(hashPath, 'utf8').trim();
        if (savedHash !== currentHash) {
            // Template changed — check if user edited the file
            const fileHash = createHash('md5').update(fs.readFileSync(A1_PATH, 'utf8')).digest('hex');
            if (fileHash === savedHash) {
                // User hasn't edited → safe to update
                fs.writeFileSync(A1_PATH, a1Content);
                fs.writeFileSync(hashPath, currentHash);
                log.info('[prompt] A-1.md updated to new version');
            } else {
                // User edited — preserve their changes, but advance hash baseline.
                // Safe-append new anchor blocks the user hasn't opted in to yet.
                let userText = fs.readFileSync(A1_PATH, 'utf8');
                const appendedDesktop = migrateDesktopControlAnchor(userText, a1Content);
                if (appendedDesktop) {
                    userText = appendedDesktop;
                }
                const appendedConnector = ensureDashboardConnectorAnchor(userText, a1Content);
                if (appendedConnector) {
                    userText = appendedConnector;
                    log.info('[prompt] A-1.md: appended dashboard-connector-intent anchor (user edits preserved)');
                }
                const appendedSessionPoll = migrateSessionPollAnchor(userText, a1Content);
                if (appendedSessionPoll) userText = appendedSessionPoll;
                if (appendedDesktop || appendedConnector || appendedSessionPoll) {
                    fs.writeFileSync(A1_PATH, userText);
                } else {
                    log.info('[prompt] A-1.md has user edits — preserved');
                }
                fs.writeFileSync(hashPath, currentHash);
            }
        }
    } else {
        // Pre-hash migration: distinguish known stock files from customized ones
        const fileContent = fs.readFileSync(A1_PATH, 'utf8');
        const normalizedFileHash = createHash('md5')
            .update(normalizeRenderedContent(fileContent))
            .digest('hex');
        const currentSourceHash = createHash('md5')
            .update(loadTemplate('a1-system.md'))
            .digest('hex');
        const action = resolveLegacyA1Migration({
            normalizedFileHash,
            currentSourceHash,
            knownSourceHashes: KNOWN_A1_SOURCE_HASHES,
        });
        if (action === 'adopt-current-template') {
            fs.writeFileSync(A1_PATH, a1Content);
            fs.writeFileSync(hashPath, currentHash);
            log.info('[prompt] A-1.md migrated from known stock template');
        } else {
            // A customized pre-hash file still deserves the current anchor
            // contract. Without this the install keeps its old desktop-control
            // block forever: the hash is advanced here and the hash-present
            // branch above never revisits an anchor that already exists.
            const migrated = migrateDesktopControlAnchor(fileContent, a1Content);
            if (migrated) fs.writeFileSync(A1_PATH, migrated);
            fs.writeFileSync(hashPath, currentHash);
            log.info('[prompt] A-1.md preserved (customized legacy file)');
        }
    }

    // This versioned supplement is append-only, including customized A1 files whose
    // template hash was already advanced. Startup owns migration; regeneration only renders.
    const persistedA1 = fs.readFileSync(A1_PATH, 'utf8');
    const slackAppend = appendAnchorIfMissing(persistedA1, a1Content,
        '<!-- anchor:slack-typed-tools-v1 -->', '<!-- /anchor:slack-typed-tools-v1 -->');
    if (slackAppend) fs.writeFileSync(A1_PATH, slackAppend);

    if (!fs.existsSync(A2_PATH)) fs.writeFileSync(A2_PATH, getA2Default());
    if (!fs.existsSync(HEARTBEAT_PATH)) fs.writeFileSync(HEARTBEAT_PATH, getHeartbeatDefault());
}

// ─── Memory ──────────────────────────────────────────

export function getMemoryDir() {
    const wd = expandHomePath(settings["workingDir"] || os.homedir(), os.homedir());
    const hash = wd.replace(/[\\/]/g, '-');
    return join(os.homedir(), '.claude', 'projects', hash, 'memory');
}

export function loadRecentMemories() {
    try {
        const CHAR_BUDGET = 10000;
        const memDir = getMemoryDir();
        if (!fs.existsSync(memDir)) return '';
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse();
        const entries = [];
        let charCount = 0;
        for (const f of files) {
            const sections = fs.readFileSync(join(memDir, f), 'utf8').split(/^## /m).filter(Boolean);
            for (const s of sections.reverse()) {
                const entry = s.trim();
                if (charCount + entry.length > CHAR_BUDGET) break;
                entries.push(entry);
                charCount += entry.length;
            }
            if (charCount >= CHAR_BUDGET) break;
        }
        if (entries.length) {
            log.info(`[memory] session memory loaded: ${entries.length} entries, ${charCount} chars`);
        }
        return entries.length
            ? '\n\n---\n## Recent Session Memories\n' + entries.map(e => '- ' + e.split('\n')[0]).join('\n')
            : '';
    } catch { return ''; }
}

// ─── System Prompt Generation ────────────────────────

function appendLegacyMemoryContext(prompt: string) {
    let next = prompt;
    try {
        const threshold = resolveFlushEvery();
        const injectInterval = Math.ceil(threshold / 2);
        // Phase 53-A: Always inject memory in the first 3 turns of a session
        // so short conversations never miss context.
        const shouldInject = memoryFlushCounter < 3 || memoryFlushCounter % injectInterval === 0;
        if (shouldInject) {
            const memories = loadRecentMemories();
            if (memories) {
                next += memories;
                log.info(`[memory] injected (msg ${memoryFlushCounter}, every ${injectInterval})`);
            }
        } else {
            log.info(`[memory] skipped injection (msg ${memoryFlushCounter}/${threshold}, interval ${injectInterval})`);
        }
    } catch {
        const memories = loadRecentMemories();
        if (memories) next += memories;
    }

    try {
        const memPath = join(JAW_HOME, 'memory', 'MEMORY.md');
        if (fs.existsSync(memPath)) {
            const coreMem = fs.readFileSync(memPath, 'utf8').trim();
            if (coreMem && coreMem.length > 50) {
                const truncated = coreMem.length > 1500
                    ? coreMem.slice(0, 1500) + '\n...(use `cli-jaw memory read MEMORY.md` for full)'
                    : coreMem;
                next += '\n\n---\n## Core Memory\n' + truncated;
                log.info(`[memory] MEMORY.md loaded: ${truncated.length} chars`);
            }
        }
    } catch { /* memory not ready */ }

    return next;
}

export function shouldIncludeVisionClickHint(activeCli?: string | null): boolean {
    return activeCli === 'codex';
}

/**
 * The settings an agent must not narrow, because they are how it is reached.
 *
 * An agent asked to set up a heartbeat for one channel narrowed
 * `slack.channelIds` to that channel and cut off every other conversation,
 * including the one it would have needed to be told (#406). Nothing in the
 * prompt said that list was its own inbound surface.
 */
export function getInboundSurfaceContract(): string {
    return [
        '## Inbound Surface (do not narrow it)',
        '- `slack.channelIds` is the allowlist of conversations this instance can HEAR. An empty list means every conversation; a non-empty list means only those.',
        '- Narrowing it silences every conversation outside the list, including the one you are being spoken to in. You cannot undo that from inside Slack.',
        '- Work that targets one channel belongs in that request\'s `target`, never in the allowlist.',
        '- Only change `slack.channelIds` when the user explicitly asks to change which conversations the bot listens to.',
    ].join('\n');
}

/**
 * Where a file has to live to be sendable.
 *
 * The guard's allowed roots come from settings the agent never reads, so a
 * refusal was unactionable: six `path_not_allowed` errors landed in stderr and
 * the turn just stopped producing the file (#404).
 *
 * The resolved absolute path, not `$JAW_HOME`: that variable does not exist in
 * the shell (the code reads `CLI_JAW_HOME`, itself usually unset), so writing it
 * here would expand to `/uploads/` and be refused for a second reason.
 */
export function getSendFileStagingContract(): string {
    return [
        '## Outbound Files',
        `- Files you intend to send to a channel go under ${diskPromptPath(join(JAW_HOME, 'uploads'))}.`,
        '- A path outside the allowed roots is refused with `path_not_allowed`; that response carries `detail.allowedRoots`, which lists the directories that would have worked.',
    ].join('\n');
}

export function getBoundedLocalSearchContract(): string {
    return [
        '## Bounded Local Search Contract',
        '- Native local search tools such as `grep_search`, Grep, Glob, or broad file listing must start from one known file or a narrow task-specific directory.',
        '- Never run local search from `/`, a home directory, the whole runtime directory, dependency trees, caches, logs, backups, generated trees, or database files such as `*.db`.',
        '- If a shell search is needed, prefer a bounded form such as `timeout 20s rg --glob \'!*.db\' --glob \'!*.log\' <query> <narrow-path>` and cap output.',
        '- If a search times out, do not widen the search. Mark the item unresolved, ask for a narrower path when needed, or stop with a partial result.',
        '- Use exact file checks (`test -e`, `test -s`, or a direct file read) when checking a known path; do not discover known files through repository-wide search.',
    ].join('\n');
}

function promptIdentityValue(value: unknown, fallback: string): string {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    return (normalized || fallback).slice(0, 120);
}

function resolveDiskWorkingDir(): string {
    return expandHomePath(settings["workingDir"] || JAW_HOME, os.homedir());
}

function diskPromptPath(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``;
}

function renderA2ForDisk(a2: string, workingDir: string): string {
    return a2.replace(
        /(## Working Directory\r?\n)- ~\/\.cli-jaw(?=\r?\n|$)/,
        (_match, heading: string) => `${heading}- ${diskPromptPath(workingDir)}`,
    );
}

function loadDiskSoul(): string {
    try {
        if (!hasSoulFile()) return '';
        const soul = loadSoulSummary(SOUL_DISK_BUDGET);
        if (!soul) {
            log.warn('[memory] disk soul exists but has no injectable content');
            return '';
        }
        if (soul.endsWith('\n...(truncated)')) {
            log.warn(`[memory] disk soul truncated to ${SOUL_DISK_BUDGET} chars`);
        } else {
            log.info(`[memory] disk soul loaded: ${soul.length} chars`);
        }
        return soul;
    } catch (error) {
        log.warn('[memory] disk soul load failed:', (error as Error).message);
        return '';
    }
}

function getCurrentSessionIdentityLine(): string {
    const sessionId = currentSessionScope()?.chatSessionId ?? getActiveChatSession();
    const session = listChatSessions().find(row => row.id === sessionId);
    const id = promptIdentityValue(sessionId, 'default');
    const label = promptIdentityValue(session?.label, 'unlabeled');
    const source = promptIdentityValue(session?.source, 'local');
    return `Session identity: id=${id}; label=${label}; source=${source}`;
}

export function getSystemPrompt(opts: { currentPrompt?: string; forDisk?: boolean; memorySnapshot?: string; activeCli?: string; freshSession?: boolean } = {}) {
    const forDisk = opts.forDisk === true;
    const diskWorkingDir = forDisk ? resolveDiskWorkingDir() : '';
    const currentPrompt = String(opts.currentPrompt || '').trim();
    // A-1: file takes priority (user-editable), rendered template fallback.
    // Runtime prompts drop desktop-control unless the current turn routes there;
    // persisted A-1.md and forDisk B.md/AGENTS.md remain complete.
    const persistedA1 = fs.existsSync(A1_PATH) ? fs.readFileSync(A1_PATH, 'utf8') : getA1Content();
    const a1 = forDisk || shouldIncludeDesktopControlSection(currentPrompt, opts.activeCli)
        ? persistedA1
        : omitDesktopControlSection(persistedA1);
    const rawA2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    const a2 = forDisk ? renderA2ForDisk(rawA2, diskWorkingDir) : rawA2;
    let prompt = `${a1}\n\n${a2}`;
    // Project root is now injected per-message in spawn.ts (user prompt wrapper)

    // Phase 15: Telegram guidance is now part of A1_CONTENT (hardcoded)
    // No dynamic injection needed — Bot-First policy with curl examples included

    if (!forDisk) {
        const injected = buildMemoryInjection(stripUndefined({
            role: 'boss',
            currentPrompt,
            providedSnapshot: opts.memorySnapshot,
        }));
        if (injected.mode === 'advanced') {
            prompt += '\n\n' + injected.text;
        } else {
            prompt = appendLegacyMemoryContext(prompt);
            prompt += '\n\n---\n## Memory Status\n';
            prompt += '- indexed memory is still initializing\n';
            prompt += '- temporary fallback memory context is active\n';
        }
        if (settings["multiSession"]?.enabled === true) {
            prompt += `\n\n---\n${getCurrentSessionIdentityLine()}`;
        }
    } else {
        // Phase 54-B: forDisk (AGENTS.md) — include a minimal memory block
        // so Codex/OpenCode sessions have soul, profile, and snapshot context.
        prompt = appendLegacyMemoryContext(prompt);
        prompt += '\n\n---\n## Resolved Instance Context\n';
        prompt += `- JAW_HOME: ${diskPromptPath(JAW_HOME)}\n`;
        prompt += `- Working directory: ${diskPromptPath(diskWorkingDir)}\n`;
        prompt += '- These resolved instance paths override placeholder paths in older/custom prompt files.\n';
        const soul = loadDiskSoul();
        try {
            const profile = loadProfileSummary(600);
            const snapshot = buildTaskSnapshot('current session context', 1500);
            if (soul || profile || snapshot) {
                prompt += '\n\n---\n## Disk Memory Context\n';
                if (soul) prompt += `\n## Soul & Identity\n${soul}\n`;
                if (profile) prompt += `\n## Profile Context\n${profile}\n`;
                if (snapshot) prompt += '\n' + snapshot;
            }
        } catch (error) {
            log.warn('[memory] disk profile/snapshot load failed:', (error as Error).message);
            if (soul) prompt += `\n\n---\n## Disk Memory Context\n\n## Soul & Identity\n${soul}\n`;
        }

        // #299: the toolchain record written at startup. Deliberately not
        // routed through the profile summary, which truncates at 600 chars and
        // would cut the very paths this section exists to publish.
        try {
            const toolchain = renderHostToolchainSection(readHostToolchain());
            if (toolchain) prompt += `\n\n---\n${toolchain}\n`;
        } catch (error) {
            log.warn('[toolchain] disk section skipped:', (error as Error).message);
        }
    }

    try {
        const emps = getEmployees.all();
        if (emps.length > 0) {
            const list = emps.map(e => {
                const r = e as { name: string; cli: string; role?: string };
                return `- "${r.name}" (CLI: ${r.cli}) — ${r.role || 'general developer'}`;
            }).join('\n');
            const example = (emps[0] as { name: string }).name;
            const vars = getTemplateVars();
            vars["EMPLOYEE_LIST"] = list;
            vars["EXAMPLE_AGENT"] = example;
            prompt += '\n\n---\n';
            prompt += renderTemplate(loadTemplate('orchestration.md'), vars);

            // PABCD orchestration: command summary stays inline; the full skill
            // body is a MUST-READ path contract (#prompt-cache — was 9.4KB inline).
            const pabcdPath = join(SKILLS_DIR, 'jaw-dev-pabcd', 'SKILL.md');
            if (fs.existsSync(pabcdPath)) {
                prompt += `\n\n## PABCD Orchestration Guide
PABCD is the structured 5-phase development workflow: I(Interview) → P(Plan) → A(Plan Audit) → B(Build) → C(Check) → D(Done). Large/"loop" work runs as MULTIPLE passes — one full P→A→B→C→D per work-phase (a work-phase is an outcome slice, not a PABCD letter).
- Transitions are shell commands only: \`cli-jaw orchestrate I|P|A|B|C|D\` (forward-only; \`I\` reachable from any state, context preserved; \`reset\` → IDLE).
- Forward transitions (P→A→B→C→D) require an EVIDENCE attestation, not narration ("현재는 B입니다" does nothing): \`cli-jaw orchestrate B --attest '{"from":"A","to":"B","did":"<what you did>"}'\` (C→D also needs \`checkOutput\`+\`exitCode\`). The state machine only moves on the command.
- Gates: P/A/B end with ⛔ STOP — present results and WAIT for user approval before advancing (goal mode self-advances). In goal mode, after D the agent re-enters P (D→IDLE→P) for the next work-phase until the objective is met; do each phase's real work, never rubber-stamp to advance.
- A audits the PLAN via a read-only employee dispatch; B: YOU write all code, employees verify (\`--mutable\` is the only write exception); C runs mechanical checks (tsc/tests) — when the work-phase produces a render artifact (HTML/SVG/UI/chart), C also requires a render-grounding loop (run, observe, fix) before C→D (C-RENDER-GROUNDING-01) — then D summarizes.
- Plan docs use decade numbering (LEXICO-SPLIT-01). Loop/multi-pass tasks WRITE all per-phase docs to diff-level up front (DIFFLEVEL-ROADMAP-01) and may open with a design-only PABCD pass.
- Use the explicit worklog or project-approved planning location; keep private records external when required. Never invent a log directory.
⛔ BEFORE running any PABCD phase, you MUST read the full workflow guide once per session: ${pabcdPath}
It defines phase contracts, dispatch pitfalls (delegation trap, context drift, phase skip), worklog/plan injection rules, and repository-root contracts that are NOT repeated here.`;
            }
        }
    } catch { /* DB not ready yet */ }

    // Boss Dev Work Classification contract (92_runtime_skill_routing_plan).
    // Compact, unconditional — renders identically with or without employees.
    prompt += '\n\n---\n## Dev Work Classification (contract)\n';
    prompt += 'Before coding, classify work C0-C5 (C0 trivial text, C1 single-file local, C2 ordinary product slice — endpoint/form/screen, C3 cross-domain — multiple modules/public API, C4 high-risk — auth/payments/security/data deletion/migration/release/permissions, C5 research/ambiguous). When signals match two classes, the higher class wins.\n';
    prompt += 'Use direct mode for C0-C1, a compact plan for C2, compact/full PABCD for C3 when persistence, public contract, or architecture risk requires it, full PABCD for C4, research/interview for C5.\n';
    prompt += 'Dispatch employees only for independent specialist work, plan/build verification, or high-risk review. Optional dispatch `task_tags` (e.g. tdd, threat_model, migration_backfill, frontend_ui) add specialist guidance without changing the employee role.\n';
    prompt += 'C4-promotion triggers (DEV-ESCALATE-01: security, data deletion/migration, destructive ops, public contract change, release surface, permission model, new dependency/framework) override any fast path and promote the affected part to C4-level care. Ask the user before destructive actions, new dependency/framework, public API/schema change, irreversible migration, permission model change, or unresolved business ambiguity.\n';
    prompt += 'Verify with the narrowest command that proves the claim; run affected-suite gates for C3 and full relevant gates for C4 or release-sensitive work.\n';

    try {
        const hbData = loadHeartbeatFile();
        if (hbData.jobs.length > 0) {
            const activeJobs = hbData.jobs.filter((j) => j.enabled);
            const jobList = hbData.jobs.map((job) => {
                const status = job.enabled ? '✅' : '⏸️';
                const schedule = normalizeHeartbeatSchedule(job.schedule);
                return `- ${status} "${job.name}" — ${describeHeartbeatSchedule(schedule)}: ${(job.prompt || '').slice(0, 50)}`;
            }).join('\n');
            const vars = getTemplateVars();
            vars["JOB_LIST"] = jobList;
            vars["ACTIVE_COUNT"] = String(activeJobs.length);
            vars["TOTAL_COUNT"] = String(hbData.jobs.length);
            prompt += '\n\n---\n' + renderTemplate(loadTemplate('heartbeat-jobs.md'), vars);
        }
    } catch (error) {
        prompt += '\n\n---\n## Heartbeat Jobs\n';
        prompt += `Heartbeat file failed to load: ${(error as Error).message}\n`;
    }

    try {
        const activeSkills = loadActiveSkills();
        const refSkills = loadSkillRegistry();
        const activeIds = new Set(activeSkills.map(s => s!.id));
        const availableRef = refSkills.filter(s => !activeIds.has(s.id));

        if (activeSkills.length > 0 || availableRef.length > 0) {
            prompt += '\n\n---\n## Skills System\n';

            const vars = getTemplateVars();
            vars["ACTIVE_SKILLS_COUNT"] = String(activeSkills.length);
            vars["ACTIVE_SKILLS_LIST"] = activeSkills.map(s => formatSkillListItem({
                id: s!.id,
                name: s!.name,
                description: s!.description,
                keywords: s!.keywords,
                triggers: s!.triggers,
            })).join('\n');
            vars["REF_SKILLS_COUNT"] = String(availableRef.length);

            // Only render sections that have content
            if (activeSkills.length > 0 && availableRef.length > 0) {
                prompt += renderTemplate(loadTemplate('skills.md'), vars);
            } else if (activeSkills.length > 0) {
                // Only active skills — render just that portion
                const tmpl = loadTemplate('skills.md');
                const activeSection = tmpl.split('### Available Skills')[0];
                const discoverySection = tmpl.split('### Skill Discovery')[1];
                prompt += renderTemplate(activeSection + '### Skill Discovery' + (discoverySection || ''), vars);
            } else {
                // Only ref skills
                const tmpl = loadTemplate('skills.md');
                const matchingSection = tmpl.split('### Active Skills')[0];
                const refSection = tmpl.substring(tmpl.indexOf('### Available Skills'));
                prompt += renderTemplate(matchingSection + refSection, vars);
            }
        }
    } catch { /* skills not ready */ }

    // ─── Vision-Click Hint (Codex only) ──────────────
    try {
        const activeCli = opts.activeCli || settings["cli"];
        if (shouldIncludeVisionClickHint(activeCli)) {
            const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
            if (fs.existsSync(visionSkillPath)) {
                prompt += '\n' + loadTemplate('vision-click.md');
            }
        }
    } catch { /* vision-click not ready */ }

    // ─── Runtime context (short-lived user intent notes) ───
    if (!forDisk) {
        try {
            const block = buildRuntimeContextBlock();
            if (block) prompt += '\n\n---\n' + block;
        } catch { /* runtime-context not ready */ }

        try {
            const hook = buildPrePromptContextHook(stripUndefined({
                currentPrompt: opts.currentPrompt,
                activeCli: opts.activeCli,
                freshSession: opts.freshSession,
            }));
            if (hook.block) prompt += '\n\n---\n' + hook.block;
        } catch { /* pre-prompt hooks are fail-open */ }

        // The wiki digest is read only when a fresh session is being built, not on every
        // turn or resume: it is a synchronous filesystem read on the prompt path, and a
        // resumed conversation already carries whatever digest it started with.
        if (opts.freshSession === true) {
            try {
                const digest = buildDigestPromptBlock();
                if (digest) prompt += '\n\n' + digest;
            } catch { /* a broken vault must never take the prompt down */ }
        }
    }

    prompt += '\n\n---\n' + getBoundedLocalSearchContract();
    prompt += '\n\n' + getInboundSurfaceContract();
    prompt += '\n\n' + getSendFileStagingContract();

    // ─── Delegation rules: jaw employees vs CLI sub-agents ───
    // Always-injected guard block (survives user-edited A-1.md overrides).
    // Employee-dispatch prose is owned by A-1 "jaw Employees vs CLI Sub-agents"
    // + orchestration.md; only the prohibition + dispatch one-liner stay here.
    prompt += '\n\n---\n## Delegation Rules\n';
    prompt += '### CLI Sub-agents (Task/Agent tool)\n';
    prompt += 'You CAN use your CLI\'s Task/Agent tools for internal subtasks: research, parallel file reads, code analysis.\n';
    prompt += 'Subagents you spawn must NOT spawn further subagents (1-level only).\n';
    prompt += 'When spawning a subagent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."\n';
    prompt += '\n### jaw Employee Dispatch\n';
    prompt += 'Write the task brief to a FRESH unique file per dispatch with your file tool, then `cli-jaw dispatch --agent "Name" --task-file <path> --async` — prints a runId and returns immediately. A completion notice carrying the FULL result (up to ~8k chars) re-enters your context when you are idle; if it says "clipped", read the rest via `cli-jaw worker read <runId> --tail 120`. Parallel fan-out: `--batch --agents-file <path> --async`. Omitting `--async` blocks the turn up to 10 minutes while polling — acceptable only for a quick (<2 min) read-only verify.\n';
    prompt += 'CLI Task tool ≠ jaw employee dispatch — simple research → CLI sub-agents, never employees (full rules: "jaw Employees vs CLI Sub-agents" section).\n';

    return prompt;
}

// ─── Employee Prompt (orchestration-free) ────────────

type EmployeeExecutionPolicy = {
    mutable?: boolean;
    scope?: string | null;
    fullAccess?: boolean;
    allowDispatch?: boolean;
    noDescendants?: boolean;
    permissions?: string | string[];
};

export function getEmployeePrompt(emp: { name: string; role?: string; id?: string | number }, policy: EmployeeExecutionPolicy = {}) {
    const vars: Record<string, string> = {
        EMP_NAME: emp.name,
        EMP_ROLE: emp.role || 'general developer',
        ACTIVE_SKILLS_SECTION: '',
    };

    // Active Skills (dynamic loading)
    try {
        const activeSkills = loadActiveSkills();
        if (activeSkills.length > 0) {
            let section = `\n## Active Skills (${activeSkills.length})\n`;
            section += `Installed skills — automatically triggered by the CLI. Use each description to decide whether to read its SKILL.md.\n`;
            section += `Read active skills from ${SKILLS_DIR}/<skill-id>/SKILL.md.\n`;
            section += `Match by intent, not exact words: compare the request, files, domain nouns, output, and task verbs against visible skill names, descriptions, and any listed metadata, keywords, or triggers.\n`;
            section += `When uncertain, inspect the best candidate: if metadata suggests a plausible match, read that SKILL.md once before deciding it does not apply.\n`;
            section += `Search intent override: for "검색", "검색해", "찾아봐", "알아봐", "look up", or "search" targeting external/current/docs/library information, inspect the active search skill before local Grep/Glob.\n`;
            for (const s of activeSkills) {
                section += `${formatSkillListItem({
                    id: s!.id,
                    name: s!.name,
                    description: s!.description,
                    keywords: s!.keywords,
                    triggers: s!.triggers,
                })}\n`;
            }
            vars["ACTIVE_SKILLS_SECTION"] = section;
        }
    } catch { /* skills not ready */ }

    // Change stock policy before inserting role/skill text, so supplied task text
    // cannot accidentally match a stock-rule replacement.
    let template = loadTemplate('employee.md');
    if (policy.mutable) {
        vars['EMP_WRITE_POLICY'] = `- ✅ You are authorized to create or modify files${policy.scope ? ` inside \`${policy.scope}\`` : ''}.${policy.fullAccess
            ? ' Respect the explicit task scope and instructions.' : ' Protected paths (.git, .env, settings.json) remain blocked.'}`;
        template = template.replace(
            '- File writes are blocked unless the Boss explicitly grants `--mutable`.',
            '{{EMP_WRITE_POLICY}}',
        );
    }
    const dispatchAllowed = policy.fullAccess === true && policy.allowDispatch === true && policy.noDescendants !== true;
    const noDescendants = policy.noDescendants === true || (policy.fullAccess === true && !dispatchAllowed);
    if (policy.fullAccess) {
        if (!policy.mutable) template = template.replace(
            '- File writes are blocked unless the Boss explicitly grants `--mutable`.',
            '- File writes are blocked by this assignment\'s read-only scope.',
        );
        template = template.replace(
            '- You are an executor, not a planner. Do NOT run `cli-jaw dispatch`, call dispatch APIs, or output subtask JSON.',
            '- Execute this assignment and use permitted tools. Do not output subtask JSON or claim human approval.',
        ).replace(
            '- You were dispatched by jaw\'s orchestrator (the Boss). Complete your assigned task and report results.',
            '- You were admitted as a Jaw worker for this assignment. Complete it and report results.',
        ).replace(/^- You must NEVER re-dispatch jaw employees\..*$/m,
            dispatchAllowed ? '- Jaw dispatch is available for this assignment; the server rechecks every request.'
                : '- This assignment does not authorize descendants or delegation.');
        if (dispatchAllowed) template = template.replace(/^- If your task is too large,.*$/m,
            '- Pass explicit task scope and constraints to any delegated work; retain the returned run IDs.');
        const providerMode = policy.permissions === 'auto' || policy.permissions === 'safe'
            ? policy.permissions : policy.permissions === undefined ? 'configured' : 'custom';
        template += `\n\n## Jaw API Access\n- This Auto instance permits qualified direct local Jaw tool requests without copying a grant or operator credential. The server rechecks new requests.\n- Provider approval mode: ${providerMode}. Provider policy and task restrictions remain separate from API access.\n- Use explicit destinations for channel sends; do not substitute the last-active conversation.\n`;
    }
    if (noDescendants) {
        template = template.replace(/^- You CAN use your CLI's sub-agent features.*$/m,
            '- Do not create child agents, use Task/Agent tools, or dispatch more workers for this assignment.');
    }
    return renderTemplate(template, vars);
}

// ─── Employee Prompt v2 (orchestration phase-aware) ──

// Task-tag → skill routing (92_runtime_skill_routing_plan). Tags are normalized
// task_tags from dispatch; they add skill pointers without changing the execution role.
const TASK_TAG_SKILL_MAP: Record<string, string[]> = {
    frontend_ui: ['jaw-dev-uiux-design'],
    testing: ['jaw-dev-testing'],
    tdd: ['jaw-dev-testing'],
    bdd_acceptance: ['jaw-dev-testing', 'jaw-dev'],
    security: ['jaw-dev-security'],
    threat_model: ['jaw-dev-security'],
    architecture: ['jaw-dev-architecture', 'jaw-dev-backend'],
    ddd: ['jaw-dev-architecture', 'jaw-dev-backend'],
    clean_arch: ['jaw-dev-architecture', 'jaw-dev-backend'],
    hexagonal: ['jaw-dev-architecture', 'jaw-dev-backend'],
    vertical_slice: ['jaw-dev-architecture', 'jaw-dev-backend', 'jaw-dev-frontend', 'jaw-dev-testing'],
    adr_rfc: ['jaw-dev-architecture', 'jaw-dev-scaffolding'],
    review: ['jaw-dev-code-reviewer'],
    code_review: ['jaw-dev-code-reviewer'],
    debugging: ['jaw-dev-debugging'],
    debugging_rca: ['jaw-dev-debugging'],
    observability: ['jaw-dev-backend'],
    observability_pipeline: ['jaw-dev-backend', 'jaw-dev-data'],
    migration_backfill: ['jaw-dev-data', 'jaw-dev-backend', 'jaw-dev-testing'],
    product_discovery: ['jaw-dev'],
    product_discovery_ui: ['jaw-dev', 'jaw-dev-uiux-design'],
    release_cd: ['jaw-dev-testing', 'jaw-dev-backend', 'jaw-dev-scaffolding'],
    crud_fullstack: ['jaw-dev-backend', 'jaw-dev-frontend', 'jaw-dev-testing'],
};

export function normalizeTaskTags(raw: unknown): string[] {
    // Bare string is coerced to a single tag (dev §0.3); separators that would
    // collide with the comma-joined cache key are normalized to underscores.
    const arr = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(arr)) return [];
    return [...new Set(
        arr.filter((t): t is string => typeof t === 'string')
            .map(t => t.trim().toLowerCase().replace(/[\s,:;-]+/g, '_'))
            .filter(Boolean),
    )].sort();
}

export function getEmployeePromptV2(
    emp: { name: string; role?: string; id?: string | number; cli?: string },
    role: string,
    currentPhase: number | string,
    opts?: EmployeeExecutionPolicy & { taskTags?: string[] },
) {
    const phase = Number(currentPhase);
    const taskTags = normalizeTaskTags(opts?.taskTags);
    const mcpSummary = getEmployeeMcpToolSummary();
    const mcpHash = mcpSummary ? createHash('md5').update(mcpSummary).digest('hex').slice(0, 8) : '';
    const policyKey = JSON.stringify([opts?.fullAccess === true, opts?.allowDispatch === true, opts?.noDescendants === true, opts?.permissions ?? null]);
    const cacheKey = `${emp.id || emp.name}:${emp.cli || ''}:${role}:${phase}:${settings["workingDir"] || '~'}:${opts?.mutable ? 'mut' : 'ro'}:${opts?.scope || ''}:${taskTags.join(',')}:${mcpHash}:${policyKey}`;
    if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

    let prompt = getEmployeePrompt(emp, opts);

    // Static-employee system prompt patch (Control etc.) injected near the top
    // so role-specific guidance downstream can still override style/tone.
    const staticSpec = findStaticEmployee(emp?.name || '');
    if (staticSpec?.systemPromptPatchFile) {
        try {
            const patch = loadTemplate(staticSpec.systemPromptPatchFile);
            if (patch) prompt += `\n\n${patch}`;
        } catch (e) {
            log.warn(`[prompt] ${staticSpec.name} system patch load failed:`, (e as Error).message);
        }
    }

    // Skill bodies are intentionally not inlined. Each employee receives a
    // compact path contract and reads only the guide needed for the task.
    const devCommonPath = findSkillPath('jaw-dev');
    const scaffoldingPath = findSkillPath('jaw-dev-scaffolding');

    const ROLE_SKILL_NAME_MAP = {
        frontend: 'jaw-dev-frontend',
        backend: 'jaw-dev-backend',
        data: 'jaw-dev-data',
        docs: 'jaw-dev-scaffolding',
        custom: null,
    };

    const roleSkillName = (ROLE_SKILL_NAME_MAP as Record<string, string | null>)[role] ?? null;
    const roleSkillPath = roleSkillName ? findSkillPath(roleSkillName) : null;
    const pabcdPath = findSkillPath('jaw-dev-pabcd');
    const reviewerPath = findSkillPath('jaw-dev-code-reviewer');
    const testingPath = findSkillPath('jaw-dev-testing');

    prompt += `\n\n## Skill Loading Contract`;
    prompt += `\nSkill bodies are not preloaded. Read each guide once, only when the task requires it.`;
    prompt += `\n- Match by intent, not exact words: compare the task, files, domain nouns, output, and task verbs against visible skill names, descriptions, and any listed metadata, keywords, or triggers.`;
    prompt += `\n- When uncertain, inspect the best candidate: if metadata suggests a plausible match, read that SKILL.md once before deciding it does not apply.`;
    prompt += `\n- Search intent override: for "검색", "검색해", "찾아봐", "알아봐", "look up", or "search" targeting external/current/docs/library information, inspect the active search skill before local Grep/Glob.`;
    if (emp.cli === 'agy') {
        prompt += `\n\n## AGY Search Grounding Rules`;
        prompt += `\nAGY/Gemini search summaries are orientation only, not final evidence.`;
        prompt += `\n- For Korean external/current/source-sensitive search tasks, rewrite the request into 1-3 focused Korean keyword queries that preserve source hints, dates, domains, and content type.`;
        prompt += `\n- Treat search_web output as URL candidates only. Do not claim original-source verification from a search summary.`;
        prompt += `\n- If the request asks for 원문, 특정 후기, 정확한 문구, 표/목록/순위, 실시간 상태, 현재 수치, 공식 공고, or source-of-truth verification, fetch/open the original candidate URL when tools allow it.`;
        prompt += `\n- If fetch/open/browser tools are unavailable or not used, explicitly say the answer is not original-source verified.`;
        prompt += `\n- For Naver Blog/Cafe, iframe shells, JS-rendered pages, official dashboards, live standings, tables, pagination, or login-gated surfaces, state that browser/browse verification is required instead of saying the snippet is enough.`;
        prompt += `\n- In final search notes, label evidence state as VERIFIED_BY_ORIGINAL_SOURCE, CANDIDATE_ONLY_NEEDS_FETCH, or NEEDS_BROWSER_VERIFICATION.`;
    }
    prompt += `\n- Common dev guide: ${formatSkillPath('dev', devCommonPath)}`;
    prompt += `\n- Scaffolding guide: ${formatSkillPath('dev-scaffolding', scaffoldingPath)} (read only for new projects, new modules, or structure audits)`;
    if (staticSpec?.skills?.length) {
        prompt += `\n- Static employee skills:`;
        for (const skillName of staticSpec.skills) {
            prompt += `\n  - ${formatSkillPath(skillName, findSkillPath(skillName))}`;
        }
    }

    prompt += `\n\n## Role Contract`;
    prompt += `\n- Role: ${role}`;
    prompt += `\n- Role guide: ${roleSkillName ? formatSkillPath(roleSkillName, roleSkillPath) : 'none'}`;
    prompt += `\n- Apply this role on every assigned task. Before role-specific implementation or review, read the role guide once if it is available.`;
    prompt += `\n- Also read the common dev guide before modifying code.`;

    // Task-tag overlays: extra skill pointers, de-duplicated against the role
    // skill and the always-present common guides. Tags never change the role.
    if (taskTags.length > 0) {
        const baseSkills = new Set(['dev', 'dev-scaffolding', roleSkillName].filter(Boolean) as string[]);
        const tagSkills: string[] = [];
        const unknownTags: string[] = [];
        for (const tag of taskTags) {
            const mapped = TASK_TAG_SKILL_MAP[tag];
            if (!mapped) { unknownTags.push(tag); continue; }
            for (const skillName of mapped) {
                if (!baseSkills.has(skillName) && !tagSkills.includes(skillName)) tagSkills.push(skillName);
            }
        }
        {
            // Render whenever tags exist — even if every mapped skill deduped
            // against base skills (e.g. product_discovery → dev), so the tag
            // stays visible to the employee.
            prompt += `\n\n## Task Tag Guides`;
            prompt += `\n- Task tags for this dispatch: ${taskTags.join(', ')}. Tags add guidance; your execution role stays "${role}".`;
            for (const skillName of tagSkills) {
                prompt += `\n- ${formatSkillPath(skillName, findSkillPath(skillName))} (read once before work the tag covers)`;
            }
            if (unknownTags.length > 0) {
                prompt += `\n- Unrecognized tags (no extra guide): ${unknownTags.join(', ')}`;
            }
        }
    }

    prompt += `\n\n## Phase Guide`;
    prompt += `\n- Use the phase context below as the source of truth for what this employee should do now.`;
    prompt += `\n- Full PABCD guide: ${formatSkillPath('dev-pabcd', pabcdPath)} (read only if phase rules are unclear).`;
    if (phase === 2) {
        prompt += `\n- Phase 2 audit: read ${formatSkillPath('dev-code-reviewer', reviewerPath)} before reviewing plans or code.`;
    } else if (phase === 4) {
        prompt += `\n- Phase 4 check: read ${formatSkillPath('dev-testing', testingPath)} before designing or running verification.`;
    }

    // ─── 4. Employee context (PABCD-aware)
    const workerContexts = parseWorkerContexts();
    const ctx = workerContexts[phase] || workerContexts[3];
    prompt += `\n\n## Employee Role\n${ctx}`;
    prompt += `\n\n## Execution Rules`;
    prompt += `\n- Read the explicit worklog, when provided, to understand context; do not invent its location`;
    prompt += `\n- Do not touch files outside your assigned scope`;
    prompt += `\n- Focus only on your assigned area`;
    prompt += `\n- Report results clearly with specific file paths and line numbers`;
    prompt += `\n- Your process cwd may be an isolated temporary directory. Do NOT treat process.cwd() as the repository root.`;
    prompt += `\n- Use the task's ## Workspace Context block as the source of truth for Project root and the explicit Worklog path; follow project policy for all planning and evidence locations.`;
    prompt += `\n- Resolve relative repository paths against Project root, and always use absolute paths in commands and reports.`;

    prompt += `\n\n${getBoundedLocalSearchContract()}`;

    prompt += `\n\n## Delegation Rules`;
    prompt += `\n- Execute the assigned task directly in this employee session.`;
    if (opts?.fullAccess && opts.allowDispatch && !opts.noDescendants) {
        prompt += `\n- You may use Jaw dispatch and available native delegation tools within this assignment's scope. Pass explicit read-only and descendant constraints to children.`;
    } else if (opts?.noDescendants || opts?.fullAccess) {
        prompt += `\n- This assignment forbids child agents, native Task/Agent tools, and further Jaw dispatch.`;
    } else {
        prompt += `\n- You CAN use CLI sub-agents (Task/Agent tool) for parallel work: research, file reads, code analysis. This is encouraged.`;
        prompt += `\nWhen spawning a sub-agent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."`;
        prompt += `\n- ⛔ Do NOT run \`cli-jaw dispatch\` or any equivalent delegation command from this session.`;
    }
    prompt += `\n- ⛔ Do NOT output jaw dispatch JSON or subtask JSON.`;
    prompt += `\n- ⛔ Do NOT describe Boss/employee orchestration structure in your answer.`;

    if (mcpSummary) {
        prompt += `\n\n${mcpSummary}`;
    }

    promptCache.set(cacheKey, prompt);
    return prompt;
}

export function clearPromptCache() { promptCache.clear(); }

let _lastPromptHash = '';

function generatedPromptPaths() {
    // Match the established writer semantics; private apply policy belongs to its caller.
    const workingDir = settings["workingDir"] || os.homedir();
    return { bPath: join(PROMPTS_DIR, 'B.md'), agentsPath: join(workingDir, 'AGENTS.md'), workingDir };
}

type GeneratedFileState = 'matched' | 'mismatched' | 'missing' | 'unreadable';
export type GeneratedPromptProof = {
    version: 1; expectedSha256: string | null; expectedBytes: number | null;
    bMatches: boolean | null; agentsMatches: boolean | null;
    bState: GeneratedFileState; agentsState: GeneratedFileState;
    error?: 'generation_failed';
};
function compareGeneratedFile(path: string, expected: Buffer): { matches: boolean | null; state: GeneratedFileState } {
    let fd: number | undefined;
    try {
        const stat = fs.statSync(path);
        if (!stat.isFile()) return { matches: null, state: 'unreadable' };
        if (stat.size !== expected.length) return { matches: false, state: 'mismatched' };
        fd = fs.openSync(path, 'r');
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) return { matches: null, state: 'unreadable' };
        if (opened.size !== expected.length) return { matches: false, state: 'mismatched' };
        // Bounded even if the file grows between stat and read.
        const actual = Buffer.alloc(expected.length + 1);
        let offset = 0;
        while (offset < actual.length) {
            const count = fs.readSync(fd, actual, offset, actual.length - offset, offset);
            if (!count) break;
            offset += count;
        }
        const matches = offset === expected.length && actual.subarray(0, offset).equals(expected);
        return { matches, state: matches ? 'matched' : 'mismatched' };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { matches: false, state: 'missing' };
        return { matches: null, state: 'unreadable' };
    } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* No raw path/error leaves this proof. */ } } }
}
export function getGeneratedPromptProof(): GeneratedPromptProof {
    try {
        const expected = Buffer.from(getSystemPrompt({ forDisk: true }), 'utf8');
        const paths = generatedPromptPaths();
        const b = compareGeneratedFile(paths.bPath, expected);
        const agents = compareGeneratedFile(paths.agentsPath, expected);
        return { version: 1, expectedSha256: createHash('sha256').update(expected).digest('hex'), expectedBytes: expected.length,
            bMatches: b.matches, agentsMatches: agents.matches, bState: b.state, agentsState: agents.state };
    } catch {
        return { version: 1, expectedSha256: null, expectedBytes: null, bMatches: null, agentsMatches: null,
            bState: 'unreadable', agentsState: 'unreadable', error: 'generation_failed' };
    }
}

export function regenerateB() {
    clearTemplateCache();
    clearPromptCache();
    try { invalidateSkillCommandsCache(); } catch { /* skill-cache not ready */ }
    const fullPrompt = getSystemPrompt({ forDisk: true });

    // Skip file write if content unchanged — preserves mtime so CLI prompt
    // caching (Claude --append, Codex resume) is not invalidated each turn.
    const hash = createHash('sha256').update(fullPrompt).digest('hex');
    const { bPath, agentsPath, workingDir: wd } = generatedPromptPaths();
    if (hash === _lastPromptHash) {
        const expected = Buffer.from(fullPrompt, 'utf8');
        if (compareGeneratedFile(bPath, expected).matches === true && compareGeneratedFile(agentsPath, expected).matches === true) return;
    }

    fs.writeFileSync(bPath, fullPrompt);

    // Generate {workDir}/AGENTS.md — read by Codex, Copilot, and OpenCode
    try {
        fs.writeFileSync(agentsPath, fullPrompt);
        _lastPromptHash = hash;
        log.info(`[prompt] AGENTS.md generated at ${wd}`);
    } catch (e: unknown) {
        log.error(`[prompt] AGENTS.md generation failed:`, (e as Error).message);
    }
}
