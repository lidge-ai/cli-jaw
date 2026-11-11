import { redactSlackToolSecrets } from '../slack/tool-context.js';
// ─── Channel Credential Redaction ────────────────────
// One masker for every channel. Error strings cross channel boundaries — the
// unified send path collects results from all three — so per-channel maskers
// leak at the seams.
//
// Three sinks matter, in order of severity:
//   1. the chat room itself (Telegram/Discord reply text)
//   2. HTTP response bodies (`{ ok: false, error }` reaches /api callers)
//   3. log files
//
// Telegram is the sharp edge: its Bot API puts the token in the URL PATH
// (`https://api.telegram.org/bot<TOKEN>/method`), so the path is itself a
// credential, exactly like Slack's `upload_url`.

/** A language-tag-free guard: keep host, drop everything that identifies it. */
import { canonicalize } from './fold.js';

const REDACTED = '...redacted';

/**
 * Characters copied while assembling redacted output, since the last reset.
 *
 * Exists for the complexity regression tests. Those used to assert a wall-clock
 * budget, which measures the runner rather than the algorithm: the same fixture
 * took 155 ms on a developer laptop and 777 ms on a CI runner, and running the
 * suite in parallel moved it again. A counter of the work actually performed is
 * the same number on every machine, so the test can state the real invariant —
 * copy work stays proportional to input length — instead of a machine-specific
 * millisecond bound.
 *
 * Incrementing one integer per emitted piece costs nothing measurable and is
 * never read in production.
 */
let charsCopied = 0;

/** Read the copy-work counter; test-only introspection. */
export function redactionCopyWork(): number {
    return charsCopied;
}

/** Reset the copy-work counter; test-only introspection. */
export function resetRedactionCopyWork(): void {
    charsCopied = 0;
}

/**
 * Mask a Telegram bot token embedded in a URL path, whatever the host.
 *
 * Host and credential are separate concerns. A lookalike host such as
 * `evil.telegram.org.attacker.dev` is deliberately left readable — hiding it
 * would conceal a suspicious destination — but a real token sitting in its
 * path must still go. Anchoring on the literal `/bot` rather than a word
 * boundary matters: in `.../bot123456:SECRET` the character before the digits
 * is `t`, so `\b` never matches.
 */
function stripBotTokenFromPath(raw: string): string {
    // The separators may themselves be percent-encoded: a URL that travelled
    // through a query parameter arrives as https%3A%2F%2F…%2Fbot<id>%3A<secret>.
    return raw.replace(
        /(\/|%2F)(?:file(?:\/|%2F))?bots?(\d{6,12})(?::|%3A)[A-Za-z0-9_-]+/gi,
        (_m, slash: string, id: string) => `${slash}bot${id}:${REDACTED}`,
    );
}

/**
 * A `bot` prefix is proof of provenance: nothing but a Telegram credential is
 * spelled `bot<digits>:<run>`. Because provenance is established, the secret's
 * shape is not consulted — requiring a character mix would leak an
 * all-uppercase token in full.
 *
 * The prefix has to stand alone. Excluding only a preceding letter was not
 * enough — `my_bot123…` and `v2bot123…` are identifiers, not credentials — so
 * the guard covers every identifier character.
 */
const PREFIXED_TOKEN = new RegExp(
    `(?<![A-Za-z0-9_])bot(\\d{6,12})(?::|\uFF1A)[A-Za-z0-9_-]{20,}`,
    'gi',
);

/**
 * A Discord token's first segment is the bot's user id in base64url, so it
 * decodes to a run of digits. An artifact id or checksum of the same dotted
 * shape does not, which is what keeps ordinary diagnostics readable.
 */
function decodesToSnowflake(segment: string): boolean {
    // The regex has no way to know where the token starts, so ordinary text
    // running into it ("logabcdefMTIz…") is captured as part of the first
    // segment. Try the trailing windows: a real header is 24 characters for an
    // 18-digit id, but ids vary in length, so scan a small range from the end.
    //
    // Padding needs no special handling here — Node's base64 decoder tolerates
    // it, so a `…Njc4==` segment still yields the id. What DOES matter is that
    // the pattern above accepts the `=` characters in the first place; without
    // that the whole match never forms.
    for (let width = 20; width <= Math.min(32, segment.length); width += 1) {
        const candidate = segment.slice(segment.length - width);
        try {
            const decoded = Buffer.from(
                candidate.replace(/-/g, '+').replace(/_/g, '/'),
                'base64',
            ).toString('utf8');
            if (/^\d{15,}$/.test(decoded)) return true;
        } catch {
            // Not valid base64 at this width; try the next.
        }
    }
    return false;
}

/**
 * Bot tokens anywhere in a string.
 *
 * Detection is anchored on the SECRET, not on what precedes it. Every earlier
 * attempt anchored on the left — a word boundary, then a delimiter set, then a
 * lookbehind — and each one was defeated by a spelling nobody had listed:
 * `Bot`, `BOT`, a bare `/`, an ordinary letter, `%3A`. What actually identifies
 * a Telegram credential is its shape: a bot id, a separator, and a long
 * high-entropy run. Match that, and the left context stops mattering.
 *
 * Separators cover the literal colon, its percent-encoding at any nesting
 * depth (`%3A`, `%253A`, …), the fullwidth colon that NFKC folds to `:`, and
 * an intervening line break — a token wrapped across lines in a log is still a
 * token once someone joins it back up.
 */
// `%3A` encoded once is `%253A`, twice is `%25253A`: each round replaces the
// leading `%` with `%25`, so the nesting shows up as repeated `25` AFTER the
// first percent, not as repeated `%25` before it.
const TOKEN_SEPARATOR = '(?::|\uFF1A|%(?:25)*3A)';
// Zero-width formatting characters can sit between the id and the separator.
// They are invisible in a log yet vanish on paste, so a token split by one is
// still a working token.
const INVISIBLE = '[\\s\\u200B-\\u200D\\uFEFF]*';
// The id runs to the END of a digit run: with a longer run, take its last 6-12
// digits rather than refusing to match. A lookbehind that demands a non-digit
// lets `9` + a 12-digit id slip past as a 13-digit run.
const TOKEN_ANYWHERE = new RegExp(
    `(\\d{6,12})${INVISIBLE}${TOKEN_SEPARATOR}${INVISIBLE}([A-Za-z0-9_-]{30,})`,
    'gi',
);

/**
 * Provenance, not shape, decides how aggressive masking may be.
 *
 * Telegram documents its token only as opaque, so a rule like "the secret
 * mixes upper case, lower case and digits" is an unwritten assumption: an
 * all-uppercase token would ship in full. Every path where the surrounding
 * text PROVES a credential — a Bot API URL, a `bot` prefix, an Authorization
 * header — therefore masks on structure alone, without consulting the shape.
 *
 * The character mix survives in exactly one place: a bare `<digits>:<run>`
 * pair in arbitrary prose, where there is no provenance and a build id or a
 * checksum would otherwise be blanked. A false negative there costs nothing,
 * because the same token inside any real Telegram context is caught above.
 */
function mixesCharacterClasses(candidate: string): boolean {
    return /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate);
}

/**
 * Find secrets in the CANONICAL form of the text, then remove those literal
 * runs from the original.
 *
 * This is what stops the spelling arms race. A pattern matched against the raw
 * string has to anticipate every encoding and every invisible character; a
 * pattern matched against the folded string sees one shape. The secret run
 * survives folding intact (its characters are base64url, which percent-decoding
 * and control-stripping leave alone), so it can be located in the original by
 * substring and blanked there.
 */
function stripSecretsFoundInCanonicalForm(input: string): string {
    // Scan the folded form ALWAYS, not only when folding changed something. A
    // string that is already canonical still needs this pass: the raw matchers
    // downstream stop at the first prefixed token, so a secret repeated later
    // in the same error string survived.
    const folded = canonicalize(input);

    // The fold gave up with escapes still unresolved. Something is nested
    // deeply enough to outrun the budget, which nothing legitimate does, so
    // blank whatever could be hiding a credential rather than pass the text
    // through unread.
    //
    // Blanking only the runs that CONTAIN an escape is not enough: the fold
    // also removes control characters, so an encoded prefix and its secret can
    // sit on either side of a newline. The bot id is public, so leaving the
    // secret half behind still hands over the credential. Any long run that
    // either carries an escape or could BE a secret goes.
    if (folded.exhausted) {
        // Scope it: the escaped run itself, and any credential-shaped run near
        // enough to be its other half. Blanking every long alphanumeric run
        // erased ordinary identifiers — `release-build-20260802-darwin-arm64`
        // among them — which hands an attacker a way to strip diagnostics by
        // burying one deeply encoded string in the same message.
        return input.replace(/\S{20,}/g, (run, offset: number) => {
            if (/%|\\u|&#/.test(run)) return REDACTED;
            // A Telegram secret is an unbroken base64url run. An ordinary long
            // identifier is punctuated — `release-build-20260802-darwin-arm64`
            // has hyphens — so requiring no separator keeps diagnostics while
            // still covering the shape a credential takes.
            if (!/^[A-Za-z0-9]{20,}$/.test(run)) return run;
            return hasEscapeWithin(input, offset, run.length) ? REDACTED : run;
        });
    }

    // Collect the SOURCE ranges each match came from. Deleting the matched
    // literal instead fails in both directions: an escape spliced inside the
    // secret means the literal is not in the source at all, and a run that
    // legitimately appears elsewhere gets destroyed with it.
    const ranges: Array<{ from: number; to: number }> = [];
    // The folded coordinates of each hit, kept alongside. Recovering them
    // afterwards meant scanning the whole map per range, which is the other
    // half of the quadratic cost.
    const foldedRanges: Array<{ foldedFrom: number; foldedTo: number }> = [];
    const record = (start: number, stop: number) => {
        if (start >= stop) return;
        const from = folded.origin[start];
        const to = folded.end[stop - 1];
        if (from === undefined || to === undefined) return;
        ranges.push({ from, to });
        foldedRanges.push({ foldedFrom: start, foldedTo: stop });
    };

    for (const match of folded.text.matchAll(PREFIXED_TOKEN)) {
        const at = match.index ?? 0;
        const separator = match[0].search(/[:\uFF1A]/);
        if (separator < 0) continue;
        record(at + separator + 1, at + match[0].length);
    }
    for (const match of folded.text.matchAll(CANONICAL_URL_TOKEN)) {
        const at = match.index ?? 0;
        const secret = match[2];
        if (!secret) continue;
        record(at + match[0].length - secret.length, at + match[0].length);
    }
    if (ranges.length === 0) return input;

    // A credential proven once in a message is a credential everywhere in it.
    // The repeat search runs over the FOLDED text, so a second mention wrapped
    // in a different encoding is caught too, and each hit is carried back by
    // the same offset map.
    //
    // Unlike the first pass this ignores whether the run is glued to
    // surrounding characters. The earlier "standalone only" rule existed to
    // protect unrelated values that happened to share the run, but once the
    // very same run has been proven a credential in this message, treating a
    // later copy as coincidence is the wrong way to be wrong.
    //
    // Bounded work: scanning the whole text once per distinct secret is
    // quadratic, and an attacker controls how many distinct token-shaped runs
    // an error string contains. Both the number of secrets and the total
    // search effort are capped; the first pass has already masked each
    // credential where it was proven, so the cap only trims the extra sweep
    // for repeats.
    // Every proven secret, not the first N. Capping this was the same mistake
    // as capping decode rounds: the 33rd credential's repeat went out in the
    // clear. Cost is controlled by making the sweep a single pass over the
    // text rather than one pass per secret.
    const known = new Set<string>();
    let shortest = Number.POSITIVE_INFINITY;
    for (const { foldedFrom, foldedTo } of foldedRanges) {
        const run = folded.text.slice(foldedFrom, foldedTo);
        if (run.length < 20) continue;
        known.add(run);
        shortest = Math.min(shortest, run.length);
    }
    if (known.size > 0) {
        // Group by prefix AND length, so a position tests at most one string
        // per length rather than every secret sharing that prefix.
        //
        // Bucketing on the prefix alone still lets an attacker pile hundreds of
        // secrets into one bucket and follow it with near-miss tails: 400 of
        // them took sixteen seconds. Any structure whose per-position work
        // grows with attacker-chosen input is not a security boundary.
        const byPrefixAndLength = new Map<string, string>();
        const lengthsByPrefix = new Map<string, number[]>();
        for (const secret of known) {
            const prefix = secret.slice(0, PROBE_WIDTH);
            byPrefixAndLength.set(`${prefix}\u0000${secret.length}`, secret);
            const lengths = lengthsByPrefix.get(prefix);
            if (lengths) {
                if (!lengths.includes(secret.length)) lengths.push(secret.length);
            } else {
                lengthsByPrefix.set(prefix, [secret.length]);
            }
        }
        for (let at = 0; at + shortest <= folded.text.length; at += 1) {
            const prefix = folded.text.slice(at, at + PROBE_WIDTH);
            const lengths = lengthsByPrefix.get(prefix);
            if (!lengths) continue;
            for (const length of lengths) {
                const candidate = byPrefixAndLength.get(`${prefix}\u0000${length}`);
                if (candidate === undefined) continue;
                if (folded.text.slice(at, at + length) !== candidate) continue;
                record(at, at + length);
                at += length - 1;
                break;
            }
        }
    }

    // Build the output once, front to back.
    //
    // Splicing the string per range re-copied the whole text for every match,
    // which is quadratic in the number of credentials — and an attacker picks
    // that number. Measured on this fixture family: 4k credentials took 167 ms
    // and 8k took 555 ms (3.3x for 2x input) while the scan itself stayed
    // linear (43 ms → 79 ms). Collecting the pieces and joining once keeps the
    // total copy work proportional to the text length.
    //
    // Overlapping ranges are MERGED rather than one being dropped. The old
    // back-to-front loop kept the rightmost of two overlapping matches and
    // discarded the other, which left the non-shared head of the discarded
    // range in the clear — for a redactor, masking the union is the only
    // direction that cannot leak. The union is bounded by the matches
    // themselves, so ordinary text around them is untouched.
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const pieces: string[] = [];
    let cursor = 0;
    let openFrom = -1;
    let openTo = -1;
    const flush = () => {
        if (openFrom < 0) return;
        pieces.push(input.slice(cursor, openFrom), REDACTED);
        charsCopied += (openFrom - cursor) + REDACTED.length;
        cursor = openTo;
        openFrom = -1;
    };
    for (const { from, to } of ranges) {
        if (openFrom >= 0 && from <= openTo) {
            if (to > openTo) openTo = to; // extend the merged run
            continue;
        }
        flush();
        openFrom = from;
        openTo = to;
    }
    flush();
    pieces.push(input.slice(cursor));
    charsCopied += input.length - cursor;
    return pieces.join('');
}

/** `/bot<id>:<secret>` inside a path, after folding. */
const CANONICAL_URL_TOKEN = /\/(?:file\/)?bots?(\d{6,12}):([A-Za-z0-9_-]{20,})/gi;


/**
 * Mask credential query VALUES while keeping the keys, in one linear pass.
 *
 * Masking every value turned ordinary links into dead ones: a review page's
 * `?clientSourceId=`, an ad library's `?id=`, a share link's `?t=`. A value
 * goes when its key names a credential, when it carries an `=` (a nested
 * query, or a fragment such as OAuth's `#access_token=`), or when its shape
 * is a signature's: a long run mixing case and digits, or an unpunctuated
 * run of letters and digits as long as a digest.
 *
 * A regex of the shape /([^&=]+)=([^&]*)/g backtracks quadratically when the
 * query holds a long run with no `=` in it — a 100 KB URL took four seconds,
 * which turns any logged string into a denial of service. Fold once with a
 * bounded budget, scan the rendered boundaries, then copy original ranges once.
 */
function maskQueryValues(query: string): string {
    const folded = canonicalize(query);
    if (folded.exhausted) return REDACTED;
    const pieces: string[] = [];
    let pairStart = 0;
    let eq = -1;
    let cursor = 0;
    for (let at = 0; at <= folded.text.length; at += 1) {
        const char = folded.text[at];
        const source = query[folded.origin[at]!];
        // HTML entities are decoded before a URL is read. Percent-escaped
        // delimiters belong to the key/value itself, not the query structure.
        if (char === '=' && eq < 0 && (source === '=' || source === '&')) eq = at;
        if (at !== folded.text.length && !(char === '&' && source === '&')) continue;
        if (eq >= 0 && isCredentialPair(folded.text.slice(pairStart, eq), folded.text.slice(eq + 1, at))) {
            const from = folded.end[eq]!;
            const to = at === folded.text.length ? query.length : folded.origin[at]!;
            pieces.push(query.slice(cursor, from), REDACTED);
            cursor = to;
        }
        pairStart = at + 1;
        eq = -1;
    }
    pieces.push(query.slice(cursor));
    return pieces.join('');
}

const CREDENTIAL_KEY = /token|secret|signature|passw|credential|auth|session|key$|^(?:code|sig|pwd|pass|otp|jwt|hmac|nonce|state|sid)$/;

function isCredentialPair(key: string, value: string): boolean {
    if (CREDENTIAL_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
    if (/=|%3d/i.test(value)) return true;
    const run = value.split('#', 1)[0]!;
    return (run.length >= 20 && mixesCharacterClasses(run))
        || (/^[A-Za-z0-9]{32,}$/.test(run) && /\d/.test(run) && /[A-Za-z]/.test(run));
}

/**
 * Redact channel credentials from any string before it reaches a log sink, an
 * API response, or a chat message.
 */
export function redactChannelSecrets(input: string): string {
    return stripSecretsFoundInCanonicalForm(redactSlackToolSecrets(input))
        // Percent-encoded URLs never reach the URL parser below, so peel their
        // credentials off first.
        .replace(/https?%3A%2F%2F[^\s]+/gi, stripBotTokenFromPath)
        // Slack bearer tokens: xoxb-, xoxp-, xoxa-, xoxs-, xapp-.
        .replace(/x(?:ox[bpas]|app)-[A-Za-z0-9-]+/g, (m: string, offset: number, whole: string) =>
            m.length <= 9 && whole.slice(offset + m.length).startsWith(REDACTED) ? m : `${m.slice(0, 9)}${REDACTED}`)
        // Discord bot tokens are three base64url segments separated by dots.
        // No word boundary and no fixed first-segment length: `\b` fails when
        // an ordinary letter abuts the token, and pinning the first segment to
        // 23-28 characters misses a token that follows other text.
        //
        // The first segment is base64url of a snowflake id, so it decodes to
        // digits — that is what separates a real token from an artifact id or
        // a checksum of the same shape. Structure alone is not enough:
        // `aaaa….bbbbb.cccc…` matches any three-run dotted string.
        //
        // KNOWN OVER-MASKING. A non-token whose first segment happens to be a
        // base64url snowflake is redacted too. Nothing in the remaining
        // segments distinguishes it: a real token's second segment is six
        // base64url characters and its third is an opaque HMAC, both of which
        // an artifact id can match exactly. Since a miss here publishes a bot
        // token while a false hit costs one unreadable diagnostic, the tie goes
        // to masking. The snowflake test already spares ordinary versions,
        // checksums and build ids, which is where the real risk of over-masking
        // was.
        //
        // Anchoring the whole match keeps it linear. Open-ended runs made the
        // engine try every split of a long dotless string; 50 KB took two
        // seconds, which the timing test caught.
        .replace(
            // The first segment may carry base64 padding when a log renders it
            // that way; rejecting `=` would leave the token in the clear.
            // `=` is padding, so it is meaningful only AFTER a segment. The
            // leading guard must still allow it: `token=<token>` puts one
            // immediately in front, and excluding it there dropped the match.
            /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{20,}={0,2})\.([A-Za-z0-9_-]{5,}={0,2})\.([A-Za-z0-9_-]{25,}={0,2})(?![A-Za-z0-9_.-])/g,
            (whole: string, header: string) => (decodesToSnowflake(header) ? REDACTED : whole),
        )
        // Prefixed tokens: provenance is certain, so shape does not matter.
        .replace(PREFIXED_TOKEN, (_m, id: string) => `bot${id}:${REDACTED}`)
        // Authorization header values, whichever scheme.
        .replace(/\b(Bot|Bearer)\s+\S+/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`)
        // URLs. ONE pass: running two URL regexes would let the second parse a
        // string the first already rewrote.
        //
        // Host matching goes through the URL parser rather than a regex on the
        // raw text, so canonical-equivalent spellings cannot slip past:
        // uppercase hosts, an explicit :443, a trailing dot, and userinfo
        // (user:pass@) all normalize before the suffix check.
        .replace(/https?:\/\/[^\s<>|"']+/gi, (match) => {
            // Link labels and closing Markdown belong to the surrounding text,
            // not the capability URL. Restore punctuation on every exit path.
            let end = match.length;
            while (end > 0 && ')]};,.!*_~`'.includes(match.charAt(end - 1))) end -= 1;
            const suffix = match.slice(end);
            const raw = match.slice(0, end);
            let parsed: URL;
            try {
                parsed = new URL(raw);
            } catch {
                return stripBotTokenFromPath(raw) + suffix;
            }
            const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
            const isSlack = host === 'slack.com' || host.endsWith('.slack.com')
                || host === 'slack-edge.com' || host.endsWith('.slack-edge.com');
            const isTelegram = host === 'telegram.org' || host.endsWith('.telegram.org');
            const isDiscord = host === 'discord.com' || host.endsWith('.discord.com')
                || host === 'discordapp.com' || host.endsWith('.discordapp.com');
            // Only literal workspace permalinks and channel links may retain
            // their path. Checking the spelling as well as the parsed URL
            // rejects dot-segment and escaped-path normalization, userinfo and
            // nondefault ports. Slack stores `&` as `&amp;` in message text,
            // so a permalink copied from a message is read with that decoded.
            const permalinkSpelling = raw.replace(/&amp;/g, '&');
            const permalink = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com(?::443)?\/archives\/[CGD][A-Z0-9]+(?:\/p[0-9]+(?:\?[^#]*)?)?$/.test(permalinkSpelling);
            const queryKeys = new Set<string>();
            const safeQuery = permalink && [...new URL(permalinkSpelling).searchParams].every(([key, value]) => {
                if (queryKeys.has(key)) return false;
                queryKeys.add(key);
                return (key === 'thread_ts' && /^\d+\.\d{6}$/.test(value))
                    || (key === 'cid' && /^[CGD][A-Z0-9]+$/.test(value));
            });
            if (safeQuery) return raw + suffix;
            // For other own-host URLs the whole path is capability-bearing: Slack's
            // upload_url is an opaque path, Telegram's carries the bot token,
            // and Discord webhook URLs carry the webhook secret.
            if (isSlack || isTelegram || isDiscord) return `https://${parsed.host}/${REDACTED}${suffix}`;
            // Untrusted host: keep the URL readable, but never leave a
            // credential in it.
            //
            // Being a URL is NOT provenance on its own — that reading blanked
            // ordinary artifact paths like /build/<id>:<hash>/artifact. Only a
            // `/bot<id>:<secret>` segment proves a Telegram credential here;
            // anything else falls back to the shape heuristic, which spares a
            // build id while still catching a real token.
            const withoutToken = stripBotTokenFromPath(raw)
                .replace(TOKEN_ANYWHERE, (whole: string, id: string, secret: string) =>
                    mixesCharacterClasses(secret) ? `${id}:${REDACTED}` : whole);
            // Query VALUES go, keys stay: a diagnostic URL stays diagnosable
            // while a signature does not survive.
            const queryAt = withoutToken.indexOf('?');
            if (queryAt < 0) return withoutToken + suffix;
            return withoutToken.slice(0, queryAt + 1) + maskQueryValues(withoutToken.slice(queryAt + 1)) + suffix;
        })
        // Bot tokens outside any URL, including percent-encoded separators and
        // a Bot/BOT/bot prefix in any casing.
        // Bare `<digits>:<run>` in arbitrary prose: no provenance, so the
        // heuristic applies and an ordinary diagnostic stays readable.
        .replace(TOKEN_ANYWHERE, (whole: string, id: string, secret: string) =>
            mixesCharacterClasses(secret) ? `${id}:${REDACTED}` : whole);
}

/**
 * Stringify anything that was thrown, without ever throwing.
 *
 * `JSON.stringify` rejects BigInt ("Do not know how to serialize a BigInt")
 * and circular references; `String()` itself throws on a Symbol or an object
 * whose `toString` throws. An error sink that can throw defeats the error
 * handling it was added to protect.
 */
function stringifyThrown(err: unknown, withStack: boolean): string {
    if (err instanceof Error) {
        return withStack ? (err.stack ?? err.message) : err.message;
    }
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err) ?? String(err);
    } catch {
        try {
            return String(err);
        } catch {
            return '[unrepresentable error]';
        }
    }
}

/**
 * For text a USER will see: message only, credentials masked.
 *
 * Never includes the stack. A stack frame carries absolute source paths, and
 * publishing the operator's directory layout to a chat room is its own leak.
 */
export function userErrorText(err: unknown): string {
    return redactChannelSecrets(stringifyThrown(err, false));
}

/** For server logs: full stack, credentials masked. */
export function logErrorText(err: unknown): string {
    return redactChannelSecrets(stringifyThrown(err, true));
}

/**
 * Last mile: mask the BODY of an outbound message, whatever produced it.
 *
 * Error paths were hardened first, but a credential does not only travel in an
 * error. An agent that reads a config file, a command that echoes a URL, a
 * forwarder relaying tool output — each puts ordinary text on the wire, and
 * that text goes to a chat room where anyone in the channel can read it.
 *
 * Every transport calls this immediately before handing text to the vendor
 * SDK, so there is one place to audit rather than one per call site.
 */
export function redactOutboundText(text: string): string {
    return redactChannelSecrets(text);
}

/**
 * Mask every string inside a structured outbound payload.
 *
 * Inline keyboards carry user-visible text in button labels and URLs, and
 * those reach the room exactly like a message body. Walking the object beats
 * enumerating fields, because the vendor's shape changes and a new field would
 * silently go unmasked.
 *
 * Depth- and breadth-bounded: the input is attacker-influenced, and a
 * recursive walk over it is a stack-overflow waiting to happen. Cycles are
 * tracked so a self-referencing object cannot spin.
 */
export function redactOutboundPayload<T>(
    value: T,
    depth = 0,
    seen = new WeakMap<object, unknown>(),
): T {
    if (typeof value === 'string') return redactChannelSecrets(value) as unknown as T;
    if (value === null || typeof value !== 'object') return value;

    // A cache, not a visited-set. Returning the ORIGINAL for an object seen
    // before means the second alias of a shared button object ships its secret
    // untouched — the first reference was sanitized and the second was not.
    const cached = seen.get(value);
    if (cached !== undefined) return cached as T;

    // Past the depth limit, drop the subtree instead of returning it. Handing
    // back the raw object is a leak; anything this deep in an outbound payload
    // is not something a channel renders.
    if (depth >= MAX_PAYLOAD_DEPTH) return (Array.isArray(value) ? [] : {}) as unknown as T;

    // Register the container BEFORE walking it, so a cycle resolves to the
    // same sanitized object rather than recursing forever.
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, out);

    if (Array.isArray(value)) {
        for (const item of value) {
            (out as unknown[]).push(redactOutboundPayload(item, depth + 1, seen));
        }
        return out as unknown as T;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        (out as Record<string, unknown>)[key] = redactOutboundPayload(item, depth + 1, seen);
    }
    return out as unknown as T;
}

/** Deeper than any keyboard or media payload a channel actually renders. */
const MAX_PAYLOAD_DEPTH = 12;

/**
 * True when an escaped run sits close enough to be the other half of a
 * credential the fold could not finish resolving.
 *
 * Distance is measured to the escaped RUN, not to an escape character. A long
 * `%2525…` chain is mostly digits, so a window around the neighbour can sit
 * entirely inside it and still contain no `%` — which read as "no escape
 * nearby" and let the secret through.
 */
function hasEscapeWithin(input: string, offset: number, length: number): boolean {
    for (const match of input.matchAll(/\S{20,}/g)) {
        if (!/%|\\u|&#/.test(match[0])) continue;
        const start = match.index ?? 0;
        const stop = start + match[0].length;
        const gapBefore = offset - stop;
        const gapAfter = start - (offset + length);
        if (gapBefore >= 0 && gapBefore <= EXHAUSTED_NEIGHBOURHOOD) return true;
        if (gapAfter >= 0 && gapAfter <= EXHAUSTED_NEIGHBOURHOOD) return true;
    }
    return false;
}

/**
 * How far to look for the escaped half. The fold strips control characters and
 * whitespace, so the two halves can be a line break and a little punctuation
 * apart — but not paragraphs apart, which is what keeps this from swallowing
 * an unrelated identifier elsewhere in the message.
 */
const EXHAUSTED_NEIGHBOURHOOD = 64;

/**
 * Width of the prefix used to index known secrets. Every tracked run is at
 * least 20 characters, so this always exists, and collisions across distinct
 * credentials are rare enough that each position tests roughly one candidate.
 */
const PROBE_WIDTH = 16;
