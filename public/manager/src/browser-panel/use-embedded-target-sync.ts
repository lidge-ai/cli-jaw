import { useEffect, useRef } from 'react';
import { getDesktop, type BrowserBridgeApi, type TargetLeaseMount } from '../panels/desktop-bridge';

const PUSH_DEBOUNCE_MS = 400;
const REFRESH_INTERVAL_MS = 60_000;
const COMMAND_POLL_WAIT_MS = 25_000;
const COMMAND_POLL_ERROR_BACKOFF_MS = 3_000;

type SharedTargetPayload = {
    targetId: string;
    webContentsId: number;
    url: string;
    title: string;
    devToolsOpen: boolean;
    sharedWithAgent: true;
    actionsEnabled: boolean;
};
type Command = { id: string; targetId: string; webContentsId: number; kind: string; act?: unknown; settleToken?: string; lease: TargetLeaseMount };

function validMount(value: Partial<TargetLeaseMount>): value is TargetLeaseMount {
    const validId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id);
    const validNumber = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
    return validId(value.authorityId) && validId(value.ownerId) && validNumber(value.generation) && validNumber(value.mountSeq);
}
function sameMount(a: TargetLeaseMount | null | undefined, b: TargetLeaseMount | null | undefined): boolean {
    return !!a && !!b && a.authorityId === b.authorityId && a.ownerId === b.ownerId && a.generation === b.generation && a.mountSeq === b.mountSeq;
}
async function collectSharedTargets(bridge: BrowserBridgeApi): Promise<{ targets: SharedTargetPayload[]; guestEpoch: number } | null> {
    const result = await bridge.getWebviewTabs!();
    if (!result?.ok) return null;
    return {
        guestEpoch: result.guestEpoch ?? 0,
        targets: (result.tabs ?? []).filter(tab => tab.sharedWithAgent === true).map(tab => ({
            targetId: tab.tabId, webContentsId: tab.webContentsId, url: tab.url, title: tab.title,
            devToolsOpen: tab.devToolsOpen === true, sharedWithAgent: true as const, actionsEnabled: true,
        })),
    };
}

/**
 * 030 v2/v2.1/v3 renderer relay, bound to an Electron-issued lease (#773).
 *
 * - The hook holds a mount granted by Electron main before it publishes; a
 *   desktop shell without the lease bridge publishes nothing (fail closed).
 * - v2: pushes agent-visible targets with the lease tuple; the server ignores
 *   snapshots below its highest accepted or revoked tuple.
 * - v2.1: relays the SELECTED instance (selected:true) and withdraws the
 *   previous one (selected:false); the server derives what each port gets.
 * - v3: long-polls only its own mount's commands and refuses a command whose
 *   lease or guest identity no longer matches.
 * - Unmount posts a keepalive revoke for the mount so targets and pending
 *   commands end immediately instead of waiting for the TTL.
 */
export function useEmbeddedBrowserTargetSync(active: boolean, selectedPort: number | null): void {
    const timerRef = useRef<number | null>(null);
    const lastInstancePortRef = useRef<number | null>(null);

    useEffect(() => {
        if (!active) return undefined;
        const bridge = getDesktop()?.browser;
        if (!bridge?.getWebviewTabs || !bridge.onWebviewState || typeof bridge.acquireTargetLease !== 'function') return undefined;
        const browser = bridge;
        let disposed = false;
        let lease: TargetLeaseMount | null = null;
        let seq = 0;
        let acquisition: Promise<void> | null = null;
        let pollAbort: AbortController | null = null;
        let retryTimer: number | null = null;
        let retryWake: (() => void) | null = null;

        function release(mount: TargetLeaseMount): void {
            try { void browser.releaseTargetLease?.(mount).catch(() => undefined); } catch { /* best effort */ }
        }
        function relay(port: number, mount: TargetLeaseMount, selected: boolean, keepalive = false): Promise<unknown> {
            return fetch(`/api/dashboard/instances/${port}/embedded-browser/targets`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive,
                body: JSON.stringify({ lease: mount, selected }),
            }).catch(() => undefined);
        }
        function schedulePush(): void {
            if (disposed) return;
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => { timerRef.current = null; void push(); }, PUSH_DEBOUNCE_MS);
        }
        function acquire(): Promise<void> {
            if (acquisition) return acquisition;
            acquisition = (async () => {
                let delay = 500;
                while (!disposed && !lease) {
                    let grant: Awaited<ReturnType<NonNullable<BrowserBridgeApi['acquireTargetLease']>>>;
                    try { grant = await browser.acquireTargetLease!(); } catch { return; }
                    const mount = grant?.ok && validMount(grant) ? {
                        authorityId: grant.authorityId, ownerId: grant.ownerId, generation: grant.generation, mountSeq: grant.mountSeq,
                    } : null;
                    if (disposed) { if (mount) release(mount); return; }
                    if (mount) {
                        lease = mount;
                        pollAbort = new AbortController();
                        void pollCommands(mount, pollAbort);
                        void push();
                        return;
                    }
                    if (!grant?.retryable || grant.ok) return;
                    await new Promise<void>(resolve => {
                        retryWake = resolve;
                        retryTimer = window.setTimeout(() => { retryTimer = null; retryWake = null; resolve(); }, delay);
                    });
                    delay = Math.min(delay * 2, 5000);
                }
            })().finally(() => { acquisition = null; });
            return acquisition;
        }
        async function push(): Promise<void> {
            const mount = lease;
            if (disposed || !mount) return;
            const snapshotSeq = ++seq;
            const snapshot = await collectSharedTargets(browser).catch(() => null);
            if (disposed || !sameMount(mount, lease) || !snapshot) return;
            let response: Response;
            try {
                response = await fetch('/api/manager/embedded-browser/targets', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lease: { ...mount, snapshotSeq }, ...snapshot }),
                });
            } catch { return; }
            if (disposed || !sameMount(mount, lease)) return;
            if (response.status === 409) {
                const body = await response.json().catch(() => null) as { reason?: string } | null;
                if (disposed || !sameMount(mount, lease)) return;
                if (body?.reason === 'guest-epoch') schedulePush();
                if (body?.reason === 'revoked') {
                    lease = null;
                    pollAbort?.abort();
                    void acquire();
                }
                return;
            }
            if (!response.ok) return;
            const previousPort = lastInstancePortRef.current;
            if (previousPort !== null && previousPort !== selectedPort) {
                await relay(previousPort, mount, false);
                if (disposed || !sameMount(mount, lease)) return;
            }
            if (selectedPort !== null) {
                // Record before the await so cleanup can withdraw an in-flight relay.
                lastInstancePortRef.current = selectedPort;
                await relay(selectedPort, mount, true);
                if (disposed || !sameMount(mount, lease)) return;
            }
            lastInstancePortRef.current = selectedPort;
        }
        async function executeCommand(command: Command): Promise<Record<string, unknown>> {
            const mount = lease;
            if (disposed || !sameMount(command.lease, mount)) return { ok: false, error: 'stale lease' };
            if (!browser.performWebviewAction) return { ok: false, error: 'bridge unavailable' };
            const shared = await collectSharedTargets(browser).catch(() => null);
            if (disposed || !sameMount(command.lease, lease)) return { ok: false, error: 'stale lease' };
            const target = shared?.targets.find(t => t.targetId === command.targetId && t.webContentsId === command.webContentsId);
            if (!target) return { ok: false, error: 'target is no longer available in Manager Browser' };
            const identity = { tabId: command.targetId, webContentsId: command.webContentsId, agentLease: mount! };
            if (command.kind === 'screenshot') {
                const result = await browser.performWebviewAction({ kind: 'captureScreenshot', ...identity });
                return result?.ok && result.screenshot ? { ok: true, screenshot: result.screenshot } : { ok: false, error: result?.error ?? 'capture failed' };
            }
            if (command.kind === 'snapshot') {
                const result = await browser.performWebviewAction({ kind: 'getDomSnapshot', ...identity });
                return result?.ok && result.snapshot ? { ok: true, snapshot: result.snapshot } : { ok: false, error: result?.error ?? 'snapshot failed' };
            }
            if (command.kind === 'act') {
                const act = command.act;
                if (!act) return { ok: false, error: 'act payload missing' };
                const targetId = command.targetId;
                const result = await browser.performWebviewAction({ kind: 'act', tabId: targetId, act: act as never, webContentsId: identity.webContentsId, agentLease: identity.agentLease });
                return result?.ok ? { ok: true, acted: true } : { ok: false, error: result?.error ?? 'act failed' };
            }
            return { ok: false, error: `unknown command kind: ${command.kind}` };
        }
        async function pollCommands(mount: TargetLeaseMount, controller: AbortController): Promise<void> {
            while (!disposed && sameMount(mount, lease)) {
                const iterationStart = Date.now();
                try {
                    const params = new URLSearchParams({ wait: String(COMMAND_POLL_WAIT_MS), authorityId: mount.authorityId,
                        ownerId: mount.ownerId, generation: String(mount.generation), mountSeq: String(mount.mountSeq) });
                    const response = await fetch(`/api/manager/embedded-browser/commands?${params}`, { signal: controller.signal });
                    if (!response.ok) throw new Error(`commands poll ${response.status}`);
                    const body = await response.json() as { commands?: Command[] };
                    for (const command of body.commands ?? []) {
                        const result = await executeCommand(command);
                        await fetch(`/api/manager/embedded-browser/commands/${encodeURIComponent(command.id)}/result`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ...result, settleToken: command.settleToken }),
                        }).catch(() => undefined);
                    }
                } catch {
                    if (!disposed && sameMount(mount, lease)) await new Promise(resolve => setTimeout(resolve, COMMAND_POLL_ERROR_BACKOFF_MS));
                }
                const elapsed = Date.now() - iterationStart;
                if (!disposed && sameMount(mount, lease) && elapsed < 1000) await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
            }
        }
        const unsubscribe = browser.onWebviewState!(() => schedulePush());
        // D4: throttle the refresh while hidden rather than skipping it. This
        // push keeps `lastPushAt` fresh, and the server drops targets after
        // STALE_AFTER_MS (5 min, src/manager/routes/embedded-browser.ts).
        // Pushing at a slower cadence keeps registration alive cheaply.
        const HIDDEN_PUSH_INTERVAL_MS = 4 * 60 * 1000;
        let lastHiddenPush = 0;
        const interval = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) {
                if (Date.now() - lastHiddenPush < HIDDEN_PUSH_INTERVAL_MS) return;
                lastHiddenPush = Date.now();
                void push();
                return;
            }
            lastHiddenPush = 0;
            void push();
        }, REFRESH_INTERVAL_MS);
        void acquire();
        return () => {
            disposed = true;
            pollAbort?.abort();
            unsubscribe();
            window.clearInterval(interval);
            if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            retryWake?.();
            const mount = lease;
            lease = null;
            if (mount) {
                void fetch('/api/manager/embedded-browser/lease/revoke', {
                    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mount),
                }).catch(() => undefined);
                release(mount);
                const port = lastInstancePortRef.current;
                if (port !== null) void relay(port, mount, false, true);
            }
            lastInstancePortRef.current = null;
        };
    }, [active, selectedPort]);
}
