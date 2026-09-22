# cli-jaw Electron Desktop Shell

Electron wrapper around the jaw manager dashboard. In development it attaches to
or spawns `jaw dashboard serve`; in packaged builds it prefers the bundled
Node.js sidecar server shipped under `extraResources/server`.

Default manager lanes:

- Web/CLI dashboard: `24576`
- Electron implicit spawn: `24577-24590`

The Electron main process must not import server-native modules such as
`better-sqlite3`. Native/server dependencies live in the manager or bundled
sidecar process.

## Install

```bash
# from the repo root
npm install
npm --prefix electron install
```

## Develop

From the repo root, run the dashboard server and Electron with hot reload:

```bash
npm run electron:dev
```

If an Electron manager server is already running on `24577`:

```bash
npm --prefix electron run dev
```

## Build The Shell

```bash
npm run electron:build
# outputs:
#   electron/out/main/index.js
#   electron/out/preload/index.js
```

Run the built shell without packaging:

```bash
npm --prefix electron run start
```

## Bundle The Sidecar

Packaged apps include a self-contained server sidecar:

```bash
npm run sidecar:bundle
```

`scripts/bundle-sidecar.sh` currently:

- downloads Node.js `24.17.0` for the target platform/arch,
- runs the root backend and frontend builds,
- copies `dist/`, `public/`, `package.json`, and lockfile into
  `electron/sidecar/server`,
- installs production dependencies with scripts disabled from the copied lockfile,
- excludes retired JWC, `jawcode`, `@jawcode-dev`, `@oven`, `bun`,
  `claude-e`, `claude-exec`, `@bitkyc08/ai-e`, and `jaw-claude-i` payloads;
  saved retired selections require an explicit supported runtime choice, and Code
  sessions use the native Codex, Claude, Cursor or Grok adapter,
- prunes frontend-only packages,
- rebuilds `better-sqlite3`,
- creates `bin/jaw` or `bin/jaw.cmd` to launch `dist/bin/cli-jaw.js`,
- verifies the staging sidecar contains no bundled retired runtime payload.

`electron/src/main/lib/jaw-spawn.ts` searches the bundled sidecar first in
packaged apps, then falls back to `JAW_BIN` and the global `jaw` binary.

## Package

```bash
npm run electron:dist:mac
```

The root `electron:dist:mac` script runs:

```bash
npm run build:frontend
npm run sidecar:bundle
npm --prefix electron run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac
npm run check:electron-dist-mac-no-jwc
npm run check:app-icons
```

The dist checks validate the packaged `.app` under `electron/dist/mac-arm64`.
They do not replace `/Applications/cli-jaw.app`; app replacement remains a
manual step after build verification.

Current `electron-builder.yml` targets:

| Platform | Arch | Artifacts |
| --- | --- | --- |
| macOS | arm64 | DMG, ZIP |
| Windows | x64 | NSIS installer, ZIP |
| Linux | x64 | AppImage |

The ordinary local `electron:dist:mac` command is ad-hoc signed. The canonical
GitHub release workflow requires a Team `U9ATA49N28` Developer ID signature,
Apple notarization and a stapled ticket. Windows artifacts remain unsigned.

## Release Workflow

`.github/workflows/desktop-release.yml` is the canonical desktop release path.
It runs on GitHub Release publish and manual `workflow_dispatch`.

For each platform matrix entry it:

1. checks out the release tag or current ref,
2. installs Node.js 24 and Python 3.11 for `node-gyp`,
3. runs root `npm ci --ignore-scripts`,
4. bundles the platform sidecar,
5. installs Electron dependencies,
6. typechecks and builds Electron,
7. signs, notarizes and staples the macOS app (Windows/Linux remain unsigned),
8. verifies the macOS identity, team, hardened runtime, timestamp, nested
   signature, Gatekeeper verdict and stapled ticket,
9. verifies the selected release's `latest-mac.yml`, ZIP size/SHA-512,
   blockmap and packaged GitHub provider,
10. verifies the final sidecar and packaged app icon inputs,
11. uploads artifacts to the release or 7-day manual-run artifact storage.

The updater runs only in an installed, packaged macOS app. It performs one
delayed silent check on startup and exposes **CLI-JAW → Check for Updates…**.
It never auto-downloads or auto-installs: both actions require native-dialog
consent, and coordinated manager cleanup completes before restart/install.
Stable builds use GitHub's latest stable release. Preview builds select a
matching preview tag from the GitHub release feed and use that release's own
`latest-mac.yml` (electron-updater's documented GitHub fallback). The first
signed release is a manual-DMG bootstrap for users of older unsigned builds.

## Desktop Behavior

Recent desktop surfaces include:

- sidecar-first `jaw` detection,
- first-launch and tray menu CLI install flow,
- background tray mode,
- browser webview panel and URL controls,
- diff repo picker and dashboard git diff API bridge,
- widened/resizable right sidebar panels,
- visible quit cleanup/progress,
- macOS Automation permission prompt for Computer Use-related flows.

## Environment Variables

| Var | Default | Description |
|---|---|---|
| `JAW_MANAGER_URL` | `http://127.0.0.1:24577/` | Manager URL to attach to |
| `JAW_MANAGER_PORT` | `24577` | Port used when URL is not set; implicit spawn falls back through `24590` |
| `JAW_BIN` | auto-detected | Path to a `jaw` CLI binary when not using the bundled sidecar |
| `JAW_ELECTRON_DEVTOOLS` | unset | Set to `1` to open DevTools |
| `NODE_ENV` | unset | `development` enables DevTools |

## CLI Flags

```text
--port <n>           Override manager port (implicit spawn uses 24577-24590)
--manager-url <url>  Override full manager URL
--attach-only        Never spawn jaw dashboard serve; only attach
--spawn              Force spawn even if no health probe is required
```

## Lifecycle

1. Health-check `${MANAGER_URL}api/dashboard/health` with backoff
   `200/400/800/1600/3000/5000ms` for up to 60 seconds.
2. Healthy manager loads immediately.
3. Unhealthy and not `--attach-only`: discover sidecar/global `jaw`, spawn
   `jaw dashboard serve --port <port> --no-open`, then re-check.
4. Binary missing: show native install/pick-path/quit dialog.
5. Crash loop guard: more than 3 manager exits within 60 seconds stops
   auto-restart and shows a dialog.
6. Quit: `SIGTERM`, 5 second grace, then `SIGKILL`.
