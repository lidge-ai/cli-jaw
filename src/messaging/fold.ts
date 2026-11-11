// ─── Canonical Folding ───────────────────────────────
// Turns a string into the form its eventual reader would see — escapes
// decoded, invisible characters removed, compatibility characters folded —
// while remembering where every surviving character came from.
//
// The offset map is the point of this module. Finding a secret in the folded
// copy and then deleting that literal from the original fails twice over: an
// escape spliced INSIDE the secret means the literal is not there at all, and
// a run that legitimately appears elsewhere gets destroyed with it. Ranges
// carry a match back to exactly the bytes it came from.
//
// COORDINATE SYSTEM: UTF-16 code units, everywhere. Regex indices,
// String.length and slice offsets all speak code units, so the map must too.
// Walking a normalized character by code POINT desynchronized the map the
// moment NFKC produced an astral pair.

/**
 * Unicode characters that render as nothing. Splicing one into a token hides
 * it from a naive matcher while leaving the token usable — the character
 * disappears on copy, or is stripped by the next parser in the chain.
 *
 * Cc/Cf covers the format controls (zero-width space and joiners, word joiner,
 * soft hyphen, bidi marks, BOM) plus the C0/C1 control characters.
 */
// Cc/Cf covers the format controls (zero-width space and joiners, word joiner,
// soft hyphen, bidi marks, BOM) and the C0/C1 controls. The explicit additions
// are default-ignorable code points that fall outside those categories: the
// combining grapheme joiner renders as nothing yet is Mn, Mongolian free
// variation selectors are Cf but its vowel separator is Zs, and the Khmer
// viramas behave the same way in practice.
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\u034F\u17B4\u17B5\u180B-\u180E\uFE00-\uFE0F]/gu;

/**
 * Characters the fold has walked, across every round, since the last reset.
 *
 * The twin of `redactionCopyWork` in redact.ts, and it exists for the same
 * reason: the test that guards this cost cannot use wall-clock time. A 300 ms
 * budget on a 43 KB fixture failed CI at 307 ms and then passed on re-run with
 * identical code, on a runner whose own job time moved between 4m50s and 7m28s.
 * Milliseconds measure the runner; this counts the work the algorithm actually
 * does, so it reads the same on every machine and under any load.
 *
 * It is charged exactly where the budget is charged, because the budget IS the
 * bound being asserted: `decodeBudgetFor` caps total work at 8x the input, so
 * folding is linear by construction. Bounding ROUNDS instead — the shape this
 * module was fixed away from — leaves each round rescanning the whole string,
 * which is quadratic in nesting depth and is what the guard has to catch.
 *
 * Incrementing one integer per round costs nothing measurable and is never
 * read in production.
 */
let charsFolded = 0;

/** Read the fold-work counter; test-only introspection. */
export function foldWork(): number {
    return charsFolded;
}

/** Reset the fold-work counter; test-only introspection. */
export function resetFoldWork(): void {
    charsFolded = 0;
}

/**
 * A folded string plus, for each of its characters, the offset in the ORIGINAL
 * that produced it.
 *
 * The map is what makes masking precise. Finding a secret in the folded text
 * and then deleting that literal run from the original fails twice over: an
 * escape spliced INSIDE the secret means the literal is not there at all, and
 * a run that legitimately appears elsewhere gets destroyed along with it.
 * Ranges carry the match back to exactly the bytes it came from.
 */
export interface FoldedText {
    text: string;
    /** `origin[i]` is the index in the source of folded character `i`. */
    origin: number[];
    /** One past the last source index consumed, per folded character. */
    end: number[];
    /**
     * True when the fold ran out of budget with escapes still unresolved.
     * The caller must treat this as "possibly hiding something", never as
     * "nothing found".
     */
    exhausted?: boolean;
}

/**
 * Fold a string to the form an attacker's target would see, so matching does
 * not have to enumerate spellings.
 *
 * Chasing spellings one at a time does not converge: `%62ot`, then `%2562ot`,
 * then U+2060 between the letters, then U+00AD, then `&#98;`. Each round added
 * an alternation and the next found another. Folding turns them into one shape.
 *
 * Decoding never throws: a malformed escape is left as written.
 * Query structure can defer percent decoding until after splitting fields;
 * HTML-generated percent escapes must not become structural delimiters.
 */
export function canonicalize(input: string, options: { decodePercent?: boolean } = {}): FoldedText {
    let current: FoldedText = {
        text: input,
        origin: Array.from({ length: input.length }, (_, i) => i),
        end: Array.from({ length: input.length }, (_, i) => i + 1),
    };
    charsFolded += input.length; // the initial strip walks the whole input
    current = stripInvisible(current);
    // Fold to a FIXED POINT. Decoding strictly shrinks — an escape is always
    // longer than the character it denotes — so this terminates on its own,
    // and there is no round cap to nest past.
    //
    // The work budget bounds CPU instead, and reaching it is reported rather
    // than swallowed: a caller that gets `exhausted` must not conclude the
    // text was clean. A cap that silently gives up is how depth 513 leaked.
    let budget = decodeBudgetFor(input);
    for (;;) {
        if (budget <= 0) return { ...current, exhausted: true };
        budget -= current.text.length;
        charsFolded += current.text.length; // every round rescans the whole string
        const next = stripInvisible(decodeOnce(current, options.decodePercent !== false));
        if (next.text === current.text) break;
        current = next;
    }
    return current;
}

/**
 * Total characters the fold may process, across all rounds.
 *
 * Bounding rounds does not bound cost: each round rescans the whole string, so
 * a 43 KB input nested 512 deep burned three quarters of a second. Charging
 * every round against one budget makes the ceiling proportional to the work
 * actually done.
 */
function decodeBudgetFor(input: string): number {
    return Math.max(input.length * 8, 64 * 1024);
}

function stripInvisible(folded: FoldedText): FoldedText {
    const text: string[] = [];
    const origin: number[] = [];
    const end: number[] = [];
    for (let i = 0; i < folded.text.length; i += 1) {
        const char = folded.text[i]!;
        INVISIBLE_CHARS.lastIndex = 0;
        if (INVISIBLE_CHARS.test(char)) continue;
        // NFKC per character, so the map stays aligned where it matters:
        // fullwidth ｂｏｔ folds to bot, and a fullwidth colon to ':'.
        //
        // Iterate CODE UNITS, not code points. `for..of` yields whole code
        // points, so a character whose NFKC expansion is astral (U+FA6C becomes
        // U+242EE, two units) pushed one entry where the string contributes
        // two. Every later offset then sat one short, which left the first
        // character of a secret behind and ate the character after it —
        // regex indices and String.length are code units throughout.
        const normalized = char.normalize('NFKC');
        for (let unit = 0; unit < normalized.length; unit += 1) {
            text.push(normalized[unit]!);
            origin.push(folded.origin[i]!);
            end.push(folded.end[i]!);
        }
    }
    return { text: text.join(''), origin, end };
}

/** Replace a slice of the folded text, keeping the map consistent. */
function spliceFolded(
    folded: FoldedText,
    from: number,
    to: number,
    replacement: string,
): { text: string[]; origin: number[]; end: number[] } {
    const sourceStart = folded.origin[from]!;
    const sourceEnd = folded.end[to - 1]!;
    return {
        // Text and both maps use UTF-16 units, including surrogate pairs.
        text: replacement.split(''),
        origin: replacement.split('').map(() => sourceStart),
        end: replacement.split('').map(() => sourceEnd),
    };
}

/**
 * One round of the escape forms that reach these sinks: percent-encoding
 * (including multi-byte UTF-8 sequences), JSON/JS `\uXXXX`, and HTML numeric
 * entities. A log line is rendered by something downstream, and each of those
 * renderers turns its own escape back into the character.
 */
function decodeOnce(folded: FoldedText, decodePercent: boolean): FoldedText {
    // All three escape families in one alternation, so a single left-to-right
    // pass can rebuild the offset map. The HTML entity's semicolon is optional:
    // browsers accept `&#98ot` and so must this.
    // Named references are here for the same reason the numeric ones are: a
    // renderer turns `&colon;` back into ':', which restores the separator the
    // token matcher looks for.
    // Decimal references stop at a non-decimal digit. HTML text also accepts
    // the legacy `&amp` spelling without a semicolon, even before a key name.
    const ESCAPE = /(?:%[0-9A-Fa-f]{2})+|\\u([0-9A-Fa-f]{4})|&#(?:x([0-9A-Fa-f]+)|([0-9]+));?|&([A-Za-z][A-Za-z0-9]{1,31});|&(amp)/gi;
    const text: string[] = [];
    const origin: number[] = [];
    const end: number[] = [];
    let cursor = 0;

    const copyRange = (from: number, to: number) => {
        for (let i = from; i < to; i += 1) {
            text.push(folded.text[i]!);
            origin.push(folded.origin[i]!);
            end.push(folded.end[i]!);
        }
    };

    for (const match of folded.text.matchAll(ESCAPE)) {
        const at = match.index ?? 0;
        copyRange(cursor, at);
        const decoded = !decodePercent && match[0].startsWith('%') ? match[0] : decodeEscape(match);
        // Push one element at a time. `push(...array)` passes every element as
        // an argument, which overflows the stack once a hostile input produces
        // enough of them.
        const spliced = spliceFolded(folded, at, at + match[0].length, decoded);
        for (let i = 0; i < spliced.text.length; i += 1) {
            text.push(spliced.text[i]!);
            origin.push(spliced.origin[i]!);
            end.push(spliced.end[i]!);
        }
        cursor = at + match[0].length;
    }
    copyRange(cursor, folded.text.length);
    return { text: text.join(''), origin, end };
}

function decodeEscape(match: RegExpMatchArray): string {
    const whole = match[0];
    if (whole.startsWith('%')) {
        try {
            // decodeURIComponent handles multi-byte UTF-8; a malformed run
            // throws, and is then left exactly as written.
            return decodeURIComponent(whole);
        } catch {
            return whole;
        }
    }
    if (match[1] !== undefined) {
        const code = Number.parseInt(match[1], 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    const digits = match[2] ?? match[3];
    if (digits === undefined) {
        const name = match[4] ?? match[5];
        if (name === undefined) return whole;
        return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    }
    const code = Number.parseInt(digits, match[2] !== undefined ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
}

/**
 * Named references that can rebuild a credential once a renderer expands them.
 *
 * Only the characters that matter to detection are listed — the separator, the
 * escape introducers, and the delimiters a URL needs. A full HTML entity table
 * would add hundreds of letters that change nothing here.
 */
const NAMED_ENTITIES: Record<string, string> = {
    colon: ':',
    amp: '&',
    percnt: '%',
    sol: '/',
    bsol: '\\',
    lowbar: '_',
    hyphen: '-',
    period: '.',
    num: '#',
    quest: '?',
    equals: '=',
    commat: '@',
    nbsp: ' ',
    zwnj: '\u200C',
    zwj: '\u200D',
};
