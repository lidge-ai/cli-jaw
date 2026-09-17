/**
 * macOS LaunchAgent plist 생성 — 순수 함수.
 * bin/commands/launchd.ts 및 테스트에서 공유.
 */

export interface PlistOptions {
    label: string;
    port: string;
    nodePath: string;
    jawPath: string;
    jawHome: string;
    logDir: string;
    servicePath: string;
    /**
     * Extra environment for the service process.
     *
     * launchd does not run a login shell, so anything a CLI expects from
     * `~/.zshenv` simply is not there — which is why a runtime can work under
     * `jaw serve` and die under the same machine's service (#393).
     */
    extraEnv?: Record<string, string>;
}

const xmlEsc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Environment a macOS service needs that a login shell would otherwise have supplied.
 *
 * Currently one entry. cursor-agent refuses to run when it sees macOS + an SSH-looking
 * session + the default credential store, telling the user to unlock a keychain that a
 * background service has no way to unlock. Pointing it at its own file store
 * (~/.cursor/auth.json) skips that check. People already set this in ~/.zshenv, which
 * is exactly why the failure looks so strange: `jaw serve` inherits it and works,
 * the launchd service does not and dies (#393).
 *
 * Kept next to the generator so both plist writers get it from one place; a value the
 * user set by hand cannot survive here, since install rewrites the plist every time.
 */
export function serviceRuntimeEnv(): Record<string, string> {
    if (process.platform !== 'darwin') return {};
    return { AGENT_CLI_CREDENTIAL_STORE: process.env['AGENT_CLI_CREDENTIAL_STORE'] || 'file' };
}

export function generateLaunchdPlist(o: PlistOptions): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEsc(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEsc(o.nodePath)}</string>
        <string>${xmlEsc(o.jawPath)}</string>
        <string>--home</string>
        <string>${xmlEsc(o.jawHome)}</string>
        <string>serve</string>
        <string>--port</string>
        <string>${xmlEsc(o.port)}</string>
        <string>--no-open</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>WorkingDirectory</key>
    <string>${xmlEsc(o.jawHome)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEsc(o.logDir)}/jaw-serve.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEsc(o.logDir)}/jaw-serve.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEsc(o.servicePath)}</string>
        <key>CLI_JAW_HOME</key>
        <string>${xmlEsc(o.jawHome)}</string>
        <key>CLI_JAW_RUNTIME</key>
        <string>launchd</string>${Object.entries(o.extraEnv ?? {}).map(([key, value]) => `
        <key>${xmlEsc(key)}</key>
        <string>${xmlEsc(value)}</string>`).join('')}
    </dict>
</dict>
</plist>`;
}
