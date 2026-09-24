#!/usr/bin/env node
// Public repository boundary. Check the index locally/CI, and every newly
// introduced commit before push (including an add-then-delete sequence).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isPrivatePath(file) {
    // `pr-assets` is not a private name but shares this guard: PR screenshot
    // evidence lives only on the orphan `pr-assets` branch, so a same-named
    // directory (e.g. `docs/pr-assets/`) must never land on a code branch.
    return file.replaceAll('\\', '/').split('/').some(segment =>
        /^(?:devlog(?:[._-].*)?|cli-jaw-internal|_plan|_fin|\.jwc|pr-assets)$/i.test(segment));
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function rejectPaths(paths, label) {
    const forbidden = paths.filter(isPrivatePath);
    if (forbidden.length) throw new Error(label + ': private paths must live outside cli-jaw:\n' + forbidden.join('\n'));
}

export function checkIndex(cwd) {
    rejectPaths(git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean), 'index');
    rejectWorkingTree(cwd);
    reportSubmodules(cwd, { enforce: submoduleEnforcement() });
}

/**
 * An ignored private directory is still a private directory.
 *
 * `ls-files` sees the index, so a `devlog/` that `.gitignore` covers reports
 * OK here while sitting in the checkout — which is exactly how one survived in
 * a working tree until a human noticed. The rule is about where records live,
 * not about whether Git happens to be tracking them: an ignored path is one
 * `git add -f` or one archive away from shipping, and it is already visible to
 * every tool and agent working in the directory.
 *
 * `--directory` reports the containing directory rather than each file inside
 * it, so a large private tree produces one actionable line.
 */
function rejectWorkingTree(cwd) {
    const untracked = git(cwd, ['ls-files', '-z', '--others', '--directory', '--no-empty-directory'])
        .split('\0').filter(Boolean)
        .map(entry => entry.replace(/\/$/, ''));
    rejectPaths(untracked, 'working tree');
}

/**
 * Submodule contents are enforced.
 *
 * They were warn-only for one reason: the `skills_ref` tip carried 29 private
 * records that predated this check, and failing on them would have broken the
 * build without deleting anything. Those records now live in cli-jaw-internal
 * and are gone from the submodule, so the reason has expired and the default
 * is a failure.
 *
 * Set `JAW_PRIVATE_BOUNDARY_SUBMODULES=warn` to go back to reporting, which
 * exists for the same situation recurring in another submodule — a finding
 * that has to be fixed elsewhere before this repository can demand it. It is
 * a bridge, not a setting to leave on.
 */
function submoduleEnforcement() {
    return String(process.env['JAW_PRIVATE_BOUNDARY_SUBMODULES'] || '').toLowerCase() !== 'warn';
}

export function reportSubmodules(cwd, { enforce = false } = {}) {
    const findings = [];
    for (const { path, cwd: subCwd } of submodules(cwd)) {
        if (!subCwd) {
            findings.push({ path, absent: true, files: [] });
            continue;
        }
        // Same reasoning as rejectWorkingTree: a submodule's own .gitignore can
        // hide a private tree from its index while it sits in the checkout and
        // ships with any archive of that submodule.
        const tracked = git(subCwd, ['ls-files', '-z']).split('\0').filter(Boolean);
        const untracked = git(subCwd, ['ls-files', '-z', '--others', '--directory', '--no-empty-directory'])
            .split('\0').filter(Boolean).map(entry => entry.replace(/\/$/, ''));
        const files = [...tracked, ...untracked].map(f => path + '/' + f).filter(isPrivatePath);
        if (files.length) findings.push({ path, absent: false, files });
    }
    for (const finding of findings) {
        if (finding.absent) {
            console.warn('[private-boundary] submodule ' + finding.path + ' is not checked out; its contents were NOT scanned');
            continue;
        }
        const label = 'submodule ' + finding.path + ': ' + finding.files.length + ' private path(s)';
        if (enforce) throw new Error(label + ':\n' + finding.files.join('\n'));
        console.warn('[private-boundary] WARN ' + label + ' — ' + finding.files.slice(0, 3).join(', ') +
            (finding.files.length > 3 ? ', …' : ''));
    }
    return findings;
}

/**
 * Submodules are gitlinks: `ls-files` and `ls-tree` stop at the pointer and
 * never enumerate their contents, so a private path committed inside a
 * submodule is invisible to a check that only walks the superproject. Publish
 * the submodule and the record ships with it.
 *
 * Returns each submodule's path plus a working-tree cwd when one is checked
 * out. An absent working tree is reported rather than skipped silently.
 */
function submodules(cwd) {
    let raw = '';
    try {
        raw = git(cwd, ['config', '--file', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`]);
    } catch {
        return []; // no .gitmodules, or no submodule entries in it
    }
    const out = [];
    for (const line of raw.trim().split('\n').filter(Boolean)) {
        const path = line.slice(line.indexOf(' ') + 1).trim();
        if (!path || path.startsWith('/') || path.split('/').includes('..')) continue;
        const subCwd = resolve(cwd, path);
        let usable = false;
        try {
            usable = git(subCwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
        } catch {
            usable = false;
        }
        out.push({ path, cwd: usable ? subCwd : null });
    }
    return out;
}

export function checkRange(cwd, base, head, destination) {
    // Range endpoints come from Git's pre-push protocol or explicit CLI args.
    // rev-parse verifies them as commits before any option-bearing git call.
    const oid = ref => git(cwd, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
    const headId = oid(head);
    const baseId = base ? oid(base) : null;
    // The guard is about NEW disclosure. A commit every ref of THIS destination
    // already advertises is public there regardless of which branch receives it,
    // so a fast-forward of preview/main onto commits that dev already published
    // must not re-scan history that predates the private-record detachment.
    // Only the destination's own refs count; unrelated/private remote-tracking
    // refs prove nothing. A new ref has no old tip and needs the destination.
    if (!baseId && !destination) throw new Error('A destination is required to check a new remote ref');
    const available = destination ? advertisedCommits(cwd, destination) : [];
    const exclude = [...(baseId ? [baseId] : []), ...available];
    const revArgs = exclude.length ? [headId, '--not', ...exclude] : [headId];
    const commits = new Set([headId, ...git(cwd, ['rev-list', ...revArgs]).trim().split('\n').filter(Boolean)]);
    for (const commit of commits) {
        rejectPaths(git(cwd, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean), commit);
    }
}

/** Commits the destination remote currently advertises and this repository has. */
function advertisedCommits(cwd, destination) {
    const advertised = git(cwd, ['ls-remote', '--refs', '--', destination])
        .split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]);
    if (advertised.some(sha => !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Invalid destination refs');
    if (!advertised.length) return [];
    return execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        cwd, encoding: 'utf8', input: advertised.map(sha => sha + '^{commit}').join('\n') + '\n',
        maxBuffer: 64 * 1024 * 1024,
    }).split('\n').filter(line => /^[a-f0-9]{40,64} commit$/.test(line)).map(line => line.split(' ')[0]);
}

export function checkPush(cwd, input, destination) {
    const zero = /^0+$/;
    for (const line of input.trim().split('\n').filter(Boolean)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]) || !/^[a-f0-9]{40,64}$/.test(fields[3])) {
            throw new Error('Invalid pre-push ref update');
        }
        if (zero.test(fields[1])) continue; // deletion introduces no content
        checkRange(cwd, zero.test(fields[3]) ? null : fields[3], fields[1], destination);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        if (args[0] === '--pre-push' && args.length <= 2) {
            checkPush(process.cwd(), readFileSync(0, 'utf8'), args[1]);
        } else if (args[0] === '--range' && args.length === 3) {
            checkRange(process.cwd(), args[1], args[2]);
        } else if (args.length === 0) {
            checkIndex(process.cwd());
        } else {
            throw new Error('Usage: check-private-boundary.mjs [--pre-push <destination> | --range <base> <head>]');
        }
        console.log('[private-boundary] OK');
    } catch (error) {
        console.error('[private-boundary] ' + error.message);
        process.exitCode = 1;
    }
}
