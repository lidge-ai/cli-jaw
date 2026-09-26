const MAX_MESSAGES = 128;
export const CLAUDE_MAX_BLOCKS = 512;
export const CLAUDE_TEXT_BYTES = 1024 * 1024;
export const CLAUDE_INPUT_BYTES = 64 * 1024;

export interface ClaudeBlock {
    type: string;
    text: string;
    json: string;
    hasJson: boolean;
    jsonRetired: boolean;
    emptyInputPending: boolean;
    toolId?: string;
    name?: string;
    streamed: boolean;
    snapshotted: boolean;
    stopped: boolean;
}
interface Message {
    blocks: Map<number, ClaudeBlock>;
    snapshots: Set<string>;
}

/** Clip by UTF-8 bytes without retaining half a code point. */
export function claudeTextPrefix(text: string, bytes: number): string {
    if (Buffer.byteLength(text) <= bytes) return text;
    let low = 0, high = Math.min(text.length, bytes);
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, mid)) <= bytes) low = mid;
        else high = mid - 1;
    }
    if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
    return text.slice(0, low);
}

/** Private turn state; public identity, redaction and preview caps belong to RuntimeProjection. */
export class ClaudeSdkMessages {
    private readonly messages = new Map<string, Message>();
    private bytes = 0;
    private blocks = 0;
    private snapshotCount = 0;
    private latestId: string | undefined;
    /** What a retired segment read as partial and interrupted text, for a turn that says nothing more. */
    private retiredPartial = '';
    private retiredText = '';
    currentId: string | undefined;

    constructor(private readonly report: (reason: 'capacity') => void) {}

    /**
     * A Code follow-up runs as its own CLI turn after a result: the finished segment's
     * messages take no more frames, so their bookkeeping is released and the continuation
     * gets the full message, block, snapshot and byte budget. The projection keeps its
     * items; `latestId` and the retired text keep the final ref and partial/interrupted
     * text as they were until the continuation starts a message.
     */
    retire(): void {
        this.retiredPartial = this.partialText;
        this.retiredText = this.interruptedText;
        this.messages.clear();
        this.bytes = 0; this.blocks = 0; this.snapshotCount = 0;
        this.currentId = undefined;
    }

    message(id: string): Message {
        let message = this.messages.get(id);
        if (!message) {
            if (this.messages.size >= MAX_MESSAGES) throw new Error('Claude message limit exceeded');
            message = { blocks: new Map(), snapshots: new Set() };
            this.messages.set(id, message);
            this.latestId = id;
        }
        return message;
    }

    start(id: string): void { this.message(id); this.currentId = id; }

    block(id: string, index: number, type: string, streamed: boolean): ClaudeBlock {
        const message = this.message(id), old = message.blocks.get(index);
        if (old) {
            if (old.type !== type) throw new Error('Malformed Claude block type');
            return old;
        }
        if (this.blocks >= CLAUDE_MAX_BLOCKS) throw new Error('Claude block limit exceeded');
        const block: ClaudeBlock = { type, text: '', json: '', hasJson: false, jsonRetired: false, emptyInputPending: false,
            streamed, snapshotted: false, stopped: false };
        message.blocks.set(index, block); this.blocks++;
        return block;
    }

    duplicateSnapshot(id: string, uuid: string | undefined): boolean {
        if (!uuid) return false;
        // Block replay deduplication only; send/result UUID correlation stays session-owned.
        const seen = this.message(id).snapshots;
        if (seen.has(uuid)) return true;
        if (this.snapshotCount >= CLAUDE_MAX_BLOCKS) throw new Error('Claude snapshot limit exceeded');
        seen.add(uuid); this.snapshotCount++;
        return false;
    }

    snapshotIndex(id: string, type: string, toolId?: string): number {
        const entries = [...this.message(id).blocks.entries()].sort(([a], [b]) => a - b);
        const matching = entries.filter(([, b]) => b.type === type && (!toolId || b.toolId === toolId));
        // .261 emits a completed single block immediately after its indexed stop.
        const pending = matching.find(([, b]) => b.streamed && b.stopped && !b.snapshotted)
            ?? matching.find(([, b]) => b.streamed && !b.snapshotted);
        if (pending) return pending[0];
        if (toolId && matching.length) return matching[0]![0];
        const next = entries.length ? entries.at(-1)![0] + 1 : 0;
        if (next >= CLAUDE_MAX_BLOCKS) throw new Error('Claude block limit exceeded');
        return next;
    }

    write(block: ClaudeBlock, text: string, append: boolean): void {
        const previous = block.text, before = append ? previous : '';
        const available = CLAUDE_TEXT_BYTES - this.bytes + (append ? 0 : Buffer.byteLength(previous));
        const part = claudeTextPrefix(text, available);
        if (part.length !== text.length) this.report('capacity');
        block.text = before + part;
        this.bytes += Buffer.byteLength(block.text) - Buffer.byteLength(previous);
    }

    appendJson(block: ClaudeBlock, fragment: string): void {
        block.hasJson = true;
        if (block.jsonRetired) return;
        const added = Buffer.byteLength(fragment);
        if (Buffer.byteLength(block.json) + added > CLAUDE_INPUT_BYTES || this.bytes + added > CLAUDE_TEXT_BYTES) {
            this.releaseJson(block); block.jsonRetired = true; this.report('capacity'); return;
        }
        block.json += fragment; this.bytes += added;
    }

    releaseJson(block: ClaudeBlock): void {
        this.bytes -= Buffer.byteLength(block.json); block.json = '';
        // An authoritative assistant snapshot may precede block_stop. Once the
        // fragments are released, there is no pending JSON for that stop to parse.
        block.hasJson = false;
    }

    text(id: string): string {
        return [...(this.messages.get(id)?.blocks.entries() ?? [])].sort(([a], [b]) => a - b)
            .filter(([, block]) => block.type === 'text').map(([, block]) => block.text).join('');
    }

    get partialText(): string {
        if (this.latestId === undefined) return '';
        return this.messages.has(this.latestId) ? this.text(this.latestId) : this.retiredPartial;
    }
    /** Interruption only: a tool-only boundary cannot erase this turn's last plaintext. */
    get interruptedText(): string {
        for (const [id, message] of [...this.messages].reverse()) {
            if ([...message.blocks.values()].some(block => block.type === 'text')) return this.text(id);
        }
        return this.retiredText;
    }
    get finalRef(): string { return this.latestId === undefined ? 'claude:final' : 'claude:message:' + this.latestId; }
}
