import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveApprovalPolicy, resolveCuaRepl, runComputerUseProxy } from './computer-use-proxy.js';

export async function runComputerUseProxyMain(): Promise<void> {
    let child: ChildProcessWithoutNullStreams | undefined;
    const stop = (): void => { child?.kill(); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    const code = await runComputerUseProxy({ input: process.stdin, output: process.stdout, errorOutput: process.stderr }, {
        spec: resolveCuaRepl({ codexHome: process.env['CODEX_HOME'] }),
        policy: resolveApprovalPolicy(process.env),
        onChild: spawned => { child = spawned; },
    });
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    // The missing-plugin path can finish immediately after a protocol error write.
    await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
    process.stdin.pause();
    process.exitCode = code;
}

void runComputerUseProxyMain();
