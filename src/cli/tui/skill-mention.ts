/**
 * `$`-skill mention popup for the TUI composer — the `@file` popup's twin
 * (file-mention.ts). The grammar lives in src/shared/skill-mention.ts so the
 * TUI inserts exactly what the server resolves.
 */
import type { OverlayItem } from '../types.js';
import { getSkillCommandsCache } from '../../core/skill-cache.js';
import { findSkillMentionToken, rankSkillMentions, skillMentionKey, type RankableSkill } from '../../shared/skill-mention.js';

export interface SkillMentionMatch {
    query: string;
    /** Character index in the trailing text segment where `$` starts. */
    replaceStart: number;
}

/** Return the active `$`-mention token under the cursor, if any. */
export function findSkillMentionMatch(trailingText: string, cursor: number): SkillMentionMatch | null {
    const token = findSkillMentionToken(trailingText, cursor);
    return token ? { query: token.query, replaceStart: token.start } : null;
}

/** Active skills ranked for the typed query, as popup rows. */
export function listSkillMentionItems(
    query: string,
    skills: readonly RankableSkill[] = getSkillCommandsCache(),
): OverlayItem[] {
    return rankSkillMentions(skills, query).map(skill => {
        const key = skillMentionKey(skill);
        return { name: key, desc: skill.description || '', insertText: `$${key}`, kind: 'skill-mention' };
    });
}
