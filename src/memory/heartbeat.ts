// ─── Heartbeat (Scheduled Jobs + fs.watch) ───────────

import fs from 'fs';
import { basename, dirname } from 'path';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { settings, HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { isAgentBusy, messageQueue } from '../agent/spawn.js';
import { orchestrateAndCollectData } from '../orchestrator/collect.js';
import { claimWorker, failWorker, finishWorker, markWorkerReplayed, WorkerBusyError } from '../orchestrator/worker-registry.js';
import { hasPendingWorkerReplays } from '../orchestrator/worker-registry.js';
import { broadcast } from '../core/bus.js';
import { sendChannelOutput, targetFromChatId } from '../messaging/send.js';
import { nextDeliverySeq, wasSelfDelivered } from '../messaging/turn-delivery.js';
import { isHeartbeatMentionWatch } from '../core/config.js';
import type { HeartbeatMentionWatch } from '../core/config.js';
import { runMentionWatchTick } from './heartbeat-mention-watch.js';
import {
    resolveHeartbeatBinding,
    verifyHeartbeatThreadBindingLive,
    heartbeatHoldMessage,
    type HeartbeatBinding,
    type HeartbeatHoldReason,
} from './heartbeat-destination.js';
import { watchNamespace } from './mention-watch-ledger.js';
import { detectLegacyMentionWatch, isQuarantined } from './legacy-mention-watch-quarantine.js';
import { verifiedSlackWorkspace } from '../slack/verified-workspace.js';
import {
    reserveSlackToolGrant,
    activateSlackToolGrant,
    revokeSlackToolGrant,
    slackCredentialKey,
    SLACK_TOOL_GRANT_ENV,
} from '../slack/tool-context.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import { getRemoteBoundSessionId, resolveOrCreateRemoteSession } from '../core/chat-sessions.js';
import { hasChatSessionWork } from '../orchestrator/session-work.js';
import { sessionLanes } from '../orchestrator/session-lanes.js';
import { channelGateOn } from '../orchestrator/scope.js';
import type { MentionHit } from '../slack/mention-watch.js';
import { getSlackSelfUserId } from '../slack/bot.js';
import { readSlackAllowlist } from '../slack/events.js';
import type { RemoteTarget } from '../messaging/types.js';
import { getEmployees, insertHeartbeatAnchor } from '../core/db.js';
import type { EmployeeRow } from '../core/employees.js';
import { runSingleAgent } from '../orchestrator/distribute.js';
import { getState } from '../orchestrator/state-machine.js';
import { getGoalContinuationPrompt } from '../goal/heartbeat.js';
import { log } from '../core/logger.js';

const HEARTBEAT_SCOPE = 'default';
/** Execution scope prefix for a mention-watch answer.
 *
 *  The answer belongs to the thread's chat session, but it must NOT run in that
 *  thread's execution scope. A turn registered there shows up as busy to the next
 *  human message, which then gets steered into it instead of starting its own run
 *  (src/orchestrator/gateway.ts, and a steered submission is not `new_run` so
 *  Slack never installs its reply path) — the person's prompt would be answered as
 *  if it were the mention. A lane nobody else submits to keeps the background turn
 *  unsteerable while the session id still puts the answer in the right history. */
const MENTION_WATCH_SCOPE_PREFIX = 'mention-watch:';
/** How long one tick may spend ANSWERING mentions.
 *
 *  A mention-watch tick is a LOOP of orchestrator turns — `maxHits` of them, each
 *  bounded only by an idle timeout — and `heartbeatBusy` is held across all of it,
 *  so one busy morning queues every other job in the home behind it.
 *
 *  Ten minutes matches the script runner's own ceiling at the `execFile` call below,
 *  so no single tick outlasts the slowest bounded runner in this file by design. It
 *  clocks the answering phase only: the scan can legitimately sleep for minutes on
 *  pacing, and charging that to the answer allowance would let a slow scan end a tick
 *  having answered nothing. */
const MENTION_WATCH_ANSWER_BUDGET_MS = 10 * 60_000;
import { applyOutputPolicy, loadPolicyHooksConfig } from '../core/policy-hooks.js';
import { setRecordPending } from '../core/policy-flags.js';
import { parseHeartbeatReport, type HeartbeatReport } from './heartbeat-report.js';
import {
    foldRunRecord,
    isHeartbeatJobFailing,
    type HeartbeatRunOutcome,
    type HeartbeatRunRecord,
} from './heartbeat-run-record.js';
import {
    describeHeartbeatSchedule,
    formatHeartbeatNow,
    getHeartbeatMinuteSlotKey,
    getHeartbeatScheduleTimeZone,
    matchesHeartbeatCron,
    normalizeHeartbeatSchedule,
    startHeartbeatCronLoop,
    validateHeartbeatCron,
} from './heartbeat-schedule.js';

const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatCronSlots = new Map<string, string>();
// Where each `every` job's grid is measured from, with the period it was
// measured for. Survives `stopHeartbeat` on purpose — that is the whole point,
// see `scheduleIntervalJob`.
type IntervalAnchor = { anchor: number; periodMs: number };
const intervalAnchors = new Map<string, IntervalAnchor>();
let heartbeatWatcher: fs.FSWatcher | null = null;
let heartbeatBusy = false;
// One job, one run. `heartbeatBusy` already stops two try-bodies from
// interleaving, because it is set synchronously before the first await, so this
// is not about concurrency. It is about the SAME job being executed twice in a
// row: a tick deferred during an active PABCD cycle stays queued, a later tick
// for that job runs directly once the cycle ends, and the finishing run then
// drains the copy it left behind. Two identical reports, seconds apart. The
// queue dedupe below cannot see this because the second arrival never queues.
const inFlightJobs = new Set<string>();
// Bumped whenever the schedule is torn down, which includes every settings
// reload and every PUT through the API. A run that was admitted under an older
// generation has been superseded: its job object, destination and prompt may all
// have been replaced on disk, so it must not send, write an anchor, or drain.
let heartbeatGeneration = 0;
let heartbeatAbort: AbortController | null = null;
type HeartbeatPendingReason = 'busy' | 'pabcd_active' | 'agent_busy';
type HeartbeatPendingPolicy = 'defer';
interface PendingHeartbeatJob {
    job: Record<string, any>;
    reason: HeartbeatPendingReason;
    policy?: HeartbeatPendingPolicy;
}
const pendingJobs: PendingHeartbeatJob[] = [];
type LiveDestinationHold = { destination: string; reason: HeartbeatHoldReason; observedAt: number };
const liveDestinationHolds = new Map<string, LiveDestinationHold>();
// What each job's last admitted tick did. Process-local on purpose for now: the
// durable home is the anchor table and that schema work is its own unit. A record
// that forgets on restart still beats today's nothing, and the API says so.
const runRecords = new Map<string, HeartbeatRunRecord>();
// Jobs observed running without destination-bound authority. Set membership is
// what makes the notice once-per-job instead of once-per-tick; a warning on every
// five-minute tick is noise an operator learns to skip past.
const unenforcedDestinationJobs = new Set<string>();

/** Environment names the heartbeat script runner must not inherit.
 *
 *  The caller's whole design is to hand the child ONE scoped secret, the Slack tool
 *  grant activated further down. Spreading `process.env` underneath it handed the
 *  same child the raw bot token whenever a channel was configured through the
 *  environment, which this repository explicitly supports — and that makes the
 *  scoped grant decoration.
 *
 *  Matched by PREFIX so a channel variable added later is excluded by default
 *  rather than leaked until someone remembers. Deliberately slightly broad:
 *  allowlists like SLACK_CHANNEL_IDS go too. A script that genuinely needs one can
 *  be given it explicitly; inheriting a credential by accident is what stops. */
const CHANNEL_SECRET_ENV_PREFIXES = ['SLACK_', 'TELEGRAM_', 'DISCORD_'] as const;

export function heartbeatScriptEnv(
    source: NodeJS.ProcessEnv,
    extra: Record<string, string>,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (CHANNEL_SECRET_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
        env[key] = value;
    }
    // Applied AFTER the filter, so the grant the script actually needs survives it.
    return { ...env, ...extra };
}
type HeartbeatDestinationJobRef = { id?: unknown; name?: unknown; destination?: unknown };

function heartbeatJobKey(job: HeartbeatDestinationJobRef): string {
    return String(job.id ?? job.name ?? '');
}

function destinationFingerprint(destination: unknown): string {
    try { return JSON.stringify(destination ?? null); }
    catch { return '[unserializable]'; }
}

/** Process-local live hold for GET/UI. A destination edit invalidates it
 * immediately; a successful later tick clears it. The timer remains armed so a
 * transient Slack failure can recover without an operator save. */
export function getHeartbeatLiveDestinationHold(job: HeartbeatDestinationJobRef): HeartbeatHoldReason | null {
    const key = heartbeatJobKey(job);
    if (!key) return null;
    const hold = liveDestinationHolds.get(key);
    if (!hold) return null;
    if (hold.destination !== destinationFingerprint(job.destination)) {
        liveDestinationHolds.delete(key);
        return null;
    }
    return hold.reason;
}

export function updateHeartbeatLiveDestinationHold(
    job: HeartbeatDestinationJobRef,
    reason: HeartbeatHoldReason | null,
): void {
    const key = heartbeatJobKey(job);
    if (!key) return;
    if (reason === null) {
        liveDestinationHolds.delete(key);
        return;
    }
    liveDestinationHolds.set(key, {
        destination: destinationFingerprint(job.destination),
        reason,
        observedAt: Date.now(),
    });
}

export function isHeartbeatQuietOutput(result: string, extraMarkers: string[] = []): boolean {
    return ['[SILENT]', ...extraMarkers].some(marker => marker.length > 0 && result.includes(marker));
}

/** Turn a stored destination into the one target this job may use.
 *
 *  `targetKind` and `peerKind` are derived from the id — Slack's C/D/G prefixes
 *  decide them — so `targetFromChatId` owns that mapping rather than the
 *  heartbeat file.
 *
 *  There is no longer a "no destination, send anyway" outcome. #437 closed the
 *  case where a malformed destination fell back to the active channel but left
 *  the absent one open, and an absent destination is the same failure wearing
 *  less: a report meant for somewhere specific delivered to whoever spoke last
 *  (#745). Every way of not naming a conversation now holds the send. */
export function heartbeatTarget(destination: unknown): HeartbeatBinding {
    return resolveHeartbeatBinding(destination);
}

function pendingSnapshot(reason?: HeartbeatPendingReason, policy?: HeartbeatPendingPolicy) {
    const deferredPending = pendingJobs.filter(item => item.policy === 'defer').length;
    const agentBusyPending = pendingJobs.filter(item => item.reason === 'agent_busy').length;
    return {
        pending: pendingJobs.length,
        deferredPending,
        agentBusyPending,
        // How many jobs actually own a timer. A job held for an unmigrated ledger
        // is absent here, which is the difference between 'not scheduled' and
        // 'scheduled and refused on every tick'.
        scheduled: heartbeatTimers.size,
        ...(reason ? { reason } : {}),
        ...(policy ? { policy } : {}),
    };
}

function queueHeartbeatJob(
    job: Record<string, any>,
    reason: HeartbeatPendingReason,
    policy?: HeartbeatPendingPolicy,
): boolean {
    if (pendingJobs.some(item => item.job["id"] === job["id"])) return false;
    pendingJobs.push(stripUndefined({ job, reason, policy }));
    broadcast('heartbeat_pending', {
        ...pendingSnapshot(reason, policy),
        jobId: job["id"],
        jobName: job["name"],
    });
    return true;
}

/** Drop any queued copy of a job that is about to run, or has just run. */
function forgetPendingJob(jobId: string): void {
    for (let i = pendingJobs.length - 1; i >= 0; i -= 1) {
        if (String(pendingJobs[i]?.job["id"] ?? "") === jobId) pendingJobs.splice(i, 1);
    }
}

/** The signal a live tick should observe; null until the first run arms one. */
export function heartbeatRunSignal(): AbortSignal | undefined {
    return heartbeatAbort?.signal;
}

export function getHeartbeatRuntimeState() {
    return {
        ...pendingSnapshot(),
        // Jobs whose last ticks all failed or all refused. They keep their timers —
        // this is visibility, not a kill switch.
        failing: [...runRecords.entries()]
            .filter(([, record]) => isHeartbeatJobFailing(record))
            .map(([jobId]) => jobId),
        // Jobs whose destination-bound Slack grant does not exist for their
        // transport. Reported rather than implied: a Discord or Telegram heartbeat
        // otherwise looks exactly like a guarded Slack one.
        unenforcedDestinations: [...unenforcedDestinationJobs],
    };
}

/** The last admitted tick's outcome for a job, or undefined if it has not run in
 *  this process. */
export function getHeartbeatRunRecord(jobId: string): HeartbeatRunRecord | undefined {
    return runRecords.get(jobId);
}

/** Milliseconds until the next boundary of `periodMs` measured from `anchor`.
 *
 *  Always inside `(0, periodMs]`. Landing exactly on a boundary returns a FULL
 *  period rather than zero, so an arm that happens to coincide with one does not
 *  fire immediately and then again a moment later.
 *
 *  A clock that stepped BACKWARDS is clamped to one period instead of returning
 *  the raw distance to the anchor. The raw distance is unbounded: a machine whose
 *  clock jumps back a month would arm a timer for a month, which is not a schedule
 *  and is something `setInterval` could never express. */
export function nextIntervalDelay(anchor: number, periodMs: number, now: number): number {
    const elapsed = now - anchor;
    if (elapsed < 0) return Math.min(-elapsed, periodMs);
    const remainder = elapsed % periodMs;
    return remainder === 0 ? periodMs : periodMs - remainder;
}

/** The instant a job's interval grid is measured from.
 *
 *  Exported because the anchor is otherwise unobservable, and "a save did not
 *  reset the phase" is exactly the property worth asserting. */
export function getHeartbeatIntervalAnchor(jobId: string): number | undefined {
    return intervalAnchors.get(jobId)?.anchor;
}

/** Arm an `every` job on a grid that survives a rebuild.
 *
 *  `setInterval` measured from the arm, and `startHeartbeat` re-arms on boot
 *  (`server.ts`), on every `PUT /api/heartbeat`, on every `heartbeat.json` write
 *  the watcher sees, and on a mention-watch fresh start. A home saved more often
 *  than a job's period therefore never reached that job's first fire, and nothing
 *  logged it because each arm looked correct on its own.
 *
 *  The anchor fixes that: the grid is measured from a fixed instant, so a rebuild
 *  resumes the schedule instead of restarting the wait.
 *
 *  A period CHANGE re-anchors. Keeping the old origin under a new period would let
 *  the next boundary land milliseconds away, so editing 60m to 61m could tick at
 *  once — something the old `setInterval` could not do, and not a regression worth
 *  trading for this. Same period keeps the grid; a different one starts a new one. */
function scheduleIntervalJob(job: Record<string, any>, periodMs: number): void {
    const jobId = String(job["id"]);
    const existing = intervalAnchors.get(jobId);
    const anchor = existing && existing.periodMs === periodMs ? existing.anchor : Date.now();
    intervalAnchors.set(jobId, { anchor, periodMs });
    // Captured, not read live: `runHeartbeatJob` is async, so a teardown can land
    // while it is awaiting. The cron loop needs no equivalent because its
    // `runCurrent` is synchronous and its re-arm cannot be interleaved.
    const generation = heartbeatGeneration;
    const arm = (): void => {
        const timer = setTimeout(() => {
            if (generation !== heartbeatGeneration) return;
            // Re-arm from the same anchor BEFORE running, so a slow turn cannot
            // push the next boundary out.
            arm();
            void runHeartbeatJob(job);
        }, nextIntervalDelay(anchor, periodMs, Date.now()));
        timer.unref?.();
        heartbeatTimers.set(jobId, timer);
    };
    arm();
}

export function startHeartbeat() {
    stopHeartbeat();
    const { jobs } = loadHeartbeatFile();
    // Re-run on every (re)start rather than once at table creation. A job that
    // was absent at upgrade time and returns under the same id later carries the
    // same unmigrated ledger, and a one-shot check would wave it through.
    const held = detectLegacyMentionWatch(Date.now());
    if (held.length) {
        log.warn(`[heartbeat] ${held.length} job(s) held for an unmigrated mention-watch ledger: ${held.join(', ')}`);
    }
    for (const job of jobs) {
        if (!job?.enabled || !job.id) continue;
        // No timer at all for a held job. The tick-time check still has to exist
        // for a hold that appears while a timer is already live, but stopping only
        // there would leave the job counted as active and logging a refusal on
        // every interval — which reads as a broken job rather than a held one.
        if (job.mentionWatch && isQuarantined(job.id)) {
            log.warn(`[heartbeat:${job.name}] not scheduled: unmigrated mention-watch ledger. `
                + `POST /api/heartbeat/${job.id}/mention-watch-fresh-start with a new since to clear it.`);
            continue;
        }
        const schedule = normalizeHeartbeatSchedule(job.schedule);
        if (schedule.kind === 'cron') {
            const cronError = validateHeartbeatCron(schedule.cron);
            if (cronError) {
                log.warn(`[heartbeat:${job.name}] invalid cron "${schedule.cron}": ${cronError}`);
                continue;
            }
            scheduleCronJob(job);
            continue;
        }
        scheduleIntervalJob(job, schedule.minutes * 60_000);
    }
    // Per-job maps outlive their jobs otherwise. Keyed off ABSENCE FROM THE FILE
    // rather than `enabled`, because a disabled job that is re-enabled should keep
    // its cadence. `liveDestinationHolds` is keyed by id-or-name, so its live set
    // uses the same derivation instead of assuming every job carries an id.
    const liveIds = new Set(jobs.map(job => String(job?.id ?? '')).filter(Boolean));
    const liveKeys = new Set(jobs.map(job => heartbeatJobKey(job)).filter(Boolean));
    for (const id of [...intervalAnchors.keys()]) if (!liveIds.has(id)) intervalAnchors.delete(id);
    for (const id of [...heartbeatCronSlots.keys()]) if (!liveIds.has(id)) heartbeatCronSlots.delete(id);
    for (const id of [...runRecords.keys()]) if (!liveIds.has(id)) runRecords.delete(id);
    for (const id of [...unenforcedDestinationJobs]) if (!liveIds.has(id)) unenforcedDestinationJobs.delete(id);
    for (const key of [...liveDestinationHolds.keys()]) if (!liveKeys.has(key)) liveDestinationHolds.delete(key);
    const n = heartbeatTimers.size;
    log.info(`[heartbeat] ${n} job${n !== 1 ? 's' : ''} active`);
}

export function stopHeartbeat() {
    // Tearing down timers was never enough. A tick already inside its try-body
    // kept the job object it was admitted with and went on to send, anchor and
    // write the mention-watch ledger, and the queue it left behind was still
    // drained by whatever finished next, including from the external callers in
    // orchestrator/pipeline, routes/orchestrate, cli/handlers-runtime and
    // agent/spawn/queue. Bump the generation and abort first so an in-flight run
    // stops at its next checkpoint, then drop the queue it would have replayed.
    heartbeatGeneration += 1;
    heartbeatAbort?.abort();
    heartbeatAbort = null;
    pendingJobs.length = 0;
    for (const timer of heartbeatTimers.values()) clearTimeout(timer);
    heartbeatTimers.clear();
    // Cron slots deliberately survive. startHeartbeatCronLoop runs the current
    // minute immediately on arm, so clearing the map here let a save plus the
    // file watcher rebuild the schedule and fire the same minute again. Keeping
    // the slot means the immediate tick recognises work it already did.
    //
    // Interval anchors survive for the same reason, one level up: they exist so a
    // rebuild resumes a job's grid rather than restarting its wait, and clearing
    // them here would reinstate exactly the defect they close.
}

export interface HeartbeatReportDecision { send: boolean; anchor: boolean; delivered: boolean }

export function decideHeartbeatReport(report: HeartbeatReport, policy: string): HeartbeatReportDecision {
    if (policy === 'silent') return { send: false, anchor: true, delivered: false };
    if (policy === 'anomaly_only') {
        const send = report.status !== 'ok' || report.userVisible;
        return { send, anchor: true, delivered: send };
    }
    return { send: true, anchor: true, delivered: true };
}

export function runHeartbeatScript(
    command: string[],
    extraEnv: Record<string, string> = {},
): Promise<HeartbeatReport> {
    return new Promise(resolve => {
        const [file, ...args] = command;
        if (!file) { resolve(parseHeartbeatReport('', 1)); return; }
        execFile(file, args, {
            timeout: 10 * 60_000,
            maxBuffer: 64 * 1024,
            env: heartbeatScriptEnv(process.env, extraEnv),
        }, (error, stdout, stderr) => {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
            resolve(parseHeartbeatReport([stdout, stderr].filter(Boolean).join('\n'), code));
        });
    });
}

async function runEmployee(
    job: Record<string, any>,
    prompt: string,
    requestId: string,
    target: RemoteTarget,
): Promise<HeartbeatReport> {
    const emp = (getEmployees.all() as EmployeeRow[]).find(row => row.name === job["employee"]);
    if (!emp) return parseHeartbeatReport('status: failed\nsummary: employee not found');
    try {
        const slot = claimWorker(emp, prompt, { origin: 'heartbeat', scopeId: HEARTBEAT_SCOPE, chatSessionId: 'default' });
        try {
            const ap = { agent: emp.name, role: emp.role || 'general developer', task: prompt, parallel: false, currentPhase: 0, currentPhaseIdx: 0, phaseProfile: [0], mutable: false, scope: null, task_tags: ['heartbeat'] };
            const result = await runSingleAgent(ap, emp, { tag: `heartbeat:${job["id"] || job["name"]}` }, 1, {
                origin: 'heartbeat',
                scopeKey: HEARTBEAT_SCOPE,
                chatSessionId: 'default',
                requestId,
                target,
            }, []);
            const text = String(result["text"] || '');
            finishWorker(slot.agentId, text, Array.isArray(result["tools"]) ? result["tools"] : []);
            // finishWorker arms a replay for a Boss to collect. A heartbeat has no
            // Boss, so nobody ever collected it — and processQueue skips any scope
            // with a pending replay, so one employee heartbeat left the default
            // queue permanently stalled behind a handoff that would never happen.
            markWorkerReplayed(slot.agentId);
            return parseHeartbeatReport(text);
        } catch (error) {
            failWorker(slot.agentId, error instanceof Error ? error.message : String(error));
            throw error;
        }
    } catch (error) {
        if (error instanceof WorkerBusyError) return parseHeartbeatReport('status: warning\nsummary: skipped: employee busy');
        throw error;
    }
}

/** One mention-watch tick, run in place of the ordinary prompt path.
 *
 *  The agent is asked per message and never posts: this function sends, then
 *  records the receipt. See heartbeat-mention-watch.ts for why that ordering is
 *  the whole point.
 *
 *  Returns false when the job is not runnable as a mention watch at all, so the
 *  caller can say so rather than silently running the prompt against nothing. */
async function runMentionWatchJob(job: Record<string, any>, watch: HeartbeatMentionWatch): Promise<boolean> {
    // Per-hit delivery anchor, read before the agent turn and consumed by the
    // send. Scoped to this call so nothing survives the tick.
    const answerAnchors = new Map<string, number>();
    const sc = settings["slack"] || {};
    const token = String(sc["botToken"] ?? '').trim();
    if (!sc["enabled"] || !token) {
        log.error(`[heartbeat:${job["name"]}] mention watch needs Slack enabled with a bot token`);
        return false;
    }
    // A mention watch answers the thread it found, so it needs no destination of
    // its own. A destination that IS stored still has to be readable: a broken
    // one means the operator meant something this code cannot honour.
    const binding = heartbeatTarget(job["destination"]);
    if (binding.state === 'held' && binding.reason !== 'unbound_destination') {
        log.error(`[heartbeat:${job["name"]}] refuse: ${binding.reason} — mention watch not run`);
        return false;
    }

    const jobId = String(job["id"] ?? job["name"] ?? 'unknown');
    // A job whose v1 ledger was never migrated is HELD until an operator restarts
    // it with a fresh floor. Checked here rather than at load time because the
    // enabled flag in heartbeat.json is the operator's intent, while this is the
    // system's judgement — and a job absent at upgrade time can return under the
    // same id later.
    if (isQuarantined(jobId)) {
        log.error(`[heartbeat:${job["name"]}] held: this job has an unmigrated mention-watch ledger. `
            + `Restart it with a fresh mentionWatch.since to clear the hold.`);
        return false;
    }

    // The ledger is keyed by (workspace, user), so the workspace has to come from
    // Slack rather than from settings — which records a team id once and never
    // re-checks it against the token. Taken ONCE here and passed as an immutable
    // snapshot: re-reading it per write would let a tick that started before a
    // workspace switch file its later rows under the new one.
    const verified = await verifiedSlackWorkspace(token);
    const ns = verified && watchNamespace(jobId, verified.teamId, watch.userId);
    if (!ns) {
        log.error(`[heartbeat:${job["name"]}] could not verify the Slack workspace for this token; `
            + `skipping this tick rather than filing the ledger under a guess`);
        return false;
    }

    const outcome = await runMentionWatchTick(ns, job, watch, {
        token,
        selfUserId: getSlackSelfUserId(),
        allowlist: readSlackAllowlist(sc["channelIds"]),
        answerBudgetMs: MENTION_WATCH_ANSWER_BUDGET_MS,
        log: (message) => log.info(`[heartbeat:${job["name"]}] ${message}`),
        // The tick already knows how to stop: it checks deps.signal before each
        // answer and reports stoppedBecause 'aborted'. Nothing ever handed it one,
        // so a scan that started before a settings reload kept answering and kept
        // writing receipts under the old configuration.
        ...(heartbeatRunSignal() ? { signal: heartbeatRunSignal()! } : {}),
        // Yield to anything a person is waiting on. Re-read per item because the
        // previous answer may have taken minutes.
        yieldNow: (hit) => {
            if (getState('default') !== 'IDLE') return 'yielded';
            if (isAgentBusy(HEARTBEAT_SCOPE)) return 'yielded';
            if (messageQueue.length > 0) return 'yielded';
            if (hasPendingWorkerReplays(HEARTBEAT_SCOPE)) return 'yielded';
            return mentionThreadYield(hit);
        },
        answer: async (hit) => {
            const prompt = buildMentionWatchPrompt(job, watch, hit);
            // Anchored BEFORE the turn runs. The agent is told not to post, and
            // `/api/channel/send` is a tool it can reach anyway; if it does, that
            // send is recorded as a delivery claim. Reading the anchor first is
            // what lets the send below tell "the user already has these words"
            // from "someone said this here an hour ago".
            const anchor = nextDeliverySeq();
            // The answer runs in the SESSION bound to that thread, so it can see
            // what was said there and the next human turn can see this reply. Only
            // now is the session minted: doing it in the guard would create a
            // permanent, undeletable row for every thread merely looked at.
            const placement = mentionThreadPlacement(hit, 'mint');
            const requestId = crypto.randomUUID();
            const target = slackThreadTarget(hit);
            const release = await reserveHeartbeatDestinationGrant(
                { state: 'bound', target, verification: 'unverified' },
                requestId,
                { scope: placement.scope, chatSessionId: placement.chatSessionId },
            );
            if (!release) {
                log.error(`[heartbeat:${job["name"]}] refuse: slack_grant_unavailable — mention-watch answer not run`);
                throw new Error('slack_grant_unavailable');
            }
            try {
                const collected = await sessionLanes.runDetachedTurn(
                    placement.scope,
                    () => orchestrateAndCollectData(prompt, {
                        origin: 'heartbeat', requestId,
                        scope: placement.scope, chatSessionId: placement.chatSessionId,
                        remoteKey: placement.remoteKey,
                        target,
                    }),
                );
                const text = applyOutputPolicy(String(collected.text), { scope: 'heartbeat', channel: 'slack' }).text;
                const quietConfig = loadPolicyHooksConfig()?.flags?.heartbeatQuietOk;
                const extraQuietMarkers = quietConfig?.enabled ? (quietConfig.markers || []) : [];
                if (!text.trim() || isHeartbeatQuietOutput(text, extraQuietMarkers)) return null;
                answerAnchors.set(hit.channelId + '/' + hit.ts, anchor);
                return text;
            } finally {
                release();
            }
        },
        send: async (hit, text) => {
            const key = hit.channelId + '/' + hit.ts;
            const anchor = answerAnchors.get(key);
            answerAnchors.delete(key);
            const target = slackThreadTarget(hit);
            // The agent was told the server posts, and it can still call
            // `/api/channel/send` itself. When it did, these exact words are
            // already in that thread and posting them again is the duplicate the
            // user reported. Treated as DELIVERED, because it is: the answer is on
            // screen, so the receipt should be written and the message not asked
            // about again.
            //
            // `wasSelfDelivered` fails open on every uncertain case, so a claim
            // that does not match still results in a post. A duplicate is
            // annoying; a swallowed answer is the user losing what they waited for.
            if (anchor !== undefined && wasSelfDelivered({ target, text, since: anchor })) {
                log.info(`[heartbeat:${job["name"]}] already delivered by the agent, not posting again`);
                return true;
            }
            // Answer IN THE THREAD that carried the mention. `threadTs` is the
            // parent when the message was already a reply, so this never starts a
            // second thread off a reply.
           const sent = await sendChannelOutput({
               channel: 'slack', type: 'text', text, target,
               allowActiveFallback: false,
               // Deliberately NOT `fromAgentSurface`: a heartbeat is not an agent
               // surface, and recording a delivery claim here would let this
               // background post suppress the turn's real answer.
           });
            if (!sent.ok && sent['retryable'] === false) {
                // Earlier chunks are already on screen; a whole-answer retry would
                // duplicate them. Partial delivery is terminal, not retried.
                log.error(`[heartbeat:${job["name"]}] slack send partially delivered, not retrying: ${sent.error}`);
                return true;
            }
            if (!sent.ok) log.error(`[heartbeat:${job["name"]}] slack send failed: ${sent.error}`);
            return sent.ok;
        },
    });

    const stopped = outcome.stoppedBecause ? ' (stopped: ' + outcome.stoppedBecause + ')' : '';
    // Counts alone cannot tell a caught-up watch from one still draining, which is
    // the distinction the scanner computes and this line used to discard. Neither
    // flag means backlog on its own: `scanIncomplete` also covers a 429 or an
    // aborted walk, and `hitCapReached` is the case where `scanIncomplete` stays
    // false while whole channels went unread.
    const drain = [
        outcome.scanIncomplete ? 'scan incomplete' : '',
        outcome.hitCapReached ? 'hit cap reached' : '',
    ].filter(Boolean).join(', ');
    log.info(`[heartbeat:${job["name"]}] mention watch: ${outcome.answered} answered, ${outcome.quiet} quiet, `
        + `${outcome.failed} failed${stopped}${drain ? ` — ${drain}` : ' — caught up'}`);
    return true;
}

/** Where the answer goes: the thread that carried the mention.
 *
 *  Built from the hit rather than from the job destination, because a
 *  mention-watch answer belongs beside the question. The job destination still
 *  gates whether the job may run (a malformed one refuses), it just does not
 *  choose the thread. */
function slackThreadTarget(hit: MentionHit): RemoteTarget {
    const base = targetFromChatId('slack', hit.channelId);
    // The flag rides along or this target keys a thread that does not exist,
    // which is the #520 defect on the mention-watch side.
    return {
        ...base,
        threadId: hit.threadTs,
        ...(hit.threadIsSynthetic ? { threadIsSynthetic: true } : {}),
    };
}


/** Where a mention-watch answer runs: the thread's SESSION, its own SCOPE.
 *
 *  Splitting the two is the point. The session id decides which history the turn
 *  reads and writes, and that has to be the thread the question is in. The scope
 *  decides which execution lane runs it, and that must be one no inbound message
 *  can reach — otherwise the next human message in that thread is steered into
 *  this background turn instead of getting its own.
 *
 *  `mode` controls whether a thread with no session yet gets one. The guard looks
 *  up only ('lookup'); the answer path mints ('mint'). Minting is a permanent row
 *  the sessions API refuses to delete, so a scan that merely READ a thread must not
 *  leave one behind. */
export function mentionThreadPlacement(
    hit: MentionHit,
    mode: 'lookup' | 'mint',
): { scope: string; chatSessionId: string; remoteKey: string } {
    const remoteKey = buildRemoteBindingKey(slackThreadTarget(hit));
    // With the gate off there are no per-conversation sessions to bind to, so the
    // shared one is the only honest answer. The scope stays separate regardless:
    // steerability does not depend on the gate.
    const bound = channelGateOn('slack') && settings["multiSession"]?.enabled === true
        ? (mode === 'mint' ? resolveOrCreateRemoteSession(remoteKey) : getRemoteBoundSessionId(remoteKey))
        : 'default';
    return {
        scope: MENTION_WATCH_SCOPE_PREFIX + remoteKey,
        chatSessionId: bound ?? 'default',
        remoteKey,
    };
}

/** Whether this thread has work that outranks answering a mention in it.
 *
 *  Three conditions, and each covers a case the others miss.
 *
 *  - A non-IDLE PABCD state means the thread is mid-cycle even with nothing
 *    running. Answering into it would let the pipeline's P post-processing save
 *    this background reply as that thread's plan.
 *  - `hasChatSessionWork` covers a turn actually in flight for that session,
 *    plus its queued messages, workers and retries.
 *  - A pending lane is checked, never awaited. A lane wait is unbounded and
 *    `heartbeatBusy` is held across this whole tick, so enqueueing behind a long
 *    human turn would stall every other heartbeat job with it. */
export function mentionThreadYield(
    hit: MentionHit,
    probes: {
        state?: (scope: string) => string;
        sessionWork?: (sessionId: string) => boolean;
        lanePending?: (scope: string) => boolean;
    } = {},
): 'yielded' | null {
    const { remoteKey, chatSessionId } = mentionThreadPlacement(hit, 'lookup');
    const readState = probes.state ?? getState;
    const readSessionWork = probes.sessionWork ?? hasChatSessionWork;
    const readLane = probes.lanePending ?? ((scope: string) => sessionLanes.hasPending(scope));
    if (readState(remoteKey) !== 'IDLE') return 'yielded';
    if (chatSessionId !== 'default' && readSessionWork(chatSessionId)) return 'yielded';
    if (readLane(remoteKey)) return 'yielded';
    return null;
}
/** The per-message prompt.
 *
 *  The job's own prompt carries the PERSPECTIVE — whose stance to answer with,
 *  which notes or wiki paths to ground it in. That stays operator-owned and
 *  out of code: hard-coding one person's opinions here would make the feature
 *  unusable for anyone else, and the stance is exactly the part that changes.
 *  Code supplies only the message that needs answering. */
function buildMentionWatchPrompt(
    job: Record<string, any>,
    watch: HeartbeatMentionWatch,
    hit: MentionHit,
): string {
    const author = hit.authorId ? `<@${hit.authorId}>` : 'unknown';
    return [
        `[heartbeat:${job["name"]}] Slack mention watch`,
        '',
        `<@${watch.userId}> was mentioned in a message you are asked to answer on their behalf.`,
        `channel: ${hit.channelId}`,
        `thread: ${hit.threadTs}`,
        `author: ${author}`,
        '',
        '--- Message ---',
        hit.text,
        '--- End Message ---',
        '',
        // The server posts the reply. An agent that also posts would double it,
        // and its own send would not be covered by the per-message receipt.
        'Reply with the ANSWER TEXT ONLY. Do not call any Slack send API yourself —',
        'the server posts your reply into that thread. Answer [SILENT] if no reply is warranted.',
        '',
        job["prompt"] || '',
    ].join('\n');
}

export type HeartbeatJobDeps = {
    verifyDestination?: (destination: unknown) => Promise<HeartbeatBinding>;
    reserveDestinationGrant?: (binding: Extract<HeartbeatBinding, { state: 'bound' }>, requestId: string) =>
        Promise<(() => void) | null>;
    activateDestinationGrant?: (requestId: string) => string | undefined;
};

async function reserveHeartbeatDestinationGrant(
    binding: Extract<HeartbeatBinding, { state: 'bound' }>,
    requestId: string,
    activation: { scope: string; chatSessionId: string } = { scope: HEARTBEAT_SCOPE, chatSessionId: 'default' },
): Promise<(() => void) | null> {
    if (binding.target.channel !== 'slack') return () => {};
    const token = String(settings["slack"]?.botToken ?? '').trim();
    const workspace = await verifiedSlackWorkspace(token, { sensitiveResponse: true }).catch(() => null);
    if (!workspace?.userId) return null;
    const reserved = reserveSlackToolGrant({
        teamId: workspace.teamId,
        actorId: workspace.userId,
        destination: binding.target,
        credentialKey: slackCredentialKey(token),
        enforceDestination: true,
    }, { requestId, scope: activation.scope, chatSessionId: activation.chatSessionId });
    return reserved ? () => revokeSlackToolGrant(requestId) : null;
}

export async function runHeartbeatJob(job: Record<string, any>, deps: HeartbeatJobDeps = {}) {
    const runner = job["runner"] || 'main';
    const jobId = String(job["id"] ?? job["name"] ?? '');
    // Checked before every other guard. A job already executing must be skipped
    // outright, not queued: queueing it is what produced the back-to-back double
    // report, because the finishing run drains what the queue still holds.
    if (jobId && inFlightJobs.has(jobId)) {
        log.info(`[heartbeat:${job["name"]}] already running, skip`);
        return;
    }
    if (runner === 'main' && getState('default') !== 'IDLE') {
        const queued = queueHeartbeatJob(job, 'pabcd_active', 'defer');
        log.info(`[heartbeat:${job["name"]}] ${queued ? 'deferred' : 'already deferred'} during active PABCD (${pendingJobs.length} pending)`);
        return;
    }
    if (heartbeatBusy) {
        if (queueHeartbeatJob(job, 'busy')) {
            log.info(`[heartbeat:${job["name"]}] queued (${pendingJobs.length} pending)`);
        } else {
            log.info(`[heartbeat:${job["name"]}] already queued, skip`);
        }
        return;
    }
    if (runner === 'main' && isAgentBusy(HEARTBEAT_SCOPE)) {
        const queued = queueHeartbeatJob(job, 'agent_busy', 'defer');
        log.info(`[heartbeat:${job["name"]}] ${queued ? 'deferred' : 'already deferred'} during active main agent (${pendingJobs.length} pending)`);
        return;
    }
    heartbeatBusy = true;
    // Admission point. From here the run owns this id, and the queue must not
    // keep a copy of it: a deferred entry for this job was satisfied by this very
    // tick. The generation is captured so the finally block can tell whether the
    // schedule was torn down underneath it.
    const generation = heartbeatGeneration;
    if (jobId) {
        inFlightJobs.add(jobId);
        forgetPendingJob(jobId);
    }
    if (!heartbeatAbort) heartbeatAbort = new AbortController();
    const startedAt = Date.now();
    // Deliberately `error`: a path that leaves without naming its outcome is a bug,
    // and a record saying so is more useful than one quietly claiming success.
    let outcome: HeartbeatRunOutcome = { execution: 'error', delivery: 'not_requested', reason: 'no outcome recorded' };
    try {
        // A mention watch replaces the prompt path entirely: its prompt describes
        // how to answer a message that has not been found yet, so running it bare
        // would answer nothing and deliver that to the job's destination. Inside
        // the try so the finally still clears `heartbeatBusy` and drains.
        const watch = job["mentionWatch"];
        if (watch != null) {
            if (!isHeartbeatMentionWatch(watch)) {
                log.error(`[heartbeat:${job["name"]}] invalid mention watch — not run`);
                outcome = { execution: 'skipped', delivery: 'not_requested', reason: 'invalid_mention_watch' };
                return;
            }
            // The boolean was already returned and already discarded. It is the only
            // thing that separates a watch that ran from one that refused for a
            // reason of its own — a disabled Slack, a quarantined ledger, an
            // unverifiable workspace — so it stops being thrown away here.
            const ran = await runMentionWatchJob(job, watch);
            outcome = ran
                ? { execution: 'ok', delivery: 'not_requested' }
                : { execution: 'skipped', delivery: 'not_requested', reason: 'mention_watch_not_runnable' };
            return;
        }
        // Resolve and, for a Slack thread, prove the destination BEFORE spending
        // model, employee or script work. A report whose address is stale or
        // unverified must not run first and discover only at delivery time that
        // it has nowhere safe to go (#745).
        const destinationBinding = await (deps.verifyDestination
            ?? ((destination: unknown) => verifyHeartbeatThreadBindingLive(destination, {
                token: String(settings["slack"]?.botToken ?? ''),
            })))(job["destination"]);
        if (destinationBinding.state === 'held') {
            updateHeartbeatLiveDestinationHold(job, destinationBinding.reason);
            log.error(`[heartbeat:${job["name"]}] refuse: ${destinationBinding.reason} — ${heartbeatHoldMessage(destinationBinding.reason)}`);
            outcome = { execution: 'skipped', delivery: 'not_requested', reason: destinationBinding.reason };
            return;
        }
        updateHeartbeatLiveDestinationHold(job, null);
        // `reserveHeartbeatDestinationGrant` returns a bare releaser for any
        // non-Slack target, which reads at the call site exactly like a successful
        // reservation. The public contract already says the grant is Slack's; the
        // runtime said nothing, so a Discord tick looked guarded in the logs.
        if (jobId && destinationBinding.target.channel !== 'slack' && !unenforcedDestinationJobs.has(jobId)) {
            unenforcedDestinationJobs.add(jobId);
            log.warn(`[heartbeat:${job["name"]}] ${destinationBinding.target.channel} destination runs without `
                + `destination-bound authority — the enforceDestination grant exists only for Slack`);
        }
        const schedule = normalizeHeartbeatSchedule(job["schedule"]);
        const timeZone = getHeartbeatScheduleTimeZone(schedule);
        const now = formatHeartbeatNow(schedule);
        const goalPrompt = getGoalContinuationPrompt();
        const goalSection = goalPrompt ? `\n\n--- Active Goal ---\n${goalPrompt}\n--- End Goal ---\n` : '';
        const prompt = `[heartbeat:${job["name"]}] 현재 시간: ${now} (${timeZone})\n\nBefore responding, you MUST search memory (cli-jaw memory search) for recent conversation context, user preferences, and ongoing tasks. Use this context to ground your response.${goalSection}\n\n${job["prompt"] || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        log.info(`[heartbeat:${job["name"]}] tick (${describeHeartbeatSchedule(schedule)})`);
        const withDestinationGuard = async <T>(
            operation: (requestId: string) => Promise<T>,
        ): Promise<{ ok: true; value: T } | { ok: false }> => {
            const requestId = crypto.randomUUID();
            const release = await (deps.reserveDestinationGrant ?? reserveHeartbeatDestinationGrant)(
                destinationBinding,
                requestId,
            );
            if (!release) {
                updateHeartbeatLiveDestinationHold(job, 'slack_grant_unavailable');
                return { ok: false };
            }
            try {
                return { ok: true, value: await operation(requestId) };
            } finally {
                release();
            }
        };
        let rawResult: string;
        if (runner === 'employee') {
            const guarded = await withDestinationGuard(
                requestId => runEmployee(job, prompt, requestId, destinationBinding.target).then(report => report.raw),
            );
            if (!guarded.ok) {
                log.error(`[heartbeat:${job["name"]}] refuse: slack_grant_unavailable — employee authority could not be reserved`);
                outcome = { execution: 'skipped', delivery: 'not_requested', reason: 'slack_grant_unavailable' };
                return;
            }
            rawResult = guarded.value;
        } else if (runner === 'script') {
            const guarded = await withDestinationGuard(async requestId => {
                let grantEnv: Record<string, string> = {};
                if (destinationBinding.target.channel === 'slack') {
                    const secret = (deps.activateDestinationGrant
                        ?? (id => activateSlackToolGrant(id, HEARTBEAT_SCOPE, 'default')))(requestId);
                    if (!secret) throw new Error('slack_grant_activation_failed');
                    grantEnv = { [SLACK_TOOL_GRANT_ENV]: secret };
                }
                return runHeartbeatScript(job["command"] || [], grantEnv);
            });
            if (!guarded.ok) {
                log.error(`[heartbeat:${job["name"]}] refuse: slack_grant_unavailable — script authority could not be reserved`);
                outcome = { execution: 'skipped', delivery: 'not_requested', reason: 'slack_grant_unavailable' };
                return;
            }
            const scriptReport = guarded.value;
            rawResult = scriptReport.status === 'failed' && !/^status:/m.test(scriptReport.raw)
                ? `${scriptReport.raw}\nstatus: failed\nsummary: ${scriptReport.summary || 'script failed'}`
                : scriptReport.raw;
        } else {
            const collect = async () => {
                const guarded = await withDestinationGuard(
                    requestId => orchestrateAndCollectData(prompt, {
                        origin: 'heartbeat',
                        requestId,
                        scope: HEARTBEAT_SCOPE,
                        chatSessionId: 'default',
                        target: destinationBinding.target,
                    }),
                );
                return guarded.ok ? guarded.value : null;
            };
            const first = await collect();
            if (!first) {
                log.error(`[heartbeat:${job["name"]}] refuse: slack_grant_unavailable — destination-bound Slack authority could not be reserved`);
                outcome = { execution: 'skipped', delivery: 'not_requested', reason: 'slack_grant_unavailable' };
                return;
            }
            const collected = first.data.agyPlannerOnly === true
                ? await collect()
                : first;
            if (!collected) {
                log.error(`[heartbeat:${job["name"]}] refuse: slack_grant_unavailable — retry authority could not be reserved`);
                outcome = { execution: 'skipped', delivery: 'not_requested', reason: 'slack_grant_unavailable' };
                return;
            }
            rawResult = String(collected.text);
        }
        const result = applyOutputPolicy(rawResult, { scope: 'heartbeat', channel: 'active' }).text;

        const quietConfig = loadPolicyHooksConfig()?.flags?.heartbeatQuietOk;
        const extraQuietMarkers = quietConfig?.enabled ? (quietConfig.markers || []) : [];
        if (isHeartbeatQuietOutput(result, extraQuietMarkers)) {
            log.info(`[heartbeat:${job["name"]}] silent`);
            outcome = { execution: 'ok', delivery: 'suppressed' };
            return;
        }

        const report = parseHeartbeatReport(result);
        if (report.recordRequired) setRecordPending(report.evidence || report.summary || result);
        const policy = job["reportPolicy"] || 'always';
        const decision = decideHeartbeatReport(report, policy);
        const deliveryText = report.summary || result;
        const formatted = report.status === 'ok' ? deliveryText : `[${report.status}] ${deliveryText}`;

        log.info(`[heartbeat:${job["name"]}] response: ${result.slice(0, 80)}`);

        // A job goes to the conversation it names and nowhere else. The
        // active-channel fallback that used to stand in for a missing
        // destination is gone: it delivered to whoever spoke to the bot most
        // recently, which is not a property of this job at all (#437, #745).
        //
        // `fullAccess` because this target is not caller input. It came from
        // `resolveHeartbeatBinding(job.destination)` — operator-written config in
        // heartbeat.json, already refused unless it names a thread or says
        // `channel_root` on purpose — which is the same authority class as the
        // `slack.channelIds` allowlist and is never readable from HTTP JSON.
        // Without it the send fell through to `authorizeExplicitTarget`, whose
        // only remaining vouchers are the last-active slot and an existing
        // binding. So a correctly configured job posting to a channel nobody had
        // recently addressed the bot in got `Invalid or disallowed target`, and
        // the operator's explicit choice ranked BELOW whoever spoke most
        // recently. Widening `slack.channelIds` is not the alternative: that
        // list also gates inbound, so naming the report channels there would
        // stop the bot answering mentions everywhere else.
        const sendResult = !decision.send
            ? { ok: true as const }
            : await sendChannelOutput({ channel: destinationBinding.target.channel, type: 'text', text: formatted,
                target: destinationBinding.target, allowActiveFallback: false, fullAccess: true })
                // A transport that THROWS is still a delivery failure, not a failed
                // job. Without this it lands in the catch below beside a crashed
                // runner and counts against the execution streak.
                .catch((error: unknown) => ({ ok: false as const, error: (error as Error).message }));
        if (!sendResult.ok) {
            log.error(`[heartbeat:${job["name"]}] send failed: ${sendResult.error}`);
        }

        // Record heartbeat anchor for context injection on next user turn
        if (decision.anchor && sendResult.ok) {
            const now = Date.now();
            try {
                insertHeartbeatAnchor.run(
                    job["id"], job["name"], settings["workingDir"],
                    destinationBinding.target.channel,
                    destinationBinding.target.targetId,
                    job["prompt"], decision.delivered ? formatted : `[quiet] ${formatted}`, now, decision.delivered ? now : null,
                );
            } catch (e) {
                log.error(`[heartbeat:${job["name"]}] anchor save failed:`, (e as Error).message);
            }
        }
        // Delivery is decided here, from the decision and the result, rather than
        // hung on a line further up. A job whose policy says stay quiet synthesizes
        // `{ ok: true }` WITHOUT sending, so reading success off that would file a
        // tick that posted nothing as delivered.
        outcome = {
            execution: 'ok',
            delivery: !decision.send ? 'not_requested' : sendResult.ok ? 'delivered' : 'not_delivered',
            ...(sendResult.ok ? {} : { reason: 'send_failed' }),
        };
    } catch (err) {
        log.error(`[heartbeat:${job["name"]}] error:`, (err as Error).message);
        outcome = { execution: 'error', delivery: 'not_requested', reason: (err as Error).message };
    } finally {
        heartbeatBusy = false;
        if (jobId) inFlightJobs.delete(jobId);
        if (jobId) {
            const record = foldRunRecord(runRecords.get(jobId), {
                jobId, startedAt, finishedAt: Date.now(),
                superseded: generation !== heartbeatGeneration,
                ...outcome,
            });
            runRecords.set(jobId, record);
            broadcast('heartbeat_run', record);
        }
        // A superseded run must not hand work to the next one. Draining here after
        // stopHeartbeat would replay jobs from a configuration the operator has
        // already replaced, which is exactly what made stop look advisory.
        if (generation === heartbeatGeneration) await drainPending();
    }
}

export async function drainPending() {
    if (pendingJobs.length === 0) return;
    // Reachable from orchestrator/pipeline, routes/orchestrate, cli/handlers-runtime
    // and agent/spawn/queue, none of which know whether the schedule is still
    // armed. Without this a stopped heartbeat kept starting jobs.
    if (heartbeatTimers.size === 0) return;
    if (isAgentBusy(HEARTBEAT_SCOPE) || messageQueue.length > 0 || hasPendingWorkerReplays(HEARTBEAT_SCOPE)) return;
    const next = pendingJobs.shift()?.job;
    if (!next) return;
    broadcast('heartbeat_pending', pendingSnapshot());
    log.info(`[heartbeat:${next["name"]}] dequeued (${pendingJobs.length} remaining)`);
    await runHeartbeatJob(next);
}

function scheduleCronJob(job: Record<string, any>) {
    const armNextTick = (tick: () => void) => {
        const timer = setTimeout(tick, msUntilNextMinute());
        timer.unref?.();
        heartbeatTimers.set(job["id"], timer);
    };
    startHeartbeatCronLoop(() => maybeRunCronJob(job), armNextTick);
}

function maybeRunCronJob(job: Record<string, any>) {
    const schedule = normalizeHeartbeatSchedule(job["schedule"]);
    if (schedule.kind !== 'cron') return;
    const timeZone = getHeartbeatScheduleTimeZone(schedule);
    if (!matchesHeartbeatCron(schedule.cron, new Date(), timeZone)) return;
    const slotKey = getHeartbeatMinuteSlotKey(schedule);
    if (heartbeatCronSlots.get(job["id"]) === slotKey) return;
    heartbeatCronSlots.set(job["id"], slotKey);
    void runHeartbeatJob(job);
}

function msUntilNextMinute(): number {
    const now = Date.now();
    const remainder = now % 60_000;
    return (remainder === 0 ? 60_000 : 60_000 - remainder) + 250;
}

// ─── fs.watch — auto-reload on file change ───────────

export function watchHeartbeatFile() {
    closeHeartbeatWatcher();
    try {
        let watchDebounce: ReturnType<typeof setTimeout> | undefined;
        const dir = dirname(HEARTBEAT_JOBS_PATH);
        const name = basename(HEARTBEAT_JOBS_PATH);
        heartbeatWatcher = fs.watch(dir, (_event, changed) => {
            if (changed && changed !== name) return;
            clearTimeout(watchDebounce);
            watchDebounce = setTimeout(() => {
                log.info('[heartbeat] file changed — reloading');
                startHeartbeat();
            }, 500);
        });
        heartbeatWatcher.on('error', () => {});
    } catch { /* expected: home dir missing in tests */ }
}

export function closeHeartbeatWatcher() {
    if (heartbeatWatcher) {
        heartbeatWatcher.close();
        heartbeatWatcher = null;
    }
}

// Re-export for route handlers
export { loadHeartbeatFile, saveHeartbeatFile };
