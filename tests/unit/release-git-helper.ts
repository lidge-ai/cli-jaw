import { mkdtempSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function gitEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const cleared = [
        'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
        'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
    ];
    for (const key of Object.keys(env)) {
        if (cleared.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) {
            delete env[key];
        }
    }
    return {
        ...env,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release@example.invalid',
    };
}

export function tempRepo() {
    const cwd = mkdtempSync(join(tmpdir(), 'release-git-'));
    git(cwd, ['init', '-b', 'dev']);
    return cwd;
}

export function git(cwd: string, args: string[], env = gitEnv()) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
    return result.stdout.trim();
}
