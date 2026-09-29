// ─── Memory Flush Controller ─────────────────────────
// Extracted from spawn.ts to reduce file size.

import fs from 'fs';
import { join } from 'path';
import { settings, JAW_HOME } from '../core/config.js';
import { getUnflushedMessages, getSessionIdsWithMessages } from '../core/db.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { getMemoryFlushFilePath } from '../memory/runtime.js';
import { maybeAutoReflect } from '../memory/reflect.js';
import { resolveDashboardHome } from '../manager/dashboard-home.js';
import { DASHBOARD_DEFAULT_PORT } from '../manager/constants.js';

export let memoryFlushCounter = 0;
export let flushCycleCount = 0;
let _flushLock = false;
// Per session, because the rows being filtered are per session. A single watermark
// meant the highest id any session had flushed became the floor for every other one:
// a quiet session with older unflushed rows could never summarise them again, since
// they all sat below a mark that a busier session had already pushed past (073 §2.3).
const _lastFlushedMessageId = new Map<string, number>();
// A flush turned away by the writer lock used to be remembered per session, because the
// flush it would run was per session (073 §2.3a). The automatic flush is merged now, so
// there is nothing to key on: one pending bit IS the queue, and it coalesces any number
// of turned-away triggers into a single retry.
//
// The lock itself stays global for the original reason — every session appends to one
// memory file, and letting two writers in corrupts it rather than isolating them.
let _pendingMergedFlush = false;
let _flushGeneration = 0;
let _activeFlushGeneration: number | null = null;

const FLUSH_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FLUSH_OUTPUT_BYTES = 64 * 1024;

// Ceiling on the ASSEMBLED CONVERSATION — not on the final string a runtime receives.
// buildFlushPrompt wraps this in a template the user may edit, and a template that
// repeats {{convo}} multiplies it; that is already true today and is not something
// this bounds.
//
// Worth bounding regardless: several runtimes pass the prompt as an argv element
// (args.ts), where the OS limit is around 1 MB. 100k is roughly three times the
// largest cycle this repo's own database can produce (8 sessions x 10 rows x ~440
// chars average) and a tenth of that argv limit.
const MAX_FLUSH_PROMPT_CHARS = 100_000;

// flushEvery sets the trigger cadence; it must not also decide how many rows one query
// returns. Someone setting it to 10,000 would otherwise read 10,000 rows per session.
const MAX_FLUSH_ROWS_PER_SESSION = 10;

// Per-row ceiling, so one enormous message cannot set the prompt size by itself. It
// fires rarely by design — a guard against a rare catastrophe, not an optimisation for
// the common case.
const MAX_FLUSH_ROW_CHARS = 4_000;
const TRUNCATION_MARK = '… [truncated]';

// The manual path keeps the original 4: a person flushing a three-row conversation gets
// the same answer as before. The merged path uses 2 for a different reason — not that
// two rows are worth summarising, but that a merged cycle finding fewer has genuinely
// nothing to do, and the alternative (refunding the spent trigger) retried every turn.
const MIN_FLUSH_ROWS_MANUAL = 4;
const MIN_FLUSH_ROWS_MERGED = 2;
/**
 * Matches any line the indexer would treat as a structural heading.
 *
 * The indexer parses `/^(#{1,3})\s+(.+)$/` against `line.trim()`
 * (indexing.ts:97), so leading whitespace does not protect us. Two distinct
 * attacks exist and both must be closed:
 *
 *  - a forged H2 carrying ` · session:<id>` becomes fabricated provenance;
 *  - a PLAIN H1 (say `# Decisions`) resets the heading stack, so every chunk
 *    after it loses the canonical H2 session heading entirely — erasing
 *    provenance without forging anything.
 *
 * Extractor output is untrusted prose, so no heading in it is legitimate.
 * Neutralize them all rather than pattern-matching the session marker.
 */
const UNTRUSTED_HEADING_RE = /^\s*#{1,6}\s+/;

export function incrementMemoryFlush(): void {
    memoryFlushCounter++;
}

export function resetMemoryFlushCounter(): void {
    memoryFlushCounter = 0;
    flushCycleCount++;
}

// The trigger is global on purpose: one flush per N assistant turns, whatever session
// they happened in.
//
// This does not reintroduce #454. That bug was "session B spends the budget A filled,
// so only B is summarised" — a mismatch between a global trigger and a per-session
// target. It was fixed by making the trigger per session; it is fixed here by making
// the TARGET global instead. When every session with unflushed rows is summarised
// together, which session spent the counter stops being a question.
//
// Separate from memoryFlushCounter, which tracks memory-flush work across turns.
// Session refresh and clear thresholds use persisted per-bucket turn counts.
let _turnsSinceFlush = 0;

/** Count a completed turn and report whether a flush has been earned. Resets on a
 *  true result, so a caller cannot fire without resetting or reset without firing. */
export function countTurnForFlush(threshold: number): boolean {
    _turnsSinceFlush++;
    if (_turnsSinceFlush < threshold) return false;
    _turnsSinceFlush = 0;
    flushCycleCount++;
    return true;
}

/** @internal exported for unit tests */
export function resetFlushCountersForTest(): void {
    _turnsSinceFlush = 0;
    _pendingMergedFlush = false;
    // Watermarks too: a suite that clears the messages table but keeps the marks leaves
    // every later case reading against ids that no longer exist.
    _lastFlushedMessageId.clear();
}

type FlushSpawnResult = {
    text: string;
    code: number;
};

type FlushSpawnOptions = {
    agentId: string;
    internal: boolean;
    forceNew: boolean;
    _skipInsert: boolean;
    _skipHistory: boolean;
    cli: string;
    model: string;
    sysPrompt: string;
    permissions: string;
};

type FlushSpawnAgent = (
    prompt: string,
    opts: FlushSpawnOptions,
) => { child: unknown; promise: Promise<FlushSpawnResult> };

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: FlushSpawnAgent;

export function setSpawnRef(fn: FlushSpawnAgent, _procs: unknown): void {
    _spawnAgent = fn;
}

// ─── Flush Prompt Builder (3-A) ──────────────────────

const DEFAULT_FLUSH_PROMPT_TEMPLATE = `You are a memory extractor. Return a short prose summary of the conversation.

Rules:
- Return only 1-3 SHORT English sentences capturing decisions, facts, preferences
- Skip greetings, errors, small talk
- If nothing worth remembering, return exactly "SKIP"
- Do not write or modify any file

Conversation:
---
{{convo}}`;

export function buildFlushPrompt(vars: { memFile?: string; time: string; convo: string; sessionId?: string }): string {
    const customPath = join(JAW_HOME, 'prompts', 'flush-prompt.md');
    let template = DEFAULT_FLUSH_PROMPT_TEMPLATE;
    if (fs.existsSync(customPath)) {
        try {
            template = fs.readFileSync(customPath, 'utf8');
        } catch (err) {
            console.warn(`[memory] failed to load custom flush prompt: ${(err as Error).message}`);
        }
    }
    // A template without {{convo}} produces a prompt containing none of the rows the
    // caller is about to mark as flushed. The extractor still answers — off the system
    // prompt alone — and that answer is treated as a successful summary, so the
    // watermark advances past conversation nobody read. Merging widened the blast
    // radius from one session to every session in the cycle.
    //
    // Fall back rather than fail: the flush still runs, and the person who wrote the
    // template gets a warning instead of a silently skipped cycle.
    if (!template.includes('{{convo}}')) {
        console.warn('[memory] custom flush prompt has no {{convo}}; using the default template');
        template = DEFAULT_FLUSH_PROMPT_TEMPLATE;
    }
    // memFile is intentionally NOT exposed. The extractor returns text; cli-jaw
    // owns the append. Handing it the destination path would let a custom
    // template — or hostile conversation text — steer a direct write that
    // bypasses output validation, generation ownership, and the canonical
    // heading. Legacy templates referencing {{memFile}} keep the literal token,
    // which is inert, rather than resolving to a writable path.
    const safeVars: Record<string, string> = { time: vars.time, convo: vars.convo };
    if (settings["multiSession"]?.enabled === true && vars.sessionId) {
        safeVars["sessionId"] = vars.sessionId;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => safeVars[key] ?? match);
}

// ─── Flush SysPrompt Loader (3-B) ───────────────────

function loadFlushSysPrompt(): string {
    const customPath = join(JAW_HOME, 'prompts', 'flush-system.md');
    if (fs.existsSync(customPath)) {
        try {
            return fs.readFileSync(customPath, 'utf8');
        } catch (err) {
            console.warn(`[memory] failed to load flush system prompt: ${(err as Error).message}`);
        }
    }
    return '';
}

// ─── Collection ──────────────────────────────────────

export type FlushOutcome = 'started' | 'insufficient' | 'locked';

type FlushRow = { id: number; role: string; content: string };
type FlushSlice = { sessionId: string; rows: FlushRow[] };

/** Clamp, not min. flushEvery is user-settable and PUT /api/memory-files/settings
 *  merges the request body into settings without validating it, so a negative value can
 *  reach SQL — where LIMIT -1 means UNLIMITED, the exact opposite of a cap. */
function flushRowLimit(flushEvery: unknown): number {
    const n = typeof flushEvery === 'number' && Number.isSafeInteger(flushEvery) ? flushEvery : 10;
    return Math.max(1, Math.min(n, MAX_FLUSH_ROWS_PER_SESSION));
}

/** Bound one row. A single enormous message would otherwise set the prompt size by
 *  itself. The id is kept, so the watermark advances past the original row — the tail is
 *  dropped, which is the one loss this design accepts. Refusing to truncate instead
 *  would wall the session off permanently, which is worse. */
function capRow(row: FlushRow): FlushRow {
    if (row.content.length <= MAX_FLUSH_ROW_CHARS) return row;
    let cut = row.content.slice(0, MAX_FLUSH_ROW_CHARS - TRUNCATION_MARK.length);
    // Never end on a lone high surrogate: slicing mid-pair emits a broken code unit.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return { ...row, content: cut + TRUNCATION_MARK };
}

function readSlice(sessionId: string, rowLimit: number): FlushSlice | null {
    const rows = (getUnflushedMessages.all(
        settings["workingDir"] || null, sessionId, _lastFlushedMessageId.get(sessionId) ?? 0, rowLimit,
    ) as FlushRow[]).map(capRow);
    return rows.length > 0 ? { sessionId, rows } : null;
}

/** The caller's own session, for a manual flush. */
function collectSessionSlice(rowLimit: number): FlushSlice[] {
    const sessionId = settings["multiSession"]?.enabled === true
        ? (currentSessionScope()?.chatSessionId ?? getActiveChatSession())
        : getActiveChatSession();
    const slice = readSlice(sessionId, rowLimit);
    return slice ? [slice] : [];
}

/** Every session's unflushed rows, oldest first.
 *
 *  Nothing is selected out of a session's run. That is the design, not an oversight: a
 *  watermark says everything at or below an id is summarised, so a partial take makes it
 *  a lie. Packing rows to fit a budget loses whichever row was skipped, permanently.
 *
 *  Ordered by the OLDEST waiting row, so waiting earns a slot. Ordering by most recent
 *  activity reads as the natural choice and starves under exactly the load it should
 *  handle — one talkative session stays at the head of every cycle and the sessions
 *  behind the ceiling never come forward. */
function collectMergedSlices(rowLimit: number): FlushSlice[] {
    const sessionIds = (getSessionIdsWithMessages.all(settings["workingDir"] || null) as Array<{ session_id: string }>)
        .map(row => row.session_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const slices: FlushSlice[] = [];
    for (const sessionId of sessionIds) {
        const slice = readSlice(sessionId, rowLimit);
        if (slice) slices.push(slice);
    }
    // rows[0] is the oldest — the SQL is ORDER BY id ASC.
    slices.sort((a, b) => (a.rows[0]?.id ?? 0) - (b.rows[0]?.id ?? 0));

    // Drop whole sessions off the tail until the conversation fits. Whole sessions, never
    // rows: a deferred session keeps its watermark and returns intact, while a deferred
    // row would break the contiguity the watermark asserts.
    const kept: FlushSlice[] = [];
    for (const slice of slices) {
        // The first slice is admitted unconditionally. Without that, a session somehow
        // exceeding the ceiling alone would never be summarised again. Overshooting a
        // soft ceiling is the lesser failure.
        if (kept.length > 0 && renderConvo([...kept, slice]).length > MAX_FLUSH_PROMPT_CHARS) break;
        kept.push(slice);
    }
    if (kept.length < slices.length) {
        console.log(`[memory] merged flush covering ${kept.length}/${slices.length} sessions`);
    }
    return kept;
}

/** Assemble the conversation. Extracted so the ceiling check measures the exact string
 *  this produces rather than estimating it with a formula kept in sync by hand.
 *
 *  The session separator does NOT consult multiSession.enabled: the collector enumerates
 *  whatever the database holds, and an install that turned multi-session off can still
 *  have rows from several sessions. Gluing two unrelated conversations together without a
 *  boundary invites the extractor to invent a relationship between them. */
function renderConvo(slices: FlushSlice[]): string {
    return slices.map(slice => {
        const head = slices.length > 1 ? `--- session ${slice.sessionId} ---\n` : '';
        return head + slice.rows.map(row => `[${row.role}] ${row.content}`).join('\n\n');
    }).join('\n\n');
}

// ─── Trigger ─────────────────────────────────────────

/** Automatic flush: merged across every session holding unflushed rows. */
export async function triggerMemoryFlush(): Promise<FlushOutcome> {
    return runFlush({ merged: true });
}

/** Manual flush (`/memory flush`, POST /api/jaw-memory/flush): still the caller's own
 *  session. Someone asking to flush THIS conversation means this one, and the entry
 *  keeps its canonical `· session:<id>` heading. */
export async function triggerMemoryFlushForCurrentSession(): Promise<FlushOutcome> {
    return runFlush({ merged: false });
}

async function runFlush(opts: { merged: boolean }): Promise<FlushOutcome> {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;

    if (_flushLock) {
        // Only the merged path is worth remembering: its trigger is a counter already
        // spent, so dropping it costs a whole cycle. A manual flush has a caller who can
        // read the message and run it again.
        if (opts.merged) _pendingMergedFlush = true;
        console.log(`[memory] flush lock held; merged retry pending=${_pendingMergedFlush}`);
        return 'locked';
    }

    const rowLimit = flushRowLimit(settings["memory"]?.flushEvery);
    const slices = opts.merged ? collectMergedSlices(rowLimit) : collectSessionSlice(rowLimit);
    const totalRows = slices.reduce((n, s) => n + s.rows.length, 0);
    if (totalRows < (opts.merged ? MIN_FLUSH_ROWS_MERGED : MIN_FLUSH_ROWS_MANUAL)) return 'insufficient';

    const generation = ++_flushGeneration;
    _flushLock = true;
    _activeFlushGeneration = generation;
    let expired = false;
    let released = false;

    const ownsGeneration = (): boolean =>
        !expired && _flushLock && _activeFlushGeneration === generation;
    const releaseLock = (): void => {
        if (released) return;
        released = true;
        if (_activeFlushGeneration === generation) {
            _activeFlushGeneration = null;
            _flushLock = false;
            if (_pendingMergedFlush) {
                _pendingMergedFlush = false;
                // Detached on purpose: this runs from inside a lock release, and awaiting
                // the retry here would hold the releasing frame open for it.
                void runFlush({ merged: true }).catch(error => {
                    console.warn('[memory] pending merged flush failed:', (error as Error).message);
                });
            }
        }
    };
    const lockTimeout = setTimeout(() => {
        if (ownsGeneration()) {
            expired = true;
            releaseLock();
            console.warn('[memory] flush lock auto-released after 5m timeout');
        }
    }, FLUSH_LOCK_TIMEOUT_MS);

    // Per session, because that is the granularity the watermark commits at. One number
    // for everybody would let a deferred session's rows fall behind a mark set by a
    // session that was included.
    const includedMaxIdBySession = new Map<string, number>();
    for (const slice of slices) {
        includedMaxIdBySession.set(slice.sessionId, Math.max(...slice.rows.map(row => row.id)));
    }
    const convo = renderConvo(slices);
    // A merged entry cannot carry provenance in its heading: the indexer matches exactly
    // one trailing `· session:<id>`, so a list would be read as whichever name came last —
    // a wrong attribution, worse than none. The conversation body carries it instead.
    const headingSessionId = opts.merged ? null : (slices[0]?.sessionId ?? null);
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 5);
    const memFile = getMemoryFlushFilePath(date);

    const flushPrompt = buildFlushPrompt({
        time,
        convo,
        // Only the single-session path can name a session; a merged conversation has no
        // one id to substitute, so custom templates keep the inert literal instead.
        ...(multiSessionEnabled && headingSessionId ? { sessionId: headingSessionId } : {}),
    });

    const flushCli = settings["memory"]?.cli || settings["cli"];
    const flushModel = settings["memory"]?.model || (settings["perCli"]?.[flushCli]?.model) || 'default';

    try {
        const { promise } = _spawnAgent(flushPrompt, {
            agentId: 'memory-flush',
            internal: true,
            forceNew: true,
            _skipInsert: true,
            _skipHistory: true,
            cli: flushCli,
            model: flushModel,
            sysPrompt: loadFlushSysPrompt(),
            // The extractor is an output-only summarizer. cli-jaw owns the
            // append, so denying the permission bypass keeps a hostile
            // conversation from talking it into writing the memory file
            // directly and sidestepping validation entirely. The prompt's
            // "do not write" line is guidance, not a boundary.
            permissions: 'deny',
        });
        promise.then(
            result => completeFlushAttempt({
                result,
                memFile,
                time,
                headingSessionId: multiSessionEnabled ? headingSessionId : null,
                includedMaxIdBySession,
                ownsGeneration,
                releaseLock,
                clearAttemptTimeout: () => clearTimeout(lockTimeout),
            }),
            error => {
                clearTimeout(lockTimeout);
                if (!ownsGeneration()) return;
                console.error('[memory] flush execution rejected:', error);
                releaseLock();
            },
        ).catch(error => {
            clearTimeout(lockTimeout);
            if (!ownsGeneration()) return;
            console.error('[memory] flush completion failed:', error);
            releaseLock();
        });
        console.log(`[memory] auto-append triggered (${totalRows} msgs, ${slices.length} session(s) → ${flushCli}/${flushModel})`);
    } catch (e) {
        clearTimeout(lockTimeout);
        releaseLock();
        console.error('[memory] flush spawn failed:', e);
        return 'started';
    }
    return 'started';
}

type CompleteFlushAttemptOptions = {
    result: FlushSpawnResult;
    memFile: string;
    time: string;
    // null for a merged entry: no single session owns it, so the heading carries no
    // `· session:<id>` suffix and provenance lives in the summarised prose instead.
    headingSessionId: string | null;
    // Only the rows that actually reached the prompt. Advancing a session past a row the
    // extractor never saw would lose it for good.
    includedMaxIdBySession: Map<string, number>;
    ownsGeneration: () => boolean;
    releaseLock: () => void;
    clearAttemptTimeout: () => void;
};

async function completeFlushAttempt(opts: CompleteFlushAttemptOptions): Promise<void> {
    opts.clearAttemptTimeout();
    if (!opts.ownsGeneration()) return;

    if (opts.result.code !== 0) {
        console.warn(`[memory] flush failed (code=${opts.result.code}); watermark unchanged`);
        opts.releaseLock();
        return;
    }

    const raw = typeof opts.result.text === 'string' ? opts.result.text : '';
    if (Buffer.byteLength(raw, 'utf8') > MAX_FLUSH_OUTPUT_BYTES) {
        console.warn('[memory] flush output exceeded 64 KiB; discarded');
        opts.releaseLock();
        return;
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'SKIP') {
        if (trimmed === 'SKIP') commitWatermarks(opts.includedMaxIdBySession);
        opts.releaseLock();
        return;
    }

    const summary = trimmed
        .split(/\r?\n/)
        // Neutralize rather than drop: removing the line would silently delete
        // content, while escaping keeps the text and only strips its structural
        // power over the indexer's heading stack.
        .map(line => (UNTRUSTED_HEADING_RE.test(line) ? line.replace(/^(\s*)#/, '$1\\#') : line))
        .join('\n')
        .trim();
    if (!summary || !opts.ownsGeneration()) {
        opts.releaseLock();
        return;
    }

    const heading = opts.headingSessionId
        ? `## ${opts.time} · session:${opts.headingSessionId}`
        : `## ${opts.time}`;
    fs.mkdirSync(join(opts.memFile, '..'), { recursive: true });
    if (!opts.ownsGeneration()) return;
    fs.appendFileSync(opts.memFile, `\n${heading}\n\n${summary}\n`);

    // Reindex the file we just wrote, inside generation ownership. This used to
    // be fire-and-forget from lifecycle-handler's onExit, which ran before the
    // extractor promise resolved — so it reindexed a file that did not yet
    // contain this entry, and an expired attempt could still trigger it.
    if (!opts.ownsGeneration()) return;
    try {
        const { reindexIntegratedMemoryFile } = await import('../memory/indexing.js');
        reindexIntegratedMemoryFile(opts.memFile);
    } catch (error) {
        console.warn('[memory:flush] post-flush reindex failed:', (error as Error).message);
    }

    if (!opts.ownsGeneration()) return;
    try {
        await maybeAutoReflect();
    } catch (error) {
        console.error('[memory] post-flush auto-reflect failed:', error);
    }
    if (!opts.ownsGeneration()) return;

    await triggerEmbeddingSync();
    if (!opts.ownsGeneration()) return;

    commitWatermarks(opts.includedMaxIdBySession);
    opts.releaseLock();
    const marks = [...opts.includedMaxIdBySession].map(([id, mark]) => `${id}=${mark}`).join(' ');
    console.log(`[memory] flush complete (code=${opts.result.code}), watermarks: ${marks}`);
}

/** Advance each contributing session to the last row that actually reached the prompt.
 *  Never further: a session deferred by the prompt ceiling is absent from this map, so
 *  its rows stay candidates for the next cycle. */
function commitWatermarks(includedMaxIdBySession: Map<string, number>): void {
    for (const [sessionId, maxId] of includedMaxIdBySession) {
        _lastFlushedMessageId.set(sessionId, maxId);
    }
}

async function triggerEmbeddingSync(): Promise<void> {
    try {
        const home = resolveDashboardHome();
        const cfgPath = join(home, 'embedding.json');
        if (!fs.existsSync(cfgPath)) return;
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (!cfg.enabled) return;

        const port = Number(process.env['DASHBOARD_PORT']) || Number(DASHBOARD_DEFAULT_PORT);
        const resp = await fetch(`http://127.0.0.1:${port}/api/dashboard/memory/reindex`, {
            method: 'POST',
            signal: AbortSignal.timeout(30_000),
            headers: { host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        });
        if (resp.ok) {
            console.log('[memory] post-flush embedding sync triggered');
        }
    } catch (err) {
        console.warn('[memory] post-flush embedding sync failed (non-critical):', (err as Error).message);
    }
}

export function getFlushStatus() {
    return {
        locked: _flushLock,
        // Kept as a single number for callers that predate multi-session, reporting the
        // furthest any session has reached, plus the per-session marks behind it.
        lastFlushedMessageId: _lastFlushedMessageId.size === 0
            ? null
            : Math.max(..._lastFlushedMessageId.values()),
        lastFlushedMessageIdBySession: Object.fromEntries(_lastFlushedMessageId),
        // Always empty now: a merged flush has no per-session queue to report. Kept for
        // one major because GET /api/memory/status serialises this object whole, and a
        // disappearing key is a breaking change to a documented response.
        deferredFlushSessions: [] as string[],
        pendingMergedFlush: _pendingMergedFlush,
        turnsSinceFlush: _turnsSinceFlush,
        counter: memoryFlushCounter,
        cycleCount: flushCycleCount,
    };
}
