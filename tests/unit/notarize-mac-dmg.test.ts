import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { findDiskImage, notarizeMacDiskImage, updateDiskImageMetadata } from '../../scripts/notarize-mac-dmg.mjs';

type Call = { cmd: string; args: string[] };
type Result = { status: number | null; stdout?: string; stderr?: string; error?: Error | null };

const TEAM = 'TEAMFIX001';
const SECRET = 'abcd-efgh-ijkl-mnop';
const SUBMISSION = '11111111-2222-3333-4444-555555555555';
const env = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: SECRET, APPLE_TEAM_ID: TEAM };

function b64(bytes: Buffer | string): string {
  return createHash('sha512').update(bytes).digest('base64');
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'jaw-dmg-notary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const dmgName = 'cli-jaw-9.9.9-arm64.dmg';
  const zipName = 'cli-jaw-9.9.9-arm64-mac.zip';
  const dmgPath = join(dist, dmgName);
  writeFileSync(dmgPath, 'signed-dmg');
  const zipDigest = b64('zip-payload');
  const metadataPath = join(dist, 'latest-mac.yml');
  writeFileSync(metadataPath, stringify({
    version: '9.9.9',
    files: [
      { url: zipName, sha512: zipDigest, size: 11 },
      { url: dmgName, sha512: b64('signed-dmg'), size: 10 },
    ],
    path: zipName,
    sha512: zipDigest,
    releaseDate: '2026-09-23T00:00:00.000Z',
  }));
  return { dist, dmgPath, dmgName, zipName, zipDigest, metadataPath };
}

/** A scripted toolchain: staple appends a ticket, app-builder describes the file. */
function toolchain(dmgPath: string, overrides: Partial<Record<string, Result>> = {}) {
  const calls: Call[] = [];
  const run = (cmd: string, args: string[]): Result => {
    calls.push({ cmd, args: [...args] });
    const key = cmd.endsWith('codesign') ? 'codesign'
      : args[0] === 'notarytool' ? `notarytool-${args[1]}`
        : args[0] === 'stapler' ? `stapler-${args[1]}`
          : args[0] === 'blockmap' ? 'blockmap' : cmd;
    if (overrides[key]) return overrides[key]!;
    switch (key) {
      case 'codesign':
        return { status: 0, stderr: `Authority=Developer ID Application: Fixture (${TEAM})\nTeamIdentifier=${TEAM}\nTimestamp=Sep 23, 2026\n` };
      case 'notarytool-submit':
        return { status: 0, stdout: JSON.stringify({ id: SUBMISSION, status: 'Accepted', message: 'Processing complete' }) };
      case 'stapler-staple':
        writeFileSync(dmgPath, 'signed-dmg+ticket');
        return { status: 0, stdout: 'The staple and validate action worked!' };
      case 'stapler-validate':
        return { status: 0, stdout: 'The validate action worked!' };
      case 'blockmap': {
        const bytes = readFileSync(dmgPath);
        return { status: 0, stdout: JSON.stringify({ size: bytes.length, sha512: b64(bytes) }) };
      }
      default:
        return { status: 0, stdout: '' };
    }
  };
  return { run, calls };
}

test('staples the DMG and moves only its metadata entry to the stapled bytes', (t) => {
  const f = fixture(t);
  const { run, calls } = toolchain(f.dmgPath);
  const report = notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: '/fixture/app-builder', expectedTeamId: TEAM, log: () => {} });

  assert.equal(report.submissionId, SUBMISSION);
  assert.equal(report.metadataUpdated, true);
  const metadata = parse(readFileSync(f.metadataPath, 'utf8'));
  const dmg = metadata.files.find((file: { url: string }) => file.url === f.dmgName);
  const zip = metadata.files.find((file: { url: string }) => file.url === f.zipName);
  assert.equal(dmg.sha512, b64('signed-dmg+ticket'));
  assert.equal(dmg.size, 'signed-dmg+ticket'.length);
  assert.equal(zip.sha512, f.zipDigest, 'the updater payload entry must not change');
  assert.equal(metadata.path, f.zipName);
  assert.equal(metadata.sha512, f.zipDigest);
  assert.equal(metadata.releaseDate, '2026-09-23T00:00:00.000Z');

  const order = calls.map(call => call.args[0] === 'notarytool' || call.args[0] === 'stapler' ? `${call.args[0]} ${call.args[1]}` : call.args[0] === 'blockmap' ? 'blockmap' : 'codesign');
  assert.deepEqual(order, ['codesign', 'notarytool submit', 'stapler staple', 'stapler validate', 'blockmap']);
  const blockmap = calls.at(-1)!;
  assert.deepEqual(blockmap.args, ['blockmap', '--input', f.dmgPath, '--output', `${f.dmgPath}.blockmap`]);
});

test('refuses a DMG that dmg-builder left unsigned before contacting the notary service', (t) => {
  const f = fixture(t);
  const { run, calls } = toolchain(f.dmgPath, {
    codesign: { status: 1, stderr: `${f.dmgPath}: code object is not signed at all` },
  });
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: 'x', log: () => {} }), /codesign -dv failed/);
  assert.equal(calls.length, 1);
});

test('refuses a DMG signed by a team other than the notarizing team', (t) => {
  const f = fixture(t);
  const { run, calls } = toolchain(f.dmgPath, {
    codesign: { status: 0, stderr: 'Authority=Developer ID Application: Other (OTHER00001)\nTeamIdentifier=OTHER00001\nTimestamp=now\n' },
  });
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: 'x', log: () => {} }), /signed by team "OTHER00001"/);
  assert.equal(calls.length, 1);
});

test('a rejected submission fails with the notary log and never prints the password', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.metadataPath, 'utf8');
  const { run, calls } = toolchain(f.dmgPath, {
    'notarytool-submit': { status: 1, stdout: JSON.stringify({ id: SUBMISSION, status: 'Invalid' }), stderr: `echo ${SECRET}` },
    'notarytool-log': { status: 0, stdout: '{"issues":[{"message":"The signature does not include a secure timestamp."}]}' },
  });
  assert.throws(
    () => notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: 'x', log: () => {} }),
    (error: Error) => {
      assert.match(error.message, /not accepted \(status: Invalid\)/);
      assert.match(error.message, /secure timestamp/);
      assert.ok(!error.message.includes(SECRET), 'app-specific password leaked into the error');
      return true;
    },
  );
  assert.ok(!calls.some(call => call.args[0] === 'stapler'), 'must not staple a rejected image');
  assert.equal(readFileSync(f.metadataPath, 'utf8'), before, 'metadata must stay untouched on failure');
});

test('fails when stapling does not leave a valid ticket', (t) => {
  const f = fixture(t);
  const { run } = toolchain(f.dmgPath, { 'stapler-validate': { status: 65, stderr: 'does not have a ticket stapled to it.' } });
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: 'x', log: () => {} }), /stapler validate failed/);
});

test('fails when the blockmap description disagrees with the stapled file', (t) => {
  const f = fixture(t);
  const { run } = toolchain(f.dmgPath, { blockmap: { status: 0, stdout: JSON.stringify({ size: 10, sha512: b64('signed-dmg') }) } });
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env, run, appBuilderPath: 'x', log: () => {} }), /does not match the stapled disk image/);
});

test('requires every notarization credential and the pinned team', (t) => {
  const f = fixture(t);
  const { run, calls } = toolchain(f.dmgPath);
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env: { APPLE_ID: 'x' }, run, log: () => {} }),
    /Missing notarization credential\(s\): APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/);
  assert.throws(() => notarizeMacDiskImage({ distDir: f.dist, env, run, expectedTeamId: 'PINNED0001', log: () => {} }),
    /does not match the expected release signing team/);
  assert.equal(calls.length, 0);
});

test('finds exactly one DMG and refuses ambiguity', (t) => {
  const f = fixture(t);
  assert.equal(findDiskImage(f.dist), f.dmgPath);
  writeFileSync(join(f.dist, 'other.dmg'), 'x');
  assert.throws(() => findDiskImage(f.dist), /exactly one \.dmg/);
});

test('metadata repair refuses a DMG named as the update payload and duplicate entries', (t) => {
  const f = fixture(t);
  const metadata = parse(readFileSync(f.metadataPath, 'utf8'));
  writeFileSync(f.metadataPath, stringify({ ...metadata, path: f.dmgName }));
  assert.throws(() => updateDiskImageMetadata(f.metadataPath, f.dmgName, { sha512: 'x', size: 1 }), /update payload/);
  writeFileSync(f.metadataPath, stringify({ ...metadata, files: [...metadata.files, { ...metadata.files[1] }] }));
  assert.throws(() => updateDiskImageMetadata(f.metadataPath, f.dmgName, { sha512: 'x', size: 1 }), /more than once/);
  writeFileSync(f.metadataPath, stringify({ ...metadata, files: [metadata.files[0]] }));
  assert.equal(updateDiskImageMetadata(f.metadataPath, f.dmgName, { sha512: 'x', size: 1 }), false);
});
