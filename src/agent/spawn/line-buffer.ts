/**
 * Guard against a newline-free stdout stream growing a line buffer without limit.
 *
 * NDJSON readers keep the trailing partial line in memory until a newline
 * arrives. A child that never emits one — a progress bar redrawing with \r,
 * binary data on stdout, a truncated JSON stream — makes that buffer grow for
 * the lifetime of the process. Measured: 200 MiB of newline-free output pushed
 * the heap past 1.5 GiB, because each append reallocates the whole string.
 *
 * The cap is generous enough that a legitimately long JSON line still parses,
 * and it is only reached when no newline has been seen at all.
 *
 * ## Frame contract (#784)
 *
 * Two distinct limits share `maxChars`:
 *
 * - **Pending cap** — the memory bound on the in-flight partial frame. The
 *   framer never retains more than `maxChars` of one frame's head, and while
 *   draining a dropped frame it keeps only a fixed `OVERFLOW_HEAD_SAMPLE_CHARS`
 *   diagnostic sample plus a counter.
 * - **Frame cap** — the accept/reject rule for a completed frame. A frame is
 *   dispatched iff its total length is ≤ `maxChars`. Because the pending cap
 *   trips exactly when a frame exceeds `maxChars`, the verdict is identical no
 *   matter how the payload is split across chunks: the same bytes always get
 *   the same answer.
 *
 * Once a frame crosses the cap it is poisoned: the framer freezes a bounded,
 * surrogate-safe head sample, counts the rest, and drains everything up to the
 * frame's LF. The dropped frame surfaces as a `NdjsonDrop` — the truncated head
 * is never spliced with a later suffix into a parseable-but-wrong message. The
 * LF that ends the poisoned frame resyncs the stream, so following frames
 * dispatch normally. EOF mid-overflow reports the drop too; no truncated
 * payload is emitted.
 */
import { sliceWithoutSplittingSurrogate } from '../stream-text.js';

export const MAX_PENDING_LINE_CHARS = 8 * 1024 * 1024;

/** Bounded head of a dropped frame, kept so the drop can be identified. */
export const OVERFLOW_HEAD_SAMPLE_CHARS = 512;

export interface NdjsonDrop {
    /** Total UTF-16 code units observed for the dropped frame. */
    frameChars: number;
    /** Surrogate-safe head of the dropped frame, ≤ OVERFLOW_HEAD_SAMPLE_CHARS. */
    headSample: string;
}

export interface NdjsonPushResult {
    /** Complete frames (LF stripped) ready to dispatch; each ≤ the cap. */
    lines: string[];
    /** Frames dropped by this push, in arrival order. */
    drops: NdjsonDrop[];
}

export interface NdjsonFramer {
    /** Feed decoded text; returns completed frames plus any drops. */
    push(text: string): NdjsonPushResult;
    /** Flush at end-of-stream: the tail pending line, or the final drop. */
    end(): { tail: string; drop: NdjsonDrop | null };
}

export function createNdjsonFramer(maxChars: number = MAX_PENDING_LINE_CHARS): NdjsonFramer {
    let pending = '';
    let overflowing = false;
    let frameChars = 0;
    let headSample = '';
    return {
        push(text) {
            const lines: string[] = [];
            const drops: NdjsonDrop[] = [];
            let offset = 0;
            while (offset <= text.length) {
                const nl = text.indexOf('\n', offset);
                const end = nl === -1 ? text.length : nl;
                const segLen = end - offset;
                if (overflowing) {
                    frameChars += segLen;
                } else if (pending.length + segLen > maxChars) {
                    // One extra code unit: slicing exactly at the bound would
                    // skip the surrogate check and could keep half a pair.
                    const headSource = pending.length > OVERFLOW_HEAD_SAMPLE_CHARS
                        ? pending
                        : pending + text.slice(offset, offset + OVERFLOW_HEAD_SAMPLE_CHARS + 1);
                    headSample = sliceWithoutSplittingSurrogate(headSource, OVERFLOW_HEAD_SAMPLE_CHARS);
                    frameChars = pending.length + segLen;
                    pending = '';
                    overflowing = true;
                } else {
                    pending += text.slice(offset, end);
                }
                if (nl === -1) break;
                if (overflowing) {
                    drops.push({ frameChars, headSample });
                    overflowing = false;
                    frameChars = 0;
                    headSample = '';
                } else {
                    lines.push(pending);
                    pending = '';
                }
                offset = nl + 1;
            }
            return { lines, drops };
        },
        end() {
            if (overflowing) {
                const drop = { frameChars, headSample };
                overflowing = false;
                frameChars = 0;
                headSample = '';
                return { tail: '', drop };
            }
            const tail = pending;
            pending = '';
            return { tail, drop: null };
        },
    };
}
