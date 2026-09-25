import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '../..');
const auditor = path.join(root, 'scripts/audit-fresh-install-evidence.mjs');
const releaseGate = path.join(root, 'scripts/verify-release-evidence.mjs');
const collector = path.join(root, 'scripts/collect-fresh-install-evidence.sh');
const verifier = path.join(root, 'scripts/verify-fresh-install.sh');

function writeFile(dir: string, name: string, content: string): void {
    fs.writeFileSync(path.join(dir, name), content.trimStart());
}

function writeExecutable(dir: string, name: string, content: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content.trimStart());
    fs.chmodSync(file, 0o755);
    return file;
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content.trimStart()).digest('hex');
}

function replaceScriptHash(summary: string, label: string, digest: string): string {
    return summary.replace(
        new RegExp(`(SCRIPT label="${label}"[^\\n]*sha256=")[a-f0-9]{64}(")`),
        `$1${digest}$2`,
    );
}

function baseSummary(target: 'macos' | 'wsl', collectorHash: string, installerHash: string, verifierHash: string): string {
    const installerSource = target === 'wsl' ? 'scripts/install-wsl.sh' : 'scripts/install.sh';
    return `
2026-05-20T00:00:00Z target=${target}
2026-05-20T00:00:00Z raw_base=https://raw.githubusercontent.com/lidge-ai/cli-jaw/master
2026-05-20T00:00:00Z install_script=
2026-05-20T00:00:00Z verifier_script=
2026-05-20T00:00:00Z skip_install=0
2026-05-20T00:00:00Z skip_doctor=0
2026-05-20T00:00:00Z out_dir=/tmp/evidence
2026-05-20T00:00:00Z SCRIPT label="collector" source="scripts/collect-fresh-install-evidence.sh" file="/tmp/evidence/00-collector-script.sh" sha256="${collectorHash}"
2026-05-20T00:00:00Z SNAPSHOT label="before" file="/tmp/evidence/00-before.txt"
2026-05-20T00:00:01Z SCRIPT label="installer" source="${installerSource}" file="/tmp/evidence/02-installer-script.sh" sha256="${installerHash}"
2026-05-20T00:00:01Z RUN label="CLI-JAW one-click installer" log="/tmp/evidence/01-install.log" command="bash ${installerSource}"
2026-05-20T00:00:02Z DONE label="CLI-JAW one-click installer" status=0
2026-05-20T00:00:03Z SCRIPT label="verifier" source="scripts/verify-fresh-install.sh" file="/tmp/evidence/21-verifier-script.sh" sha256="${verifierHash}"
2026-05-20T00:00:03Z DONE label="packaged fresh-install verifier" status=0
2026-05-20T00:00:04Z DONE label="current bash login-shell probe" status=0
2026-05-20T00:00:05Z RESULT pass
`;
}

function beforeSnapshot(target: 'macos' | 'wsl', preexistingNode = false): string {
    const nodeLine = preexistingNode ? 'node=/usr/local/bin/node' : 'node=missing';
    if (target === 'macos') {
        return `
label=before
target=macos
uname=Darwin host 25.0.0 Darwin Kernel Version arm64
ProductName:\t\tmacOS
xcode_select=/Library/Developer/CommandLineTools
${nodeLine}
npm=missing
jaw=missing
cli-jaw=missing
`;
    }
    return `
label=before
target=wsl
uname=Linux host 6.6.87.2-microsoft-standard-WSL2 x86_64 GNU/Linux
NAME="Ubuntu"
${nodeLine}
npm=missing
jaw=missing
cli-jaw=missing
`;
}

function writeEvidence(
    target: 'macos' | 'wsl',
    options: {
        preexistingNode?: boolean;
        powershellProbe?: boolean;
        externalPowershellProbe?: boolean;
        incompleteExternalPowershellProbe?: boolean;
        bashProbe?: string;
        currentScripts?: boolean;
    } = {},
): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-evidence-audit-'));
    const collectorScript = options.currentScripts
        ? fs.readFileSync(collector, 'utf8')
        : '#!/usr/bin/env bash\necho collector ok\n';
    const installerScript = options.currentScripts
        ? fs.readFileSync(path.join(root, 'scripts', target === 'wsl' ? 'install-wsl.sh' : 'install.sh'), 'utf8')
        : target === 'wsl'
            ? '#!/usr/bin/env bash\n# WSL One-Click Installer\ncase "$HOME" in /mnt/*) echo "HOME points to Windows path"; exit 1;; esac\necho installer ok\n'
            : '#!/usr/bin/env bash\n# One-Click Installer (macOS / Linux)\necho installer ok\n';
    const verifierScript = options.currentScripts
        ? fs.readFileSync(verifier, 'utf8')
        : '#!/usr/bin/env bash\necho verifier ok\n';
    writeFile(dir, '00-collector-script.sh', collectorScript);
    writeFile(dir, '02-installer-script.sh', installerScript);
    writeFile(dir, '21-verifier-script.sh', verifierScript);
    const powershellSummary = target === 'wsl' && options.powershellProbe
        ? `2026-05-20T00:00:05Z RUN label="PowerShell-to-WSL jaw probe" log="/tmp/evidence/33-powershell-to-wsl-probe.log" command="powershell.exe -NoProfile -Command wsl.exe -d Ubuntu -- bash -lc jaw --version"
2026-05-20T00:00:06Z DONE label="PowerShell-to-WSL jaw probe" status=0
`
        : '';
    const summary = baseSummary(target, sha256(collectorScript), sha256(installerScript), sha256(verifierScript))
        .replace('2026-05-20T00:00:05Z RESULT pass', `${powershellSummary}2026-05-20T00:00:07Z RESULT pass`);
    writeFile(dir, 'summary.txt', summary);
    writeFile(dir, '00-before.txt', beforeSnapshot(target, Boolean(options.preexistingNode)));
    writeFile(dir, '01-install.log', 'installer ok\n');
    writeFile(dir, '10-after.txt', `
label=after
target=${target}
node=/home/user/.nvm/versions/node/v22.22.3/bin/node
npm=/home/user/.nvm/versions/node/v22.22.3/bin/npm
jaw=/home/user/.npm-global/bin/jaw
cli-jaw=/home/user/.npm-global/bin/cli-jaw
`);
    writeFile(dir, '20-verify.log', `
CLI-JAW fresh-install verification
✔ node version is >=22: v22.22.3
✔ jaw works: /home/user/.npm-global/bin/jaw
✔ npm global bin is on PATH: /home/user/.npm-global/bin
${target === 'wsl' ? '✔ WSL bash login shell resolves node/npm/jaw\n' : ''}
✔ jaw doctor completed
ALL PASS
`);
    writeFile(dir, '30-bash-login-probe.log', options.bashProbe || `
node_path=/home/user/.nvm/versions/node/v22.22.3/bin/node
npm_path=/home/user/.nvm/versions/node/v22.22.3/bin/npm
jaw_path=/home/user/.npm-global/bin/jaw
cli-jaw v2.0.6
`);
    if (target === 'macos') {
        writeFile(dir, '31-zsh-login-probe.log', `
node_path=/Users/user/.nvm/versions/node/v22.22.3/bin/node
npm_path=/Users/user/.nvm/versions/node/v22.22.3/bin/npm
jaw_path=/Users/user/.npm-global/bin/jaw
cli-jaw v2.0.6
`);
        writeFile(dir, '32-zsh-interactive-probe.log', `
node_path=/Users/user/.nvm/versions/node/v22.22.3/bin/node
npm_path=/Users/user/.nvm/versions/node/v22.22.3/bin/npm
jaw_path=/Users/user/.npm-global/bin/jaw
cli-jaw v2.0.6
`);
    }
    if (target === 'wsl' && options.powershellProbe) {
        writeFile(dir, '33-powershell-to-wsl-probe.log', 'cli-jaw v2.0.6\n');
    }
    if (target === 'wsl' && options.externalPowershellProbe) {
        writeFile(dir, '33-powershell-to-wsl-probe.log', `
command=wsl.exe -d Ubuntu -- bash -lc jaw --version
cli-jaw v2.0.6
`);
    }
    if (target === 'wsl' && options.incompleteExternalPowershellProbe) {
        writeFile(dir, '33-powershell-to-wsl-probe.log', `
cli-jaw v2.0.6
`);
    }
    return dir;
}

function audit(dir: string, args: string[] = []) {
    return spawnSync(process.execPath, [auditor, dir, ...args], {
        cwd: root,
        encoding: 'utf8',
    });
}

function verifyReleaseEvidence(args: string[] = []) {
    return spawnSync(process.execPath, [releaseGate, ...args], {
        cwd: root,
        encoding: 'utf8',
    });
}

test('fresh evidence collector output passes auditor in local smoke mode', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-evidence-home-'));
    const bin = path.join(home, 'bin');
    const outDir = path.join(home, 'evidence');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH=${JSON.stringify(`${bin}:${path.join(home, '.local', 'bin')}:$PATH`)}\n`);

    writeExecutable(bin, 'node', `
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "v22.22.3"; exit 0; fi
if [ "$1" = "-e" ]; then exit 0; fi
exit 0
`);
    writeExecutable(bin, 'npm', `
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.9.8"; exit 0; fi
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then echo "$HOME/.local"; exit 0; fi
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "$HOME/.local/lib/node_modules"; exit 0; fi
exit 0
`);
    writeExecutable(bin, 'jaw', `
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "cli-jaw v2.0.6"; exit 0; fi
if [ "$1" = "doctor" ]; then exit 0; fi
exit 0
`);
    writeExecutable(bin, 'cli-jaw', `
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "cli-jaw v2.0.6"; exit 0; fi
exit 0
`);
    writeExecutable(bin, 'zsh', `
#!/usr/bin/env bash
if [ "$1" = "-lc" ] || [ "$1" = "-ic" ]; then
  shift
  bash -lc "$1"
  exit $?
fi
exec bash "$@"
`);
    writeExecutable(bin, 'uname', `
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo "Darwin"; exit 0; fi
if [ "$1" = "-a" ]; then echo "Darwin smoke 25.0.0 Darwin Kernel Version arm64"; exit 0; fi
exec /usr/bin/uname "$@"
`);
    writeExecutable(bin, 'sw_vers', `
#!/usr/bin/env bash
echo "ProductName:\t\tmacOS"
echo "ProductVersion:\t\t15.5"
`);
    writeExecutable(bin, 'xcode-select', `
#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo "/Library/Developer/CommandLineTools"; exit 0; fi
exit 0
`);

    try {
        const collect = spawnSync('bash', [
            collector,
            '--target',
            'macos',
            '--skip-install',
            '--skip-doctor',
            '--verifier-script',
            verifier,
            '--out-dir',
            outDir,
        ], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                HOME: home,
                SHELL: '/bin/zsh',
                NVM_DIR: path.join(home, '.nvm'),
                PATH: `${bin}:${path.join(home, '.local', 'bin')}:${process.env.PATH || ''}`,
            },
        });
        assert.equal(collect.status, 0, `${collect.stdout}\n${collect.stderr}`);

        const result = audit(outDir, [
            '--target',
            'macos',
            '--allow-skip-install',
            '--allow-skip-doctor',
            '--allow-preexisting-node',
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS target=macos/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('fresh evidence auditor accepts complete macOS evidence', () => {
    const dir = writeEvidence('macos');
    try {
        const result = audit(dir, ['--target', 'macos']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS target=macos/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires explicit non-skipped summary metadata', () => {
    const missingSkipInstallDir = writeEvidence('macos');
    try {
        const summary = fs.readFileSync(path.join(missingSkipInstallDir, 'summary.txt'), 'utf8')
            .replace(/^.*skip_install=0\n/m, '');
        fs.writeFileSync(path.join(missingSkipInstallDir, 'summary.txt'), summary);
        const result = audit(missingSkipInstallDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /summary\.txt must include skip_install=0\|1/);
    } finally {
        fs.rmSync(missingSkipInstallDir, { recursive: true, force: true });
    }

    const invalidSkipDoctorDir = writeEvidence('macos');
    try {
        const summary = fs.readFileSync(path.join(invalidSkipDoctorDir, 'summary.txt'), 'utf8')
            .replace('skip_doctor=0', 'skip_doctor=false');
        fs.writeFileSync(path.join(invalidSkipDoctorDir, 'summary.txt'), summary);
        const result = audit(invalidSkipDoctorDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /summary\.txt must include skip_doctor=0\|1/);
    } finally {
        fs.rmSync(invalidSkipDoctorDir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires archived collector, installer, and verifier source hashes', () => {
    const missingCollectorDir = writeEvidence('macos');
    try {
        fs.rmSync(path.join(missingCollectorDir, '00-collector-script.sh'));
        const result = audit(missingCollectorDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /missing 00-collector-script\.sh/);
    } finally {
        fs.rmSync(missingCollectorDir, { recursive: true, force: true });
    }

    const missingInstallerDir = writeEvidence('macos');
    try {
        fs.rmSync(path.join(missingInstallerDir, '02-installer-script.sh'));
        const result = audit(missingInstallerDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /missing 02-installer-script\.sh/);
    } finally {
        fs.rmSync(missingInstallerDir, { recursive: true, force: true });
    }

    const hashMismatchDir = writeEvidence('macos');
    try {
        fs.appendFileSync(path.join(hashMismatchDir, '21-verifier-script.sh'), 'echo changed\n');
        const result = audit(hashMismatchDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /21-verifier-script\.sh sha256 mismatch/);
    } finally {
        fs.rmSync(hashMismatchDir, { recursive: true, force: true });
    }

    const notScriptDir = writeEvidence('macos');
    try {
        const verifier = 'echo verifier without shebang\n';
        writeFile(notScriptDir, '21-verifier-script.sh', verifier);
        let summary = fs.readFileSync(path.join(notScriptDir, 'summary.txt'), 'utf8');
        summary = summary.replace(/sha256="[a-f0-9]{64}"(?=\n2026-05-20T00:00:03Z DONE)/, `sha256="${sha256(verifier)}"`);
        fs.writeFileSync(path.join(notScriptDir, 'summary.txt'), summary);
        const result = audit(notScriptDir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /21-verifier-script\.sh must be an archived bash script with a bash shebang/);
    } finally {
        fs.rmSync(notScriptDir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires macOS zsh probes to prove node npm and jaw', () => {
    const dir = writeEvidence('macos');
    try {
        fs.writeFileSync(path.join(dir, '31-zsh-login-probe.log'), `
jaw_path=/Users/user/.npm-global/bin/jaw
cli-jaw v2.0.6
`);
        const result = audit(dir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /31-zsh-login-probe\.log must include "node_path="/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor treats macOS bash probe as informational', () => {
    const dir = writeEvidence('macos', { bashProbe: 'bash: jaw: command not found\n' });
    try {
        const result = audit(dir, ['--target', 'macos']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS target=macos/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor rejects mismatched summary and requested target', () => {
    const dir = writeEvidence('macos');
    try {
        const summary = fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8')
            .replace('target=macos', 'target=wsl');
        fs.writeFileSync(path.join(dir, 'summary.txt'), summary);
        const result = audit(dir, ['--target', 'macos']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /summary\.txt target=wsl does not match --target macos/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor rejects wrong archived installer for target', () => {
    const dir = writeEvidence('wsl', { externalPowershellProbe: true });
    try {
        const wrongInstaller = '#!/usr/bin/env bash\n# One-Click Installer (macOS / Linux)\necho wrong target\n';
        fs.writeFileSync(path.join(dir, '02-installer-script.sh'), wrongInstaller);
        const summary = replaceScriptHash(
            fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8'),
            'installer',
            sha256(wrongInstaller),
        );
        fs.writeFileSync(path.join(dir, 'summary.txt'), summary);
        const result = audit(dir, ['--target', 'wsl']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /02-installer-script\.sh must include "WSL One-Click Installer"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires WSL PowerShell-to-WSL probe by default', () => {
    const dir = writeEvidence('wsl');
    try {
        const result = audit(dir, ['--target', 'wsl']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /missing 33-powershell-to-wsl-probe\.log/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires the WSL verifier login-shell check', () => {
    const dir = writeEvidence('wsl', { externalPowershellProbe: true });
    try {
        const verifyLog = fs.readFileSync(path.join(dir, '20-verify.log'), 'utf8')
            .replace('✔ WSL bash login shell resolves node/npm/jaw\n', '');
        fs.writeFileSync(path.join(dir, '20-verify.log'), verifyLog);
        const result = audit(dir, ['--target', 'wsl']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /20-verify\.log must include "WSL bash login shell resolves node\/npm\/jaw"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor accepts external PowerShell-to-WSL probe log with command evidence', () => {
    const dir = writeEvidence('wsl', { externalPowershellProbe: true });
    try {
        const result = audit(dir, ['--target', 'wsl']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS target=wsl/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor requires internal PowerShell-to-WSL probe command evidence', () => {
    const dir = writeEvidence('wsl', { powershellProbe: true });
    try {
        const summary = fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8')
            .replace(/^.*RUN label="PowerShell-to-WSL jaw probe".*\n/m, '');
        fs.writeFileSync(path.join(dir, 'summary.txt'), summary);
        const result = audit(dir, ['--target', 'wsl']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /summary\.txt must record the PowerShell-to-WSL wsl\.exe -d \.\.\. bash -lc command/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor rejects external PowerShell-to-WSL probe log without command evidence', () => {
    const dir = writeEvidence('wsl', { incompleteExternalPowershellProbe: true });
    try {
        const result = audit(dir, ['--target', 'wsl']);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /33-powershell-to-wsl-probe\.log must include "command=wsl\.exe -d"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fresh evidence auditor rejects preexisting Node unless explicitly allowed', () => {
    const dir = writeEvidence('macos', { preexistingNode: true });
    try {
        const rejected = audit(dir, ['--target', 'macos']);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /preexisting Node\.js/);

        const allowed = audit(dir, ['--target', 'macos', '--allow-preexisting-node']);
        assert.equal(allowed.status, 0, allowed.stderr);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('release evidence gate requires strict macOS and WSL evidence together', () => {
    const macosDir = writeEvidence('macos', { currentScripts: true });
    const wslDir = writeEvidence('wsl', { powershellProbe: true, currentScripts: true });
    try {
        const result = verifyReleaseEvidence(['--macos', macosDir, '--wsl', wslDir]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /ALL PASS/);
        assert.match(result.stdout, /PASS macOS/);
        assert.match(result.stdout, /PASS Windows-via-WSL/);
    } finally {
        fs.rmSync(macosDir, { recursive: true, force: true });
        fs.rmSync(wslDir, { recursive: true, force: true });
    }
});

test('release evidence gate rejects evidence from stale archived scripts', () => {
    const macosDir = writeEvidence('macos', { currentScripts: true });
    const wslDir = writeEvidence('wsl', { powershellProbe: true, currentScripts: true });
    try {
        const staleInstaller = `${fs.readFileSync(path.join(macosDir, '02-installer-script.sh'), 'utf8')}\n# stale local modification\n`;
        fs.writeFileSync(path.join(macosDir, '02-installer-script.sh'), staleInstaller);
        const summary = replaceScriptHash(
            fs.readFileSync(path.join(macosDir, 'summary.txt'), 'utf8'),
            'installer',
            sha256(staleInstaller),
        );
        fs.writeFileSync(path.join(macosDir, 'summary.txt'), summary);

        const result = verifyReleaseEvidence(['--macos', macosDir, '--wsl', wslDir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /macOS archived 02-installer-script\.sh does not match current install\.sh/);
    } finally {
        fs.rmSync(macosDir, { recursive: true, force: true });
        fs.rmSync(wslDir, { recursive: true, force: true });
    }
});

test('release evidence gate rejects incomplete matrix evidence', () => {
    const macosDir = writeEvidence('macos');
    try {
        const result = verifyReleaseEvidence(['--macos', macosDir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /missing --wsl DIR/);
    } finally {
        fs.rmSync(macosDir, { recursive: true, force: true });
    }
});

test('release evidence gate rejects missing evidence directories before audit', () => {
    const macosDir = path.join(os.tmpdir(), `jaw-missing-macos-${Date.now()}`);
    const wslDir = writeEvidence('wsl', { powershellProbe: true });
    try {
        const result = verifyReleaseEvidence(['--macos', macosDir, '--wsl', wslDir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /macOS evidence directory does not exist/);
        assert.equal(result.stdout.includes('[release-evidence] RUN macOS'), false);
    } finally {
        fs.rmSync(wslDir, { recursive: true, force: true });
    }
});

test('release evidence gate rejects non-file auditor path before audit', () => {
    const macosDir = writeEvidence('macos');
    const wslDir = writeEvidence('wsl', { powershellProbe: true });
    try {
        const result = verifyReleaseEvidence(['--macos', macosDir, '--wsl', wslDir, '--auditor', macosDir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /auditor path is not a file/);
        assert.equal(result.stdout.includes('[release-evidence] RUN macOS'), false);
    } finally {
        fs.rmSync(macosDir, { recursive: true, force: true });
        fs.rmSync(wslDir, { recursive: true, force: true });
    }
});
