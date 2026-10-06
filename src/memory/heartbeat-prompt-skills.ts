import fs from 'node:fs';
import { join, sep } from 'node:path';
import { SKILLS_DIR, isHeartbeatPromptSkills } from '../core/config.js';

const MAX_SKILL_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
export type PromptSkillFailure = 'prompt_skill_missing' | 'prompt_skill_not_file'
    | 'prompt_skill_outside_root' | 'prompt_skill_too_large'
    | 'prompt_skill_read_failed' | 'prompt_skill_bad_frontmatter' | 'prompt_skill_invalid_id';
export type PromptSkillsResult = { ok: true; block: string }
    | { ok: false; reason: PromptSkillFailure; id: string };

/** Read only operator-pinned skill bodies; never let a broken skill run a prompt without its policy. */
export function loadHeartbeatPromptSkills(ids: unknown, options: { skillsDir?: string } = {}): PromptSkillsResult {
    try {
        return readHeartbeatPromptSkills(ids, options);
    } catch {
        // Includes unexpected filesystem/runtime failures. A scheduled tick must
        // receive a refusal value rather than escaping into its answer path.
        return { ok: false, reason: 'prompt_skill_read_failed', id: '' };
    }
}

function readHeartbeatPromptSkills(ids: unknown, options: { skillsDir?: string }): PromptSkillsResult {
    if (!isHeartbeatPromptSkills(ids)) return { ok: false, reason: 'prompt_skill_invalid_id', id: '' };
    const skillsDir = options.skillsDir ?? SKILLS_DIR;
    let root: string;
    try { root = fs.realpathSync(skillsDir); }
    catch (error) {
        return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'prompt_skill_missing' : 'prompt_skill_read_failed', id: ids[0]! };
    }
    let total = 0;
    const blocks: string[] = [];
    for (const id of ids) {
        const file = join(skillsDir, id, 'SKILL.md');
        try {
            fs.lstatSync(file);
        } catch (error) {
            return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'prompt_skill_missing' : 'prompt_skill_read_failed', id };
        }
        let actual: string;
        try { actual = fs.realpathSync(file); }
        catch (error) {
            return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'prompt_skill_missing' : 'prompt_skill_read_failed', id };
        }
        if (!actual.startsWith(root + sep)) return { ok: false, reason: 'prompt_skill_outside_root', id };
        let handle: number | undefined;
        try {
            handle = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            if (!fs.fstatSync(handle).isFile()) return { ok: false, reason: 'prompt_skill_not_file', id };
            const buffer = Buffer.allocUnsafe(MAX_SKILL_BYTES + 1);
            let size = 0;
            while (size < buffer.length) {
                const read = fs.readSync(handle, buffer, size, buffer.length - size, null);
                if (read === 0) break;
                size += read;
            }
            if (size > MAX_SKILL_BYTES || total + size > MAX_TOTAL_BYTES) {
                return { ok: false, reason: 'prompt_skill_too_large', id };
            }
            total += size;
            let body = buffer.subarray(0, size).toString('utf8');
            if (/^---(?:\r?\n|$)/.test(body)) {
                const openingEnd = body.indexOf('\n');
                if (openingEnd < 0) return { ok: false, reason: 'prompt_skill_bad_frontmatter', id };
                const close = /^---[ \t]*\r?$/gm;
                close.lastIndex = openingEnd + 1;
                const found = close.exec(body);
                if (!found) return { ok: false, reason: 'prompt_skill_bad_frontmatter', id };
                body = body.slice(found.index + found[0].length).replace(/^\r?\n/, '');
            }
            blocks.push(`--- Skill: ${id} (operator-pinned for this job) ---\n${body.trim()}\n--- End Skill ---`);
        } catch {
            return { ok: false, reason: 'prompt_skill_read_failed', id };
        } finally {
            if (handle !== undefined) try { fs.closeSync(handle); } catch { /* read already settled */ }
        }
    }
    return { ok: true, block: blocks.join('\n\n') };
}
