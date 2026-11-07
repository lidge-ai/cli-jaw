import { redactSlackToolSecrets } from '../slack/tool-context.js';
export const SECRET_KEY_RE = /(authorization|bearer|cookie|password|passwd|token|api[_-]?key|secret|credential|session[_-]?id|aws[_-]?access|jwt)/i;
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
    [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]'],
    [/\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_ANTHROPIC_KEY]'],
    [/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_OPENAI_KEY]'],
    [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
    [/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]'],
    [/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_GOOGLE_KEY]'],
    [/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED_AWS_KEY]'],
    [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[REDACTED_JWT]'],
    [/((?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)=)[^\s"']+/gi, '$1[REDACTED]'],
];

function redactString(value: string): string {
    let next = redactSlackToolSecrets(value);
    for (const [pattern, replacement] of TOKEN_PATTERNS) next = next.replace(pattern, replacement);
    return next;
}

export function redactTraceValue(value: unknown, depth = 0): unknown {
    if (depth > 8) return '[MAX_DEPTH]';
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(item => redactTraceValue(item, depth + 1));
    if (typeof value !== 'object') return String(value);
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactTraceValue(raw, depth + 1);
    }
    return output;
}

export function stringifyTraceValue(value: unknown): string {
    try {
        return typeof value === 'string'
            ? redactString(value)
            : JSON.stringify(redactTraceValue(value), null, 2);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ unserializable: true, error: message });
    }
}

export function tracePreview(value: unknown, fallback = 'trace event', max = 360): string {
    const raw = stringifyTraceValue(value).replace(/\s+/g, ' ').trim() || fallback;
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}
