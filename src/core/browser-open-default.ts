import { isWsl, defaultPlatformProbes, type PlatformProbes } from './platform-kind.js';

/**
 * Explicit, environment-level opt-out from any startup browser open.
 *
 * A background service has no user sitting in front of it, so a KeepAlive
 * respawn that pops a browser window is noise, not a convenience. Service
 * runtimes (launchd/systemd/Windows service) therefore never auto-open, and
 * `JAW_OPEN_BROWSER=0` / `JAW_NO_BROWSER=1` lets any launcher say so directly.
 */
export function isBrowserOpenSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env["JAW_NO_BROWSER"] === '1') return true;
    if (env["JAW_OPEN_BROWSER"] === '0') return true;
    if (env["JAW_DASHBOARD_OPEN"] === '0') return true;
    return Boolean(env["CLI_JAW_RUNTIME"]);
}

export function isHeadlessBrowserEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    if (env["CI"] || env["SSH_CONNECTION"] || env["SSH_TTY"] || env["REMOTE_CONTAINERS"] || env["CODESPACES"]) return true;
    if (platform !== 'linux') return false;
    // WSL has no X display unless WSLg is running, so treat it as headless.
    if (isWsl(platform, env, probes)) return true;
    return !env["DISPLAY"] && !env["WAYLAND_DISPLAY"];
}

export function shouldOpenBrowserByDefault(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    if (isBrowserOpenSuppressed(env)) return false;
    return !isHeadlessBrowserEnvironment(env, platform, probes);
}
