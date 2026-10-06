import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { loadHeartbeatFile, saveHeartbeatFile, isHeartbeatDestination, isHeartbeatMentionWatch, isHeartbeatPromptSkills, settings } from '../core/config.js';
import type { HeartbeatDestination, HeartbeatMentionWatch, HeartbeatJob } from '../core/config.js';
import { getHeartbeatLiveDestinationHold, getHeartbeatRunRecord, startHeartbeat } from '../memory/heartbeat.js';
import type { HeartbeatRunRecord } from '../memory/heartbeat-run-record.js';
import { isCompleteHeartbeatDestination, resolveHeartbeatBinding } from '../memory/heartbeat-destination.js';
import { validateHeartbeatScheduleInput } from '../memory/heartbeat-schedule.js';
import { approveLegacyFreshStart, quarantineState, detectLegacyMentionWatch, isQuarantined } from '../memory/legacy-mention-watch-quarantine.js';
import { verifiedSlackWorkspace } from '../slack/verified-workspace.js';
import { getEmployees } from '../core/db.js';
import type { EmployeeRow } from '../core/employees.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { capturePeriodKey } from '../memory/period-thread-key.js';
import { periodThreadFirstLine } from '../memory/period-thread-root.js';
import { readPeriodThreadDiagnostic } from '../memory/period-thread-state.js';

type RunnerFields = Pick<import('../core/config.js').HeartbeatJob, 'runner' | 'employee' | 'command' | 'reportPolicy'>;
export type HeartbeatPutRunnerResult = { ok: true; fields: RunnerFields } | { ok: false; error: string };

/** Resolve the destination a PUT should persist.
 *
 *  Every shipped UI (Classic `normalizeHeartbeatJob`, Manager `safeJob`) rebuilds
 *  each job from a fixed five-field shape, so a field they do not know about is
 *  absent from the body rather than explicitly cleared. Inheriting on absence is
 *  what keeps an ordinary "Save jobs" click from deleting a destination the UI
 *  cannot even display — the same reason runner fields already inherit.
 *
 *  An explicit `null` is the deliberate clear, and is NOT folded into undefined:
 *  doing so would make unsetting impossible from any client. */
export function resolveHeartbeatDestination(
    job: Record<string, unknown>,
    existing: HeartbeatDestination | null | undefined,
): { ok: true; destination: HeartbeatDestination | undefined } | { ok: false; error: string } {
    if (!Object.prototype.hasOwnProperty.call(job, 'destination')) {
        return { ok: true, destination: existing ?? undefined };
    }
    const raw = job['destination'];
    if (raw === null) return { ok: true, destination: undefined };
    if (!isHeartbeatDestination(raw)) return { ok: false, error: 'invalid heartbeat destination' };
    // A supplied destination must say WHERE, not just which room. Inheritance
    // above keeps existing half-filled jobs loadable; this rejects writing a new
    // one, so the gap closes as jobs are edited instead of being re-saved
    // forever with no thread (#745).
    if (!isCompleteHeartbeatDestination(raw)) {
        return { ok: false, error: 'heartbeat destination needs a threadId, or scope:"channel_root" to post at the conversation root' };
    }
    return { ok: true, destination: raw };
}

/** Surface a stored destination a tick will refuse, so an operator can see the
 *  hold instead of waiting for a report that never arrives. Mention-watch jobs
 *  answer the thread they find and need no destination of their own. */
function heldForDestination(job: HeartbeatJob): (HeartbeatJob & { held: string }) | null {
    if (job.mentionWatch) return null;
    const binding = resolveHeartbeatBinding(job.destination);
    if (binding.state === 'held') return { ...job, held: binding.reason };
    const live = getHeartbeatLiveDestinationHold(job);
    return live ? { ...job, held: live } : null;
}

function withPeriodThreadDiagnostic<T extends HeartbeatJob>(job: T): T | (T & { periodThread: object }) {
    const destination = job.destination;
    if (!isHeartbeatDestination(destination) || destination.scope !== 'period_thread' || !destination.periodThread) return job;
    const captured = capturePeriodKey(Date.now(), destination.periodThread.period);
    const p = destination.periodThread;
    return { ...job, periodThread: {
        rootKey: p.rootKey, period: p.period, role: p.role, slot: p.slot,
        periodKey: captured.periodKey, label: captured.label,
        firstLine: periodThreadFirstLine(destination, captured),
        ...readPeriodThreadDiagnostic(destination, captured),
    } };
}

/** Resolve the mention-watch a PUT should persist.
 *
 *  Same inheritance rule as `destination`, for the same reason: every shipped UI
 *  rebuilds a job from a fixed field set, so a field it does not know about
 *  arrives absent rather than cleared. An explicit `null` is the deliberate
 *  unset.
 *
 *  A malformed value is a 400 rather than a silent drop. The prompt on such a job
 *  is written to answer a mention that was handed to it; running it as an
 *  ordinary heartbeat would post an answer to nothing. */
export function resolveHeartbeatMentionWatch(
    job: Record<string, unknown>,
    existing: HeartbeatMentionWatch | null | undefined,
): { ok: true; mentionWatch: HeartbeatMentionWatch | undefined } | { ok: false; error: string } {
    if (!Object.prototype.hasOwnProperty.call(job, 'mentionWatch')) {
        return { ok: true, mentionWatch: existing ?? undefined };
    }
    const raw = job['mentionWatch'];
    if (raw === null) return { ok: true, mentionWatch: undefined };
    if (!isHeartbeatMentionWatch(raw)) return { ok: false, error: 'invalid heartbeat mention watch' };
    return { ok: true, mentionWatch: raw };
}

export function resolveHeartbeatPromptSkills(
    job: Record<string, unknown>, existing: string[] | undefined,
): { ok: true; promptSkills: string[] | undefined } | { ok: false; error: string } {
    if (!Object.prototype.hasOwnProperty.call(job, 'promptSkills')) return { ok: true, promptSkills: existing };
    if (job['promptSkills'] === null) return { ok: true, promptSkills: undefined };
    if (!isHeartbeatPromptSkills(job['promptSkills'])) return { ok: false, error: 'invalid heartbeat prompt skills' };
    return { ok: true, promptSkills: job['promptSkills'] };
}

export function normalizeHeartbeatPutRunnerFields(
    job: Record<string, unknown>,
    existing: RunnerFields | undefined,
    employeeNames: ReadonlySet<string>,
): HeartbeatPutRunnerResult {
    const inherited = (key: keyof RunnerFields): unknown =>
        Object.prototype.hasOwnProperty.call(job, key) ? job[key] : existing?.[key];
    const runnerValue = inherited('runner');
    const runner = runnerValue == null ? undefined : runnerValue;
    const employee = inherited('employee');
    const command = inherited('command');
    const reportPolicy = inherited('reportPolicy');
    if (runner !== undefined && runner !== 'main' && runner !== 'employee' && runner !== 'script') return { ok: false, error: 'invalid heartbeat runner' };
    if (runner === 'employee' && (typeof employee !== 'string' || !employeeNames.has(employee))) return { ok: false, error: 'unknown heartbeat employee' };
    if (runner === 'script' && (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string' && part.length > 0))) {
        return { ok: false, error: 'command must be a non-empty string array' };
    }
    if (reportPolicy !== undefined && reportPolicy !== null && reportPolicy !== 'always' && reportPolicy !== 'anomaly_only' && reportPolicy !== 'silent') {
        return { ok: false, error: 'invalid heartbeat report policy' };
    }
    return { ok: true, fields: stripUndefined({
        runner: runner ?? undefined,
        employee: employee == null ? undefined : employee as string,
        command: command == null ? undefined : command as string[],
        reportPolicy: reportPolicy == null ? undefined : reportPolicy as RunnerFields['reportPolicy'],
    }) };
}

/** Attach the last admitted tick's outcome.
 *
 *  Additive beside `held`, for the reason `held` was additive: a client that does
 *  not know the field behaves exactly as before. The record is process-local, so a
 *  job that has not ticked since the last restart carries NO `lastRun` rather than
 *  a stale one — absent is the honest answer, not a zeroed record. */
function withLastRun<T extends { id?: string }>(job: T): T | (T & { lastRun: HeartbeatRunRecord }) {
    const lastRun = job.id ? getHeartbeatRunRecord(job.id) : undefined;
    return lastRun ? { ...job, lastRun } : job;
}

export function registerHeartbeatRoutes(app: Express, requireAuth: AuthMiddleware): void {
    // `enabled` is the operator's intent; it is not the same as running.
    //
    // A mention-watch job holding an unmigrated ledger is refused before a timer
    // is even created, yet its file entry still says `enabled: true` — the file is
    // intent and the hold is the system's judgement, deliberately stored apart.
    // Every operator surface counts the file flag, so a held job read as ACTIVE.
    // `held` is additive, so a client that ignores it behaves exactly as before.
    app.get('/api/heartbeat', requireAuth, (_req, res) => {
        const file = loadHeartbeatFile();
        detectLegacyMentionWatch(Date.now());
        res.json({
            ...file,
            jobs: file.jobs.map(job => withLastRun(withPeriodThreadDiagnostic(job.mentionWatch && job.id && isQuarantined(job.id)
                ? { ...job, held: 'unmigrated_mention_watch_ledger' as const }
                : heldForDestination(job) ?? job))),
        });
    });

    app.put('/api/heartbeat', requireAuth, (req, res) => {
        const data = req.body;
        if (!data || !Array.isArray(data.jobs)) {
            res.status(400).json({ error: 'jobs array required' });
            return;
        }
        const normalizedJobs = [];
        const existingById = new Map(loadHeartbeatFile().jobs.filter(job => job.id).map(job => [job.id, job]));
        const employeeNames = new Set((getEmployees.all() as EmployeeRow[]).map(employee => employee.name));
        const idPrefix = `hb_${Date.now()}`;
        const seenIds = new Set<string>();
        const markerOwners = new Map<string, string>();
        const rootContracts = new Map<string, string>();
        for (const [index, rawJob] of data.jobs.entries()) {
            const job = (rawJob && typeof rawJob === 'object') ? rawJob as Record<string, unknown> : {};
            const scheduleResult = validateHeartbeatScheduleInput(job["schedule"]);
            const jobId = typeof job["id"] === 'string' && job["id"].trim()
                ? job["id"].trim()
                : `${idPrefix}_${index}`;
            if (!scheduleResult.ok) {
                res.status(400).json({
                    error: 'invalid heartbeat schedule',
                    code: scheduleResult.code,
                    detail: scheduleResult.error,
                    index,
                    jobId,
                });
                return;
            }
            // Two jobs under one id would share a mention-watch ledger namespace,
            // so the second one inherits the first one's cursor and skips every
            // message below it. Rejected rather than de-duplicated: silently
            // dropping one of them loses a job the operator just asked to save.
            if (seenIds.has(jobId)) {
                res.status(400).json({ error: 'duplicate heartbeat job id', index, jobId });
                return;
            }
            seenIds.add(jobId);
            const existing = existingById.get(jobId);
            const runnerResult = normalizeHeartbeatPutRunnerFields(job, existing, employeeNames);
            if (!runnerResult.ok) { res.status(400).json({ error: runnerResult.error, index, jobId }); return; }
            const skillResult = resolveHeartbeatPromptSkills(job, existing?.promptSkills);
            if (!skillResult.ok) { res.status(400).json({ error: skillResult.error, index, jobId }); return; }
            if (runnerResult.fields.runner === 'script' && skillResult.promptSkills) {
                res.status(400).json({ error: 'script runner cannot use promptSkills', index, jobId }); return;
            }
            const destResult = resolveHeartbeatDestination(job, existing?.destination);
            if (!destResult.ok) { res.status(400).json({ error: destResult.error, index, jobId }); return; }
            const watchResult = resolveHeartbeatMentionWatch(job, existing?.mentionWatch);
            if (!watchResult.ok) { res.status(400).json({ error: watchResult.error, index, jobId }); return; }
            const destination = destResult.destination;
            if (destination?.scope === 'period_thread' && watchResult.mentionWatch) {
                res.status(400).json({ error: 'period_thread cannot be combined with mentionWatch', index, jobId }); return;
            }
            if (destination?.scope === 'period_thread') {
                const p = destination.periodThread!;
                const marker = `${destination.targetId}|${p.title}`;
                const owner = markerOwners.get(marker);
                if (owner !== undefined && owner !== p.rootKey) {
                    res.status(400).json({ error: 'period_thread title must be unique per channel', index, jobId }); return;
                }
                markerOwners.set(marker, p.rootKey);
                const contract = `${destination.targetId}|${p.period}|${p.title}`;
                const prior = rootContracts.get(p.rootKey);
                if (prior !== undefined && prior !== contract) {
                    res.status(400).json({ error: 'period_thread rootKey must agree on channel, period and title', index, jobId }); return;
                }
                rootContracts.set(p.rootKey, contract);
            }
            normalizedJobs.push(stripUndefined({
                id: jobId,
                name: typeof job["name"] === 'string' ? job["name"] : '',
                enabled: job["enabled"] !== false,
                schedule: scheduleResult.schedule,
                prompt: typeof job["prompt"] === 'string' ? job["prompt"] : '',
                promptSkills: skillResult.promptSkills,
                ...runnerResult.fields,
                destination: destResult.destination,
                mentionWatch: watchResult.mentionWatch,
            }));
        }
        const payload = { jobs: normalizedJobs };
        saveHeartbeatFile(payload);
        startHeartbeat();
        res.json(payload);
    });

    // Read the hold, so an operator can tell a held job from a broken one. The
    // scheduler refuses a quarantined job on every tick and says why in the log,
    // but a log line is not something the dashboard can show.
    //
    // Detection runs here rather than being assumed from startup. `startHeartbeat`
    // is called after the server is already listening, so a request arriving in
    // that window would find v1 rows with no marker yet and be told the job is
    // fine. It is INSERT OR IGNORE, so calling it again is free.
    app.get('/api/heartbeat/:jobId/mention-watch-hold', requireAuth, (req, res) => {
        const jobId = String(req.params['jobId'] ?? '').trim();
        if (!jobId) { res.status(400).json({ error: 'jobId required' }); return; }
        detectLegacyMentionWatch(Date.now());
        const state = quarantineState(jobId);
        res.json({ jobId, held: state?.status === 'pending', state });
    });

    // Release a held job with a NEW floor.
    //
    // A plain `enabled: true` PUT is deliberately not accepted as the approval:
    // every shipped UI rebuilds a job from a fixed field set and omits
    // `mentionWatch` entirely, so reading a save click as consent would let any
    // unrelated edit lift the hold and replay the backlog.
    //
    // The order below is the crash-safety argument and is not interchangeable.
    // `since` lives in heartbeat.json and the hold lives in SQLite, so the two
    // cannot share a transaction. Writing the file first means a crash before the
    // database step leaves the new floor saved and the job still held, which a
    // retry fixes. The reverse lifts the hold while the OLD floor is still live.
    app.post('/api/heartbeat/:jobId/mention-watch-fresh-start', requireAuth, async (req, res) => {
        const jobId = String(req.params['jobId'] ?? '').trim();
        if (!jobId) { res.status(400).json({ error: 'jobId required' }); return; }
        const since = String((req.body as Record<string, unknown> | undefined)?.['since'] ?? '').trim();
        // An empty floor is what makes this dangerous: the watch would walk
        // backward through all reachable history and answer it again.
        if (!since) { res.status(400).json({ error: 'since required to restart a held mention watch', jobId }); return; }

        // The ONE await comes first, before anything is read.
        //
        // Verification needs the network, and every decision after it reads state
        // that a concurrent request can change. Snapshotting the hold and the file
        // and THEN awaiting is what lets a losing approval resume with a stale
        // whole-file copy and write its floor over the winner's — the DB tells it
        // 'conflict' only after the file damage is already done. Doing the await
        // up front leaves everything below it synchronous, so Node's single thread
        // is the mutual exclusion.
        //
        // The workspace belongs in the record because the ledger is keyed by it: an
        // approval granted while the token pointed at workspace A is otherwise
        // indistinguishable from one granted under B, and the v2 rows the job goes
        // on to write land in a namespace the operator was not looking at. Failing
        // verification is a refusal, not a default.
        const readBotToken = (): string =>
            String((settings['slack'] as Record<string, unknown> | undefined)?.['botToken'] ?? '').trim();
        const token = readBotToken();
        const verified = token ? await verifiedSlackWorkspace(token) : null;
        if (!verified) {
            res.status(409).json({
                error: 'cannot verify the Slack workspace for this token; approving would record a guessed namespace',
                jobId,
            });
            return;
        }
        // A settings write during that await can have swapped the token. The
        // verified team id then describes the OLD credential while the job the
        // approval is about to release runs under the new one — the recorded
        // provenance and the namespace actually written would disagree, which is
        // the exact confusion recording the workspace exists to prevent.
        if (readBotToken() !== token) {
            res.status(409).json({
                error: 'the Slack bot token changed while verifying; retry so the approval records the workspace it will actually run under',
                jobId,
            });
            return;
        }

        // Everything from here down runs without yielding.
        //
        // Same startup-window reason as the GET: without this, a legacy job whose
        // marker has not been written yet reads as 'never held' and 404s.
        detectLegacyMentionWatch(Date.now());
        const state = quarantineState(jobId);
        if (!state) { res.status(404).json({ error: 'no mention-watch hold for this job', jobId }); return; }

        const file = loadHeartbeatFile();
        const job = file.jobs.find(candidate => candidate.id === jobId);
        if (!job?.mentionWatch) {
            res.status(400).json({ error: 'job has no mention watch to restart', jobId });
            return;
        }

        const resolution = JSON.stringify({ since, userId: job.mentionWatch.userId, workspaceId: verified.teamId });
        // Already resolved with the same decision is the caller retrying after a
        // lost response; a different one is a second, conflicting decision.
        if (state.status === 'resolved') {
            const outcome = approveLegacyFreshStart(jobId, resolution, Date.now());
            if (outcome === 'conflict') {
                res.status(409).json({ error: 'this hold was already cleared with a different floor', jobId, state });
                return;
            }
            // The recorded decision matching is not enough. The floor lives in the
            // file, and an edit after the approval can have moved it — reporting
            // this floor as in force while another one governs the scan is the one
            // wrong answer available here. Rewriting silently is worse: it would
            // undo a later deliberate change.
            if ((job.mentionWatch.since ?? '') !== since) {
                res.status(409).json({
                    error: 'the persisted floor no longer matches this approval',
                    jobId,
                    approvedSince: since,
                    persistedSince: job.mentionWatch.since ?? null,
                });
                return;
            }
            res.json({ jobId, outcome, since });
            return;
        }

        const updated: HeartbeatJob[] = file.jobs.map(candidate => (candidate.id === jobId
            ? { ...candidate, mentionWatch: { ...job.mentionWatch!, since } }
            : candidate));
        // Step 1: the file, and only past this line is the new floor durable.
        saveHeartbeatFile({ jobs: updated });
        // Step 2: claim the hold, then archive and delete the v1 rows, as one unit.
        const outcome = approveLegacyFreshStart(jobId, resolution, Date.now());
        if (outcome === 'conflict') {
            res.status(409).json({ error: 'this hold was already cleared with a different floor', jobId, state });
            return;
        }
        if (outcome === 'not-pending') {
            res.status(409).json({ error: 'the hold changed while restarting; retry', jobId });
            return;
        }
        // Step 3: only now can the job be scheduled again.
        startHeartbeat();
        res.json({ jobId, outcome, since });
    });
}
