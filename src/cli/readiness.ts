import { detectAllCli } from '../core/config.js';
import { probeExec, probeGrokModels } from '../core/probe-exec.js';
import { readClaudeCreds, readCodexTokens } from '../routes/quota.js';
import { hasCopilotAuthSync } from '../../lib/quota-copilot.js';
import { CLI_KEYS, DEFAULT_CLI } from './registry.js';
import { probeCodexAppCapability, type CapabilityProbeResult } from './capability-probe.js';
import type { CliEngine } from '../types/cli-engine.js';

export interface CliReadiness {
    cli: string;
    installed: boolean;
    binaryInstalled: boolean;
    capabilityReady: boolean;
    authenticated: boolean;
    source: string;
}

interface ReadinessDependencies {
    detectAllCli: typeof detectAllCli;
    readClaudeCreds: typeof readClaudeCreds;
    readCodexTokens: typeof readCodexTokens;
    hasCopilotAuthSync: typeof hasCopilotAuthSync;
    probeCodexAppCapability: (binary: string) => CapabilityProbeResult;
}

const DEFAULT_DEPENDENCIES: ReadinessDependencies = {
    detectAllCli,
    readClaudeCreds,
    readCodexTokens,
    hasCopilotAuthSync,
    probeCodexAppCapability,
};

export function getCliReadiness(dependencies: ReadinessDependencies = DEFAULT_DEPENDENCIES): CliReadiness[] {
    const detected = dependencies.detectAllCli();
    const results: CliReadiness[] = [];

    for (const cli of CLI_KEYS) {
        const info = (detected as Record<string, any>)[cli];
        const binaryInstalled = !!info?.available;
        let capabilityReady = binaryInstalled;
        let installed = binaryInstalled;
        let authenticated = false;
        let source = 'none';

        if (!binaryInstalled) {
            results.push({ cli, installed, binaryInstalled, capabilityReady, authenticated, source });
            continue;
        }

        switch (cli) {
            case 'aside': {
                source = 'installed; selected account authentication is unverified';
                break;
            }
            case 'agy': {
                authenticated = true; // agy performs auth checks during prompt execution.
                source = 'installed; auth checked by agy at run time';
                break;
            }
            case 'pi': {
                authenticated = true; // Pi profiles validate endpoint/key during Settings registration.
                source = info?.rejected?.some((entry: any) => String(entry.reason || '').includes('npm-exec'))
                    ? 'npm-exec fallback; profile auth validated at registration'
                    : 'profile auth validated at registration';
                break;
            }
            case 'claude': {
                const creds = dependencies.readClaudeCreds();
                authenticated = !!creds?.token;
                if (creds?.source === 'cloud-provider-env') authenticated = true;
                source = creds?.source ?? 'none';
                break;
            }
            case 'codex': {
                const tokens = dependencies.readCodexTokens();
                authenticated = !!tokens?.access_token;
                source = authenticated ? 'auth.json' : 'none';
                break;
            }
            case 'cursor': {
                if (process.env["CURSOR_API_KEY"]) {
                    authenticated = true;
                    source = 'CURSOR_API_KEY';
                    break;
                }
                {
                    const r = probeExec(info.path || 'cursor-agent', ['status']);
                    authenticated = r.status === 0 && /logged in|authenticated/i.test(r.stdout);
                    source = authenticated ? 'cursor-agent status' : 'none';
                }
                break;
            }
            case 'kiro-code': {
                {
                    const r = probeExec(info.path || 'kiro-cli', ['whoami']);
                    authenticated = r.status === 0 && /logged in|email:/i.test(r.stdout);
                    source = authenticated ? 'kiro-cli whoami' : 'none';
                }
                break;
            }
            case 'grok': {
                {
                    const out = probeGrokModels(info.path || 'grok');
                    authenticated = out !== null;
                    source = authenticated ? 'grok models' : 'none';
                }
                break;
            }
            case 'copilot': {
                authenticated = dependencies.hasCopilotAuthSync();
                source = authenticated ? 'local-auth-chain' : 'none';
                break;
            }
            case 'codex-app': {
                const capability = dependencies.probeCodexAppCapability(info.path || 'codex');
                capabilityReady = capability.ok;
                installed = binaryInstalled && capabilityReady;
                const tokens = dependencies.readCodexTokens();
                authenticated = !!tokens?.access_token;
                const authSource = authenticated ? 'auth.json' : 'none';
                source = capabilityReady
                    ? authSource
                    : `app-server unavailable: ${capability.reason}; auth: ${authSource}`;
                break;
            }
            case 'opencode': {
                authenticated = true; // opencode has no separate auth
                source = 'installed';
                break;
            }
        }

        results.push({ cli, installed, binaryInstalled, capabilityReady, authenticated, source });
    }

    return results;
}

export const DEFAULT_READINESS_ORDER: readonly CliEngine[] = ['codex-app', 'pi', 'claude', 'agy', 'codex', 'cursor', 'kiro-code', 'copilot', 'grok', 'opencode', 'aside'];

export function pickFirstReadyCli(
    order: readonly CliEngine[] = DEFAULT_READINESS_ORDER,
    dependencies: ReadinessDependencies = DEFAULT_DEPENDENCIES,
): CliEngine {
    const effectiveOrder = [DEFAULT_CLI, ...order.filter(cli => cli !== DEFAULT_CLI && cli !== 'aside')];
    const readiness = getCliReadiness(dependencies);
    // Tier 1: installed + authenticated
    for (const cli of effectiveOrder) {
        const r = readiness.find(x => x.cli === cli);
        if (r?.installed && r?.authenticated) return cli;
    }
    // Tier 2: installed only
    for (const cli of effectiveOrder) {
        const r = readiness.find(x => x.cli === cli);
        if (r?.installed) return cli;
    }
    // Tier 3: fallback
    return DEFAULT_CLI;
}
