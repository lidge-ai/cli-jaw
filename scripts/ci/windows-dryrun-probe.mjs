// Diagnostic observations only: this workflow does not certify a release.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const prepareOnly = process.argv.includes('--prepare-only');
if (process.platform !== 'win32' && !prepareOnly) throw new Error('This probe requires native Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'jaw-wis-probe-'));
let instrumented = source;
function surround(statement, phase) {
    if (instrumented.split(statement).length !== 2) throw new Error(`Probe seam changed: ${phase}`);
    const indent = statement.match(/^ */)[0];
    instrumented = instrumented.replace(statement,
        `${indent}[Console]::Error.WriteLine('WIS_PHASE:${phase}.before')\r\n${statement}\r\n${indent}[Console]::Error.WriteLine('WIS_PHASE:${phase}.after')`);
}
surround('    $embedded = $script:EmbeddedBootstrapManifest | ConvertFrom-Json', 'embedded.parse');
surround('            $sibling = Get-Content -LiteralPath $siblingPath -Raw | ConvertFrom-Json', 'sibling.read-and-parse');
surround('            $embJson = $embedded | ConvertTo-Json -Depth 10 -Compress', 'embedded.stringify');
surround('            $sibJson = $sibling | ConvertTo-Json -Depth 10 -Compress', 'sibling.stringify');
surround('    $arch = Resolve-NativeArch', 'architecture');
surround('        Write-Info "[dry-run] $Tool $($entry.version) ($arch)"', 'dry-run.first-output');
const metadataSeam = "            [Console]::Error.WriteLine('WIS_PHASE:sibling.read-and-parse.after')";
instrumented = instrumented.replace(metadataSeam, `${metadataSeam}\r\n            foreach ($name in @('PSDrive', 'PSProvider', 'ReadCount')) { [Console]::Error.WriteLine('WIS_META:' + $name + '=' + ($null -ne $sibling.PSObject.Properties[$name])) }`);
const script = join(directory, 'install.ps1');
writeFileSync(script, instrumented);
copyFileSync(join(root, 'scripts/windows-bootstrap-manifest.json'), join(directory, 'windows-bootstrap-manifest.json'));
if (prepareOnly) {
    console.log(JSON.stringify({ preparedOnly: true, script, originalSha: createHash('sha256').update(source).digest('hex') }));
    process.exit(0);
}
const environmentValue = name => process.env[Object.keys(process.env).sort().find(key => key.toLowerCase() === name.toLowerCase()) || ''];
const powershell = join(environmentValue('SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const inheritedModulePath = environmentValue('PSModulePath') || '';
const report = {
    diagnosticOnly: true,
    sourceSha: createHash('sha256').update(source).digest('hex'),
    node: process.version,
    parentHasPs7ModulePath: /[\\/]PowerShell[\\/]7(?:-[^;\\/]+)?[\\/]Modules/i.test(inheritedModulePath),
    observations: [],
};
const output = join(process.env.RUNNER_TEMP || tmpdir(), 'jaw-wis-observations.json');
for (const mode of ['original-cold', 'clean-before', 'inherited', 'clean-after']) {
    const env = { ...process.env };
    if (mode !== 'inherited' && mode !== 'original-cold') {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    }
    const tracedCommand = `[Console]::Error.WriteLine('WIS_PS:' + $PSVersionTable.PSVersion); $env:Path = 'C:\\WINDOWS\\system32'; & '${script.replaceAll("'", "''")}' -DryRun; [Console]::Error.WriteLine('WIS_PHASE:script.return:' + $?); exit 0`;
    const originalScript = join(root, 'scripts/install.ps1');
    const command = mode === 'original-cold'
        ? `$env:Path = 'C:\\WINDOWS\\system32'; & '${originalScript.replaceAll("'", "''")}' -DryRun; exit 0`
        : tracedCommand;
    const start = Date.now();
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    });
    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    const plainStdout = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const observation = {
        mode, elapsedMs: Date.now() - start, pid: result.pid,
        error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
        status: result.status, signal: result.signal,
        phases: [...stderr.matchAll(/WIS_PHASE:([^\r\n]+)/g)].map(match => match[1]),
        actualPlan: /^\s*\[dry-run\] node /m.test(plainStdout) && /^\s*\[dry-run\] git /m.test(plainStdout),
        stdoutTail: stdout.slice(-4096), stderrTail: stderr.slice(-4096),
    };
    report.observations.push(observation);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(observation));
}
const [, before, inherited, after] = report.observations;
const passes = row => !row.error && row.status === 0 && row.actualPlan;
report.cleanInheritedCleanPattern = passes(before) && !passes(inherited) && passes(after);
report.allArmsPassed = report.observations.every(passes);
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ diagnosticOnly: true, parentHasPs7ModulePath: report.parentHasPs7ModulePath,
    cleanInheritedCleanPattern: report.cleanInheritedCleanPattern, allArmsPassed: report.allArmsPassed }));
