import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { HeartbeatDestination } from '../core/config.js';
import type { CapturedPeriod } from './period-thread-key.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const rootDir = () => path.join(process.env['CLI_JAW_SHARED_HOME'] || path.join(os.homedir(), '.cli-jaw-shared'), 'period-threads');
export function periodThreadRootHash(teamId: string, destination: HeartbeatDestination, captured: CapturedPeriod): string {
    const p = destination.periodThread!;
    return hash([teamId, destination.targetId, p.rootKey, p.period, captured.periodKey].join('|'));
}
export function periodThreadReplyHash(rootHash: string, slot: string, botUserId: string): string {
    return hash([rootHash, slot, botUserId].join('|'));
}
export function periodThreadMarkerHash(destination: HeartbeatDestination, captured: CapturedPeriod): string {
    const p = destination.periodThread!;
    return hash([destination.targetId, p.title, p.period, captured.periodKey].join('|'));
}

function dir(name: 'claims' | 'roots' | 'replies' | 'slots'): string {
    const parent = rootDir();
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const location = path.join(parent, name);
    fs.mkdirSync(location, { recursive: true, mode: 0o700 });
    return location;
}
function readJson<T>(file: string): T | null {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function claim(file: string, value: object): boolean {
    try { fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
function info(file: string, value: object): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
}
function claimIdentity() { return { pid: process.pid, host: os.hostname(), at: Date.now() }; }

export function registerPeriodThreadMarker(destination: HeartbeatDestination, captured: CapturedPeriod): boolean {
    const file = path.join(dir('claims'), `marker.${periodThreadMarkerHash(destination, captured)}`);
    if (claim(file, { rootKey: destination.periodThread!.rootKey })) return true;
    return readJson<{ rootKey?: string }>(file)?.rootKey === destination.periodThread!.rootKey;
}
export function claimPeriodThreadCreation(rootHash: string): { status: 'claimed' | 'in_progress' | 'uncertain' | 'exhausted'; attempt: number } {
    const claims = dir('claims');
    for (let attempt = 1; attempt <= 3; attempt++) {
        const file = path.join(claims, `${rootHash}.create.${attempt}`);
        if (claim(file, claimIdentity())) return { status: 'claimed', attempt };
        const rejected = fs.existsSync(`${file}.rejected`);
        if (!rejected) return { status: attempt === 1 ? 'in_progress' : 'uncertain', attempt };
    }
    return { status: 'exhausted', attempt: 3 };
}
export function rejectPeriodThreadCreation(rootHash: string, attempt: number): void {
    claim(path.join(dir('claims'), `${rootHash}.create.${attempt}.rejected`), { at: Date.now() });
}
export function claimPeriodThreadReply(replyHash: string): boolean {
    return claim(path.join(dir('claims'), `${replyHash}.reply`), claimIdentity());
}
export function hasPeriodThreadReplyClaim(replyHash: string): boolean {
    return fs.existsSync(path.join(dir('claims'), `${replyHash}.reply`));
}
export type PeriodRootInfo = { schema: 1; teamId: string; channelId: string; rootKey: string; period: 'day' | 'week'; periodKey: string; ts?: string; authorUserId?: string; lastCode: string; updatedAt: number };
export function writePeriodRootInfo(rootHash: string, value: PeriodRootInfo): void { info(path.join(dir('roots'), `${rootHash}.json`), value); }
export function readPeriodRootInfo(rootHash: string): PeriodRootInfo | null { return readJson(path.join(dir('roots'), `${rootHash}.json`)); }
export type PeriodReplyInfo = { status: 'claimed' | 'delivered' | 'failed' | 'delivered_by_agent'; updatedAt: number };
export function writePeriodReplyInfo(replyHash: string, status: PeriodReplyInfo['status']): void {
    info(path.join(dir('replies'), `${replyHash}.json`), { status, updatedAt: Date.now() });
}
export function readPeriodReplyInfo(replyHash: string): PeriodReplyInfo | null { return readJson(path.join(dir('replies'), `${replyHash}.json`)); }
export function periodThreadClaims(rootHash: string): { create: number | null; rejected: boolean } {
    const claims = dir('claims');
    for (let attempt = 3; attempt >= 1; attempt--) {
        if (fs.existsSync(path.join(claims, `${rootHash}.create.${attempt}`))) {
            return { create: attempt, rejected: fs.existsSync(path.join(claims, `${rootHash}.create.${attempt}.rejected`)) };
        }
    }
    return { create: null, rejected: false };
}

export function readPeriodThreadDiagnostic(destination: HeartbeatDestination, captured: CapturedPeriod): {
    root: PeriodRootInfo | null; reply: PeriodReplyInfo | null; claims: { create: number | null; rejected: boolean };
} {
    const location = path.join(rootDir(), 'roots');
    let root: PeriodRootInfo | null = null;
    let rootHash: string | null = null;
    try {
        for (const name of fs.readdirSync(location)) {
            if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
            const candidate = readJson<PeriodRootInfo>(path.join(location, name));
            if (candidate?.channelId === destination.targetId && candidate.rootKey === destination.periodThread!.rootKey
                && candidate.period === destination.periodThread!.period && candidate.periodKey === captured.periodKey) {
                root = candidate; rootHash = name.slice(0, 32); break;
            }
        }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!rootHash) return { root: null, reply: null, claims: { create: null, rejected: false } };
    const claimsDir = path.join(rootDir(), 'claims');
    let create: number | null = null;
    for (let attempt = 3; attempt >= 1; attempt--) {
        if (fs.existsSync(path.join(claimsDir, `${rootHash}.create.${attempt}`))) { create = attempt; break; }
    }
    const reply = destination.periodThread!.role === 'creator' && root?.authorUserId
        ? readJson<PeriodReplyInfo>(path.join(rootDir(), 'replies', `${periodThreadReplyHash(rootHash, destination.periodThread!.slot, root.authorUserId)}.json`))
        : null;
    return { root, reply, claims: { create, rejected: create !== null && fs.existsSync(path.join(claimsDir, `${rootHash}.create.${create}.rejected`)) } };
}

type Sequence = { pid: number; host: string; token: string; at: number };
function alive(entry: Sequence): boolean {
    if (entry.host !== os.hostname()) return true;
    try { process.kill(entry.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function sequences(): Array<{ number: number; file: string; entry: Sequence; issued: boolean }> {
    const location = dir('slots');
    const names = fs.readdirSync(location);
    const nameSet = new Set(names);
    const numbered = new Map<number, { number: number; file: string; entry: Sequence; issued: boolean }>();
    for (const name of names) {
        const match = /^issued\.(\d+)$/.exec(name);
        if (!match || nameSet.has(`done.${match[1]}`)) continue;
        const entry = readJson<Sequence>(path.join(location, name));
        if (entry) numbered.set(Number(match[1]), { number: Number(match[1]), file: path.join(location, `seq.${match[1]}`), entry, issued: true });
    }
    for (const name of names) {
        const match = /^seq\.(\d+)$/.exec(name);
        if (!match || numbered.has(Number(match[1])) || nameSet.has(`done.${match[1]}`)) continue;
        const entry = readJson<Sequence>(path.join(location, name));
        if (entry) numbered.set(Number(match[1]), { number: Number(match[1]), file: path.join(location, name), entry, issued: false });
    }
    return [...numbered.values()];
}
function cleanupDead(entries: ReturnType<typeof sequences>): ReturnType<typeof sequences> {
    return entries.filter(item => {
        if (alive(item.entry)) return true;
        if (item.issued) claim(path.join(dir('slots'), `done.${item.number}`), { at: Date.now() });
        try { fs.unlinkSync(item.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return false;
    });
}
export async function acquirePeriodConsumerSlot(maxConcurrent = 2, waitSeconds = 300): Promise<(() => void) | null> {
    const token = randomUUID();
    const location = dir('slots');
    // Permanent issue receipts prevent a number from being recycled after every
    // active sequence has gone. Otherwise a concurrent dead-sequence collector
    // could unlink a new owner's sequence under the same name.
    const issued = fs.readdirSync(location).flatMap(name => {
        const match = /^(?:issued|seq)\.(\d+)$/.exec(name);
        return match ? [Number(match[1])] : [];
    });
    let number = issued.reduce((maximum, value) => Math.max(maximum, value), 0) + 1;
    const identity = { ...claimIdentity(), token };
    while (!claim(path.join(location, `issued.${number}`), identity)) number++;
    const file = path.join(location, `seq.${number}`);
    if (!claim(file, identity)) throw new Error('period_consumer_sequence_collision');
    const release = () => {
        if (readJson<Sequence>(file)?.token === token) {
            claim(path.join(location, `done.${number}`), { at: Date.now() });
            try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
    };
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
        const active = cleanupDead(sequences());
        if (active.filter(item => item.number < number).length < maxConcurrent) return release;
        if (Date.now() >= deadline) { release(); return null; }
        await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, deadline - Date.now()))));
    }
}
