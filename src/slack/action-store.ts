import type { Database as SqliteDatabase } from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { SlackToolGrant } from './tool-context.js';
import type { RemoteTarget } from '../messaging/types.js';

export type ActionResource = { workspace: string; kind: string; id: string; actor: string; channel: string; botUserId: string; credentialKey: string; status: 'active' | 'retired'; metadata: Record<string, unknown> };
export type HeldSlackAction = { operation: string; invocationId: string; requested: Record<string, unknown>; originalTarget: { channel: string; threadTs: string }; sourceTarget: { channel: string; threadTs: string }; reason: string };
export type StoredAction = { request_hash: string; status: string; receipt_json: string | null };
const INVOCATION_CAP = 100000;
const RESOURCE_CAP = 10000;
export class SlackActionStore {
    constructor(private readonly database: SqliteDatabase) {
        database.exec(`CREATE TABLE IF NOT EXISTS slack_blocked_actions (
            workspace TEXT NOT NULL, actor TEXT NOT NULL, invocation_id TEXT NOT NULL,
            credential_key TEXT NOT NULL, source_channel TEXT NOT NULL, source_thread TEXT NOT NULL,
            source_request TEXT NOT NULL, source_session TEXT NOT NULL, requested_channel TEXT NOT NULL, requested_thread TEXT NOT NULL, operation TEXT NOT NULL,
            requested_json TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
            PRIMARY KEY(workspace,actor,invocation_id));
            CREATE TABLE IF NOT EXISTS slack_tool_invocations (
            workspace TEXT NOT NULL, actor TEXT NOT NULL, invocation_id TEXT NOT NULL,
            request_hash TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(workspace,actor,invocation_id));
            CREATE TABLE IF NOT EXISTS slack_tool_resources (
            workspace TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
            actor TEXT NOT NULL, channel TEXT NOT NULL, bot_user_id TEXT NOT NULL,
            credential_key TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
            PRIMARY KEY(workspace,kind,resource_id));
            CREATE TABLE IF NOT EXISTS slack_tool_verified (
            workspace TEXT NOT NULL, credential_key TEXT NOT NULL, operation TEXT NOT NULL,
            verified_at INTEGER NOT NULL, PRIMARY KEY(workspace,credential_key,operation));`);
    }
    holdBlocked(grant: SlackToolGrant, operation: string, raw: Record<string, unknown>, reason: string): void {
        const id = raw['invocationId'];
        if (typeof id !== 'string' || this.invocation(grant.teamId, grant.actorId, id)) return;
        const channel = raw['channel']; const thread = raw['threadTs'];
        if (typeof channel !== 'string' || typeof thread !== 'string' || !thread) return;
        const requested = JSON.stringify(raw);
        if (Buffer.byteLength(requested) > 16384) return;
        this.database.prepare(`INSERT OR IGNORE INTO slack_blocked_actions
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?, 'held'
            WHERE (SELECT COUNT(*) FROM slack_blocked_actions) < 128`)
            .run(grant.teamId, grant.actorId, id, grant.credentialKey, grant.destination.targetId,
                grant.destination.threadId ?? '', grant.requestId, grant.chatSessionId, channel, thread, operation, requested, reason);
    }
    blockedFor(grant: SlackToolGrant): HeldSlackAction[] {
        return (this.database.prepare(`SELECT operation,invocation_id,requested_json,source_channel,source_thread,requested_channel,requested_thread,reason
            FROM slack_blocked_actions b WHERE workspace=? AND actor=? AND credential_key=? AND source_channel=?
            AND requested_channel=source_channel AND requested_thread=? AND source_request<>? AND state='held'
            AND NOT EXISTS (SELECT 1 FROM slack_tool_invocations i WHERE i.workspace=b.workspace AND i.actor=b.actor AND i.invocation_id=b.invocation_id)
            ORDER BY rowid LIMIT 1`)
            .all(grant.teamId, grant.actorId, grant.credentialKey, grant.destination.targetId,
                grant.destination.threadId ?? '', grant.requestId) as Array<Record<string, unknown>>)
            .map(row => ({ operation: String(row['operation']), invocationId: String(row['invocation_id']),
                requested: JSON.parse(String(row['requested_json'])) as Record<string, unknown>,
                originalTarget: { channel: String(row['requested_channel']), threadTs: String(row['requested_thread']) },
                sourceTarget: { channel: String(row['source_channel']), threadTs: String(row['source_thread']) }, reason: String(row['reason']) }));
    }
    checkBlocked(grant: SlackToolGrant, invocationId: string, operation: string, raw: Record<string, unknown>): void {
        const row = this.database.prepare(`SELECT credential_key,source_channel,requested_channel,requested_thread,operation,requested_json
            FROM slack_blocked_actions WHERE workspace=? AND actor=? AND invocation_id=?`)
            .get(grant.teamId, grant.actorId, invocationId) as Record<string, unknown> | undefined;
        if (!row) return;
        if (row['credential_key'] !== grant.credentialKey || row['source_channel'] !== grant.destination.targetId
            || row['requested_channel'] !== grant.destination.targetId || row['requested_thread'] !== grant.destination.threadId
            || row['operation'] !== operation || !isDeepStrictEqual(JSON.parse(String(row['requested_json'])), raw)) {
            throw Object.assign(new Error('slack_blocked_intent_mismatch'), { code: 'slack_blocked_intent_mismatch', statusCode: 409 });
        }
    }
    claimBlocked(grant: SlackToolGrant, invocationId: string, operation: string): void {
        this.database.prepare(`UPDATE slack_blocked_actions SET state='attempted'
            WHERE workspace=? AND actor=? AND credential_key=? AND source_channel=?
            AND requested_channel=source_channel AND requested_thread=? AND source_request<>? AND invocation_id=? AND operation=? AND state='held'`)
            .run(grant.teamId, grant.actorId, grant.credentialKey, grant.destination.targetId,
                grant.destination.threadId ?? '', grant.requestId, invocationId, operation);
    }
    blockedState(grant: SlackToolGrant, invocationId: string): string | undefined {
        const row = this.database.prepare(`SELECT state FROM slack_blocked_actions
            WHERE workspace=? AND actor=? AND credential_key=? AND invocation_id=?`)
            .get(grant.teamId, grant.actorId, grant.credentialKey, invocationId) as { state: string } | undefined;
        return row?.state;
    }
    blocksRoot(requestId: string, target: RemoteTarget): boolean {
        return !target.threadId && !!this.database.prepare(`SELECT 1 FROM slack_blocked_actions
            WHERE source_request=? AND source_channel=? AND requested_channel=source_channel
            AND requested_thread<>'' AND state='held' LIMIT 1`).get(requestId, target.targetId);
    }
    invocation(workspace: string, actor: string, id: string): StoredAction | undefined {
        return this.database.prepare('SELECT request_hash,status,receipt_json FROM slack_tool_invocations WHERE workspace=? AND actor=? AND invocation_id=?').get(workspace, actor, id) as StoredAction | undefined;
    }
    reserve(workspace: string, actor: string, id: string, hash: string): boolean {
        return this.database.transaction(() => {
            const count = this.database.prepare('SELECT count(*) AS n FROM slack_tool_invocations').get() as { n: number };
            if (count.n >= INVOCATION_CAP) return false;
            const now = Date.now();
            return this.database.prepare('INSERT OR IGNORE INTO slack_tool_invocations VALUES (?,?,?,?,?,?,?,?)').run(workspace, actor, id, hash, 'reserved', null, now, now).changes === 1;
        })();
    }
    dispatched(workspace: string, actor: string, id: string): void {
        this.database.prepare("UPDATE slack_tool_invocations SET status='dispatched',updated_at=? WHERE workspace=? AND actor=? AND invocation_id=? AND status IN ('reserved','dispatched')").run(Date.now(), workspace, actor, id);
    }
    finish(workspace: string, actor: string, id: string, status: 'completed' | 'failed' | 'unknown', receipt: unknown): void {
        const json = JSON.stringify(receipt);
        if (Buffer.byteLength(json) > 16384) throw new Error('slack_action_receipt_too_large');
        this.database.prepare('UPDATE slack_tool_invocations SET status=?,receipt_json=?,updated_at=? WHERE workspace=? AND actor=? AND invocation_id=?').run(status, json, Date.now(), workspace, actor, id);
    }
    resource(workspace: string, kind: string, id: string): ActionResource | undefined {
        const row = this.database.prepare('SELECT workspace,kind,resource_id,actor,channel,bot_user_id,credential_key,status,metadata_json FROM slack_tool_resources WHERE workspace=? AND kind=? AND resource_id=?').get(workspace, kind, id) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        const metadata: unknown = JSON.parse(String(row['metadata_json']));
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !['active', 'retired'].includes(String(row['status']))) throw new Error('slack_action_resource_invalid');
        return { workspace: String(row['workspace']), kind: String(row['kind']), id: String(row['resource_id']), actor: String(row['actor']), channel: String(row['channel']), botUserId: String(row['bot_user_id']), credentialKey: String(row['credential_key']), status: row['status'] as 'active' | 'retired', metadata: metadata as Record<string, unknown> };
    }
    resources(workspace: string, kind: string, channel: string, actor?: string): ActionResource[] {
        const rows = (actor === undefined
            ? this.database.prepare('SELECT resource_id FROM slack_tool_resources WHERE workspace=? AND kind=? AND channel=? LIMIT 1001').all(workspace, kind, channel)
            : this.database.prepare('SELECT resource_id FROM slack_tool_resources WHERE workspace=? AND kind=? AND channel=? AND actor=? LIMIT 1001').all(workspace, kind, channel, actor)) as Array<{ resource_id: string }>;
        if (rows.length > 1000) throw new Error('slack_action_resource_list_incomplete');
        return rows.map(row => this.resource(workspace, kind, row.resource_id)!);
    }
    remember(value: Omit<ActionResource, 'status'>): void {
        const metadata = JSON.stringify(value.metadata);
        if (Buffer.byteLength(metadata) > 262144) throw new Error('slack_action_resource_too_large');
        const existing = this.resource(value.workspace, value.kind, value.id);
        if (existing && (existing.actor !== value.actor || existing.channel !== value.channel || existing.botUserId !== value.botUserId
            || (value.kind === 'schedule' && existing.credentialKey !== value.credentialKey))) throw new Error('slack_action_resource_collision');
        const count = this.database.prepare('SELECT count(*) AS n FROM slack_tool_resources').get() as { n: number };
        if (!existing && count.n >= RESOURCE_CAP) throw new Error('slack_action_resource_capacity');
        this.database.prepare(`INSERT INTO slack_tool_resources VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace,kind,resource_id) DO UPDATE SET metadata_json=excluded.metadata_json,status='active'`).run(value.workspace, value.kind, value.id, value.actor, value.channel, value.botUserId, value.credentialKey, 'active', metadata);
    }
    retire(workspace: string, kind: string, id: string): void {
        this.database.prepare("UPDATE slack_tool_resources SET status='retired',metadata_json='{}' WHERE workspace=? AND kind=? AND resource_id=?").run(workspace, kind, id);
    }
    verified(workspace: string, credentialKey: string, operation: string): number | null {
        const row = this.database.prepare('SELECT verified_at FROM slack_tool_verified WHERE workspace=? AND credential_key=? AND operation=?').get(workspace, credentialKey, operation) as { verified_at: number } | undefined;
        return row?.verified_at ?? null;
    }
    recordVerified(workspace: string, credentialKey: string, operation: string): void {
        this.database.prepare('INSERT INTO slack_tool_verified VALUES (?,?,?,?) ON CONFLICT(workspace,credential_key,operation) DO UPDATE SET verified_at=excluded.verified_at').run(workspace, credentialKey, operation, Date.now());
    }
}
