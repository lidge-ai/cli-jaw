import type { Database as SqliteDatabase } from 'better-sqlite3';

const MAX_CLAIMS = 100000;

/** Permanent hashed claims. A crash between commit and POST intentionally loses
 * the notification rather than authorizing an uncertain notification replay.
 */
export class SlackFailureStore {
    constructor(private readonly database: SqliteDatabase) {
        database.exec(`CREATE TABLE IF NOT EXISTS slack_failure_claims (
            claim_hash TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL
        )`);
    }

    claim(hash: string): boolean {
        return this.database.prepare(`INSERT OR IGNORE INTO slack_failure_claims (claim_hash, claimed_at)
            SELECT ?, ? WHERE (SELECT COUNT(*) FROM slack_failure_claims) < ?`)
            .run(hash, Date.now(), MAX_CLAIMS).changes === 1;
    }
}

let store: SlackFailureStore | null = null;
export function configureSlackFailureStore(value: SlackFailureStore | null): void { store = value; }
export function getSlackFailureStore(): SlackFailureStore | null { return store; }
