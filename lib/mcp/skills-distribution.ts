/**
 * lib/mcp/skills-distribution.ts
 * 3-way skill distribution: Codex live → GitHub clone → bundled fallback.
 * Auto-activation of CODEX_ACTIVE + OPENCLAW_ACTIVE sets.
 */
import fs from 'fs';
import os from 'os';
import { basename, join } from 'path';
import { execSync } from 'child_process';
import {
    JAW_HOME,
    shouldSkipClone, writeCloneMeta, CLONE_TIMEOUT_MS,
    CODEX_ACTIVE, OPENCLAW_ACTIVE,
    copyDirRecursive, findPackageRoot,
    loadRegistry, getSkillVersion, shouldUpdateSkillDirectory,
    isDiscoverableSkillDirName, isSkillSourceEntryName, shouldUseLocalSkillsSource,
} from './skills-utils.js';
import { normalizeSkillNamespace, type LegacyMigrationResult } from './skills-migration.js';

type SkillRegistry = {
    skills?: Record<string, { category?: string }>;
};

/**
 * Skill ids this home refuses to activate, from `skills.disabled` in settings.json.
 *
 * Auto-activation is otherwise unconditional, so deleting an unwanted skill from
 * skills/ only lasts until the next boot copies it back from skills_ref/. An
 * instance that must route all browser work through another tool (Aside) needs a
 * durable way to say so. Read the file directly: this module runs during startup,
 * before the settings module is guaranteed to be loaded.
 */
function disabledSkillIds(): Set<string> {
    try {
        const parsed = JSON.parse(fs.readFileSync(join(JAW_HOME, 'settings.json'), 'utf8')) as {
            skills?: { disabled?: unknown };
        };
        const list = parsed.skills?.disabled;
        if (!Array.isArray(list)) return new Set<string>();
        return new Set(list.filter((value): value is string => typeof value === 'string'));
    } catch {
        return new Set<string>();
    }
}

/**
 * Phase 6 — 2×3 Skill Classification at Install
 *
 * Priority: ~/.codex/skills/ (live Codex) > bundled skills_ref/ (fallback)
 *
 * 1. If Codex is installed, classify its skills into active/ref
 * 2. Copy bundled skills_ref/ (OpenClaw + Codex fallback) → ~/.cli-jaw/skills_ref/
 * 3. Auto-activate: CODEX_ACTIVE + OPENCLAW_ACTIVE from refDir → activeDir
 *    (covers devices where Codex isn't installed)
 */
export function copyDefaultSkills() {
    const activeDir = join(JAW_HOME, 'skills');
    const refDir = join(JAW_HOME, 'skills_ref');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(refDir, { recursive: true });

    let copied = 0;
    const disabledSkills = disabledSkillIds();

    // Phase 1 dedup: these skills were merged into others — never copy from Codex
    const DEDUP_EXCLUDED = new Set([
        'spreadsheet',         // → xlsx
        'doc',                 // → docx
        'screenshot',          // → screen-capture
        'nano-pdf',            // → pdf
        'gh-issues',           // → github
        'gh-address-comments', // → github
        'gh-fix-ci',           // → github
        'yeet',                // → github
        'playwright',          // → webapp-testing
        'frontend-design',     // → dev-frontend (Orchestration v2)
    ]);

    // ─── 1. Codex live skills (if installed) ────────
    const codexSkills = join(os.homedir(), '.codex', 'skills');
    if (fs.existsSync(codexSkills)) {
        const skills = fs.readdirSync(codexSkills, { withFileTypes: true })
            .filter(d => d.isDirectory()
                && isDiscoverableSkillDirName(d.name)
                && !DEDUP_EXCLUDED.has(d.name));

        let activeCount = 0, refCount = 0;

        for (const skill of skills) {
            const src = join(codexSkills, skill.name);

            if (disabledSkills.has(skill.name)) continue;
            if (CODEX_ACTIVE.has(skill.name)) {
                const dst = join(activeDir, skill.name);
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    activeCount++;
                }
            } else {
                const dst = join(refDir, skill.name);
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    refCount++;
                }
            }
        }
        copied += activeCount + refCount;
        console.log(`[skills] Codex: ${activeCount} active, ${refCount} ref`);
    } else {
        console.log(`[skills] Codex: not installed, using bundled fallback`);
    }

    // ─── 2. Populate skills_ref/ ─────────────────────
    // Priority: git clone (always latest) → bundled fallback (dev) → offline
    const packageRefDir = join(findPackageRoot(), 'skills_ref');
    const SKILLS_REPO = 'https://github.com/lidge-jun/cli-jaw-skills.git';

    let skillsSourceResolved = false;

    // 2a. Try GitHub clone first (public repo, no auth needed), unless local
    // bundled skills are explicitly requested for compatibility closeout work.
    if (shouldUseLocalSkillsSource()) {
        const sourceMode = process.env["JAW_SKILLS_SOURCE"] || 'local';
        console.log(`[skills] using local bundled skills_ref (JAW_SKILLS_SOURCE=${sourceMode})`);
    } else if (shouldSkipClone()) {
        console.log(`[skills] GitHub clone suppressed (cooldown active)`);
    } else {
        try {
            const tmpClone = join(JAW_HOME, '.skills_clone_tmp');
            if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true });
            console.log(`[skills] fetching latest skills from GitHub...`);
            execSync(`git clone --depth 1 ${SKILLS_REPO} "${tmpClone}"`, {
                stdio: 'pipe', timeout: CLONE_TIMEOUT_MS,
            });
            // Version-aware merge from clone
            const srcReg = loadRegistry(tmpClone);
            const dstReg = loadRegistry(refDir);
            const cloned = fs.readdirSync(tmpClone, { withFileTypes: true });
            let cloneNew = 0, cloneUpdated = 0;
            for (const entry of cloned) {
                if (!isSkillSourceEntryName(entry.name)) continue;
                const src = join(tmpClone, entry.name);
                const dst = join(refDir, entry.name);
                if (entry.isDirectory()) {
                    if (!fs.existsSync(dst)) {
                        copyDirRecursive(src, dst);
                        cloneNew++;
                    } else if (shouldUpdateSkillDirectory(entry.name, src, dst, srcReg, dstReg)) {
                        const sv = getSkillVersion(entry.name, srcReg);
                        const dv = getSkillVersion(entry.name, dstReg);
                        fs.rmSync(dst, { recursive: true, force: true });
                        copyDirRecursive(src, dst);
                        cloneUpdated++;
                        console.log(`[skills] updated: ${entry.name} ${dv ?? '(same)'} → ${sv ?? '(mtime)'}`);
                    }
                } else if (entry.isFile()) {
                    fs.copyFileSync(src, dst);
                }
            }
            fs.rmSync(tmpClone, { recursive: true, force: true });
            console.log(`[skills] ✅ GitHub: ${cloneNew} new, ${cloneUpdated} updated`);
            writeCloneMeta(true);
            skillsSourceResolved = true;
        } catch (e) {
            writeCloneMeta(false);
            console.log(`[skills] GitHub clone skipped: ${(e as Error).message?.slice(0, 60)}`);
        }
    }

    // 2b. Fallback: bundled skills_ref/ (dev mode with initialized submodule)
    if (!skillsSourceResolved) {
        const bundledHasContent = fs.existsSync(packageRefDir) && fs.existsSync(join(packageRefDir, 'registry.json'));
        if (bundledHasContent) {
            const srcReg = loadRegistry(packageRefDir);
            const dstReg = loadRegistry(refDir);
            const entries = fs.readdirSync(packageRefDir, { withFileTypes: true });
            let refCopied = 0, refUpdated = 0;
            for (const entry of entries) {
                if (!isSkillSourceEntryName(entry.name)) continue;
                const src = join(packageRefDir, entry.name);
                const dst = join(refDir, entry.name);
                if (entry.isDirectory()) {
                    if (!fs.existsSync(dst)) {
                        copyDirRecursive(src, dst);
                        refCopied++;
                    } else if (shouldUpdateSkillDirectory(entry.name, src, dst, srcReg, dstReg)) {
                        const sv = getSkillVersion(entry.name, srcReg);
                        const dv = getSkillVersion(entry.name, dstReg);
                        fs.rmSync(dst, { recursive: true, force: true });
                        copyDirRecursive(src, dst);
                        refUpdated++;
                        console.log(`[skills] updated: ${entry.name} ${dv ?? '(same)'} → ${sv ?? '(mtime)'}`);
                    }
                } else if (entry.isFile()) {
                    fs.copyFileSync(src, dst);
                }
            }
            if (refCopied > 0) console.log(`[skills] Bundled fallback: ${refCopied} new skills → ref`);
            if (refUpdated > 0) console.log(`[skills] Bundled fallback: ${refUpdated} skills updated`);
            skillsSourceResolved = true;
        }
    }

    if (!skillsSourceResolved) {
        const hasExisting = fs.existsSync(join(refDir, 'registry.json'));
        if (!hasExisting) {
            const refDirDisplay = refDir.replace(/\\/g, '/');
            console.warn('');
            console.warn('[skills] ⚠️  Skills not available (GitHub clone failed)');
            console.warn('');
            console.warn('  Run manually:');
            console.warn(`    git clone --depth 1 ${SKILLS_REPO} "${refDirDisplay}"`);
            console.warn('    jaw skill reset');
            console.warn('');
            console.warn('  This fetches all skills and activates defaults.');
            console.warn('');
        }
    }

    // ─── 3. Auto-activate from refDir ───────────────
    // Promotes CODEX_ACTIVE + OPENCLAW_ACTIVE from ref → active
    // (fallback for devices without ~/.codex/skills/)
    // Orchestration v2: registry에서 category=orchestration인 스킬도 자동 활성화
    try {
        const registryPath = join(refDir, 'registry.json');
        if (fs.existsSync(registryPath)) {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SkillRegistry;
            for (const [id, meta] of Object.entries(registry.skills || {})) {
                if (meta.category === 'orchestration') OPENCLAW_ACTIVE.add(id);
            }
        }
    } catch { /* registry parse error — skip */ }
    const AUTO_ACTIVATE = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    let autoCount = 0;
    for (const id of AUTO_ACTIVATE) {
        if (disabledSkills.has(id)) continue;
        const src = join(refDir, id);
        const dst = join(activeDir, id);
        if (!fs.existsSync(src)) continue;
        if (!fs.existsSync(dst)) {
            copyDirRecursive(src, dst);
            copied++;
            autoCount++;
            console.log(`[skills] auto-activated: ${id}`);
        } else {
            // Sync active copy if any source file changed, not only SKILL.md.
            if (shouldUpdateSkillDirectory(id, src, dst, { skills: {} }, { skills: {} })) {
                fs.rmSync(dst, { recursive: true, force: true });
                copyDirRecursive(src, dst);
                autoCount++;
                console.log(`[skills] active synced: ${id}`);
            }
        }
    }
    if (autoCount > 0) console.log(`[skills] Total auto-activated/synced: ${autoCount}`);

    // A disabled skill that is already sitting in skills/ would still be loaded,
    // so removal happens here rather than only at the copy site.
    for (const id of disabledSkills) {
        const dst = join(activeDir, id);
        if (!fs.existsSync(dst)) continue;
        fs.rmSync(dst, { recursive: true, force: true });
        console.log(`[skills] disabled by settings, removed from active: ${id}`);
    }

    reportNamespaceMigration(normalizeSkillNamespace(activeDir, JAW_HOME));

    return copied;
}

/** Log what the jaw-* namespace pass moved, linked, or could not do. */
export function reportNamespaceMigration(result: LegacyMigrationResult): void {
    for (const moved of result.backedUp) console.log(`[skills] legacy skill backed up: ${moved}`);
    for (const id of result.unlinked) console.log(`[skills] stale compat link replaced: ${id}`);
    if (result.linked.length > 0) {
        console.log(`[skills] legacy-name compat links: ${result.linked.length}`);
    }
    for (const w of result.warnings) console.warn(`[skills] ${w}`);
}

/**
 * Propagate skills from JAW_HOME to all ~/.cli-jaw-* instance directories.
 * Runs after copyDefaultSkills() so the base is already up-to-date.
 *
 * - skills_ref/: version-aware merge (new + updated)
 * - skills/ (active): update existing + auto-activate standard set
 */
export function propagateSkillsToInstances() {
    const home = os.homedir();
    const baseActive = join(JAW_HOME, 'skills');
    const baseRef = join(JAW_HOME, 'skills_ref');
    if (!fs.existsSync(baseRef)) return;

    let instances: string[];
    try {
        instances = fs.readdirSync(home, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\.cli-jaw-\d+$/.test(d.name))
            .map(d => join(home, d.name));
    } catch { return; }

    if (instances.length === 0) return;

    const srcRefReg = loadRegistry(baseRef);

    // Build auto-activate set (same logic as copyDefaultSkills)
    const autoActivate = new Set([...CODEX_ACTIVE, ...OPENCLAW_ACTIVE]);
    try {
        const registryPath = join(baseRef, 'registry.json');
        if (fs.existsSync(registryPath)) {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SkillRegistry;
            for (const [id, meta] of Object.entries(registry.skills || {})) {
                if (meta.category === 'orchestration') autoActivate.add(id);
            }
        }
    } catch { /* skip */ }

    for (const instDir of instances) {
        const instRef = join(instDir, 'skills_ref');
        const instActive = join(instDir, 'skills');
        fs.mkdirSync(instRef, { recursive: true });
        fs.mkdirSync(instActive, { recursive: true });

        // 1. Sync skills_ref/ (version-aware)
        const dstRefReg = loadRegistry(instRef);
        let refNew = 0, refUpdated = 0;
        for (const entry of fs.readdirSync(baseRef, { withFileTypes: true })) {
            if (!isSkillSourceEntryName(entry.name)) continue;
            const src = join(baseRef, entry.name);
            const dst = join(instRef, entry.name);
            if (entry.isDirectory()) {
                if (!fs.existsSync(dst)) {
                    copyDirRecursive(src, dst);
                    refNew++;
                } else if (shouldUpdateSkillDirectory(entry.name, src, dst, srcRefReg, dstRefReg)) {
                    fs.rmSync(dst, { recursive: true, force: true });
                    copyDirRecursive(src, dst);
                    refUpdated++;
                }
            } else if (entry.isFile()) {
                fs.copyFileSync(src, dst);
            }
        }

        // 2. Sync default active skills from the instance's freshly synced ref.
        // Keep a baseActive fallback for future local-only defaults.
        let activeUpdated = 0, autoActivated = 0;
        for (const id of autoActivate) {
            const refSrc = join(instRef, id);
            const baseSrc = join(baseActive, id);
            const src = fs.existsSync(refSrc) ? refSrc : baseSrc;
            if (!fs.existsSync(src)) continue;

            const dst = join(instActive, id);
            if (!fs.existsSync(dst)) {
                copyDirRecursive(src, dst);
                autoActivated++;
            } else if (shouldUpdateSkillDirectory(id, src, dst, { skills: {} }, { skills: {} })) {
                fs.rmSync(dst, { recursive: true, force: true });
                copyDirRecursive(src, dst);
                activeUpdated++;
            }
        }

        // Each instance is its own home: legacy dirs back up inside it, and
        // its own compat links get (re)created.
        reportNamespaceMigration(normalizeSkillNamespace(instActive, instDir));

        const tag = basename(instDir);
        const parts: string[] = [];
        if (refNew) parts.push(`${refNew} new ref`);
        if (refUpdated) parts.push(`${refUpdated} updated ref`);
        if (activeUpdated) parts.push(`${activeUpdated} active updated`);
        if (autoActivated) parts.push(`${autoActivated} auto-activated`);
        if (parts.length > 0) {
            console.log(`[skills] ${tag}: ${parts.join(', ')}`);
        }
    }

    console.log(`[skills] propagated to ${instances.length} instance(s)`);
}
