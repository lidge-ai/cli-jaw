// ─── Dependency advisory classification ───────────────
//
// Pure half of scripts/check-deps-audit.ts, split out so the policy can be
// tested without the registry. An allowlist entry is a decision about specific
// advisories, not a mute on a package: when npm reports advisory objects for a
// package, every advisory id has to appear in that entry's `advisories`. A new
// advisory against an already-allowlisted package therefore fails the gate
// instead of riding along on an old reachability argument.

export interface AllowEntry {
    package: string;
    severity: string;
    reason: string;
    review: string;
    advisories?: string[];
}

export type AuditVia = string | { title?: string; url?: string; source?: number | string };

export interface AuditVuln {
    severity: string;
    isDirect?: boolean;
    via?: AuditVia[];
}

export interface AuditClassification {
    unexpected: string[];
    stale: string[];
    allowedCount: number;
}

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

export function atLeast(severity: string, floor: string): boolean {
    return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(floor);
}

/** GHSA id from an advisory object's url, falling back to npm's numeric source. */
export function advisoryId(via: Exclude<AuditVia, string>): string {
    const fromUrl = via.url?.split('/').filter(Boolean).pop();
    if (fromUrl) return fromUrl;
    return via.source !== undefined ? String(via.source) : '';
}

export function classifyAudit(
    vulns: Record<string, AuditVuln>,
    allow: AllowEntry[],
    failAt: string,
    today: string,
): AuditClassification {
    const allowed = new Map(allow.map(entry => [entry.package, entry]));
    const unexpected: string[] = [];
    const stale: string[] = [];
    let allowedCount = 0;

    for (const [name, vuln] of Object.entries(vulns)) {
        if (!atLeast(vuln.severity, failAt)) continue;
        const advisories = (vuln.via ?? []).filter((via): via is Exclude<AuditVia, string> => typeof via !== 'string');
        const entry = allowed.get(name);
        if (!entry) {
            const titles = advisories.map(via => via.title ?? '').filter(Boolean).slice(0, 2).join('; ');
            const paths = (vuln.via ?? []).filter((via): via is string => typeof via === 'string').slice(0, 2).join(', ');
            const detail = titles || (paths ? `via ${paths}` : '');
            unexpected.push(`${vuln.severity.toUpperCase()} ${name}${detail ? ` — ${detail}` : ''}`);
            continue;
        }
        if (advisories.length > 0) {
            if (!entry.advisories || entry.advisories.length === 0) {
                unexpected.push(`${vuln.severity.toUpperCase()} ${name} — allowlist entry must list the advisory IDs it waives (${advisories.map(advisoryId).join(', ')})`);
                continue;
            }
            const waived = new Set(entry.advisories);
            const unlisted = advisories.filter(via => !waived.has(advisoryId(via)));
            if (unlisted.length > 0) {
                for (const via of unlisted) {
                    unexpected.push(`${vuln.severity.toUpperCase()} ${name} — ${advisoryId(via)} ${via.title ?? ''} is not covered by its allowlist entry`.trimEnd());
                }
                continue;
            }
        }
        allowedCount++;
        if (entry.review < today) stale.push(`${name} (review was due ${entry.review})`);
    }

    return { unexpected, stale, allowedCount };
}

