import test, { after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ExecCall = { command: string; args: string[] };
type SpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error; signal?: string | null };

const roots: string[] = [];
const execCalls: ExecCall[] = [];
const openedPaths = new Map<number, string>();
let spawnResult: SpawnResult = { status: 0, stdout: '', stderr: '' };
let spawnResults: SpawnResult[] = [];
let identityResult: { name: string; hash?: string } | null = null;
let identityCalls: Array<{ type: string; qualifier: unknown; keychain: unknown }> = [];
let traversalFault: string | null = null;
let readFault: string | null = null;

const realOpenSync = fs.openSync.bind(fs);
const realReadSync = fs.readSync.bind(fs);
const realCloseSync = fs.closeSync.bind(fs);
const realReaddir = fsPromises.readdir.bind(fsPromises);
mock.method(childProcess, 'spawnSync', () => (spawnResults.shift() ?? spawnResult) as ReturnType<typeof childProcess.spawnSync>);
mock.method(childProcess, 'execFileSync', ((command: string, args: string[]) => {
    execCalls.push({ command, args: [...args] });
    return '';
}) as typeof childProcess.execFileSync);
mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string) => {
    const fd = realOpenSync(path, flags);
    openedPaths.set(fd, String(path));
    return fd;
}) as typeof fs.openSync);
mock.method(fs, 'readSync', ((fd: number, ...args: unknown[]) => {
    if (openedPaths.get(fd) === readFault) throw new Error('fixture read denied');
    return (realReadSync as (...values: unknown[]) => number)(fd, ...args);
}) as typeof fs.readSync);
mock.method(fs, 'closeSync', ((fd: number) => {
    openedPaths.delete(fd);
    return realCloseSync(fd);
}) as typeof fs.closeSync);
mock.method(fsPromises, 'readdir', (async (path: fs.PathLike, options: unknown) => {
    if (String(path) === traversalFault) throw new Error('fixture traversal denied');
    return (realReaddir as (...values: unknown[]) => Promise<unknown>)(path, options);
}) as typeof fsPromises.readdir);

const { default: afterSign } = await import('../../electron/build/after-sign.mjs');
const { default: signExtraBinaries } = await import('../../electron/build/sign-extra-binaries.mjs');
const { verifyMacSignature, verifyMacDiskImage } = await import('../../scripts/verify-mac-signature.mjs');

const signingDependencies = {
    // Pinned source anchors: app-builder-lib 25.1.8
    // out/macPackager.js:190-197 and out/codeSign/macCodeSign.js:251-272.
    findIdentity: async (type: string, qualifier: unknown, keychain: unknown) => {
        identityCalls.push({ type, qualifier, keychain });
        return identityResult;
    },
};

afterEach(() => {
    execCalls.length = 0;
    identityCalls = [];
    identityResult = null;
    traversalFault = null;
    readFault = null;
    spawnResult = { status: 0, stdout: '', stderr: '' };
    spawnResults = [];
    delete process.env['CSC_IDENTITY_AUTO_DISCOVERY'];
    delete process.env['CSC_NAME'];
    delete process.env['CSC_LINK'];
    delete process.env['VERIFY_EXPECTED_TEAM_ID'];
});
after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function appFixture(): { root: string; resources: string } {
    const root = mkdtempSync(join(tmpdir(), 'jaw-signing-hook-'));
    roots.push(root);
    const resources = join(root, 'cli-jaw.app', 'Contents', 'Resources');
    mkdirSync(resources, { recursive: true });
    return { root, resources };
}

function packContext(
    root: string,
    signingInfo: Promise<{ keychainFile: string | null }> = Promise.resolve({ keychainFile: null }),
    identity: string | null | undefined = undefined,
    platformOverrides: Record<string, unknown> = {},
) {
    let signingInfoReads = 0;
    return {
        context: {
            electronPlatformName: 'darwin',
            appOutDir: root,
            packager: {
                appInfo: { productFilename: 'cli-jaw' },
                platformSpecificBuildOptions: { identity, ...platformOverrides },
                codeSigningInfo: {
                    get value() {
                        signingInfoReads += 1;
                        return signingInfo;
                    },
                },
            },
        },
        get signingInfoReads() { return signingInfoReads; },
    };
}

function writeMagic(path: string, magic: number): void {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(magic, 0);
    writeFileSync(path, bytes);
}

test('direct afterSign invocation preserves a valid Developer ID signature reported on stderr', async () => {
    spawnResult = {
        status: 0,
        stdout: '',
        stderr: 'Executable=cli-jaw.app/Contents/MacOS/cli-jaw\nAuthority=Developer ID Application: Fixture (TEAMFIX001)\n',
    };
    const { root } = appFixture();

    await afterSign(packContext(root).context);

    assert.equal(execCalls.length, 0, 'a real signature must never be replaced by the ad-hoc fallback');
});

test('direct afterSign invocation applies a plain ad-hoc fallback only for a recognized unsigned result', async () => {
    spawnResult = { status: 1, stdout: '', stderr: 'cli-jaw.app: code object is not signed at all\n' };
    const { root } = appFixture();

    await afterSign(packContext(root).context);

    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0]!.args.slice(0, 4), ['--force', '--deep', '--sign', '-']);
    assert.ok(!execCalls[0]!.args.includes('--options'), 'plain ad-hoc fallback must not claim hardened-runtime signing');
    assert.ok(!execCalls[0]!.args.includes('runtime'), 'plain ad-hoc fallback must not pass the runtime option');
    assert.ok(!execCalls[0]!.args.includes('--timestamp'), 'plain ad-hoc fallback must not request a secure timestamp');
});

test('direct afterSign invocation fails closed when the signature probe fails unexpectedly', async () => {
    spawnResult = { status: 2, stdout: '', stderr: 'cli-jaw.app: operation not permitted\n' };
    const { root } = appFixture();

    await assert.rejects(afterSign(packContext(root).context), /could not inspect existing signature.*operation not permitted/s);
    assert.equal(execCalls.length, 0);
});

test('afterPack awaits builder signing info and uses its identity and temporary keychain', async () => {
    const { root, resources } = appFixture();
    writeMagic(join(resources, 'sidecar-node'), 0xfeedfacf);
    identityResult = { name: 'Developer ID Application: Fixture (TEAMFIX001)', hash: 'FIXTUREHASH' };
    let release!: (value: { keychainFile: string }) => void;
    const signingInfo = new Promise<{ keychainFile: string }>(resolvePromise => { release = resolvePromise; });
    const fixture = packContext(root, signingInfo);

    const pending = signExtraBinaries(fixture.context, signingDependencies);
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    assert.equal(execCalls.length, 0, 'codesign must wait until electron-builder imports CSC_LINK');
    release({ keychainFile: '/fixture/electron-builder.keychain' });
    await pending;

    assert.equal(fixture.signingInfoReads, 1);
    assert.deepEqual(identityCalls, [{
        type: 'Developer ID Application', qualifier: undefined, keychain: '/fixture/electron-builder.keychain',
    }]);
    const sign = execCalls[0]!;
    assert.equal(sign.command, '/usr/bin/codesign');
    assert.ok(sign.args.includes('FIXTUREHASH'));
    assert.deepEqual(sign.args.slice(sign.args.indexOf('--keychain'), sign.args.indexOf('--keychain') + 2),
        ['--keychain', '/fixture/electron-builder.keychain']);
});

test('afterPack preserves the explicit unsigned opt-out without touching signing credentials', async () => {
    process.env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false';
    const { root, resources } = appFixture();
    writeMagic(join(resources, 'sidecar-node'), 0xfeedfacf);
    const fixture = packContext(root);

    await signExtraBinaries(fixture.context, signingDependencies);

    assert.equal(fixture.signingInfoReads, 0);
    assert.equal(identityCalls.length, 0);
    assert.equal(execCalls.length, 0);
});

test('afterPack fails a requested signed build when no Developer ID identity resolves', async () => {
    process.env['CSC_LINK'] = 'file:///fixture/developer-id.p12';
    const { root } = appFixture();
    const fixture = packContext(root, Promise.resolve({ keychainFile: '/fixture/electron-builder.keychain' }));

    await assert.rejects(signExtraBinaries(fixture.context, signingDependencies), /Developer ID Application identity/);
    assert.equal(execCalls.length, 0);
});

test('afterPack treats enabled notarization as an explicit signed-build request', async () => {
    const { root } = appFixture();
    const fixture = packContext(root, Promise.resolve({ keychainFile: null }), undefined, { notarize: true });

    await assert.rejects(signExtraBinaries(fixture.context, signingDependencies), /requested signing.*Developer ID Application/);
    assert.equal(execCalls.length, 0);
});

test('afterPack fails credential-owner errors without echoing credential diagnostics', async t => {
    await t.test('keychain preparation', async () => {
        const { root } = appFixture();
        const fixture = packContext(root, Promise.reject(new Error('sensitive fixture payload')));
        await assert.rejects(signExtraBinaries(fixture.context, signingDependencies), error => {
            assert.equal((error as Error).message, '[sign-extra] electron-builder could not prepare signing credentials');
            assert.doesNotMatch((error as Error).message, /sensitive fixture payload/);
            return true;
        });
    });
    await t.test('keychain preparation reports only a safe failure stage', async () => {
        const { root } = appFixture();
        const fixture = packContext(root, Promise.reject(
            new Error('Command failed: /usr/bin/security import /tmp/certificate.p12 -P sensitive fixture payload'),
        ));
        await assert.rejects(signExtraBinaries(fixture.context, signingDependencies), error => {
            assert.match((error as Error).message, /certificate import failed/);
            assert.doesNotMatch((error as Error).message, /sensitive fixture payload|certificate\.p12/);
            return true;
        });
    });
    await t.test('identity lookup', async () => {
        const { root } = appFixture();
        const fixture = packContext(root);
        await assert.rejects(signExtraBinaries(fixture.context, {
            findIdentity: async () => { throw new Error('sensitive fixture payload'); },
        }), error => {
            assert.equal((error as Error).message,
                '[sign-extra] electron-builder could not resolve the Developer ID Application identity');
            assert.doesNotMatch((error as Error).message, /sensitive fixture payload/);
            return true;
        });
    });
});

test('afterPack allows unconfigured local auto-discovery to find no identity', async () => {
    const { root } = appFixture();
    const fixture = packContext(root);

    await signExtraBinaries(fixture.context, signingDependencies);

    assert.equal(fixture.signingInfoReads, 1);
    assert.equal(identityCalls.length, 1);
    assert.equal(execCalls.length, 0);
});

test('afterPack honors an explicit null identity without initializing signing credentials', async () => {
    const { root } = appFixture();
    const fixture = packContext(root, Promise.resolve({ keychainFile: null }), null);

    await signExtraBinaries(fixture.context, signingDependencies);

    assert.equal(fixture.signingInfoReads, 0);
    assert.equal(identityCalls.length, 0);
    assert.equal(execCalls.length, 0);
});

test('afterPack signs FAT64 binaries in both byte orders and skips ordinary files', async () => {
    const { root, resources } = appFixture();
    writeMagic(join(resources, 'fat64-be'), 0xcafebabf);
    writeMagic(join(resources, 'fat64-le'), 0xbfbafeca);
    writeFileSync(join(resources, 'ordinary.txt'), 'not Mach-O');
    identityResult = { name: 'Developer ID Application: Fixture (TEAMFIX001)', hash: 'FIXTUREHASH' };

    await signExtraBinaries(packContext(root, Promise.resolve({ keychainFile: null })).context, signingDependencies);

    const signed = execCalls.map(call => call.args.at(-1)).sort();
    assert.deepEqual(signed, [join(resources, 'fat64-be'), join(resources, 'fat64-le')].sort());
});

test('afterPack surfaces traversal and Mach-O read failures instead of silently skipping them', async t => {
    await t.test('traversal failure', async () => {
        identityResult = { name: 'Developer ID Application: Fixture (TEAMFIX001)', hash: 'FIXTUREHASH' };
        const { root, resources } = appFixture();
        const blocked = join(resources, 'blocked');
        mkdirSync(blocked);
        traversalFault = blocked;
        await assert.rejects(signExtraBinaries(packContext(root).context, signingDependencies), /could not traverse.*fixture traversal denied/s);
        traversalFault = null;
    });
    await t.test('read failure', async () => {
        identityResult = { name: 'Developer ID Application: Fixture (TEAMFIX001)', hash: 'FIXTUREHASH' };
        const { root, resources } = appFixture();
        const unreadable = join(resources, 'unreadable');
        writeMagic(unreadable, 0xfeedfacf);
        readFault = unreadable;
        await assert.rejects(signExtraBinaries(packContext(root).context, signingDependencies), /could not inspect.*fixture read denied/s);
        readFault = null;
    });
    assert.equal(execCalls.length, 0);
});

function validVerificationProbes(teamId = 'TEAMFIX001'): SpawnResult[] {
    return [
        {
            status: 0,
            stdout: '',
            stderr: [
                'Authority=Developer ID Application: Fixture (' + teamId + ')',
                'TeamIdentifier=' + teamId,
                'Timestamp=Sep 21, 2026 at 12:00:00',
                'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded',
            ].join('\n'),
        },
        { status: 0, stdout: '', stderr: 'valid on disk\nsatisfies its Designated Requirement\n' },
        { status: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' },
        { status: 0, stdout: 'The validate action worked!\n', stderr: '' },
    ];
}

test('signature verifier reads successful stderr reports and accepts an optional matching team', () => {
    const { root } = appFixture();
    spawnResults = validVerificationProbes('TEAMFIX001');

    const report = verifyMacSignature({
        appPath: join(root, 'cli-jaw.app'), expectedTeamId: 'TEAMFIX001', requireStapled: true,
    });

    assert.equal(report.teamId, 'TEAMFIX001');
    assert.match(report.authority, /^Developer ID Application:/);
    assert.equal(spawnResults.length, 0);
});

test('signature verifier enforces VERIFY_EXPECTED_TEAM_ID only when explicitly provided', () => {
    const { root } = appFixture();
    const appPath = join(root, 'cli-jaw.app');
    spawnResults = validVerificationProbes('ARBITRARY01');
    assert.equal(verifyMacSignature({ appPath, requireStapled: true }).teamId, 'ARBITRARY01');

    process.env['VERIFY_EXPECTED_TEAM_ID'] = 'EXPECTED01';
    spawnResults = validVerificationProbes('OTHERTEAM1');
    assert.throws(() => verifyMacSignature({ appPath, requireStapled: true }),
        /signature team "OTHERTEAM1" does not match expected team "EXPECTED01"/);
});

test('signature verifier rejects an ad-hoc report without authority, hardened runtime, or timestamp', () => {
    const { root } = appFixture();
    spawnResults = [
        {
            status: 0,
            stdout: '',
            stderr: [
                'Signature=adhoc',
                'TeamIdentifier=not set',
                'CodeDirectory v=20400 size=123 flags=0x2(adhoc) hashes=1+7 location=embedded',
            ].join('\n'),
        },
        { status: 0, stdout: '', stderr: 'valid on disk\nsatisfies its Designated Requirement\n' },
        { status: 0, stdout: '', stderr: 'accepted\nsource=Unnotarized Developer ID\n' },
    ];

    assert.throws(
        () => verifyMacSignature({ appPath: join(root, 'cli-jaw.app'), requireStapled: false }),
        error => {
            const message = (error as Error).message;
            assert.match(message, /bundle carries no certificate authority/);
            assert.match(message, /bundle is ad-hoc signed/);
            assert.match(message, /hardened runtime is not enabled/);
            assert.match(message, /signature has no secure timestamp/);
            return true;
        },
    );
});

test('signature verifier fails closed when the metadata probe cannot execute cleanly', () => {
    const { root } = appFixture();
    spawnResults = [
        { status: 2, stdout: '', stderr: 'operation not permitted' },
        { status: 0, stdout: '', stderr: '' },
        { status: 0, stdout: '', stderr: '' },
    ];

    assert.throws(() => verifyMacSignature({ appPath: join(root, 'cli-jaw.app'), requireStapled: false }),
        /codesign -dv failed:\noperation not permitted/);
});

function dmgFixture(): string {
    const { root } = appFixture();
    const dmgPath = join(root, 'cli-jaw-9.9.9-arm64.dmg');
    writeFileSync(dmgPath, 'dmg');
    return dmgPath;
}

function validDiskImageProbes(teamId = 'TEAMFIX001'): SpawnResult[] {
    return [
        { status: 0, stdout: '', stderr: 'Authority=Developer ID Application: Fixture (' + teamId + ')\nTeamIdentifier=' + teamId + '\nTimestamp=Sep 23, 2026 at 01:15:10\n' },
        { status: 0, stdout: '', stderr: 'valid on disk\nsatisfies its Designated Requirement\n' },
        { status: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' },
        { status: 0, stdout: 'The validate action worked!\n', stderr: '' },
    ];
}

test('disk image verifier accepts a notarized, stapled Developer ID DMG from the expected team', () => {
    const dmgPath = dmgFixture();
    spawnResults = validDiskImageProbes('TEAMFIX001');
    const report = verifyMacDiskImage({ dmgPath, expectedTeamId: 'TEAMFIX001' });
    assert.equal(report.teamId, 'TEAMFIX001');
    assert.equal(spawnResults.length, 0);
});

test('disk image verifier rejects the unsigned DMG shape shipped before disk image notarization', () => {
    const dmgPath = dmgFixture();
    spawnResults = [
        { status: 1, stdout: '', stderr: dmgPath + ': code object is not signed at all\n' },
        { status: 1, stdout: '', stderr: dmgPath + ': code object is not signed at all\n' },
        { status: 3, stdout: '', stderr: dmgPath + ': rejected\nsource=no usable signature\n' },
        { status: 65, stdout: '', stderr: 'does not have a ticket stapled to it.\n' },
    ];
    assert.throws(() => verifyMacDiskImage({ dmgPath, expectedTeamId: 'U9ATA49N28' }), error => {
        const message = (error as Error).message;
        assert.match(message, /codesign -dv failed/);
        assert.match(message, /spctl did not accept the disk image as notarized/);
        assert.match(message, /no stapled notarization ticket/);
        return true;
    });
});

test('disk image verifier treats an accepted but unnotarized signature as a failure', () => {
    const dmgPath = dmgFixture();
    spawnResults = validDiskImageProbes('TEAMFIX001');
    spawnResults[2] = { status: 0, stdout: '', stderr: 'accepted\nsource=Unnotarized Developer ID\n' };
    assert.throws(() => verifyMacDiskImage({ dmgPath }), /spctl did not accept the disk image as notarized/);
});

test('disk image verifier enforces the expected team', () => {
    const dmgPath = dmgFixture();
    spawnResults = validDiskImageProbes('OTHERTEAM1');
    assert.throws(() => verifyMacDiskImage({ dmgPath, expectedTeamId: 'EXPECTED01' }),
        /disk image team "OTHERTEAM1" does not match expected team "EXPECTED01"/);
});
