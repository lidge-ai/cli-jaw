// ─── Inline skill mention grammar ─────────────────────
// Codex-style `$skill-id` mentions. One grammar for the server (prompt
// injection), the TUI composer and the web composer popup, so a mention the
// popup inserts is exactly a mention the server resolves.

/** A `$` right after a word character or another `$` is not a mention (`US$5`, `a$b`, `$$x`). */
const MENTION_RE = /(?<![A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_:-]*)/g;
/** The mention being typed: a `$` token that ends at the cursor. */
const TYPING_RE = /(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9_:-]*)$/;

export interface SkillMentionToken {
    /** Index of the `$`. */
    start: number;
    /** Lower-cased text typed after the `$`. */
    query: string;
}

export interface RankableSkill {
    id: string;
    name?: string | undefined;
    description?: string | undefined;
}

export function findSkillMentionToken(text: string, cursor: number = text.length): SkillMentionToken | null {
    const value = String(text || '');
    const before = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
    const match = TYPING_RE.exec(before);
    if (!match) return null;
    const typed = match[1] ?? '';
    return { start: before.length - typed.length - 1, query: typed.toLowerCase() };
}

/** Id prefix beats id substring beats name/description substring; ties sort by id. */
export function rankSkillMentions<T extends RankableSkill>(skills: readonly T[], query: string): T[] {
    const q = String(query || '').toLowerCase();
    const score = (skill: T): number => {
        if (!q) return 1;
        const id = skill.id.toLowerCase();
        if (id.startsWith(q)) return 3;
        if (id.includes(q)) return 2;
        const text = `${skill.name || ''} ${skill.description || ''}`.toLowerCase();
        return text.includes(q) ? 1 : 0;
    };
    return skills
        .map(skill => ({ skill, score: score(skill) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
        .map(entry => entry.skill);
}

/** Mentioned ids in first-seen order, lower-cased, trailing `-`/`:` trimmed, deduped. */
export function extractSkillMentionIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const match of String(text || '').matchAll(MENTION_RE)) {
        const id = (match[1] ?? '').replace(/[-:]+$/, '').toLowerCase();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}
