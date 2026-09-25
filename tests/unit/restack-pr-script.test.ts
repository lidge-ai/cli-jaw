import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const scriptPath = join(projectRoot, 'scripts', 'restack-pr.sh');

function setupRepo(name: string) {
  const root = mkdtempSync(join(tmpdir(), name));
  execFileSync('git', ['init', '--bare'], { cwd: root });

  const work = mkdtempSync(join(tmpdir(), name + '-work'));
  execFileSync('git', ['clone', root, '.'], { cwd: work });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: work });

  writeFileSync(join(work, 'dev.txt'), 'dev');
  execFileSync('git', ['add', 'dev.txt'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'dev'], { cwd: work });
  execFileSync('git', ['push', 'origin', 'HEAD:dev'], { cwd: work });

  return { remoteRoot: root, workDir: work };
}

function commit(work: string, file: string, content: string, message: string) {
  writeFileSync(join(work, file), content);
  execFileSync('git', ['add', file], { cwd: work });
  execFileSync('git', ['commit', '-m', message], { cwd: work });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
}

function isAncestor(work: string, a: string, b: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: work });
    return true;
  } catch {
    return false;
  }
}

test('restack-pr scenario A: child moves cleanly onto updated dev', { skip: process.platform === 'win32' }, () => {
  const { remoteRoot, workDir } = setupRepo('restack-ok');
  execFileSync('git', ['checkout', '-b', 'child'], { cwd: workDir });
  const pHead = commit(workDir, 'parent.txt', 'parent line\n', 'parent commit');
  commit(workDir, 'child.txt', 'child line\n', 'child commit');
  execFileSync('git', ['push', 'origin', 'HEAD:child'], { cwd: workDir });

  // Squash parent onto dev
  execFileSync('git', ['checkout', 'dev'], { cwd: workDir });
  writeFileSync(join(workDir, 'parent.txt'), 'parent line\n');
  execFileSync('git', ['add', 'parent.txt'], { cwd: workDir });
  execFileSync('git', ['commit', '-m', 'squashed parent'], { cwd: workDir });
  execFileSync('git', ['push', 'origin', 'HEAD:dev'], { cwd: workDir });

  const out = execFileSync('bash', [scriptPath, '--no-push', '--remote', remoteRoot, '--onto', 'dev', 'child', pHead], {
    cwd: workDir, encoding: 'utf8',
  });
  assert.match(out, /OK: child restacked onto/);

  const childDiff = execFileSync('git', ['diff', 'dev', 'child'], { cwd: workDir, encoding: 'utf8' }).trim();
  assert.match(childDiff, /child\.txt/);
  assert.doesNotMatch(childDiff, /parent\.txt/);
});

test('restack-pr scenario B: dev also edits child line -> conflict exit 3', { skip: process.platform === 'win32' }, () => {
  const { remoteRoot, workDir } = setupRepo('restack-conflict');
  execFileSync('git', ['checkout', '-b', 'child'], { cwd: workDir });
  const pHead = commit(workDir, 'shared.txt', 'parent line\nchild line\n', 'parent commit');
  commit(workDir, 'shared.txt', 'parent line\nchild edited\n', 'child commit');
  execFileSync('git', ['push', 'origin', 'HEAD:child'], { cwd: workDir });

  execFileSync('git', ['checkout', 'dev'], { cwd: workDir });
  writeFileSync(join(workDir, 'shared.txt'), 'parent line\nchild dev edit\n');
  execFileSync('git', ['add', 'shared.txt'], { cwd: workDir });
  execFileSync('git', ['commit', '-m', 'squashed parent with dev edit'], { cwd: workDir });
  execFileSync('git', ['push', 'origin', 'HEAD:dev'], { cwd: workDir });

  let thrown: Error | null = null;
  try {
    execFileSync('bash', [scriptPath, '--no-push', '--remote', remoteRoot, '--onto', 'dev', 'child', pHead], {
      cwd: workDir, encoding: 'utf8',
    });
  } catch (e: any) {
    thrown = e;
  }
  assert.ok(thrown, 'expected conflict');
  assert.equal(thrown!.status, 3);
  assert.match(thrown!.stderr, /shared\.txt/);

  // Branch on remote should not have moved
  const remoteChild = execFileSync('git', ['rev-parse', 'child'], { cwd: remoteRoot, encoding: 'utf8' }).trim();
  assert.equal(remoteChild, execFileSync('git', ['rev-parse', 'child'], { cwd: workDir, encoding: 'utf8' }).trim());
});

test('restack-pr scenario C: old parent not ancestor without --reviewed-base -> exit 1', { skip: process.platform === 'win32' }, () => {
  const { remoteRoot, workDir } = setupRepo('restack-rewritten');
  execFileSync('git', ['checkout', '-b', 'child'], { cwd: workDir });
  const firstParent = commit(workDir, 'parent.txt', 'parent line\n', 'parent commit');
  commit(workDir, 'child.txt', 'child line\n', 'child commit');
  execFileSync('git', ['push', 'origin', 'HEAD:child'], { cwd: workDir });

  // Add an unrelated commit to dev so we can rewrite child from the new dev.
  execFileSync('git', ['checkout', 'dev'], { cwd: workDir });
  commit(workDir, 'other.txt', 'other\n', 'other dev commit');
  execFileSync('git', ['push', 'origin', 'HEAD:dev'], { cwd: workDir });

  // Rewrite child from the new dev tip, so firstParent is no longer an ancestor.
  execFileSync('git', ['checkout', '-B', 'child', 'origin/dev'], { cwd: workDir });
  commit(workDir, 'parent2.txt', 'parent line rewritten\n', 'rewritten parent');
  commit(workDir, 'child.txt', 'child line\n', 'child commit again');
  execFileSync('git', ['push', 'origin', '+HEAD:child'], { cwd: workDir });

  // Verify firstParent is not an ancestor of the new child head.
  assert.equal(isAncestor(workDir, firstParent, 'child'), false, 'firstParent should not be an ancestor of the rewritten child');

  let thrown: Error | null = null;
  try {
    execFileSync('bash', [scriptPath, '--no-push', '--remote', remoteRoot, '--onto', 'dev', 'child', firstParent], {
      cwd: workDir, encoding: 'utf8',
    });
  } catch (e: any) {
    thrown = e;
  }
  assert.ok(thrown, 'expected rewrite refusal');
  assert.equal(thrown!.status, 1);
  assert.match(thrown!.stderr, /branch was rewritten/);
});

test('restack-pr scenario D: unpushed local commits on the child -> exit 1, local work kept', { skip: process.platform === 'win32' }, () => {
  const { remoteRoot, workDir } = setupRepo('restack-local');
  execFileSync('git', ['checkout', '-b', 'child'], { cwd: workDir });
  const pHead = commit(workDir, 'parent.txt', 'parent line\n', 'parent commit');
  commit(workDir, 'child.txt', 'child line\n', 'child commit');
  execFileSync('git', ['push', 'origin', 'HEAD:child'], { cwd: workDir });
  const localOnly = commit(workDir, 'local.txt', 'not pushed\n', 'local-only commit');

  let thrown: Error | null = null;
  try {
    execFileSync('bash', [scriptPath, '--no-push', '--remote', remoteRoot, '--onto', 'dev', 'child', pHead], {
      cwd: workDir, encoding: 'utf8',
    });
  } catch (e: any) {
    thrown = e;
  }
  assert.ok(thrown, 'expected refusal to discard local commits');
  assert.equal(thrown!.status, 1);
  assert.match(thrown!.stderr, /commits that are not on/);
  assert.equal(execFileSync('git', ['rev-parse', 'child'], { cwd: workDir, encoding: 'utf8' }).trim(), localOnly);
});
