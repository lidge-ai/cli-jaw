// ─── Inline Skill Mentions ────────────────────────────
// The user names an active skill inline with `$skill-id` and that skill's
// SKILL.md rides along with that one message. The chat row keeps the typed
// text; only the agent prompt carries the expansion (see orchestrate()).

import { join } from 'node:path';
import { SKILLS_DIR } from './config.js';
import { getSkillCommandsCache, type SkillCommandEntry } from './skill-cache.js';
import { extractSkillMentionIds, skillMentionKey } from '../shared/skill-mention.js';

/** SKILL.md bodies run to 66 KB; five of them is already a very large turn. */
export const MAX_INLINE_SKILLS = 5;
export const MAX_INLINE_SKILL_CHARS = 200_000;

/** CLIs that receive the whole prompt on argv (src/agent/args.ts buildArgs/buildResumeArgs,
 * agy bootstrap envelope). Windows caps a command line at 32,767 chars, so one inlined
 * SKILL.md can already fail the spawn: these get the path stub only. Claude and codex
 * write the prompt to stdin (src/agent/spawn.ts) and keep the inline budget. */
const ARGV_PROMPT_CLIS: ReadonlySet<string> = new Set(['cursor', 'grok', 'kiro-code', 'opencode', 'agy']);

export interface SkillMentionOptions {
    /** The CLI that will receive this prompt; argv CLIs get path stubs only. */
    cli?: string | undefined;
    skills?: readonly SkillCommandEntry[] | undefined;
    skillsDir?: string | undefined;
}

/** Active skills only, by exact id or exact mention word (the skill name, e.g.
 * `jaw-browser` for the `browser` compat directory). An id wins over another skill's
 * name. Unknown words (`$HOME`, `$video` with no such skill) resolve to nothing. */
export function resolveSkillMentions(
    text: string,
    skills: readonly SkillCommandEntry[] = getSkillCommandsCache(),
): SkillCommandEntry[] {
    const byWord = new Map<string, SkillCommandEntry>();
    for (const skill of skills) byWord.set(skill.id.toLowerCase(), skill);
    for (const skill of skills) {
        const key = skillMentionKey(skill).toLowerCase();
        if (!byWord.has(key)) byWord.set(key, skill);
    }
    const seen = new Set<string>();
    return extractSkillMentionIds(text).flatMap(word => {
        const skill = byWord.get(word);
        if (!skill || seen.has(skill.id)) return [];
        seen.add(skill.id);
        return [skill];
    });
}

export function buildSkillMentionBlock(
    skills: readonly SkillCommandEntry[],
    options: { inline?: boolean; skillsDir?: string | undefined } = {},
): string {
    if (!skills.length) return '';
    const inline = options.inline !== false;
    const skillsDir = options.skillsDir ?? SKILLS_DIR;
    let inlined = 0;
    let used = 0;
    const blocks = skills.map(skill => {
        const path = join(skillsDir, skill.id, 'SKILL.md');
        // A body that itself contains the closing tag must not end the wrapper early.
        const body = skill.content.trim().replaceAll('</skill>', '</ skill>');
        const fits = inline && inlined < MAX_INLINE_SKILLS && used + body.length <= MAX_INLINE_SKILL_CHARS;
        if (fits) {
            inlined += 1;
            used += body.length;
        }
        const reason = inline ? 'over the inline skill budget for one message' : 'this CLI takes its prompt on the command line';
        return [
            '<skill>',
            `<name>${skillMentionKey(skill)}</name>`,
            `<path>${path}</path>`,
            fits ? body : `[Not inlined: ${reason}. Read the file at <path> before acting.]`,
            '</skill>',
        ].join('\n');
    });
    return [
        '[Inline Skills — the user mentioned these skills with $skill-id in this message. Follow each one for this message.]',
        ...blocks,
    ].join('\n');
}

/** Append the mentioned skills to a prompt. No mention → the prompt is returned unchanged. */
export function withSkillMentions(prompt: string, userText: string, options: SkillMentionOptions = {}): string {
    const skills = resolveSkillMentions(userText, options.skills ?? getSkillCommandsCache());
    const block = buildSkillMentionBlock(skills, {
        inline: !ARGV_PROMPT_CLIS.has(String(options.cli || '')),
        skillsDir: options.skillsDir,
    });
    return block ? `${prompt}\n\n${block}` : prompt;
}
