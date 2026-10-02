import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../../electron/build/update-user-path.ps1');
const windowsOnly = {
  skip: process.platform === 'win32' ? false : 'requires Windows PowerShell',
};

function compute(mode: 'add' | 'remove', current: string, dir = 'C:\\Program Files\\cli-jaw\\resources\\server\\bin') {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Dir', dir,
    '-Mode', mode,
    '-Current', current,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('adding the installer bin directory twice is idempotent', windowsOnly, () => {
  const first = compute('add', 'C:\\Windows;C:\\Tools');
  const second = compute('add', first);
  assert.equal(second, first);
});

test('add removes every duplicate before prepending one entry', windowsOnly, () => {
  const dir = 'C:\\Program Files\\cli-jaw\\resources\\server\\bin';
  const result = compute('add', `C:\\Tools;${dir};C:\\Other;${dir}`, dir);
  assert.equal(result, `${dir};C:\\Tools;C:\\Other`);
});

test('matching ignores case and a trailing backslash', windowsOnly, () => {
  const dir = 'C:\\Program Files\\cli-jaw\\resources\\server\\bin';
  const current = 'C:\\PROGRAM FILES\\CLI-JAW\\RESOURCES\\SERVER\\BIN\\;C:\\Tools';
  assert.equal(compute('add', current, dir), `${dir};C:\\Tools`);
});

test('remove filters matching entries without adding a replacement', windowsOnly, () => {
  const dir = 'C:\\Program Files\\cli-jaw\\resources\\server\\bin';
  const current = `C:\\Tools;${dir};C:\\Other;${dir}\\`;
  assert.equal(compute('remove', current, dir), 'C:\\Tools;C:\\Other');
});

// ── registry mode (A11): a disposable HKCU key per test, never the real Environment ──

const DIR = 'C:\\Program Files\\cli-jaw\\resources\\server\\bin';

function testKey(t: { after(fn: () => void): void }): string {
  const key = `Software\\cli-jaw-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const created = spawnSync('reg', ['add', `HKCU\\${key}`, '/f'], { encoding: 'utf8', windowsHide: true });
  assert.equal(created.status, 0, created.stderr);
  t.after(() => { spawnSync('reg', ['delete', `HKCU\\${key}`, '/f'], { windowsHide: true }); });
  return key;
}

function setRaw(key: string, type: 'REG_SZ' | 'REG_EXPAND_SZ', value: string): void {
  const result = spawnSync('reg', ['add', `HKCU\\${key}`, '/v', 'Path', '/t', type, '/d', value, '/f'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function readRaw(key: string): { value: string; kind: string } | null {
  const command = [
    `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}')`,
    "if ($k.GetValueNames() -notcontains 'Path') { 'null'; exit 0 }",
    "@{ value = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = [string]$k.GetValueKind('Path') } | ConvertTo-Json -Compress",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { value: string; kind: string } | null;
}

function apply(key: string, mode: 'add' | 'remove'): void {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Dir', DIR, '-Mode', mode, '-RegistryKey', key, '-NoBroadcast',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}

test('registry: an absent Path is created as REG_EXPAND_SZ holding only the bin directory', windowsOnly, (t) => {
  const key = testKey(t);
  assert.equal(readRaw(key), null);
  apply(key, 'add');
  assert.deepEqual(readRaw(key), { value: DIR, kind: 'ExpandString' });
});

test('registry: a REG_SZ Path stays REG_SZ and a rerun does not add a second copy', windowsOnly, (t) => {
  const key = testKey(t);
  setRaw(key, 'REG_SZ', 'C:\\Tools;C:\\Other');
  apply(key, 'add');
  apply(key, 'add');
  assert.deepEqual(readRaw(key), { value: `${DIR};C:\\Tools;C:\\Other`, kind: 'String' });
});

test('registry: %VAR% entries in a REG_EXPAND_SZ Path stay unexpanded', windowsOnly, (t) => {
  const key = testKey(t);
  setRaw(key, 'REG_EXPAND_SZ', '%USERPROFILE%\\bin;C:\\Tools');
  apply(key, 'add');
  assert.deepEqual(readRaw(key), { value: `${DIR};%USERPROFILE%\\bin;C:\\Tools`, kind: 'ExpandString' });
});

test('registry: remove drops only the bin directory and can leave an empty value', windowsOnly, (t) => {
  const key = testKey(t);
  setRaw(key, 'REG_EXPAND_SZ', `%USERPROFILE%\\bin;${DIR}`);
  apply(key, 'remove');
  assert.deepEqual(readRaw(key), { value: '%USERPROFILE%\\bin', kind: 'ExpandString' });
  apply(key, 'remove');
  apply(key, 'add');
  apply(key, 'remove');
  assert.deepEqual(readRaw(key), { value: '%USERPROFILE%\\bin', kind: 'ExpandString' });
  setRaw(key, 'REG_SZ', DIR);
  apply(key, 'remove');
  assert.deepEqual(readRaw(key), { value: '', kind: 'String' });
});

