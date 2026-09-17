/**
 * cli-jaw service — 크로스 플랫폼 서비스 관리
 * Usage:
 *   jaw service              — OS 감지 → 설치 + 시작 (원스텝)
 *   jaw service --port 3458  — 커스텀 포트로 등록
 *   jaw service status       — 현재 상태 확인
 *   jaw service stop         — 이 홈의 서버만 graceful stop
 *   jaw service restart      — 이 홈의 서버만 graceful restart
 *   jaw service unset        — 서비스 제거
 *   jaw service logs         — 로그 보기
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';
import { instanceId, getNodePath, getJawPath, sanitizeUnitName, buildServicePath } from '../../src/core/instance.js';
import { defaultLifecycleDeps, verifyOwnership, type OwnershipVerdict } from '../../src/core/instance-lifecycle.js';
import { manualSupervisionGuidance } from '../../src/manager/manual-supervision.js';
import { renderSupervisorScript, supervisorInstallSummary } from '../../src/manager/supervisor-service.js';
import type { DashboardLifecycleResult, DashboardServiceState } from '../../src/manager/types.js';
import { detectServiceState, permInstance, restartServiceInstance, stopServiceInstance, unpermInstance } from '../../src/manager/platform-service.js';

export type ServiceLifecycleOutcome = {
    action: 'stop' | 'restart';
    status: 'stopped' | 'already-stopped' | 'no-pidfile' | 'stale' | 'foreign'
        | 'permission-denied' | 'unverifiable' | 'raced' | 'timeout';
    pid?: number;
    message: string;
};

export interface ServiceLifecycleDeps {
    verifyOwnership: () => OwnershipVerdict;
    /** Final re-check shrinks, but cannot close, the residual race before kill(2). */
    verifyAndSignal: (signal: NodeJS.Signals) => 'signalled' | 'raced' | 'not-owned';
    controlNative?: ((action: 'stop' | 'restart') => Promise<ServiceLifecycleOutcome>) | null;
    waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>;
    startInstance?: (() => Promise<void>) | null;
}

export interface NativeControlDeps {
    detectServiceState: (port: number, home: string) => Promise<DashboardServiceState>;
    stopServiceInstance: (label: string) => Promise<DashboardLifecycleResult>;
    restartServiceInstance: (label: string) => Promise<DashboardLifecycleResult>;
}

export function nativeOutcome(action: 'stop' | 'restart', result: DashboardLifecycleResult): ServiceLifecycleOutcome {
    return { action, status: result.ok ? 'stopped' : 'foreign', ...(result.pid ? { pid: result.pid } : {}), message: result.message };
}

export async function resolveControlNative(
    port: number,
    home: string,
    deps: NativeControlDeps,
): Promise<((action: 'stop' | 'restart') => Promise<ServiceLifecycleOutcome>) | null> {
    const state = await deps.detectServiceState(port, home);
    // loaded, not registered (#380): autostart artifacts existing does not mean
    // a native controller can stop a process. A registered-but-not-running (or
    // Startup-wrapper) install falls through to the PID-verified path.
    if (!state.loaded) return null;
    return action => (action === 'stop' ? deps.stopServiceInstance(state.label) : deps.restartServiceInstance(state.label))
        .then(result => nativeOutcome(action, result));
}

function nonOwnedOutcome(action: 'stop' | 'restart', verdict: Exclude<OwnershipVerdict, { status: 'owned' }>): ServiceLifecycleOutcome {
    const pid = 'record' in verdict ? verdict.record.pid : undefined;
    const reason = 'reason' in verdict ? `: ${verdict.reason}` : '';
    const message = verdict.status === 'unverifiable' ? `cannot verify ownership${reason}; refusing to signal`
        : verdict.status === 'permission-denied' ? `permission denied for pid ${pid}; refusing to signal`
            : verdict.status === 'no-pidfile' ? 'no pidfile exists for this home'
                : verdict.status === 'already-stopped' ? `pid ${pid} is already stopped` : `${verdict.status} pidfile${reason}`;
    return { action, status: verdict.status, ...(pid ? { pid } : {}), message };
}

export async function runServiceLifecycle(action: 'stop' | 'restart', deps: ServiceLifecycleDeps): Promise<ServiceLifecycleOutcome> {
    if (deps.controlNative) return deps.controlNative(action);
    const verdict = deps.verifyOwnership();
    if (verdict.status !== 'owned') return nonOwnedOutcome(action, verdict);
    const signalResult = deps.verifyAndSignal('SIGTERM');
    if (signalResult === 'raced') return { action, status: 'raced', pid: verdict.record.pid, message: 'the instance exited while stopping it; nothing was signalled' };
    if (signalResult === 'not-owned') return { action, status: 'stale', pid: verdict.record.pid, message: 'final ownership check denied the pid; nothing was signalled' };
    if (action === 'stop') return { action, status: 'stopped', pid: verdict.record.pid, message: `sent SIGTERM to pid ${verdict.record.pid}` };
    if (!await deps.waitForExit(verdict.record.pid, 5000)) return { action, status: 'timeout', pid: verdict.record.pid, message: `pid ${verdict.record.pid} did not exit within 5000ms` };
    await deps.startInstance?.();
    return { action, status: 'stopped', pid: verdict.record.pid, message: `restarted instance after pid ${verdict.record.pid} exited` };
}

// ─── Args ────────────────────────────────────────────
export async function main(): Promise<void> {
// The service being installed belongs to JAW_HOME, so its port has to come from
// that home. Defaulting to 3457 made `jaw --home <other> service install` write a
// unit that starts the other home's server on the main instance's port, and two
// servers then fight over 3457.
const homePort = (() => {
    try {
        const parsed = JSON.parse(readFileSync(join(JAW_HOME, 'settings.json'), 'utf8')) as { port?: unknown };
        const value = typeof parsed.port === 'number' ? String(parsed.port) : parsed.port;
        return typeof value === 'string' && value.trim() ? value.trim() : '3457';
    } catch {
        return '3457';
    }
})();
const { values: opts, positionals: pos } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: homePort },
        backend: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
});

// unknown flag guard
const knownKeys = new Set(['port', 'backend']);
for (const key of Object.keys(opts)) {
    if (!knownKeys.has(key)) {
        console.error(`❌ Unknown option: --${key}`);
        console.error('   Usage: jaw service [--port PORT] [--backend launchd|systemd|docker|supervisor] [status|stop|restart|unset|logs]');
        process.exit(1);
    }
}

// --backend whitelist validation
const VALID_BACKENDS = new Set(['launchd', 'systemd', 'windows', 'docker', 'supervisor']);
if (opts.backend && !VALID_BACKENDS.has(opts.backend as string)) {
    console.error(`❌ Unknown backend: ${opts.backend}`);
    console.error('   Supported: launchd, systemd, windows, docker, supervisor');
    process.exit(1);
}

// --backend windows is only meaningful on win32: platform-service derives its
// backend from process.platform at load, so honoring the flag elsewhere would
// silently perform a different backend's install.
if (opts.backend === 'windows' && process.platform !== 'win32') {
    console.error('❌ --backend windows requires Windows (platform-service is platform-derived)');
    process.exit(1);
}

const PORT = opts.port as string;

// port validation: must be numeric and in valid range
const portNum = Number(PORT);
if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error(`\u274c Invalid port: ${PORT}`);
    console.error('   Port must be an integer between 1 and 65535');
    process.exit(1);
}

const lifecycleAction = pos[0] === 'stop' || pos[0] === 'restart' ? pos[0] : null;
if (lifecycleAction) {
    const controlNative = await resolveControlNative(portNum, JAW_HOME, {
        detectServiceState, stopServiceInstance, restartServiceInstance,
    });
    let initiallyOwned: Extract<OwnershipVerdict, { status: 'owned' }>['record'] | null = null;
    const outcome = await runServiceLifecycle(lifecycleAction, {
        controlNative,
        verifyOwnership: () => {
            const verdict = verifyOwnership(JAW_HOME, defaultLifecycleDeps);
            initiallyOwned = verdict.status === 'owned' ? verdict.record : null;
            return verdict;
        },
        verifyAndSignal: signal => {
            const finalVerdict = verifyOwnership(JAW_HOME, defaultLifecycleDeps);
            if (finalVerdict.status === 'stale' || finalVerdict.status === 'foreign') return 'not-owned';
            if (finalVerdict.status !== 'owned') return 'raced';
            if (!initiallyOwned
                || finalVerdict.record.pid !== initiallyOwned.pid
                || finalVerdict.record.startedAt.source !== initiallyOwned.startedAt.source
                || finalVerdict.record.startedAt.value !== initiallyOwned.startedAt.value) return 'raced';
            try { process.kill(finalVerdict.record.pid, signal); return 'signalled'; }
            catch { return 'raced'; }
        },
        waitForExit: async (pid, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (defaultLifecycleDeps.probe(pid).status === 'dead') return true;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        },
        startInstance: async () => {
            const child = nodeSpawn(getNodePath(), [getJawPath(), '--home', JAW_HOME, 'serve', '--port', PORT, '--no-open'], {
                detached: true, stdio: 'ignore',
            });
            child.unref();
        },
    });
    console.log(outcome.message);
    if (!['stopped', 'already-stopped', 'no-pidfile'].includes(outcome.status)) process.exitCode = 1;
    return;
}

const INSTANCE = instanceId();
const LOG_DIR = join(JAW_HOME, 'logs');

// ─── Backend detection ───────────────────────────────

type Backend = 'launchd' | 'systemd' | 'windows' | 'docker' | 'supervisor';

function detectBackend(): Backend {
    if (process.platform === 'darwin') return 'launchd';
    if (process.platform === 'win32') return 'windows';

    // Docker container detection
    if (existsSync('/.dockerenv')) return 'docker';

    // Linux: verify PID 1 is actually systemd (not just binary installed)
    try {
        const pid1 = readFileSync('/proc/1/comm', 'utf8').trim();
        if (pid1 === 'systemd') return 'systemd';
    } catch { /* /proc may not exist */ }

    // Fallback: check systemctl exists (less reliable but covers more cases)
    try {
        execFileSync('which', ['systemctl'], { stdio: 'pipe' });
        console.warn('⚠️  PID 1이 systemd가 아닐 수 있습니다. --backend systemd로 강제 지정 가능');
        return 'systemd';
    } catch { /* no systemctl */ }

    // No service manager (#479). tmux/screen used to be suggested here, but a
    // multiplexer needs an interactive session to attach to and inherits the
    // same non-interactive PATH that already failed to resolve `jaw` — so it
    // is unusable from the one-shot ssh command that lands operators here.
    //
    // Auto-selecting the supervisor backend here would be wrong: writing a
    // script and telling the operator to wire it into boot is a different act
    // from registering autostart, so it stays opt-in via --backend supervisor.
    console.error('❌ ' + manualSupervisionGuidance({
        nodePath: getNodePath(),
        jawPath: getJawPath(),
        home: JAW_HOME,
        port: PORT,
        logPath: join(JAW_HOME, 'logs', 'jaw-serve.log'),
    }).join('\n')
        + '\n\n   Or generate a supervisor loop:  jaw service --backend supervisor --port ' + PORT);
    process.exit(1);
}

const backend: Backend = (opts.backend as Backend) || detectBackend();

// ─── macOS: delegate to launchd command (legacy) ────
if (backend === 'launchd') {
    // launchd.ts supports: status, unset, default (install)
    // service.ts additionally supports: logs
    // Map unsupported subcommands for launchd
    const subcommand = pos[0];
    if (subcommand === 'logs') {
        // launchd doesn't have 'logs' → show log file path directly
        const logDir = join(JAW_HOME, 'logs');
        console.log(`📋 macOS launchd logs:\n`);
        console.log(`   stdout: ${logDir}/jaw-serve.log`);
        console.log(`   stderr: ${logDir}/jaw-serve.err\n`);
        console.log(`   tail -f ${logDir}/jaw-serve.log`);
        process.exit(0);
    }
    // Rebuild argv from parsed values — eliminates all --backend variants
    // Only pass --port on install (default). status/unset read from existing plist.
    const isInstall = !subcommand || (subcommand !== 'status' && subcommand !== 'unset');
    const portArgs = isInstall && PORT !== '3457' ? ['--port', PORT] : [];
    process.argv = [
        process.argv[0]!, process.argv[1]!,
        'launchd',
        ...(subcommand ? [subcommand] : []),
        ...portArgs,
    ];
    process.env["_CLI_JAW_SERVICE_DELEGATE"] = '1';
    await import('./launchd.js');
    process.exit(0);
}

// ─── Docker: info only ───────────────────────────────
if (backend === 'docker') {
    console.log('🐳 Docker 컨테이너 내부에서 실행 중입니다.\n');
    console.log('   컨테이너 자체가 restart policy로 관리됩니다.');
    console.log('   docker-compose.yml의 restart: unless-stopped 설정을 확인하세요.\n');
    console.log('   상태 확인: docker ps | grep cli-jaw');
    console.log('   로그 확인: docker logs -f cli-jaw');

    // A restart policy only restarts the container, and only when jaw is its
    // entrypoint. Someone who ran `jaw service` inside an already-running
    // container (#479's shape: PID 1 = tini, no systemd) is not in that case,
    // and exiting 0 here told them a daemon existed when none had started.
    if (!existsSync('/run/systemd/system')) {
        console.log('\n   If jaw is NOT this container\'s entrypoint, nothing is supervising it.');
        console.log('   ' + manualSupervisionGuidance({
            nodePath: getNodePath(),
            jawPath: getJawPath(),
            home: JAW_HOME,
            port: PORT,
            logPath: join(JAW_HOME, 'logs', 'jaw-serve.log'),
        }).slice(2).join('\n   '));
    }
    process.exit(0);
}

// ─── Windows: delegate to platform-service (#379) ───
// ─── Supervisor: script for hosts with no service manager (#479) ───
//
// Opt-in only. This backend does not register autostart — nothing on such a
// host can — it writes the loop the operator would otherwise hand-roll and
// says where to wire it in.
if (backend === 'supervisor') {
    const subcommand = pos[0];
    const scriptPath = join(JAW_HOME, 'jaw-supervisor.sh');
    const logPath = join(LOG_DIR, 'jaw-serve.log');
    const ctx = {
        nodePath: getNodePath(),
        jawPath: getJawPath(),
        home: JAW_HOME,
        port: PORT,
        logPath,
        intervalSeconds: 60,
    };

    if (subcommand === 'status') {
        // The generated loop branches on this exit code, so it must report
        // liveness rather than the presence of a registration artifact.
        // systemd's status branch exits 0 either way; a supervisor trusting
        // that would never restart a dead server.
        const verdict = verifyOwnership(JAW_HOME, defaultLifecycleDeps);
        const running = verdict.status === 'owned';
        console.log('🦈 jaw serve — ' + (running ? '🟢 running' : '⚪ not running'));
        console.log('   home:       ' + JAW_HOME);
        console.log('   port:       ' + PORT);
        console.log('   verdict:    ' + verdict.status);
        console.log('   supervisor: ' + (existsSync(scriptPath) ? scriptPath : 'not installed'));
        process.exit(running ? 0 : 1);
    }

    if (subcommand === 'logs') {
        console.log('📋 tail -n 50 -f ' + logPath);
        process.exit(0);
    }

    if (subcommand === 'unset') {
        if (!existsSync(scriptPath)) {
            console.log('⚠️  no supervisor script at ' + scriptPath);
            process.exit(0);
        }
        rmSync(scriptPath, { force: true });
        console.log('✅ removed ' + scriptPath);
        console.log('   A supervisor loop already running keeps its copy in memory —');
        console.log('   stop it where you started it (container, cron, or shell job).');
        process.exit(0);
    }

    // default: write the script
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(scriptPath, renderSupervisorScript(ctx), { mode: 0o755 });
    console.log('🦈 ' + supervisorInstallSummary(scriptPath, ctx).join('\n'));
    process.exit(0);
}

if (backend === 'windows') {
    const subcommand = pos[0];
    if (subcommand === 'status') {
        const state: DashboardServiceState = await detectServiceState(portNum, JAW_HOME);
        console.log('\u{1F988} Windows service status');
        console.log('   registered: ' + (state.registered ? 'yes' : 'no'));
        console.log('   loaded:     ' + (state.loaded ? 'yes' : 'no'));
        console.log('   pid:        ' + (state.pid ?? '-'));
        console.log('   label:      ' + state.label);
        process.exit(state.registered ? 0 : 1);
    }
    if (subcommand === 'logs') {
        const outLog = join(LOG_DIR, 'service-out.log');
        const errLog = join(LOG_DIR, 'service-err.log');
        console.log('\u{1F4C4} Windows service logs:\n');
        console.log('   stdout: ' + outLog);
        console.log('   stderr: ' + errLog + '\n');
        console.log('   Get-Content -Tail 50 -Wait "' + outLog + '"');
        process.exit(0);
    }
    if (subcommand === 'unset') {
        const result = await unpermInstance(portNum, JAW_HOME);
        console.log(result.message);
        process.exit(result.ok ? 0 : 1);
    }
    // default: install (register autostart + start now)
    const result = await permInstance(portNum, JAW_HOME);
    console.log(result.message);
    process.exit(result.ok ? 0 : 1);
}

// ═══════════════════════════════════════════════════════
//  systemd backend
// ═══════════════════════════════════════════════════════

// Guard the systemd tail explicitly: a backend without its own branch above
// must never fall through into sudo/systemd paths (#379).
if (backend !== 'systemd') {
    console.error('\u274c Unsupported backend fall-through: ' + backend);
    process.exit(1);
}

const SAFE_INSTANCE = sanitizeUnitName(INSTANCE);
const UNIT_NAME = `jaw-${SAFE_INSTANCE}`;
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

/** Create secure temp file for unit generation. */
function makeTmpUnit(): string {
    try {
        return execFileSync('mktemp', ['/tmp/jaw-unit-XXXXXX.service'], { encoding: 'utf8' }).trim();
    } catch {
        // fallback if mktemp unavailable
        const fallback = `/tmp/jaw-unit-${Date.now()}-${process.pid}.service`;
        return fallback;
    }
}

/** Run a sudo command with visible output (password prompt visible). */
function sudo(args: string[]): void {
    execFileSync('sudo', args, { stdio: 'inherit' });
}

function generateUnit(): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const servicePath = buildServicePath(process.env["PATH"] || '', [dirname(nodePath), dirname(jawPath)]);
    let user: string;
    try { user = execFileSync('whoami', { encoding: 'utf8' }).trim(); }
    catch { user = 'nobody'; }
    mkdirSync(LOG_DIR, { recursive: true });

    // systemd quoting: paths with spaces must be quoted
    const q = (s: string) => s.includes(' ') ? `"${s}"` : s;

    return `[Unit]
Description=CLI-JAW Server (${SAFE_INSTANCE})
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${q(JAW_HOME)}
ExecStart=${q(nodePath)} ${q(jawPath)} --home ${q(JAW_HOME)} serve --port ${PORT} --no-open
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment="PATH=${servicePath}"
Environment=CLI_JAW_HOME=${q(JAW_HOME)}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT_NAME}

[Install]
WantedBy=multi-user.target`;
}

function isActive(): string {
    try {
        return execFileSync('systemctl', ['is-active', UNIT_NAME], { encoding: 'utf8' }).trim();
    } catch { return 'inactive'; }
}

const sub = pos[0];

switch (sub) {
    case 'unset': {
        if (!existsSync(UNIT_PATH)) {
            console.log('⚠️  jaw serve가 systemd에 등록되어 있지 않습니다');
            break;
        }
        try { sudo(['systemctl', 'stop', UNIT_NAME]); } catch { /* ok if already stopped */ }
        try { sudo(['systemctl', 'disable', UNIT_NAME]); } catch { /* ok */ }
        sudo(['rm', '-f', UNIT_PATH]);
        sudo(['systemctl', 'daemon-reload']);
        console.log('✅ jaw serve 자동 실행 해제 완료');
        break;
    }

    case 'status': {
        if (!existsSync(UNIT_PATH)) {
            console.log('\u26a0\ufe0f  jaw serve\uac00 systemd\uc5d0 \ub4f1\ub85d\ub418\uc5b4 \uc788\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4');
            console.log('   \ub4f1\ub85d: jaw service');
            break;
        }
        // Read actual port from unit file if possible
        let displayPort = PORT;
        try {
            const unitContent = readFileSync(UNIT_PATH, 'utf8');
            const portMatch = unitContent.match(/--port\s+(\d+)/);
            if (portMatch) displayPort = portMatch[1]!;
        } catch { /* use CLI port as fallback */ }
        const state = isActive();
        const icon = state === 'active' ? '\ud83d\udfe2' : state === 'failed' ? '\ud83d\udd34' : '\u26aa';
        console.log(`\ud83e\udd88 jaw serve \u2014 ${icon} ${state}`);
        console.log(`   instance: ${INSTANCE}`);
        console.log(`   unit:     ${UNIT_NAME}`);
        console.log(`   port:     ${displayPort}`);
        console.log(`   unit file: ${UNIT_PATH}`);
        console.log(`\n   \ub85c\uadf8: jaw service logs`);
        console.log(`   \uc911\uc9c0: jaw service unset`);
        break;
    }

    case 'logs': {
        console.log(`📋 journalctl -u ${UNIT_NAME} -f\n`);
        const child = nodeSpawn('journalctl', ['-u', UNIT_NAME, '-f', '--no-pager', '-n', '50'], {
            stdio: 'inherit',
        });
        // Clean exit on Ctrl+C
        const cleanup = () => { child.kill('SIGINT'); process.exit(0); };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        child.on('exit', (code) => process.exit(code ?? 0));
        break;
    }

    default: {
        // 원스텝: 유닛 생성 → daemon-reload → enable --now
        console.log('🦈 jaw service setup (systemd)\n');

        if (existsSync(UNIT_PATH)) {
            console.log('📄 기존 유닛 발견 — 재생성합니다');
            try { sudo(['systemctl', 'stop', UNIT_NAME]); } catch { /* ok */ }
        } else {
            console.log('📄 유닛 없음 — 새로 생성합니다');
        }

        // 1. 유닛 파일 생성 (mktemp → sudo cp)
        const unit = generateUnit();
        const tmpUnit = makeTmpUnit();
        writeFileSync(tmpUnit, unit);
        sudo(['cp', tmpUnit, UNIT_PATH]);
        try { writeFileSync(tmpUnit, ''); } catch { /* cleanup */ }
        console.log(`✅ 유닛 저장: ${UNIT_PATH}`);

        // 2. 등록 + 시작
        sudo(['systemctl', 'daemon-reload']);
        sudo(['systemctl', 'enable', '--now', UNIT_NAME]);
        console.log('✅ systemd 등록 + 시작 완료\n');

        // 3. 상태 확인
        setTimeout(() => {
            const state = isActive();
            if (state === 'active') {
                console.log('🦈 jaw serve가 백그라운드에서 실행 중입니다');
                console.log(`   instance: ${INSTANCE}`);
                console.log(`   http://localhost:${PORT}`);
                console.log(`   로그: jaw service logs`);
                console.log('\n   해제: jaw service unset');
            } else {
                console.log('⚠️  시작되지 않았습니다. 상태를 확인하세요:');
                console.log(`   systemctl status ${UNIT_NAME}`);
                console.log(`   journalctl -u ${UNIT_NAME} --no-pager -n 20`);
            }
        }, 2000);
        break;
    }
}
}

const isEntryPoint = process.argv[1]?.endsWith('service.js')
    || process.argv[1]?.endsWith('service.ts');
if (isEntryPoint) void main();
