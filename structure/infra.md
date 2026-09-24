---
created: 2026-03-28
tags: [cli-jaw, infra, runtime, core]
aliases: [CLI-JAW Infra, infrastructure modules, core runtime]
---

> 📚 [INDEX](INDEX.md) · [에이전트 실행 ↗](agent_spawn.md) · [서버 API ↗](server_api.md) · **인프라 모듈**

# 인프라 모듈 — core/ · messaging/ · telegram/ · discord/ · memory/ · browser/ · routes/ · security/ · http/ · lib/mcp-sync

> 의존 0 모듈 + 데이터 레이어 + 멀티 채널 메시징 + 외부 도구 통합
> 현재 tree 기준으로 `src/core/`는 support cluster, `src/messaging/`는 Telegram/Discord 공통 런타임, `src/telegram/`·`src/discord/`는 각 채널 transport 구현으로 분리됨

---

## 실제 실행/배포 표면 — `package.json` · Docker · CLI

Print observation reuses the existing journal; `merge-tool-log.ts` is a pure merge owner, not another store. `getTraceToolEntry` recovers only an exact existing tool row through the established decoder/safe path and contains read errors. Snapshot hydration's explicit `knownOmitted` sanitizer option reserves the warning slot and retains a conservative prior loss count without double-counting overlapping reconstructed rows; default sanitizer callers preserve their previous additive append semantics. Native terminal updates remain frozen unless the print-only caller explicitly opts in.

Activity persistence uses the existing SQLite trace tables: nullable `trace_runs.session_id/scope_key`, a session index, a runtime-row partial index and one unique control row per run. `activity-journal.ts` owns transactional append/read, `activity-control.ts` is the DB-only control leaf, and `activity-retention.ts` prunes raw rows before whole canonical prefixes. `store.ts` uses control/retention without importing the journal, avoiding a new store/journal cycle. Startup migration backfills only original message owners; chat deletion removes owned trace headers transactionally. Completed events are immutable; late conditional finalization cannot rewrite completed control. Spill cleanup never follows symlinked roots/directories. See `runtime-integration.md` for budgets/loss and `server_api.md` for owner-bound reads.

### Package metadata

| 항목 | 현재 값 |
| --- | --- |
| package | `cli-jaw` |
| version | `2.2.4` |
| type | `module` |
| Node engine | `>=22.4.0` |
| bin | `cli-jaw` → `dist/bin/cli-jaw.js`, `jaw` → `dist/bin/cli-jaw.js` |
| published files | `dist/`, `public/`, `scripts/`, `package.json` |

### `package.json` scripts

| script | command |
| --- | --- |
| `dev` | `tsx --env-file=.env server.ts` |
| `ensure:native` | `node scripts/ensure-native-modules.cjs` |
| `rebuild:native` | `npm rebuild better-sqlite3` |
| `postinstall` | `node scripts/postinstall-guard.cjs` |
| `clean:dist` | `node -e "const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});"` |
| `check:copilot-gap` | `tsx scripts/check-copilot-gap.ts` |
| `check:deps` | `tsx scripts/check-deps-offline.ts` |
| `check:frontend-build-output` | `tsx scripts/check-web-ui-build-output.ts` |
| `check:strict-baseline` | `node scripts/check-strict-baseline.mjs` |
| `gate:redaction-sinks` | `node scripts/release-gates.mjs redaction-sinks` — channel replies/sends/loggers must route through a credential masker |
| `gate:electron-version` | `node scripts/release-gates.mjs electron-version` — `electron/package.json` version must equal the root `package.json` so desktop artifacts carry the release version |
| `sync:electron-version` | `node scripts/sync-electron-version.cjs` — writes the root version into `electron/package.json` and its lockfile; called by both release scripts before `gate:all` |
| `gate:gate-docs` | `node scripts/release-gates.mjs gate-docs` — `structure/INDEX.md` must list exactly the live gates, with the right count, and each must have its `gate:<name>` npm script |
| `gate:sidecar-prune-safety` | `node scripts/release-gates.mjs sidecar-prune-safety` — the sidecar prune list must never delete a package the server imports (a packaged app died on `node-fetch`) |
| `gate:native-load` | `node scripts/release-gates.mjs native-load` — `node-pty` must actually `dlopen` and `spawn-helper` must genuinely execute. Both are resolved from `build/Release` or `prebuilds/<platform>-<arch>`: node-pty's install is `prebuild.js \|\| node-gyp rebuild`, so a matching prebuild skips the source build and `build/Release` is never created. Needs `electron/node_modules`, so it reports `SKIPPED` (exit 3) when absent and only hard-fails under `JAW_GATE_REQUIRE_NATIVE=1`, which `desktop-release.yml` sets after `npm ci --prefix electron` |
| `gate:sidecar-smoke` | `node scripts/release-gates.mjs sidecar-smoke` — target Node executes a byte-verified isolated artifact copy; finite imports and server import/listener/HTTP/stop/close have separate checks. Default absent bundle is `SKIPPED` (exit 3), never verified; explicit `--server-root` or `JAW_GATE_REQUIRE_SIDECAR=1` requires a real artifact. `--report NEW_FILE` selects retained evidence outside the artifact. |
| `scripts/pick-gyp-python.sh` | prints a `python3` that can `import distutils`, which node-gyp still requires; wired into `electron:dist:mac` because Homebrew Python 3.12+ breaks the node-pty rebuild |
| `i18n:registry` | `tsx scripts/i18n-registry.ts` |
| `check:deps:online` | `bash scripts/check-deps-online.sh` |
| `prebuild`, `pretest`, `pretest:all`, `pretest:integration`, `pretest:smoke` | `npm run ensure:native` |
| `test` | `tsx --experimental-test-module-mocks tests/run.mts` — programmatic driver, `isolation:'process'` + `concurrency:true`, fresh `CLI_JAW_HOME` per child, never `forceExit` (#661), per-file stall watchdog armed at a file's first result and bounded by `JAW_TEST_FILE_STALL_MS` (default 180000) unless `--watch`. Options: `--scope root,unit,integration,manager,browser,bin` (default `root,unit`), `--shard i/N` (byte-ordered round-robin, `tests/setup/shard.ts`), `--list` (print selection, exit 0) |
| `test:shard` | `tsx --experimental-test-module-mocks tests/run.mts --scope root,unit --shard` — `npm run test:shard -- 1/4` runs exactly what CI's `test 1/4` job runs |
| `test:integration:all` | `tsx --experimental-test-module-mocks tests/run.mts --scope integration,manager,bin` — CI's `integration` job set; `api-smoke` needs a server on `TEST_PORT` and fails closed when `CI` is set |
| `test:all` | `tsx --experimental-test-module-mocks tests/run.mts --all` |
| `test:integration` | `tsx --experimental-test-module-mocks --test tests/integration/*.test.ts` |
| `test:coverage` | `tsx --experimental-test-module-mocks --experimental-test-coverage tests/run.mts --all` — the driver turns the flag into `run({ coverage: true })` (node:test ≥ 22.10); the flag alone is ignored by the programmatic API |
| `test:watch` | `tsx --experimental-test-module-mocks tests/run.mts --watch` |
| `test:web-ui-runtime` | `tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test tests/unit/web-ui-runtime-*.test.ts tests/unit/web-ui-processblock-runtime.test.ts tests/unit/web-ui-mermaid-runtime.test.ts tests/unit/web-ui-sanitizer.test.ts tests/unit/web-ui-build-output-guard.test.ts` |
| `test:events` | `tsx --test tests/events.test.ts` |
| `test:telegram` | `tsx --test tests/telegram-forwarding.test.ts` |
| `test:manager:browser` | `tsx --test tests/browser/manager-layout-smoke.test.ts` |
| `test:smoke` | `node scripts/run-with-env.mjs TEST_PORT=3457 -- tsx --test tests/integration/api-smoke.test.ts` |
| `smoke:opencode` | `tsx scripts/smoke/opencode-external-dir-smoke.ts` |
| `verify:fresh-install` | `bash scripts/verify-fresh-install.sh` |
| `collect:fresh-install-evidence` | `bash scripts/collect-fresh-install-evidence.sh` |
| `audit:fresh-install-evidence` | `node scripts/audit-fresh-install-evidence.mjs` |
| `verify:release-evidence` | `node scripts/verify-release-evidence.mjs` |
| `test:fresh-install` | `tsx scripts/fresh-install-smoke.ts` |
| `test:install-risk` | `node scripts/install-risk-gate.mjs` |
| `check:cli-bin-links` | `node scripts/check-cli-bin-links.cjs` |
| `build` | `bash scripts/atomic-build.sh` — staged `dist/bin/cli-jaw.js` 실행권한을 보장한 뒤 atomic swap |
| `postbuild` | `node scripts/link-current-nvm-bin.cjs` — non-NVM Node에서는 링크를 skip하되 `dist/bin/cli-jaw.js` chmod repair는 먼저 수행 |
| `build:frontend` | `vite build --config vite.config.ts` |
| `qa:manager-frontend` | `npm run build:frontend && npm run typecheck:frontend` |
| `dev:frontend` | `vite --config vite.config.ts` |
| `preview:frontend` | `vite preview --config vite.config.ts` |
| `typecheck` | `tsc --noEmit` |
| `typecheck:frontend` | `tsc --noEmit -p tsconfig.frontend.json` |
| `gate:typecheck` / `gate:tests` / `gate:*` | `node scripts/release-gates.mjs <gate>` |
| `gate:all` | `node scripts/release-gates.mjs` |
| `prepublishOnly` | `npm run build && npm run build:frontend && npm run check:frontend-build-output` |
| `electron:dev` | `concurrently -k -n jaw,electron "node scripts/electron-dev-manager.mjs" "npm --prefix electron run dev"` |
| `electron:dist:mac:signed` | Opt-in local Developer ID build with operator-provided signing configuration and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. Requests app notarization and a signed DMG, notarizes and staples the DMG (`scripts/notarize-mac-dmg.mjs`), then runs artifact, update-metadata, app and DMG signature verification. The default local command remains ad-hoc; the canonical desktop release workflow requires Team `U9ATA49N28` signing/notarization and fails closed. |
| `verify:mac-signature` | Checks the built macOS app's Developer ID authority, hardened runtime, secure timestamp, nested signature, Gatekeeper assessment and stapled ticket. Source tests alone do not certify an artifact. |
| `verify:mac-dmg` | Checks the single `electron/dist/*.dmg`: Developer ID authority and team, secure timestamp, `codesign --verify --strict`, Gatekeeper `--type open` primary-signature verdict reporting `Notarized Developer ID`, and a stapled ticket. |
| `verify:electron-update-metadata` | Verifies the GitHub provider's per-release `latest-mac.yml`: version, safe ZIP name, size, SHA-512, blockmap, the size/SHA-512 of every other listed artifact (the post-staple DMG) and packaged provider before any macOS artifact upload. Preview clients select a matching prerelease tag from GitHub's feed, then use that release's `latest-mac.yml` fallback. |
| `electron:build` | `npm --prefix electron run build` |
| `sidecar:bundle` | `bash scripts/bundle-sidecar.sh darwin arm64` |
| `electron:dist:mac` | `npm run build:frontend && npm run sidecar:bundle && npm --prefix electron run build && CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac && npm run electron:resign:mac && npm run check:electron-dist-mac-no-jwc && npm run check:app-icons`. With no signing identity configured, electron-builder skips mac signing and `afterSign`; the following re-sign step creates the final plain ad-hoc local artifact. |
| `electron:resign:mac` | `codesign --force --deep --sign - electron/dist/mac-arm64/cli-jaw.app` — plain ad-hoc only: no Developer ID authority, hardened-runtime option or secure timestamp. It is not a signed-release rehearsal. |
| `electron:start` | `npm --prefix electron run start` |
| `check:electron-sidecar-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs` |
| `check:electron-dist-mac-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/mac-arm64/cli-jaw.app/Contents/Resources/server` |
| `check:electron-dist-win-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/win-unpacked/resources/server` |
| `check:electron-dist-linux-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/linux-unpacked/resources/server` |
| `check:app-icons` | `node scripts/check-app-icon-assets.cjs` |
| `check:electron-no-native` | `node scripts/check-electron-no-native.cjs` |

> 현재 `package.json`에는 `lint` script가 없다.

### Windows npm install integrity and PowerShell shims

npm 12+ may block dependency lifecycle scripts unless `cli-jaw` is explicitly
approved. The supported one-shot recovery is
`npm install -g cli-jaw --allow-scripts=cli-jaw`; persist the narrow approval
with `npm config set allow-scripts=cli-jaw --location=user`. Do not use npm's
package-less printed variant or a wildcard approval. Run `jaw doctor` after
recovery: the install receipt check distinguishes completed, stale, blocked,
safe-mode, failed, and receipt-free `.git` development clones. Doctor also
lists verified `.cli-jaw-*` npm staging leftovers so a user can close the
locking process and remove them manually.

On native Windows npm may generate both `jaw.ps1` and `jaw.cmd`. PowerShell
execution policy applies to `jaw.ps1`, but not to `jaw.cmd`. Doctor probes
`Get-ExecutionPolicy` with a three-second bound: `Restricted`, `AllSigned`, and
`Undefined` warn; `RemoteSigned`, `Bypass`, and `Unrestricted` pass; probe
failure is informational. Recovery choices are:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
jaw.cmd doctor
node "$(npm prefix -g)\node_modules\cli-jaw\dist\bin\cli-jaw.js" doctor
```

The policy change is user-scoped. Operators who must not change policy can use
the cmd shim or direct Node entry point instead.

### Direct smoke utilities

### CI job graph (`.github/workflows/test.yml`, #565)

`scripts/check-private-boundary.mjs` checks indexed paths by default; the local `.githooks/pre-push` uses `--pre-push` to inspect outgoing commit trees before upload. See [contributor setup](../CONTRIBUTING.md#local-private-path-check) for checkout-local activation and manual `--range` checks. CI and publish checks are backstops after upload, not pre-disclosure guards. npm packaging uses explicit private-path exclusions in `package.json`'s `files` allowlist because root `.npmignore` alone does not override that allowlist.

opencodex `ci.yml` 의 샤딩 구조를 이식했다. 하나의 직렬 `node-tests` 잡(9m51s, 34128612867)이
아래 그래프로 바뀌었고, 같은 커밋 기준 전체 벽시계 5m00s (34139039203).

```
changes ──┬── test 1/4 … test 4/4   tsc + tests/run.mts --scope root,unit --shard i/4   (fail-fast: false, 5-min step limit)
          ├── integration           npm run build → build:frontend → server :3457 → --scope integration,manager,bin (CI=1) → fresh-install smoke
          ├── gates                 gate:all · check:deps · check:deps:audit · copilot gap · file size · windows manifest validate
          ├── windows-unit          scripts/ci/windows-unit-manifest.txt via windows-unit-manifest.mjs --print (pwsh, one argv array)
          └── coverage (advisory)   dev push / workflow_dispatch only; continue-on-error; not in the aggregate
                     └──────────────► ci-aggregate   bash scripts/ci/aggregate-check.sh
```

`Hosted Manager QA` is a separate manual-event job in this same workflow. Run
`gh workflow run test.yml --ref dev` for the selected candidate, then match the
run's `headSha` to that candidate and inspect the QA job itself. Push/PR runs skip
this opt-in job; that skip is not browser verification. Existing required producer
and aggregate rules are unchanged. The workflow's shared-ref concurrency can
cancel an earlier run, so finish the push run before dispatching manual QA.

The hosted job installs the locked Playwright Chromium under Node 24.18.0,
which includes the stream compatibility fix for the older ZIP extractor. Browser
provisioning has an eight-minute deadline. It switches to Node 24.17.0 before
native ABI preparation, backend/frontend builds and QA, preserving the target
runtime. Then `tests/helpers/hosted-manager-qa.mjs` owns isolated
Manager/worker fixtures and browser processes under an exclusive short
`/tmp/jaw-qa-*` root so Chromium's Unix socket paths fit Linux limits. Artifacts
remain in the explicit runner artifact directory. It runs native Code, retired
settings and Manager layout files sequentially: seven named tests, including
16 native Code scenarios, two retirement widths and five layout scenarios.
Structured results reject skipped or missing cases; logs, screenshots, traces
and process-exit receipts are uploaded even on failure. The layout fixture serves
real worker HTML through the production Preview proxy. This proves deterministic
Linux browser integration; it does not certify live provider authentication or
packaged Electron behavior on other platforms.

집계 규칙 (`scripts/ci/aggregate-check.sh`, 진리표는 `tests/unit/ci-aggregate-rules.test.ts`):

| `changes` | `code` | producer 결과 | 판정 |
|---|---|---|---|
| success | true | 전부 success | pass |
| success | true | 하나라도 skipped | **fail** (잡이 떨어져 나간 것) |
| success | false | success 또는 skipped | pass (docs-only) |
| — | — | failure / cancelled / 빈 값 / 미지 값 | fail |
| ≠ success | 또는 true/false 이외 | — | fail |

`ci-aggregate` 이름은 브랜치 ruleset 이 문자 그대로 매칭하므로 바꾸지 않는다. `publish.yml` 과
릴리스 스크립트는 잡 이름이 아니라 **워크플로 파일명·정확한 SHA·push 이벤트·preview|main 브랜치**로
런을 고른다 (`publish.yml:85`, `promote-to-main.sh:29`, `release-preview.sh:289`). `workflow_dispatch` 런은
그 필터를 통과하지 못하므로 릴리스를 인증할 수 없다.

CI 에서 skip 은 실패다: `api-smoke` 는 서버가 없으면 `CI` 아래에서 assert-fail 한다. 격리(quarantine) 목록 —
provider 인증과 실제 추론이 필요해 opt-in 으로만 도는 파일:

| file | opt-in | reason |
|---|---|---|
| `tests/integration/agy-print-smoke.test.ts` | `JAW_AGY_SMOKE=1` + AGY 인증 | 실제 AGY print 모드 추론 |
| `tests/integration/codex-app-multiplex-activation.test.ts` | activation flag + `CODEX_HOME/auth.json` | 정확한 codex-cli 버전과 실제 추론 |

integration 잡의 skip 목록이 이 표와 달라지면 새 격리가 아니라 회귀다.

샤드 분할은 `tests/setup/shard.ts`: 선택 파일을 `Buffer.compare`(LC_ALL=C 바이트 순)로 정렬하고
`index % N === i-1` 을 취한다 — `node --test-shard` 및 opencodex helper 와 같은 규칙이라 러너마다 같은
분할이 나온다. 파일 수 균형 ≠ 시간 균형: 34139039203 기준 72/83/104/89s. 한 샤드가 240s 를 넘거나
최대/최소가 2배를 넘으면 N 을 올린다. 멈춘 파일은 `forceExit` 가 아니라 드라이버의 진행 감시가 막는다:
`forceExit` 는 자식마다 `--test-force-exit` 를 붙여 루트가 "이미 아는" 테스트만 끝나면 즉시 프로세스를
끝냈고, 그래서 top-level await 뒤에 등록된 테스트가 실행만 되고 보고되지 않았다(#661, 회차마다 4~62개).
지금은 결과를 내기 시작한 뒤 `JAW_TEST_FILE_STALL_MS`(기본 180000ms) 동안 조용한 파일을 이름과 함께
실패로 보고하고 나머지를 abort 한다 — 34138235928 shard 3/4 가 4분 반 침묵하다 스텝 타임아웃으로
죽었을 때 없던 귀속 정보다. dequeue 부터 재지 않는 이유는 500개 자식이 코어를 다투는 동안 정상 파일도
첫 이벤트까지 60s 를 기다릴 수 있기 때문이고(측정), 첫 결과 이후 관측된 최대 간격은 9.5s 다.
회귀 가드는 `tests/unit/test-runner-driver.test.ts` 와 `tests/fixtures/test-runner/*.fixture.ts`.
`test.yml` 의 shard 스텝 한도는 480s 다 — 감시(180s)가 Actions 보다 먼저 울려서 파일 이름을 남길
여유를 주기 위해서다. 정지 메시지는 파일마다 마지막 이벤트 종류·개수·경과를 함께 찍는다.

`test.yml`의 `windows-unit`은 기존 Windows 서비스·설치·실행 검사에 더해
`claude-sdk-windows-launch`, `claude-sdk-session`, `claude-sdk-control`,
`claude-sdk-core-hardening`, `claude-sdk-deferred-core`의 명시적 테스트 파일을 실행한다.
SDK query와 프로세스 경계는 fixture로 격리하며, macOS에서 같은 파일을 실행한 결과는
실제 Windows job의 성공 증거를 대신하지 않는다. 파일 목록은 인라인이 아니라
`scripts/ci/windows-unit-manifest.txt` 에 있고, `scripts/ci/windows-unit-manifest.mjs` 가 Linux(`gates` 잡 +
`tests/unit/windows-unit-manifest.test.ts`)와 Windows 양쪽에서 같은 규칙(빈 목록·중복·`tests/unit/` 밖·없는 파일
거부)으로 검증한다. Node 22·aggregate 검증과 code-change skip 거부 조건은 유지한다.

#### 테스트 격리는 프로세스 단위지 DB 단위가 아니다

`tests/run.mts` 는 `isolation:'process'` 로 파일마다 자식 프로세스를 띄우고, #564 부터는
`run({ execArgv: ['--import', tests/setup/test-home.ts] })` 로 **자식마다 새 `CLI_JAW_HOME` = 새 `jaw.db`** 를
준다 (그 전에는 부모가 한 번 정한 홈을 모두 상속해 하나의 `jaw.db` 를 공유했고, 샤딩으로 배치 구성이
바뀌자 두 파일이 첫 open 마이그레이션을 경쟁해 `SqliteError: duplicate column name` 으로 죽었다).
파일 **안**의 격리는 여전히 없다 — 한 파일의 여러 케이스는 같은 DB 를 본다. 이 문장을 케이스 단위
"subprocess DB isolation" 으로 읽으면 없는 보장을 있다고 믿게 된다 (#521 조사에서 실제로 그 오독으로
잘못된 가설을 세웠다).

파일 안에서 스위트를 지켜주는 것은 두 가지다:

- `src/core/db.ts` 의 `journal_mode = WAL` + `busy_timeout = 5000`. WAL 에서 리더는
  라이터를 막지 않으므로 평범한 동시 접근은 잠금이 되지 않는다.
- 파일별 opt-in 격리 `tests/setup/isolated-home.ts`. 이건 좁고 구체적인 위험
  — `isAlive` 를 스텁한 전역 파괴적 sweep 이 다른 프로세스의 행을 지우거나,
  session singleton을 sentinel로 교체·복원하는 검사가 다른 파일을 덮는 경우 —
  에만 필요하며, DB 를 여는 파일 전부가 아니라 이런 공유 상태 위험이 있는 파일에 넣는다.

로그에서 `database is locked` 를 봤다고 곧장 경합이라고 결론내지 말 것.
`tests/unit/memory-search-provider.test.ts` 는 `BEGIN IMMEDIATE` 를 4.2초 잡는 자식을
**의도적으로** 띄워 재시도 경로를 검증하며, 그건 `jaw.db` 가 아니라 메모리 인덱스 DB다.
통과하는 테스트의 정상 출력이다.

| utility | command | purpose |
| --- | --- | --- |
| Fullscreen TUI `/quit` PTY smoke | `JAW_TUI_SMOKE_TIMEOUT=15 COLUMNS=100 LINES=30 scripts/smoke/tui-quit-smoke.exp` | built `dist/bin/cli-jaw.js chat`가 raw-mode fullscreen composer에서 `/quit`로 정상 종료되는지 검증 |
| Fullscreen TUI frame resize stress | `npx tsx --import ./tests/setup/test-home.ts scripts/smoke/tui-frame-resize-stress.ts` | live/committed/expanded tool rows + final answer가 resize 후에도 width-safe이고 bottom composer cluster가 고정되는지 검증 |
| Fullscreen TUI WS sequence stress | `npx tsx --import ./tests/setup/test-home.ts scripts/smoke/tui-ws-sequence-stress.ts` | synthetic WS 이벤트로 live tool, final answer, Ctrl-O expansion, resize-safe frame을 서버/모델 없이 검증 |
| Native Activity deterministic POSIX PTY | `node_modules/.bin/tsx tests/smoke/tui-activity-pty.mts --built-head <HEAD> --build-report <build-report.json> --evidence <owned-dir>` | 컴파일된 CLI·가짜 HTTP/SSE·실제 POSIX PTY로 제출/Stop, saved MESSAGE 복구, F6·resize·paste, raw NDJSON과 종료를 검증. 실제 provider/DB 영속성 증거는 아님 |

PTY 도구는 설치된 Node/tsx/xterm과 Python 3 POSIX 표준 라이브러리를 사용하며,
새 패키지를 설치하지 않는다. `--build-report`는 호출자가 실제 실행한
`npm run build --ignore-scripts`의 `command`, `exitCode`, `timedOut`, `overflow`,
`groupLive`, `rootRemoved` 결과를 가진 JSON이다. 성공 기록만으로 빌드 출처를
추정하지 말고 해당 소스·dist와의 일치도 확인한다. 도구는 현재 HEAD와 소스/dist
변경 여부를 추가 검사한다. `--ownership-self-test --evidence <owned-dir>`는
실제 PID 재사용 없이 신호 권한·불확실한 정리 결과를 검증한다. 회수된 PID/PGID에는
파괴적 신호를 보내지 않으며, 소유권이 불분명하면 실패와 임시 루트 보존으로 끝난다.
이 보존을 무효화하는 상위 임시 디렉터리 자동 삭제 wrapper로 감싸지 않는다.

#### 새 워크트리의 네이티브 바이너리가 Windows Application Control 에 막힌다

증상은 테스트 하네스 버그처럼 보인다. `npm ci` 직후 하트비트 스위트를 돌리면 18 개 중
11 개가 **파일 단위로** `tests/unit/X.test.ts:1:1` 에서 실패하는데, 각 파일 안의 개별
케이스는 전부 통과한 것으로 찍힌다. DB 를 건드리는 파일만 골라서 실패하므로 위의
프로세스 격리 이야기와 엮어 읽기 쉽다 — 그건 원인이 아니다.

실제 원인은 import 단계에서 죽는 것이다:

```
Error: An Application Control policy has blocked this file.
...\node_modules\better-sqlite3\prebuilds\win32-x64.node
    at getBinding (node_modules/better-sqlite3/lib/binding.js:30)
    at new Database (node_modules/better-sqlite3/lib/database.js:46)
    at <anonymous> (src/core/db.ts:29)
```

진단할 때 두 가지 함정이 있다.

- `require('better-sqlite3')` 는 이 오류를 내지 않는다. `getBinding` 은 `Database`
  생성자 안에서 돌기 때문에, 차단된 바이너리에서도 bare require 는 성공한다. 확인하려면
  반드시 `new Database(':memory:')` 까지 해야 한다.
- 한 체크아웃에 둔 프로브 스크립트를 다른 체크아웃의 cwd 에서 실행하면, Node 는 cwd 가
  아니라 **스크립트 위치** 기준으로 모듈을 찾는다. 세 체크아웃이 전부 같은 파일을 로드해
  똑같이 고장난 것처럼 보인다. 프로브는 체크아웃마다 절대 경로로 require 할 것.

차단은 내용이나 버전이 아니라 **경로** 기준이다. 같은 `better-sqlite3` 13.0.2 가 오래된
체크아웃에서는 로드되고, 그 바이너리를 새 워크트리로 바이트 단위 복사해도 여전히 거부된다.
`Unblock-File` 도 듣지 않는다 (Zone.Identifier 스트림이 애초에 없다).

우회는 허용된 경로를 제자리에 끼워 넣는 것이다. 추적 파일은 건드리지 않으며
`node_modules` 는 gitignore 대상이라 `npm ci` 로 원복된다:

```powershell
Rename-Item node_modules\better-sqlite3\prebuilds prebuilds.blocked-by-appcontrol
New-Item -ItemType Junction -Path node_modules\better-sqlite3\prebuilds -Target <허용된-체크아웃>\node_modules\better-sqlite3\prebuilds
```

패키지 디렉터리를 `Remove-Item -Recurse` 로 지우고 다시 만들려 하지 말 것. 관리형
워크트리 안의 경로라 가드가 막고, 애초에 삭제가 필요 없다.

### 실행 모드

| 모드 | 명령/엔트리 | 실제 동작 |
| --- | --- | --- |
| Source server dev | `npm run dev` | `tsx --env-file=.env server.ts`로 source server 실행 |
| CLI serve | `jaw serve` / `cli-jaw serve` | `bin/commands/serve.ts`가 source면 `tsx server.ts`, dist면 `node --dns-result-order=ipv4first server.js` spawn |
| CLI serve options | `--port`, `--host`, `--no-open`, `--lan`, `--remote`, `--trust-proxy`, `--trust-forwarded` | env로 `PORT`, `HOST`, `JAW_OPEN_BROWSER`, `JAW_LAN_MODE`, `JAW_REMOTE_ACCESS_MODE`, `JAW_TRUST_PROXY`, `JAW_TRUST_FORWARDED` 주입 |
| Frontend dev | `npm run dev:frontend` | Vite dev server port `5173`, `/api` proxy는 `http://localhost:3458` |
| Frontend build | `npm run build:frontend` | Vite가 `public/index.html` + `public/manager/index.html`을 `public/dist`로 빌드 |
| Manager dashboard | `jaw dashboard serve` | `src/manager/server.ts` 또는 `dist/src/manager/server.js` 실행, 기본 port `24576` |
| Electron manager dashboard | Electron implicit spawn | Web/CLI lane `24576`과 분리된 manager port `24577` 기본값, fallback `24578-24590`; packaged app prefers bundled sidecar `server/bin/jaw` |
| Docker npm image | `Dockerfile` | `npm install -g cli-jaw@${CLI_JAW_VERSION}` → `jaw serve --no-open` |
| Docker local source | `Dockerfile.dev` | local source copy → `npm run build` + `npm run build:frontend` → `node dist/server.js` |
| Compose | `docker-compose.yml` | 단일 `jaw` service, `${PORT:-3457}:3457`, `.env`, named volume `jaw-data` |

### Sidecar build and smoke ownership

`scripts/bundle-sidecar.sh <platform> <arch>` is a matching-host runtime-verified
build, not implicit cross-compilation or release. It validates target/lockfile
and output provenance before work, takes an exclusive `.server-build.lock`, and
uses a unique source/dependency snapshot plus staging tree. Root backend build
skips global-link lifecycle hooks but runs the existing compiled-asset checker
explicitly; locked dependencies, prune, native-load and no-JWC checks remain.
Original `dist` is not rebuilt in place. Relative contained source links retain
their text; external/absolute links and unrecognized output refuse adoption.

The smoke parent `scripts/check-sidecar-smoke.mjs` and child
`scripts/sidecar-smoke-probe.mjs` execute the artifact's Node against the three
fixed critical targets. The execution copy lives outside checkout dependency
ancestors so missing packages cannot borrow repository `node_modules`. Copied
module/binary identity, private IPC, actual primary listener and HTTP identity,
bounded errors/output and physical close are checked. Controlled metadata
commands retain a scrubbed environment; provider/credential probes are not
authentication evidence. A timeout, non-module exception, unexpected delegation
or uncertain cleanup is failure, not successful import.

Smoke reports are exclusive, outside the input artifact, and durable before
payload-home deletion; paired cleanup is separate. Default report directories
are intentionally retained evidence. The original artifact remains unchanged.
The bundler binds its runtime candidate through smoke and sealing, then promotes
only a completed, locally fingerprinted output. `.jaw-sidecar-build.json` is
local provenance/integrity metadata, not a cryptographic signature.

The smoke CLI exits `0` only for verified runtime success, `1` for a required
missing artifact or operational failure, `2` for invalid arguments, and `3` for
an optional absent default bundle (explicitly unverified). Sole help exits `0`
without probing. CI alone does not require a bundle; an explicit `--server-root`
or `JAW_GATE_REQUIRE_SIDECAR=1` does. The release wrapper may accept a skip as
policy success but retains its SKIPPED/nothing-imported detail.

Successful build snapshots/reports and actual previous-output backups remain
available for inspection. Interrupted/failed work retains staging/extraction/
lock when completion is uncertain; do not blindly remove a lock or signal old
numeric PIDs. Cleanup failure after promotion is not a rollback. Final Electron
QA must still test the builder-filtered `.app` resources and native UI; these
gates alone do not certify live providers or every platform.

### Isolated desktop QA

`CLI_JAW_ISOLATED_QA_ROOT` is an explicit controlled-launch profile, not a normal
user setting. Absence retains existing behavior; present-empty, malformed paths
or conflicting ports reject rather than falling back. The supervisor must create
canonical existing directories and scrub the environment **before** Node/CLI
probes, application imports or Electron starts. `src/shared/isolated-qa.ts` is
pure on import and owns validation/construction; it does not initialize stores.

| Fixed layout below canonical root R | Environment / role |
| --- | --- |
| `home`, `tmp` | `HOME`, `TMPDIR`; constructed `USERPROFILE=home`, `TEMP=tmp`, `TMP=tmp` (Node on Windows uses TEMP/TMP) |
| `xdg/config`, `xdg/cache`, `xdg/data`, `xdg/state` | Matching `XDG_*_HOME`; constructed `LOCALAPPDATA=xdg/cache`, `APPDATA=xdg/data` |
| `worker`, `manager`, `dashboard` | Worker `CLI_JAW_HOME=worker`; Manager/Electron `CLI_JAW_HOME=manager`; `CLI_JAW_DASHBOARD_HOME=dashboard` |
| `providers/codex`, `providers/claude`, `providers/pi` | `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` |
| `electron/userData`, `electron/sessionData`, `electron/logs`, `electron/crashDumps` | Electron path adapter, applied before lock/session creation |

All layout directories must exist inside R. Set distinct decimal ports W/M/P:
`DASHBOARD_SCAN_FROM=W`, `DASHBOARD_PORT=M`, `DASHBOARD_PREVIEW_FROM=P`,
`DASHBOARD_SCAN_COUNT=1`; worker also requires `PORT=W`. Electron requires the
exact explicit `http://127.0.0.1:M/` Manager URL. Conflicting/invalid CLI flags,
including earlier duplicate values, reject before default normalization.
Observed 2026-09-08 on a packaged 2.17.40 bundle: launching with the layout above but without `providers/*` directories and without `--manager-url` exits silently (stdout empty, no window) — the isolated launcher refuses before any logging. Create every row of the layout, including `providers/codex`, `providers/claude`, `providers/pi`, and pass `--manager-url http://127.0.0.1:M/` explicitly.

The child environment is a fresh allowlist, not an ambient overlay. Initial
supervisors remove inherited renderer tokens; only the app-generated IPC token
is deliberately forwarded along the Electron-to-Manager chain.

QA Electron suppresses protocol/login/shortcut/Automation/CLI-install actions,
including menu callbacks and repeated startup. Packaged startup uses the exact
sidecar Node/CLI, never shell PATH repair, global jaw or picker fallback.
Dashboard CLI preserves W/M/1/P at its Manager child. Manager rejects foreign
stored/custom/single scan ranges before fetch/cache/preview/service effects,
never enumerates peer dashboards, and refuses HTTP/direct lifecycle actions;
the supervisor owns process teardown. Existing normal-mode behavior remains.

This covers controlled entrypoints, not arbitrary CLI commands, raw imports,
shell/browser actions or malicious same-user filesystem replacement. Empty
task-owned messaging/jobs/MCP fixtures are prerequisites, not copied personal
settings. Import-time DB containment belongs to the supervisor. A built module,
mocked startup test or this profile alone does not certify the builder-filtered
packaged resources, actual native UI, provider authentication or OS-wide behavior.

### 환경변수

| 변수 | 실제 사용처 | 의미 |
| --- | --- | --- |
| `CLI_JAW_HOME` | `src/core/config.ts`, `bin/cli-jaw.ts`, `bin/postinstall.ts` | 데이터 홈 override. 기본 `~/.cli-jaw` |
| `PORT` | `server.ts`, `bin/commands/serve.ts`, CLI API commands | server port. 기본 `3457` |
| `HOST` | `bin/commands/serve.ts` | serve child env로 전달 |
| `JAW_OPEN_BROWSER` | `server.ts`, `serve.ts` | `serve` 실행 후 브라우저 open 여부 |
| `JAW_LAN_MODE` | `server.ts`, `serve.ts` | LAN host/origin bypass 활성화 |
| `JAW_REMOTE_ACCESS_MODE` | `serve.ts` | `--remote`에서 `direct`로 주입 |
| `JAW_TRUST_PROXY` | `server.ts`, `serve.ts` | Express trust proxy 설정 |
| `JAW_TRUST_FORWARDED` | `server.ts`, `serve.ts` | forwarded host/proto 신뢰 |
| `JAW_AUTH_TOKEN` | `server.ts`, `doctor.ts` | loopback 외 API bearer auth token |
| `JAW_BOSS_TOKEN` | `src/core/boss-auth.ts`, `bin/commands/dispatch.ts` | boss-only employee dispatch token |
| `JAW_EMPLOYEE_MODE` | `bin/commands/dispatch.ts` | employee 내부 dispatch 차단 |
| `TELEGRAM_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` | `src/core/config.ts` | Telegram settings override |
| `JAW_HUB_CALLBACK_URL` | `src/telegram/hub-callback.ts`, `src/manager/lifecycle.ts` | Telegram Hub member outbound callback override (loopback http only; manager spawn sets `http://127.0.0.1:${DASHBOARD_DEFAULT_PORT}`) |
| `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_IDS` | `src/core/config.ts` | Discord settings override |
| `DASHBOARD_PORT`, `DASHBOARD_SCAN_FROM`, `DASHBOARD_SCAN_COUNT`, `JAW_DASHBOARD_OPEN` | `bin/commands/dashboard.ts`, `src/manager/server.ts` | Manager dashboard 실행/scan 설정 |
| `LOG_LEVEL` | `src/core/logger.ts` | logger verbosity |
| `OFFICECLI_REPO` | `scripts/install-officecli.sh`, `scripts/install-officecli.ps1` | install 스크립트 소스 repo override (`lidge-jun/OfficeCLI` 기본) |
| `JAW_SAFE`, `npm_config_jaw_safe` | `bin/postinstall.ts` | postinstall safe mode |
| `CLI_JAW_MIGRATE_SHARED_PATHS`, `npm_config_jaw_migrate_shared_paths` | `bin/postinstall.ts` | shared path migration opt-in |
| `TEST_PORT` | `package.json` `test:smoke` | smoke test target port |

### Docker 설정

| 파일 | 실제 내용 |
| --- | --- |
| `Dockerfile` | `node:22-slim`, `python3 make g++ chromium curl`, non-root `jaw`, npm global `cli-jaw@${CLI_JAW_VERSION}` (`ARG CLI_JAW_VERSION=latest`), `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, entrypoint `jaw serve --no-open` |
| `Dockerfile.dev` | `node:22-slim`, local source copy, `npm ci --ignore-scripts` (better-sqlite3 13은 prebuild 동봉이라 rebuild 불필요), `npm run build && npm run build:frontend`, `node dist/bin/postinstall.js`, `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, entrypoint `node dist/server.js` |
| `docker-compose.yml` | `jaw` service, `build: .`, `container_name: cli-jaw`, `${PORT:-3457}:3457`, `env_file: .env`, `jaw-data:/home/jaw/.cli-jaw`, `restart: unless-stopped`, `/dev/shm` tmpfs 512m |

### `scripts/` 실제 파일

`atomic-build.sh`, `audit-fresh-install-evidence.mjs`, `bundle-sidecar.sh`, `capture-agy-quota-fixture.mjs`, `check-app-icon-assets.cjs`, `check-cli-bin-links.cjs`, `check-copilot-gap.ts`, `check-deps-offline.ts`, `check-deps-online.sh`, `check-electron-no-native.cjs`, `check-electron-sidecar-no-jwc.cjs`, `check-redaction-sinks.mjs`, `check-sidecar-prune-safety.mjs`, `check-strict-baseline.mjs`, `check-web-ui-build-output.ts`, `claim-audit.mjs`, `collect-fresh-install-evidence.sh`, `electron-dev-manager.mjs`, `ensure-native-modules.cjs`, `fresh-install-smoke.ts`, `i18n-registry.ts`, `install-officecli.ps1`, `install-officecli.sh`, `install-risk-gate.mjs`, `install-wsl.sh`, `install.sh`, `retired-runtime-package-smoke.mjs`, `link-current-nvm-bin.cjs`, `pi-rpc-probe.mts`, `postinstall-guard.cjs`, `prepare-sidecar-package-json.cjs`, `release-1.6.0.sh`, `release-gates.mjs`, `release-preview.sh`, `promote-to-main.sh`, `pick-gyp-python.sh`, `require-release-evidence.mjs`, `signal-dashboard-restart.mjs`, `sync-electron-version.cjs`, `verify-fresh-install.sh`, `verify-release-evidence.mjs`, `ci/aggregate-check.sh`, `ci/windows-unit-manifest.mjs`, `ci/windows-unit-manifest.txt`, `smoke/opencode-external-dir-smoke.ts`, `smoke/tui-frame-resize-stress.ts`, `smoke/tui-fullscreen-frame-smoke.ts`, `smoke/tui-ws-sequence-stress.ts`.

---

## 릴리스 파이프라인과 부분 실패 복구 (preview → main → npm)

Canonical release path is `feature → preview → main`, then an npm publish
dispatched onto `main`. `dev` is the contributor integration base and is **not**
part of the release path — nothing publishes from `dev`.

Every command below is quoted from the file and line noted beside it. Read the
source before improvising; a wrong command during a broken release is worse
than no command.

### 정상 경로 (normal flow)

| 단계 | 실행 | 검증되는 SHA |
| --- | --- | --- |
| 1. preview 릴리스 | `bash scripts/release-preview.sh [--major\|--minor\|--patch\|<X.Y.Z>]` | the `origin/preview` head just pushed, re-read with `git ls-remote` and compared before dispatch (`scripts/release-preview.sh:356-362`) |
| 2. 인증 (certification) | `.github/workflows/test.yml` push run on `preview` | the same preview SHA; promotion refuses to start without a successful run for it (`scripts/promote-to-main.sh:28-38`) |
| 3. 승격 (promotion) | `bash scripts/promote-to-main.sh [<preview-sha>]` | the live `origin/preview` head; an explicit argument must equal it (`scripts/promote-to-main.sh:13-18`) |
| 4. stable publish | `.github/workflows/publish.yml`, `workflow_dispatch` only (`publish.yml:3-4`) | `expected-sha` must equal the checked-out `GITHUB_SHA` (`publish.yml:54-65`) |

**1 — preview.** `release-preview.sh` bumps `package.json` to
`X.Y.Z-preview.TIMESTAMP` (`:131`), syncs the Electron version (`:167`), runs
`npm run gate:all` (`:181`), commits (`:200`), pushes to `origin/preview`
(`:204-209`), then dispatches:

```bash
gh workflow run publish.yml --ref preview \
  -f version="$VERSION" -f tag=preview -f expected-sha="$RELEASE_SHA" -f dry-run=false
```

(`scripts/release-preview.sh:365-366`.) Note it does **not** pass
`create-github-release`, so that input defaults to `false` (`publish.yml:27-31`);
the GitHub *pre*release is created by the script itself (`:242-256`), not by the
workflow.

**2 — certification.** Nothing is promoted that does not already have a green
`test.yml` push run on `preview` for that exact commit.

**3 — promotion.** `promote-to-main.sh` requires `origin/main` to be an ancestor
of the certified preview SHA, builds a throwaway worktree at that SHA, runs
`npm version <stable>`, `sync-electron-version`, `npm run gate:all` and
`require-release-evidence.mjs`, and commits `chore: promote vX.Y.Z` **on top of
preview**. It then fast-forwards `preview` to that commit, waits for `test.yml`
(and `postinstall-platform.yml` when installer-sensitive files changed) to go
green **on that exact SHA**, re-checks that live `preview` still equals it, and
fast-forwards `main` to the same commit with a plain non-force push.

The wait is not a wall clock over execution. `wait_for_run` spends its 1200s
budget only while no run for the SHA has appeared; once one is queued or running
it is followed for its own lifetime, because the `windows-wsl` job alone may take
25 minutes and the old fixed budget was shorter than that. A failed or cancelled
conclusion is terminal only when no live run remains for the SHA: both workflows
set `cancel-in-progress`, so a superseded run leaves a cancelled row beside its
replacement. The platform lookup carries no `--event` filter, matching
`publish.yml` and `require-release-evidence.mjs`, which resolve it by commit; the
Tests lookup stays push-only because `publish.yml` accepts nothing else.

Because the script writes to the remote before it is finished, it can be
interrupted with `preview` already carrying the stable bump and `main` behind.
`scripts/promotion-state.mjs` classifies that state (`prerelease`, `resume`,
`already_on_main`, `refuse`) and a re-run resumes: it takes the commit `preview`
already holds and skips both the version bump and the preview push, so a tree CI
has certified is never replaced by a same-version copy. `resume` requires the
full fingerprint — `main` an ancestor, the parent the matching prerelease, the
subject `chore: promote vX.Y.Z`, and a diff touching only the four version
manifests — and anything else is refused rather than guessed at.

There is no PR and no squash (#480). `main` and `preview` end up on the SAME
commit, which is why the ancestry guard keeps holding on the next cycle.

**4 — publish.** Only after all of that:

```bash
gh workflow run publish.yml \
  --ref main \
  -f version="$STABLE_VERSION" \
  -f tag=latest \
  -f expected-sha="$MERGED_MAIN_SHA" \
  -f dry-run=false \
  -f create-github-release=true
```

(`scripts/promote-to-main.sh:175-181`.)

Because `create-github-release=true`, the stable GitHub release is created by the
workflow rather than by an operator. That difference decides how desktop builds
start, and the two channels are NOT symmetric:

| 채널 | 릴리스를 만드는 주체 | `desktop-release.yml` 시작 방법 |
| --- | --- | --- |
| preview | `release-preview.sh` (운영자 토큰) | `release: published` 이벤트로 자동 |
| stable | `publish.yml` (기본 `GITHUB_TOKEN`) | `publish.yml`이 `gh workflow run`으로 명시 dispatch |

A release created with the default `GITHUB_TOKEN` emits no `release: published`
event — GitHub suppresses it so a workflow cannot trigger itself. `workflow_dispatch`
is a documented exception, so `publish.yml` starts the desktop build explicitly
with `actions: write` and `-f release-tag=vX.Y.Z`. Before that step existed,
`v2.17.57` and `v2.17.58` both published to npm with an **empty** GitHub release
and needed a manual dispatch. The dispatch is limited to `tag == 'latest'`; adding
it to preview as well would build every preview twice.

#### 승격된 SHA는 인증된 SHA와 문자 그대로 같다

The commit published to npm is the SAME commit CI certified — not a copy of its
tree. That is the point of the #480 ff promotion: the version bump is committed
on top of preview, preview is fast-forwarded to it, that exact SHA is certified,
and `main` is fast-forwarded to the same object.

This section previously described a PR + squash promotion in which `main` got a
NEW SHA sharing only the tree. That implementation is gone; if you are reading
recovery advice that assumes a differing SHA, it predates #480.

### ⚠️ 승격 성공 후에는 스크립트를 다시 돌릴 수 없다

`promote-to-main.sh` dispatches `publish.yml` at `:167-173`, prints one line at
`:175`, and **exits without ever checking whether the publish run succeeded**.
That is the single most important property of this pipeline: a green script exit
means *the publish was requested*, never *the publish happened*.

And the script cannot simply be re-run. Under the ff design the rejection comes
from the preview-version check near the top: after a successful promotion the
live `preview` head carries the STABLE version, which does not match the
required `X.Y.Z-preview.TIMESTAMP` shape, so the script refuses before it
reaches the ancestry guard. **Every recovery below is therefore manual.**

### 복구 1 — git은 성공, npm은 실패

Symptom: `main` carries the stable version, `npm view cli-jaw@<version>` finds
nothing, and there is no `v<version>` GitHub release.

Re-dispatch `publish.yml` by hand with the same inputs the script would have
used. The correct `expected-sha` is the **merged `main` head**, read the same way
the script reads it (`scripts/promote-to-main.sh:86`):

```bash
git fetch origin main
MERGED_MAIN_SHA="$(git ls-remote origin refs/heads/main | cut -f1)"
STABLE_VERSION="$(git show "$MERGED_MAIN_SHA:package.json" \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')"

gh workflow run publish.yml \
  --ref main \
  -f version="$STABLE_VERSION" \
  -f tag=latest \
  -f expected-sha="$MERGED_MAIN_SHA" \
  -f dry-run=false \
  -f create-github-release=true
```

All five inputs are the full set declared at `publish.yml:5-31`; `version`,
`tag` and `expected-sha` are `required: true`, `dry-run` defaults to `true` and
`create-github-release` defaults to `false`, so both must be passed explicitly
for a real release.

The workflow re-checks, and will refuse if any of these no longer hold:

- `expected-sha` equals the checked-out `GITHUB_SHA` (`publish.yml:54-65`) — so
  if `main` moved after the audit, the dispatch fails instead of publishing a
  different tree.
- a successful `test.yml` push run exists for that commit **on `preview` or
  `main`** (`publish.yml:67-84`). The branch filter matters because `test.yml`
  also runs on `dev` pushes (#521) and every cycle fast-forwards `dev` onto the
  preview head, so one SHA carries runs from both branches; the lookup scans the
  run list rather than the newest single run, or a newer `dev` run would be
  selected and then discarded, falsely blocking a certified release.
- `postinstall-platform.yml` is green for that commit when the installer surface
  changed since the previous stable tag (`publish.yml:80-120`).
- `package.json` version equals `version` (`publish.yml:179-182`).
- a real `latest` publish runs from `main` (`publish.yml:184-193`) and the
  version is not a prerelease (`publish.yml:230-237`).

Re-dispatching is safe when the version is already on npm: the run detects it
and skips the publish rather than failing (`publish.yml:307-332`).

### 복구 2 — npm은 게시됨, GitHub 릴리스가 없거나 잘못됨

**Re-dispatch `publish.yml` — that is the supported repair.** `Create GitHub
release` is gated only on `skip-publish`, `dry-run` and `create-github-release`;
the `registry.exists` gate that once blocked backfill was removed in
`20fa16232`. The step is create-or-edit (`gh release view` then `edit`/`create`),
so a re-dispatch fixes a missing or wrong release for a version that is already
on npm. The publish itself is skipped because `registry.exists` is `true`.

`Registry smoke` runs AFTER release creation and the desktop dispatch, so a slow
registry can no longer skip them. It used to run before both, and a publish whose
version stayed invisible past the 15-minute window failed the job there — leaving
a published npm version with no GitHub release at all.

A stable re-dispatch also re-dispatches `desktop-release.yml`; asset upload uses
`gh release upload --clobber`, so repeating it is safe.

Backfill by hand only if the workflow itself cannot run:

```bash
# stable (latest)
gh release create "v<version>" --target "<merged-main-sha>" \
  --title "v<version>" --latest --notes-file <notes-file>

# if a wrong release already exists, edit instead of create
gh release edit "v<version>" --target "<merged-main-sha>" \
  --title "v<version>" --latest --notes-file <notes-file>
```

For a preview release the workflow uses `--prerelease` and the title
`v<version> (preview)` instead of `--latest` (`publish.yml:397-405`).

### 복구 3 — 잘못된 버전이 npm `latest`에 도달함

This is the real rollback case.

**`npm unpublish` is not the normal remedy.** npm only permits unpublishing
within a limited window after publish (documented as 72 hours), it breaks every
consumer that already resolved the version, and **the version number can never
be reused** — a republish of the same `X.Y.Z` will be rejected forever. Treat it
as a last resort for a genuine secret leak or legal problem, not for a bad
build. *(npm's unpublish policy is registry-side and has changed over time;
confirm the current rules against npm's own documentation before relying on the
72-hour figure. Additional restrictions apply when other packages depend on the
version.)*

**The normal remedy is to move the dist-tag back, then ship forward.**

```bash
npm dist-tag ls cli-jaw
npm dist-tag add cli-jaw@<last-good-version> latest
```

(`npm dist-tag ls cli-jaw` is the same read the publish run does at
`publish.yml:341`; `release-preview.sh:83` reads the moved tag back via
`npm view cli-jaw dist-tags.latest`, so the next preview bump computes off the
restored version.)

What moving the tag **does** fix: `npm install -g cli-jaw`,
`npm install -g cli-jaw@latest`, and new `Dockerfile` builds — which default to
`ARG CLI_JAW_VERSION=latest` — resolve to the last good version again.

What it **does not** fix:

- `npm install cli-jaw@<bad-version>` still resolves. The tarball stays on the
  registry; only the pointer moved.
- users who already installed the bad version are not downgraded.
- lockfiles that pinned the bad version keep resolving to it.
- already-built Docker images keep the bad version baked in.
- the `main` commit and the GitHub release are untouched.

So also move the GitHub "Latest" pointer back, using the same flag the workflow
uses (`publish.yml:402`, `:407`):

```bash
gh release edit "v<last-good-version>" --latest
```

The `preview` channel has the exact same shape:

```bash
npm dist-tag add cli-jaw@<last-good-preview-version> preview
```

Then ship a forward patch through the normal path — a new
`release-preview.sh` run, certification, and `promote-to-main.sh`. The dist-tag
move buys time; only a new version actually fixes users.

### 복구 4 — 검증 실패한 커밋이 `main`에 도달함

Much less reachable since #480. The promotion certifies the exact SHA **on
`preview`, before `main` moves**: it waits for `test.yml` (and
`postinstall-platform.yml` when installer-sensitive files changed) on the
promotion commit, re-checks that live `preview` still equals it, and only then
fast-forwards `main` to that same object. There is no PR and no post-merge
certification window.

`main` still has **no ruleset and no branch protection** (`gh api
repos/lidge-jun/cli-jaw/rulesets` returns `[]`), so nothing stops a human from
pushing to it by hand — that, not the promotion path, is how a bad commit
reaches `main` now. Repo-admin rights to install a ruleset are tracked in #333.

Revert path:

1. Determine the shape of the offending commit first. A promotion commit is
   single-parent by construction, but a hand-pushed one may not be:

   ```bash
   git fetch origin main
   git log --graph --oneline origin/main -5
   ```

2. Revert on a branch, never by pushing to `main` directly:

   ```bash
   git checkout -b revert/<version> origin/main
   git revert <sha>            # single-parent (squash) commit
   git revert -m 1 <sha>       # two-parent merge commit — mainline is parent 1
   git push -u origin revert/<version>
   gh pr create --base main --title "revert: <version>"
   ```

3. If the bad commit already reached npm `latest`, the revert alone changes
   nothing for users — do 복구 3 as well.

4. Do not try to re-promote the same `preview` head afterwards. Its version is
   now stable-shaped, so the preview-version check rejects it before any other
   gate runs. Cut a fresh preview instead.

### 하지 말 것

- Do not push directly to `main` or `preview`.
- Do not hand-edit a published npm tarball; publish a new version.
- Do not re-run `promote-to-main.sh` to "retry" a failed publish — see the
  preview-version check above; re-dispatch `publish.yml` instead (복구 1).
- Do not treat a green script exit as a completed publish. Both release scripts
  DISPATCH `publish.yml` and return without waiting for it, so a host can
  reinstall the OLD `latest` while every command in the sequence looked fine.
  Verify `status=completed`, `conclusion=success`, the exact `headSha`, and the
  registry version before deploying anything.
- Do not dispatch `publish.yml` with a stale `expected-sha`; it is the only
  thing standing between a moved branch and a mismatched publish.

---

## 시작 경로 안정성 계약 (start-path reliability)

`jaw <command>` 실행 시 네이티브 의존성 준비를 담당하는 표면.

### 실행 경로

```
jaw (전역 bin 심링크) → dist/bin/cli-jaw.js
                          └─ ensureNativeModulesReady(cmd)   [bin/cli-jaw.ts]
                               └─ 자식 프로세스: scripts/ensure-native-modules.cjs
bin/jaw (개발 클론 / 직접 호출 런처)
     └─ argv 기반 probe → 실패 시 위 스크립트에 위임
```

전역 설치 사용자는 `bin/jaw`를 거치지 않는다. `--help`/`--version` 등은 가드를 건너뛴다.

### `scripts/ensure-native-modules.cjs` 계약

| 항목 | 계약 |
| --- | --- |
| 실패 분류 | `missing` (해석 불가 **또는** 로드 시 `MODULE_NOT_FOUND`) / `abi` (dlopen·NODE_MODULE_VERSION) / `other` — `classifyNativeError()`로 export |
| 해석 검사 | `createRequire(root/package.json).resolve()`. `node_modules` 디렉터리 존재 여부로 판정하지 않음 (PnP 등) |
| `missing` 행동 | rebuild 금지. `npm install` 안내 + exit 1 |
| `abi` 행동 | 잠금 획득 → 재probe → 1회 rebuild → 재probe |
| `other` 행동 | rebuild 금지. Node 버전/ABI/platform/arch 출력 후 exit 1 |
| 잠금 위치 | `tmpdir()/jaw-native-rebuild-<sha256(realpath(root)).16>.lock` — **`node_modules` 밖** (npm install이 지울 수 있으므로) |
| 잠금 획득 | `mkdirSync({recursive:false})` 원자성. 최대 5분 대기 |
| 잠금 회수 | 소유자 PID를 `process.kill(pid, 0)`로 probe. `ESRCH`=회수, `EPERM`=살아있음. 시간(`LOCK_STALE_MS`)은 PID를 못 읽을 때만 쓰는 backstop |
| ABI 판정 범위 | 의도적으로 **넓게** 유지 (기존 자동복구 퇴행 방지). 좁힌 것은 `missing`뿐 |

현재 설치본 better-sqlite3 **12.8.0**은 `install` 훅(`prebuild-install || node-gyp rebuild --release`)이 있어
`npm rebuild`가 복구 경로다 (로컬 `node_modules`에서 확인). 상위 메이저에서 번들 prebuilds로 전환되며
훅이 사라진다는 보고가 있으므로 — 로컬에서 검증 불가 — **업그레이드 시 이 가정을 반드시 재확인할 것.**

### `bin/jaw` 런처 규칙

- 경로를 **JavaScript 소스로 보간하지 않는다** — argv로 전달 (공백·아포스트로피·유니코드 안전)
- `readlink -f`를 요구하지 않는다 (GNU 확장; stock macOS/BSD에 없음) — `realpath` → Node `fs.realpathSync`
- 복구 분기의 `cd`는 서브셸에 가둔다 — `exec`되는 CLI가 호출자의 cwd를 유지해야 함
- 복구 실패 시 `exec`하지 않는다 — 종료코드 검사 후 진단과 함께 exit

### 프로세스 종료 계약 (`src/agent/spawn/process-kill.ts`)

지연 SIGKILL 승격은 반드시 `killProcessTreeIfAlive()`를 거친다. 판정 기준은
`exitCode !== null || signalCode !== null`이며 **`ChildProcess.killed`가 아니다** —
`killed`는 "시그널을 보냈다"는 뜻이라 아직 실행 중인 프로세스도 `true`가 된다.
가드 없이 승격하면 SIGTERM 후 재사용된 PID를 죽일 수 있고, `killProcessTree`가
`pgrep -P`로 재귀하므로 무관한 프로세스의 하위 트리까지 함께 죽는다.

### 회귀 가드 테스트

`tests/unit/cli-native-guard-contract.test.ts`, `launcher-portability.test.ts`,
`native-repair-lock.test.ts`, `kill-escalation-liveness.test.ts`.
마지막 파일에는 가드 없는 지연 SIGKILL이 새로 추가되면 실패하는 스윕 테스트가 있다.

---

## 런타임 수명주기 계약 (openclaw/hermes 파리티)

### 턴 종료 — `close`이지 `exit`이 아니다

턴은 `child.on('close')`에서 resolve된다. `close`는 자식 종료가 아니라 **stdio 스트림이
전부 닫혀야** 발생하므로, stdio를 상속한 자손이 살아있으면 오지 않는다.
`src/agent/spawn/exit-drain.ts`의 `releaseChildOutputAfterExit()`가 이 대기를 경계 짓는다:

| 상수 | 값 | 역할 |
|------|-----|------|
| `EXIT_DRAIN_IDLE_MS` | 100ms | 마지막 데이터 이후 유휴 유예. 새 데이터가 오면 **재무장** |
| `EXIT_DRAIN_MAX_MS` | 1000ms | 절대 상한 |

idle 만료 시 `setImmediate`로 이벤트 루프 poll 턴을 **한 번 양보**한 뒤 destroy한다 —
부하 걸린 루프는 이미 버퍼에 있는 데이터보다 타이머를 먼저 관측할 수 있기 때문이다.
모든 타이머는 `unref()`되고, `close`/`error` 양쪽 경로에서 정리 함수를 호출한다.

**주의:** 워치독은 이 상황을 구제하지 못한다. 자식은 이미 죽었고, PID 재사용 가드가
(올바르게) kill을 건너뛴다. 파이프 destroy만이 유일한 해소 수단이다.

### 출력 누적 상한 — 원시 stdout에만 필요하다

| 대상 | 상한 | 이유 |
|------|------|------|
| 미완 NDJSON 라인 (`spawn/line-buffer.ts`) | 8 MiB (pending cap = frame cap) | 개행 없는 스트림이 라인 버퍼를 무한히 키운다. 실측 200 MiB 입력 → 힙 1.5 GiB |
| agy/kiro `fullText` | 8 MiB / `maxBytes` | **원시 plain-text stdout**을 직접 축적 |
| 파싱된 assistant 이벤트 경로 | 없음 (의도적) | 상류가 유한. 과거 상한이 실제 최종 답변을 잘라먹은 사고(`8b4ce983b`) |
| `stderr` | 4000자 (스트리밍 append 전부) | 진단 전용 |

절단은 항상 **보고**한다. 조용한 절단은 금지다.

NDJSON 프레이머(`spawn/line-buffer.ts`)의 두 상한은 구분된다: **pending cap**은
진행 중인 프레임의 메모리 상한이고, **frame cap**은 완성 프레임의 수락·거절 기준이다.
둘은 같은 값(8 MiB)을 공유하므로 수락 여부가 chunk 분할에 따라 달라지지 않는다 —
상한을 넘는 프레임은 한 chunk로 도착하든 여러 chunk로 나뉘든 항상 폐기된다.
폐기된 프레임은 경계가 되는 LF까지 drain되며 잘린 head에 suffix를 붙여 다른
payload로 전달하지 않는다(#784). print 경로(`spawn.ts`)의 drop은 `ndjson_overflow` trace 이벤트와 경고로
보고되고(bounded head sample + 총 길이), 그 LF 이후의 정상 프레임은 오염되지 않는다.
Pi RPC 경로는 경고만 남기고, 프롬프트 진행 중의 drop은 그 턴을 즉시 `error`로 끝낸다
(풀 세션은 poison되어 재사용되지 않는다).

### 진행(progress) 판정

워치독은 진행 신호에 종류를 부여한다: `output`(원시 출력, 약한 신호) / `rate-limit` / `structured`.
stall 사유에 `lastProgress=<kind>`를 남기므로, `lastProgress=output x47`은
**턴이 전진했다는 증거 없이 출력만 흘렀다**는 뜻이다.

deadline 계산은 종류와 무관하다 — `markProgress()`는 어떤 kind로 호출되든 동일하게
`absoluteDeadline`을 갱신하며, `absoluteHardCapMs`(4시간)가 상한이다. 즉 종류 태깅은
**진단 전용**이고 타임아웃 동작을 바꾸지 않는다.

휴리스틱(`text.trim().length > 10`)을 좁히지 않은 이유는 주요 엔진(agy·kiro·grok)이
각자 raw chunk 또는 파싱 이벤트 경로에서 `markProgress`를 직접 호출하기 때문이다.
`watchdog.ts`만 좁혀도 그 엔진들의 liveness는 그대로다.

### 재시도 — 부작용 게이트

프롬프트를 재실행하는 **세 경로**(main 429 / employee transient / **fallback**)는
모두 `performedSideEffects(ctx)`를 확인한다.

```ts
const REPEATABLE_TOOL_TYPES = new Set(['search', 'thinking']);
// search = grep/web-search/read-url, thinking = 추론 스트림
// command/file/subagent + 미지의 타입 = 부작용 (fail closed)
```

재시도는 같은 프롬프트를 다시 돌리므로 이전 시도가 실행한 도구가 **다시 실행**된다.
`_skipInsert`는 로컬 DB 행만 막고 외부 전송·커밋·파일 쓰기는 막지 못한다.
거부된 재시도는 이유를 로그로 남긴다.

`isTransientStartup`은 **출력이 없을 때만** 인정된다 — 이름이 약속하는 "작업 시작 전"을
구현이 보장하게 했다.

### 회귀 가드 테스트

`exit-drain.test.ts`, `line-buffer-bound.test.ts`, `raw-stdout-capture-bound.test.ts`,
`progress-semantics.test.ts`, `retry-side-effect-gate.test.ts`, `retry-stall-ordering.test.ts`.

---


### session-generation.ts / access-policy.ts / remote-command-context.ts (M4-A0)

M4-A2a adds opaque `issueApprovalCallback` / `resolveApprovalCallback` on the in-memory `DispatchApprovalStore`. Telegram operator DMs attach Approve/Deny buttons (`appr:`/`aprd:` opaque ids). Discord operator DMs attach Approve/Deny buttons (same `appr:`/`aprd:` ids). Slack operator DMs attach Approve/Deny Block Kit buttons (same `appr:`/`aprd:` ids). Generic Slack `keyboard` send stays unsupported (`interactiveActions: false`). HTTP still has no approve endpoint. Store `generation` is the process boot UUID (`restart_void`); callback `sessionGeneration` is `chat_sessions.generation`.

`src/core/session-generation.ts` owns persistent `chat_sessions.generation` (additive PRAGMA/ALTER). This integer is not `src/agent/session-persistence.ts` process-local spawn ownership. `replaceRemoteSessionGeneration` rebinds one conversation onto one session in a single transaction because `remote_session_bindings.chat_session_id` is UNIQUE. `src/messaging/access-policy.ts` is default-deny substrate (`deny` / `allowlist` / `paired` / `all`) with no production caller until M4-A1. `src/messaging/remote-command-context.ts` names `{channel, actorId, conversationKey, chatSessionId, generation}` so the three transports cannot invent three shapes.

## src/core/ — runtime support cluster (30 files, 3803L)

`boss-auth.ts`, `config.ts`, `codex-config.ts`, `instance.ts`, `runtime-path.ts`, `main-session.ts`, `message-summary.ts`, `path-expand.ts`, `runtime-settings.ts`, `runtime-settings-gate.ts`, `settings-merge.ts`, `db.ts`, `db-maintenance.ts`, `bus.ts`, `employees.ts`, `i18n.ts`, `compact.ts`, `logger.ts`, `claude-install.ts`, `launchd-cleanup.ts`, `launchd-plist.ts`, `tcc.ts`.

| Module | 역할 |
| --- | --- |
| `config.ts` | 경로/설정/CLI 탐지 + `JAW_HOME`/`settings.json`/`skills_ref`/`messaging`/`network` defaults |
| `codex-config.ts` | Codex `config.toml` context window sync |
| `instance.ts` | launchd/systemd용 instance ID + node/jaw binary resolution |
| `runtime-path.ts` | 서비스/launchd 환경에서 PATH 정규화 (`~/.local/bin`, `~/.claude/local/bin`, nvm/fnm/asdf/bun/homebrew 포함) |
| `main-session.ts` | active_cli/session_id/model/working_dir/effort sync + reset helpers |
| `message-summary.ts` | message preview/summary helper |
| `path-expand.ts` | shell-style path expansion helper |
| `runtime-settings.ts` | `applyRuntimeSettingsPatch()` 진입점, workingDir 재생성, messaging restart |
| `runtime-settings-gate.ts` | settings mutation in-flight gate |
| `settings-merge.ts` | nested settings deep merge (`telegram`, `discord`, `messaging`, `memory`, `stt`, `tui`, `network`) |
| `db.ts` | SQLite schema/prepared statements + one-time batched tool_log migration |
| `db-maintenance.ts` | schema_migrations marker, page/freelist stats, explicit checkpoint+VACUUM |
| `bus.ts` | broadcast hub + named listener lifecycle |
| `employees.ts` | default employee seeding + static/virtual synthetic employee helpers + regenerate |
| `i18n.ts` | locale normalize + `t()` |
| `compact.ts` | compact marker / transcript helpers |
| `logger.ts` | minimal console logger shim |
| `boss-auth.ts` | boss/employee scope 분리용 auth helper |
| `claude-install.ts` | Claude CLI 설치 상태 점검 helper |
| `launchd-cleanup.ts` | launchd stale plist / runtime cleanup |
| `launchd-plist.ts` | launchd plist 생성 helper |
| `tcc.ts` | macOS TCC / screen-recording 권한 점검 |

---

## src/core/platform-kind.ts — 플랫폼 분류 단일 소스

`windows-native | wsl | linux | darwin | other` 를 판정하는 유일한 기준점.
플랫폼을 다시 유추하는 코드를 새로 만들지 말고 이 모듈을 호출한다.

### 엄격 규칙

`process.platform` 이 먼저다. `win32` 프로세스는 어떤 환경변수가 들어와도
`windows-native` 이고, WSL 분기는 `linux` 에서만 도달할 수 있다. 두 값은
구조적으로 겹치지 않는다.

**`WSLENV` 은 판정에 쓰지 않는다.** Microsoft 문서상 이 변수는 Windows 쪽과
공유되는 값이라 WSL 안에 있다는 증거가 못 된다. 실제로 doctor 와 postinstall
이 이 변수를 검사하는 바람에, WSL interop 을 설정해 둔 네이티브 Windows
사용자에게 "WSL 안에서 Windows Node 를 쓰고 있다"는 경고가 나갔다.

### API

| 함수 | 역할 |
| --- | --- |
| `resolvePlatformKind(platform, env, probes)` | 플랫폼 분류. 모든 입력이 주입 가능하므로 한 OS 에서 전체 매트릭스를 테스트할 수 있다 |
| `isWindowsNative(platform)` | `platform === 'win32'`. env 를 받지 않는 것이 의도다 |
| `isWsl(platform, env, probes)` | WSL 여부 |
| `isWindowsNodeLaunchedFromWsl(platform, cwd)` | WSL 디렉터리에서 실행된 Windows Node. 환경변수가 아니라 UNC 작업 디렉터리(`\\wsl$\`, `\\wsl.localhost\`)로 판정한다 |
| `resolveInvocationCwd(env)` | `INIT_CWD` 우선. npm lifecycle script 는 패키지 루트에서 돌기 때문에 `process.cwd()` 로는 사용자의 디렉터리를 알 수 없다 |

WSL 증거는 `WSL_DISTRO_NAME`, `WSL_INTEROP`, `/run/WSL`,
`/proc/sys/fs/binfmt_misc/WSLInterop`, 그리고 `osrelease`/`/proc/version` 의
`microsoft` 문자열이다. 마지막 항목은 커스텀 커널에서 빠질 수 있어 경로 마커가
백업 역할을 한다.

### 위임 사이트 (4곳)

`src/core/browser-open.ts`, `src/core/browser-open-default.ts`,
`src/browser/connection.ts`, `bin/commands/doctor.ts` 가 모두 이 모듈로
위임한다. `tests/unit/platform-kind-delegation.test.ts` 가 이 네 파일에
`WSL_DISTRO_NAME`/`WSL_INTEROP`/`WSLENV` 나 `/proc/version` 직접 참조가 없는지
검사한다.

`bin/postinstall.ts` 는 위임 사이트가 아니다. "이 Windows 프로세스가 WSL
디렉터리에서 시작됐는가"라는 다른 질문을 하므로 `isWindowsNodeLaunchedFromWsl`
을 쓴다.

`src/lib/tui/terminal.ts` 는 의도적으로 제외했다. 루트 `tsconfig.json` 이
`src/lib/tui` 를 제외하고 있고 그 파일의 `$env` 는 객체가 아니라 함수라서,
타입 검사도 되지 않는 vendored 번들을 굳이 통과시킬 이유가 없다.

브라우저 헬퍼들은 `probes` 파라미터를 받는다. 이게 없으면 desktop-linux
픽스처가 실제 호스트의 `/proc` 를 읽어서 WSL 러너에서 결과가 뒤집힌다.

### Windows serve 로깅

`jaw serve` 는 상속받은 stdout/stderr 출력을 그대로 유지하면서 두 스트림을
`<JAW_HOME>\logs\serve.log` 에 append 한다. 서버 시작 시 파일이 5 MiB 이상이면
기존 `serve.log.1` 을 교체하고 현재 파일을 그 이름으로 한 단계 rotate 한다.

PowerShell `Start-Process -RedirectStandardOutput/-RedirectStandardError` 는 대상
파일을 시작마다 생성하거나 truncate한다. 따라서 이 옵션을 instance-owned
`serve.log` 에 연결하지 않는다. 별도 운영자 로그가 필요하면 child PowerShell의
append redirection을 사용한다.

```powershell
$jawHome = 'C:\jaw\worker-a'
$logDir = Join-Path $jawHome 'logs'
$outLog = Join-Path $logDir 'serve.out.log'
$errLog = Join-Path $logDir 'serve.err.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$jaw = (Get-Command jaw.cmd -ErrorAction Stop).Source
$command = "& '$jaw' --home '$jawHome' serve --no-open 1>> '$outLog' 2>> '$errLog'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
Start-Process powershell.exe -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden
```

---

## src/cli/registry.ts — CLI/모델 단일 소스 (231L)

**의존 없음** — `core/config.ts`, `cli/commands.ts`, `server.ts`, 프론트엔드가 모두 이 레지스트리를 참조.

| Export | 역할 |
| --- | --- |
| `CLI_REGISTRY` | 10개 CLI 정의 (`pi`, `agy`, `claude`, `codex`, `codex-app`, `cursor`, `grok`, `kiro-code`, `opencode`, `copilot`; 나머지는 동일) |
| `CLI_KEYS` | `Object.keys(CLI_REGISTRY)` — 순서 보장 배열 |
| `DEFAULT_CLI` | 기본 CLI (`claude` 우선, 없으면 첫 항목) |
| `buildDefaultPerCli()` | registry에서 기본 `perCli` 객체 빌드 |
| `buildModelChoicesByCli()` | CLI별 모델 목록 맵 빌드 |

---

## src/cli/api-auth.ts — CLI Auth Helper (45L)

CLI → 서버 API 호출 시 인증 토큰을 관리하는 경량 헬퍼. 포트별 토큰 캐싱으로 멀티 인스턴스를 지원한다.

| Function | 역할 |
| --- | --- |
| `getCliAuthToken(portOrBase?)` | `settings.json`에서 `authToken` 읽기. 포트별 캐시 |
| `authHeaders(extra?)` | `{ Authorization: 'Bearer <token>', ...extra }` 헤더 생성 |
| `cliFetch(url, init?)` | `fetch()` + 자동 auth header 주입 래퍼 |

사용처: `dispatch.ts`, `orchestrate.ts`, `reset.ts`, `employee.ts`, `memory.ts`, `browser.ts`, `tui/api.ts`

---

## src/core/config.ts — 경로, 설정, CLI 탐지 (528L)

**상수**: `JAW_HOME` (`CLI_JAW_HOME` env || `~/.cli-jaw`) · `PROMPTS_DIR` · `DB_PATH` · `SETTINGS_PATH` · `HEARTBEAT_JOBS_PATH` (`heartbeat.json`) · `UPLOADS_DIR` · `SKILLS_DIR` · `SKILLS_REF_DIR` · `MIGRATION_MARKER` · `DEFAULT_PORT` (`3457`) · `CDP_PORT_OFFSET` (`5783`) · `APP_VERSION` (package.json)

| Function | 역할 |
| --- | --- |
| `ensureDirs()` | `prompts/`, `uploads/`, `skills/`, `skills_ref/` 생성 |
| `runMigration()` | legacy `claw.db`/project-local settings → `~/.cli-jaw/` migration |
| `loadSettings()` | settings.json 로드 + normalize/migration |
| `saveSettings(s)` | 설정 저장 |
| `replaceSettings(s)` | ESM live binding 대체 |
| `loadHeartbeatFile()` / `saveHeartbeatFile()` | `heartbeat.json` 읽기/쓰기 |
| `deriveCdpPort(serverPort?)` | server port + offset으로 browser CDP port 계산; valid overflow는 1024–65535 modular rotation으로 고유 wrap, invalid input은 9240 |
| `getServerUrl(port)` | `http://localhost:${port || process.env.PORT || settings.port || DEFAULT_PORT}` |
| `getWsUrl(port)` | websocket URL 생성 |
| `detectCli(name)` | `buildServicePath()`를 적용한 `which`/`where` 기반 바이너리 존재 확인 |
| `detectAllCli()` | registry 기반 CLI 상태 반환 |
| `buildDefaultPerCli()` | registry에서 기본 perCli 빌드 |

`settings` 기본값에는 `showReasoning`, `channel`, `telegram.forwardAll`, `discord.forwardAll`, `messaging.lastActive/latestSeen`, `memory.autoReflectAfterFlush`, `memory.flushMessageWindow`, `avatar.*`, `stt.*`, `network.bindHost/lanBypass/remoteAccess`가 포함된다. `--home`은 `cli-jaw.ts`에서 `CLI_JAW_HOME`으로 주입된 뒤 이 모듈이 로드된다.

### Current registry defaults

| CLI | Default Model | Notable model aliases |
| --- | --- | --- |
| `pi` | `grok-composer-2.5-fast` | Pi RPC runtime with isolated profile/model registration |
| `agy` | AGY-selected | print-mode runtime; `--model` is capability-gated (observed in AGY 1.1.4); no separate effort flag. Model values must be the tier-bearing label form that `agy --model` accepts on its own, e.g. `Gemini 3.6 Flash (Medium)`. A bare tier-less slug such as `gemini-3.5-flash` is rejected (`requires --effort`) because cli-jaw never sends `--effort` for AGY. Note `agy models` prints effort-suffixed slugs (`gemini-3.6-flash-medium`), which is a different form — do not copy that output into the registry |
| `claude` | `claude-opus-4-8` | canonical choices include `opus`, `sonnet`, `sonnet[1m]`, `haiku`; pinned full IDs include `claude-opus-5`/`claude-opus-5[1m]`; legacy aliases normalize |
| `codex` | `gpt-5.5` | inactive ocx fallback shows only `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`; when ocx health is ok, `/model` completions and `/api/cli-registry` expand from ocx `/v1/models` including routed models |
| `codex-app` | `gpt-5.5` | Codex app-server runtime using the same inactive fallback / active ocx model choices as `codex` |
| `cursor` | `composer-2.5` | uses `cursor-agent --model <resolvedModelId>`; effort resolves into model ids such as `composer-2.5-fast`, `gpt-5.5-medium-fast`, `claude-opus-5-xhigh`, or `claude-opus-4-7-thinking-high-fast` |
| `grok` | `grok-build` | effort disabled because `grok-build` rejects `reasoningEffort`; auth/readiness via `grok models` |
| `opencode` | `opencode-go/kimi-k2.6` | includes current opencode-go provider aliases such as `glm-5.1`, `kimi-k2.6`, `mimo-v2.5`, `minimax-m2.7`, `qwen3.6-plus`, `deepseek-v4-*` |
| `copilot` | `claude-sonnet-4.6` | includes `gpt-5.5`, Claude 4.x aliases, `gpt-5.4*`, `gpt-5.3-codex`, `gpt-5.2-codex` |

---

## src/core/codex-config.ts — Codex config.toml Context Window Sync (78L)

`~/.codex/config.toml`에 `model_context_window`와 `model_auto_compact_token_limit` 키를 주입/제거한다. 1M Context 토글 변경 시 호출된다.

| Function | 역할 |
| --- | --- |
| `syncCodexContextWindow(cfg)` | enabled=true → upsert, enabled=false → remove |

---

## src/core/db.ts — Database (388L)

```sql
session   (id='default', active_cli, session_id, model, permissions, working_dir, effort, updated_at)
messages  (id PK, role, content, cli, model, trace, tool_log, cost_usd, duration_ms, working_dir, created_at)
memory    (id PK, key UNIQUE, value, source, created_at, updated_at)
employees (id PK, name, cli, model, role, status, created_at)
employee_sessions (employee_id PK, session_id, cli, model, created_at)
orc_state (id PK, state, ctx, updated_at)
queued_messages (id PK, payload, created_at)
jaw_ceo_transcript (id PK, at, role, text, source, created_at)
schema_migrations (name PK, applied_at)
```

Virtual employees are not written to `employees` or `employee_sessions`. `src/core/employees.ts` emits `SyntheticEmployeeRow` values with `virtual:` IDs for one-off dispatch, and `src/orchestrator/distribute.ts` skips session resume/persist for those IDs.

`trace`, `tool_log`, and `working_dir` are added by in-place migration if missing. Oversized legacy `tool_log` rows are re-sanitized in 25-row transactions once, tracked by `schema_migrations`; boot only warns above 30% free pages, while `jaw db maintain` owns checkpoint + VACUUM. `working_dir` also gets `idx_messages_wd`; Jaw CEO transcript rows are bounded by the coordinator persistence layer.

| Prepared Statement | 용도 |
| --- | --- |
| `insertMessage` | `(role, content, cli, model, working_dir)` |
| `insertMessageWithTrace` | `(role, content, cli, model, trace, tool_log, working_dir)` |
| `getMessages` | working_dir 포함 UI/API 조회 |
| `getMessagesWithTrace` | full row 조회 |
| `getRecentMessages` | `WHERE working_dir = ? OR working_dir IS NULL` 히스토리 빌더용 |
| `insertQueuedMessage` / `listQueuedMessages` / `deleteQueuedMessage` | agent queue 영속화 |

---

## src/core/bus.ts — Broadcast Bus (57L)

순환 의존 방지 허브. 의존 0. Public audience는 `src/core/event-bus.ts`로 SSE publish하고, internal listener fan-out은 audience와 무관하게 수행한다. X-01 이후 current server에는 public WebSocket broadcast registration이 없다.

| Function | 역할 |
| --- | --- |
| `inferTopic(type)` | broadcast type → SSE topic 매핑 |
| `broadcast(type, data, audience?)` | public audience는 SSE publish, 모든 audience는 내부 리스너 fan-out |
| `addBroadcastListener(fn)` | 내부 리스너 추가 |
| `removeBroadcastListener(fn)` | 특정 핸들러 제거 |
| `clearAllBroadcastListeners()` | 테스트/초기화용 listener set 비우기 |

> `removeBroadcastListener(fn)`는 named handler lifecycle에 맞춰 정확히 해당 참조만 제거한다.

---

## src/messaging/ — shared messaging runtime (44 files)

### ack-reaction.ts / queue-notice.ts

ACK 리액션과 큐 안내 생명주기는 채널이 아니라 이 계층이 소유한다 (#410, #411). 세 채널이
각자 클로저로 처리하던 것을 올린 것이고, 이유는 그렇게 두면 매번 세 번 틀리기 때문이다.

`ack-reaction.ts` — received/running -> success/failure 상태머신. 전이를 내부 promise
chain으로 직렬화한다: lane runner가 task를 동기 시작할 수 있어(`orchestrator/session-lanes.ts`)
settle이 running의 벤더 호출을 추월할 수 있다. terminal은 벤더 호출 **전에** settled를
세워 첫 outcome이 이긴다. apply가 reject하면 applied를 갱신하지 않는다 — Slack API가
실패를 throw하지 않고 {ok:false}로 돌려주므로 transport가 검사해서 throw해야 한다.
`resolveAckEmoji`가 유일한 이모지 결정 지점이고 채널 제약은 각 transport의 coerce가
처리한다. 채널별 기본값과 `mergeAckSettings`(중첩 병합, boot/API/watch 3경로 공유)도 여기서.

`queue-notice.ts` — 안내 생명주기. 핵심은 삭제가 아니라 **순서**다: 안내는 await로
게시되는데 그 사이 큐 작업이 끝날 수 있어 정리가 대상보다 먼저 도착한다. 하나의 deferred
completion을 모든 close() 호출자가 공유하고, 늦은 bind()가 벤더 작업을 끝낸 뒤 resolve
한다 — 먼저 resolve하면 drain이 요청 도중에 transport를 내린다. answered는 삭제, expired는
만료 문구로 편집(답변이 영영 안 온 턴의 흔적을 지우지 않는다). abandon()은 post 실패용.
`QueueNoticeRegistry.drain(timeoutMs)`이 셧다운을 소유하며 deadline에서 실제로 abort
한다 — race로 반환만 하는 것은 기다림을 멈출 뿐 요청을 취소하지 않는다.

채널은 transport 팩토리만 제공한다: Slack reactions.add/remove + chat.delete/update,
Telegram setMessageReaction(replace 의미론 + ReactionTypeEmoji 허용목록 73개, 체크/엑스
표시는 목록에 없어 엄지 사용), Discord 저수준 client.rest(고수준 helper가 request options를
넘기지 않아 취소 불가). 세 채널 모두 reaction: true 이며 payload/route 캡처 테스트가 뒷받침한다.

### durable-ingress.ts / ingress-audit.ts

`IngressJournal` rows stamp `session_generation`. A redelivery whose generation no longer matches is `stale_generation` and is not claimed. `IngressJournal` is the SQLite record of every inbound Telegram/Discord/Slack event. Transports call `admitIngress`/`settleIngress`. Slack ACK stays after preflight admit; Slack settle is handle early-returns plus the ingress lane around `processSlackMessageEvent`, and a Slack failure after ACK is `dead_letter` because Slack will not redeliver. Operators inspect and recover with `jaw messaging ingress list|show|replay|audit`. `requestReplay` is a state CAS back to `received`. Nothing in-process re-runs the handler — vendor redelivery does. Replay audit is append-only JSONL at `$JAW_HOME/messaging-ingress-audit.jsonl`.

`admitIngress` enters that row's existing `trace_id` into `MessagingTraceContext` so a later `log.event` on the same turn can stamp it; it does not mint a second id.
`/api/health` adds `channels.ingress` from `IngressJournal.counts()` and this-process `channels.metrics`; `jaw messaging doctor --json` reads the same SQLite file locally and cannot see the server ring.
`gate:messaging-conformance` is the 22nd release gate: it re-runs the existing three-channel contract suites and writes a `functional-certified` artifact. It is not a chaos matrix and it is not `release-certified`.
A file-backed restart is `tests/integration/messaging-ingress-restart.test.ts`: a second `IngressJournal` on the same `jaw.db` path. Completed stays `already_handled`; mid-flight keeps the stored `trace_id`.
`append` treats a primary-key clash from a second connection as `duplicate`. A locked or full database still throws so Slack can refuse ACK.
`src/messaging/effect-once.ts` owns `effect_claims`.
`src/messaging/outbound-outbox.ts` owns `outbound_attempts`. A row is reserved before the vendor call. `ambiguous` is reachable only from `sending` and is terminal for the automatic path. Non-terminal and `ambiguous` attempts block the ingress retention sweep. A claim is held by `owner_id` + `claim_token`; an expired lease lets a new owner claim the row but never re-runs the effect body, and `manual` is the terminal hold for an outcome nobody can determine. Non-terminal claims block the ingress retention sweep.
`sendSlackText` waits a short Slack `ratelimited`/429 and retries that chunk once. A long Retry-After still surfaces. The chunk loop does not restart.
`sendChannelOutput` emits `outbound.send` on the current messaging ALS. Empty ALS stays empty — no second id.

`forwarder-origin.ts` — 채널 forwarder의 공통 origin 필터다. 자기 채널에서 시작한 턴과 producer가 직접 배달하는 `heartbeat` 결과를 건너뛴다. 하트비트는 지정 destination으로 직접 보낸다. Forwarder는 last-active를 읽지 않는다; 핀이 없으면 침묵이다. 하트비트를 forwarder에 태우면 지정 destination에 중복 발화가 생긴다.


Telegram/Discord/Slack 채널의 활성 타겟 상태와 outbound routing을 공유한다. `settings.messaging.lastActive/latestSeen`를 유지하고, `core/runtime-settings.ts`의 restart 경로가 이 레이어를 다시 초기화한다. Persisted target은 channel/target/peer kind와 optional thread/guild/parent 필드까지 검증한 뒤 복원한다.

`thread-target.ts` — `threadIdNumber(target)` extracts `message_thread_id` for programmatic Telegram sends (P0 forum topic support).

### 채널 공통 하드닝 모듈 (260802)

Slack 채널 유닛에서 확립한 전송 규율을 Discord/Telegram에 소급 적용하며 추가된
공유 레이어. 채널별 구현을 두면 한쪽만 고쳐지는 문제가 반복되어, 전 채널이 지나는
choke point로 모았다.

| 파일 | 역할 |
| --- | --- |
| `chunk.ts` | 무손실 분할. 서로게이트 페어를 쪼개지 않고, 코드펜스 균형과 언어 태그를 유지한다. Discord/Slack/Telegram이 모두 이 코어를 쓴다. **단서**: delimiter 자체가 채널 한도보다 길면(백틱 2,001개짜리 유효 fence 등) 재개가 한도를 넘기므로 펜스 복구를 포기한다 — 무손실·서로게이트 안전·한도 준수는 그대로 유지되고, continuation이 prose로 렌더링될 뿐이다. |
| `fold.ts` | 정규화 폴딩. escape 디코드 + invisible 제거 + NFKC를 고정점까지 반복하며, 각 문자가 원문 어디서 왔는지 오프셋 맵으로 추적한다. **좌표계는 전부 UTF-16 code unit.** |
| `redact.ts` | 크리덴셜 마스킹. `redactOutboundText`(본문), `redactOutboundPayload`(keyboard 등 구조화 payload), `userErrorText`/`logErrorText`(오류)를 제공한다. |
| `dedupe.ts` | 배달 중복 제거. TTL seen-set이며, sweep은 **만료된 항목만** 지운다 — 미만료 항목을 크기 맞추려 쫓아내면 막으려던 중복이 다시 생긴다. |
| `retry.ts` | 전송 실패 분류. `format`만 형식 폴백을 얻고, `rate-limit`은 대기 후 같은 형식 재시도, `ambiguous`는 중복 전송 위험이 있어 중단한다. |

마스킹은 **전송 직전(last mile)**에 건다. 호출부마다 걸면 반드시 하나가 누락되고,
실제로 감사 과정에서 반복해서 발견됐다. 오류 경로만으로는 부족하다 — 크리덴셜은
평범한 메시지 본문·캡션·버튼 라벨·로그 preview로도 흐른다.

### runtime.ts (146L)

| Function | 역할 |
| --- | --- |
| `registerTransport()` | 채널별 init/shutdown 등록 |
| `getEnabledChannels()` | 현재 enabled 채널 목록 반환 |
| `getHomeChannel()` | 현재 home 채널 반환 |
| `initEnabledMessagingRuntimes()` | enabled 채널 각각 transport init |
| `shutdownMessagingRuntime()` | 전체 transport shutdown |
| `restartMessagingRuntime()` | enabled set, per-channel config, locale 변경 시 영향 채널만 restart (home-only 변경은 restart 없음) |
| `setLastActiveTarget()` / `getLastActiveTarget()` | 마지막 활성 타겟 추적 |
| `setLatestSeenTarget()` / `getLatestSeenTarget()` | 최신 관측 타겟 추적 |
| `clearTargetState()` | stale target 제거 |
| `hydrateTargetsFromSettings()` | persisted `settings.messaging` 복원 |

### send.ts (147L)

파일 전송은 `ok`(벤더가 바이트를 받았다)와 `confirmation`(벤더가 무엇을 만들었는지 말했다)을
분리한다. 어휘는 `file-receipt.ts` 가 갖고, `confirmation` 은 반드시 **최상위 필드**다 —
`sendChannelOutput` 이 `isUnconfirmedSend(sanitized)` 로 그걸 읽어, unconfirmed 전송에도
caption 자기배달 청구를 남기기 때문이다. 중첩된 영수증에 숨기면 그 예외가 발동하지 않고
디스패치 경로가 같은 caption 을 한 번 더 게시한다. 확정 실패(400/413/auth)는 이 예외를
빌리지 못한다 — 아무것도 배달하지 않았으므로 턴의 진짜 답변이 나가야 한다.

세 채널의 미확인 기준은 벤더 문서에서 왔다. Slack 은 `files[]` echo 가 없는 completion,
Telegram 은 `message_id` 가 0 이거나 없는 응답(0 은 "아직 실제로 전송되지 않았다"는
벤더 정의), Discord 는 Create Message 가 message id 를 돌려주지 않은 경우다.
**Discord 의 거절은 `sendDiscordFileRest` 안에만 둔다** — 같은 `DiscordRestScheduler` 가
reaction/delete/unpin 도 나르고 거기서는 204 가 문서화된 정상 성공이다. 상태 코드는
`FILE_UNCONFIRMED_STATUS`(502)이고 4xx 가 아니다: 요청에 잘못된 것이 없고, 에이전트가
재시도해야 할 일도 아니다(이미 도착했을 수 있다).

`confirmation` 은 중간 계층이 벗기면 의미가 없다. Telegram Hub 릴레이(`sendToTopic` →
허브 라우트 → 멤버 핸들러)와 legacy `/api/telegram/send` 가 그 필드를 통과시키는 이유가
이것뿐이다 (#700).

| Export | 역할 |
| --- | --- |
| `ChannelSendRequest` | outbound request 타입 |
| `registerSendTransport()` | 채널별 send 함수 등록 |
| `normalizeChannelSendRequest()` | HTTP body → request 정규화 |
| `validateTarget()` | allowlist + full target shape 검증. 빈 Slack allowlist에서 explicit target은 검증된 `lastActive/latestSeen`의 같은 conversation/thread만 재사용 가능 |
| `sendChannelOutput()` | explicit target > **validated turn address** > validated lastActive > validated latestSeen > configured fallback 순으로 전송 |

추가로 `validateTarget()`이 Telegram `allowedChatIds`와 Discord `channelIds`/thread parent를 같이 검사하고, stale cached target이면 `clearTargetState()`로 바로 비운다.

### session-key.ts (27L)

| Function | 역할 |
| --- | --- |
| `buildRemoteSessionKey(target)` | 리모트 세션 키 생성 |
| `groupQueueKey(origin, target)` | origin+target 큐 그룹 키 생성 |

### types.ts (27L)

`MessengerChannel` (`telegram` | `discord`), `RemoteTarget`, `OutboundType`, `RuntimeOrigin` 타입 정의.

---

## src/telegram/ — Telegram transport (9 files)

`bot.ts`, `forwarder.ts`, `rich-message.ts`, `telegram-file.ts`,
`elicitation-buttons.ts`, `voice.ts`, `hub-callback.ts`,
`status-update-buffer.ts`, `fetch-body.ts`.

- `bot.ts` — thread-aware programmatic send (P0) + hub-member outbound relay (P2b)
- `rich-message.ts` — Bot API 10.1 rich Markdown, the default outbound text path
- `elicitation-buttons.ts` — single_select fences rendered as inline keyboards
- `hub-callback.ts` — loopback-only SSRF guard for hub callback URL
- `status-update-buffer.ts` — coalesces tool-status edits
- `fetch-body.ts` — IPv4-pinned fetch body helper

### bot.ts (859L)

Telegram transport main entry. `registerTransport('telegram', ...)`와 `registerSendTransport('telegram', ...)`를 등록하고, `settings.telegram.forwardAll`, allowlist, mention gating, voice, attachment, slash command 흐름을 모두 처리한다.

미들웨어 순서가 중요하다: self-echo 가드 → 로깅 → allowlist → mention gating → dedupe.
dedupe이 마지막인 이유는 앞 게이트에서 버려질 트래픽이 seen-set을 채우지 않게 하기
위해서다 — 처리 대상인 중복은 어차피 같은 게이트를 통과하므로 보장은 그대로다.
self-echo 가드는 `getMe()`로 얻은 봇 id를 쓰고, 그 호출이 끝나기 전 구간은 `is_bot`
플래그로 덮는다. 로깅보다 앞에 두어 자기 에코가 로그를 오염시키지 않게 한다.
`settings.telegram.allowBots`는 Discord와 대칭이며 기본 false다. P0: thread-aware programmatic send via `thread-target.ts`. P2b: hub-member outbound relay to Dashboard `/api/dashboard/telegram-hub/outbound`.

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성 + handler registration + forwarder lifecycle |
| `shutdownTelegram()` | Bot/forwarder shutdown |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성 + `applyRuntimeSettingsPatch()` |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 (`threadId` when `message_thread_id` present) |

### forwarder.ts (105L)

`createTelegramForwarder()`는 `agent_done`만 forwarding하고, `shouldSkip`으로 Telegram-origin 결과를 제외한다. `createForwarderLifecycle()`는 detach/attach를 관리한다.

### voice.ts (36L)

`handleVoice(ctx)`는 Telegram voice 파일을 내려받아 `lib/stt.ts`로 전사한 뒤 `tgOrchestrate()`로 넘긴다.

### telegram-file.ts (133L)

Telegram file upload / retry helper. 텍스트가 아닌 media send와 attachment 전달에 사용된다. Optional `{ threadId }` for forum topics.

### hub-callback.ts (19L)

`resolveHubCallback()` — loopback-only SSRF guard for hub-member outbound callback URL. Default `http://127.0.0.1:24576`.

### shared runtime points

- Telegram과 Discord는 모두 `src/messaging/runtime.ts`에 자기 transport를 등록한다.
- Telegram/Discord 설정 변경은 `core/runtime-settings.ts`를 통해 같은 restart 경로를 탄다.
- `settings.messaging.lastActive/latestSeen`는 Interactive omit-target 과 inbound vouch 용이다. `agent_done` forward 대상이 아니다.
- **턴 주소(`turnTarget`)는 저장되지 않는다.** 인바운드 턴의 프롬프트에 `reply_to=` 로
  실려 나가고 에이전트가 `/api/channel/send` 의 `turn_conversation` 으로 돌려준다.
  `lastActive/latestSeen` 은 채널당 하나뿐인 휘발 슬롯이라 "누가 마지막에 말했나"를
  답하는데, 멀티세션에서 DM 턴과 채널 턴이 동시에 돌면 그 답이 이 대화가 아니게 된다
  (#474). 턴 주소는 "지금 누구에게 답하는 중인가"를 답하고 턴이 사는 동안 바뀌지 않는다.
  프로세스 환경변수가 아닌 **프롬프트** 로 실어 나르는 이유는 `codex-app` 이 풀링된
  프로세스를 재사용하면서 env 는 생성 시점에만 설정하기 때문이다 — 재사용된 프로세스는
  자기를 처음 띄운 턴의 주소를 계속 답하게 된다. 턴 주소도 `validateTarget()` 을 거친다.
- `src/orchestrator/pipeline.ts`는 Telegram/Discord origin에만 21 Elicitation remote-channel guard를 동적으로 붙인다. A1 system prompt는 수정하지 않으며, accidental `elicitation` / `choice-buttons` fence 출력은 remote 응답 직전에 plain text numbered question fallback으로 normalize한다.

### Dashboard Telegram Hub (`src/manager/telegram-hub/` — 3 files)

Forum supergroup topic → managed instance port routing. Config in `DashboardRegistry.telegramHub`. Routes at `/api/dashboard/telegram-hub` (loopback-only). `hub-bot.ts` owns single-bot long-poll; hub commands `/setthread`, `/threads`, `/hubhelp`. Manager UI: `TelegramHub.tsx`. See `telegram.md` § Telegram Hub.

---

## src/discord/ — Discord transport (7 files, 858L)

`bot.ts`, `forwarder.ts`, `commands.ts`, `discord-file.ts`,
`send-only-client.ts`, `channel-types.ts`, `register.ts`.

### bot.ts (432L)

Discord transport main entry. guild/DM message ingestion, `allowBots`, `mentionOnly`, channel allowlist, attachment handling, `registerTransport('discord', ...)`, `registerSendTransport('discord', ...)`를 담당한다.

### commands.ts (119L)

Guild-scoped slash command registration + execution. `getVisibleCommands('discord')`와 `makeCommandCtx('discord', ...)`를 사용한다. `/orchestrate` 스티어 경로는 Discord 채널로 collect 결과를 다시 전송한다.

### forwarder.ts (85L)

`agent_done` 결과를 Discord 채널로 chunked forwarding 한다.

### discord-file.ts (67L)

Discord attachment/file send helper.

### send-only-client.ts (88L)

REST-only client for sends that must not require a gateway session.

### channel-types.ts (50L) · register.ts (17L)

Channel narrowing helpers and slash-command registration.

---

## src/slack/ — Slack transport

### inbound context (`bot.ts`, `history.ts`, `conversation.ts`, `context.ts`, `thread-tracker.ts`, `ingress.ts`)

top-level 채널은 현재 event ts 직전의 `conversations.history`를 세션 소유 세대당 한 번 프롬프트 preamble에 주입한다. thread는 `conversations.replies` cursor를 최대 10페이지 따라가며 parent + 최신 50 replies만 보존한다. 합성 top-level reply 주소는 채널 session identity를 공유하되 `midRunPolicy: followup`으로 진행 중인 다른 사용자의 turn을 steer/kill하지 않는다.

### trusted bot triggers (`events.ts`)

`slack.trustedBotTriggers`는 다른 봇 하나가 이 인스턴스의 턴을 시작할 수 있게 하는 운영자 선언 목록이다. 규칙은 `{channelId, botId, userId, textMarker}` 네 필수 키와 선택적 `workflowSkill`만 허용한다. 네 필수 값은 각각 `^[CG][A-Z0-9]{2,}$`, `^B[A-Z0-9]{2,}$`, `^[UW][A-Z0-9]{2,}$`, `^[A-Z][A-Z0-9_]{2,63}$`를 만족해야 한다. 목록은 최대 16개이고 **하나라도 어긋나면 전체가 무효**다 — 인바운드 권한 설정의 오타는 절반만 살아 있는 상태보다 닫히는 쪽이 낫다.

매칭은 이벤트가 자기 자신을 멘션하고, `bot_id`/`bot_profile.id`와 `user`/`bot_profile.user_id`가 서로 모순되지 않으며, 삭제된 프로필이 아니고, 어떤 규칙이 채널·봇·발신자·마커 단어와 정확히 맞을 때만 성립한다. 마커는 공백 단위 단어 비교라 `EXAMPLE_WORK_V1`은 더 긴 단어의 일부로 매칭되지 않는다.

일치는 정확히 세 거부만 연다: `bot_message` subtype 무시, `allowBots:false` 거부, 그리고 `mention_via_app_mention` 중복 제거. self-echo, 채널 누락, 대화 허용목록, `mentionOnly`, empty-event 검사는 그대로다. 중복 제거를 열어도 실행은 한 번인데, `bot.ts`가 dispatch 전에 `slackEventKey(teamId, channel, ts)`를 선점하므로 같은 글의 `app_mention`/`message` 두 봉투가 하나로 접힌다. `isSlackMention()` 자체는 넓히지 않는다 — 그 함수는 thread 참여 소유권도 정하기 때문에, 넓히면 #400이 고친 과잉 응답이 되돌아온다.

선택적 `workflowSkill`은 실제 이벤트의 발신자·채널·봇 사용자·마커와 자기 멘션이 모두 맞은 뒤 운영자가 설정한 실행 경로를 선택한다. 메시지 본문으로 다른 스킬을 고를 수 없다. 네 키만 있는 기존 규칙은 기존 동작을 유지한다. 선택된 활성 스킬만 최대 64 KiB로 읽으며, 발신·요청 정보를 확인할 수 없거나(`source_unavailable`), 스킬을 사용할 수 없거나(`skill_unavailable`), 선택이 모호하면(`ambiguous`) `slack.workflow.unavailable`로 차단을 알리고 모델로 대체하지 않는다. 일반 승인·도구 권한·원본 접근 권한은 그대로다.

선택된 스킬은 요청 수락(admission) 시점에 읽고, 캡처한 내용·해시·출처 메타데이터를 큐 대기와 재시작 이후에도 보존한다. 이 기능을 선택한 워크플로 요청은 busy 상태에서 `followup` 큐로 보내며, 관련 없는 실행 중 턴에 steer하거나 collect로 합치지 않는다.

등록 워크플로의 결과가 비었거나 단독 `SILENT`이면 `slack.workflow.unconfirmed` 안내와 실패 ACK로 끝낸다. 워크플로 요청은 unconfirmed/failed로 판정하되 provider/native의 최종 텍스트와 상태는 보존한다. 이미 작업이 시작되었을 수 있으므로 자동 재실행하지 않고 기록을 확인한 뒤 재시도한다. AI 답변 수신만으로 업무 완료를 판정하지 않는다.

### mention-watch.ts (345L)

`scanSlackMentions()`는 봇이 가입한 명시적 채널에서 특정 사용자가 태그된 새 메시지를 찾는다. 봇 토큰으로 쓸 수 없는 user-token 전용 `search.messages` 대신 `conversations.history`를 newest에서 과거 방향으로 읽는다. 커서는 처리가 끝난 메시지까지만 전진하고, 끝내지 못한 backward walk는 `resume_before`에서 이어간다. 채널 시작점을 tick마다 회전해 hot channel의 독점을 막고, 429가 오면 wrapper 재시도 없이 그 tick을 멈춘다. 한 tick의 채널 상한은 60이며 초과분은 `overflowChannels`로 반환한다.

---

## src/memory/ — persistent + advanced memory runtime (14 files, 3391L)

`memory.ts`, `runtime.ts`, `shared.ts`, `heartbeat.ts`, `heartbeat-schedule.ts`, `heartbeat-mention-watch.ts`, `indexing.ts`, `keyword-expand.ts`, `bootstrap.ts`, `injection.ts`, `identity.ts`, `reflect.ts`, `advanced.ts`, `worklog.ts`.

### memory.ts (154L)

| Function | 역할 |
| --- | --- |
| `search(query)` | grep-rni 기반 검색 |
| `read(filename)` | 파일 읽기 |
| `save(filename, content)` | append 저장 |
| `list()` | 파일 목록 |
| `appendDaily(content)` | 일별 메모리 추가 |
| `loadMemoryForPrompt(maxChars)` | system prompt 주입용 |

### runtime.ts (374L)

Advanced memory runtime의 entry point. FTS5 인덱스, search routing, task snapshot, bootstrap, reindex 제어를 묶는다.

### injection.ts / identity.ts / reflect.ts

- `injection.ts`: 역할별(`boss`/`employee`/`subagent`/`flush`/`read_only_tool`) memory injection 정책과 search routing
- `identity.ts`: `shared/soul.md` 관리, soul read/update 경로
- `reflect.ts`: 최근 episode를 `shared/*`, `procedures/runbooks.md`, `shared/soul.md`로 승격

### heartbeat.ts / heartbeat-schedule.ts

주기 작업과 스케줄 파싱/실행을 담당한다. 현재 소스 오브 트루스는 `~/.cli-jaw/heartbeat.json`이며, schedule은 `every`/`cron` + `timeZone`을 지원한다. PABCD 활성, heartbeat 중첩, main agent busy 상태에서는 `pendingJobs` 큐로 밀어두고, user message queue가 먼저 비워진 뒤 heartbeat pending을 drain한다. 프롬프트 앞에는 memory search 지시를 자동 주입한다. (#252) job별 opt-in `runner: main|employee|script`(기본 main; employee는 `claimWorker`+`runSingleAgent`, busy 시 `skipped: employee busy` 경고 리포트; script는 argv `execFile` no-shell)와 `reportPolicy: always|anomaly_only|silent` + 구조화 리포트 계약(`heartbeat-report.ts`: status/changed/record_required/user_visible/summary/evidence/next_action)을 지원한다. `[SILENT]`/quiet marker는 정책과 무관하게 우선하며, silent 정책 anchor는 `delivered_at NULL` + "recorded (not sent)" 주입 문구로 구분된다. main runner는 `orchestrateAndCollectData`의 `agyPlannerOnly` 신호(#251)에 1회 한정 재시도한다. 바인딩된 일반 destination send는 `fullAccess: true`와 `allowActiveFallback: false`를 쓰며 HTTP JSON은 그 flag를 설정하지 못한다. `mentionWatch`가 있으면 같은 `runHeartbeatJob`이 일반 prompt path 대신 멘션 항목 루프를 실행한다. 선택 `userIds`/`conditions`(mention|talk)는 기본을 `userId` 멘션으로 두고 talk는 opt-in이며 inbound `mentionOnly`를 바꾸지 않는다. 답변 턴은 답하는 스레드의 `chatSessionId`를 쓰되 실행 스코프는 전용 `mention-watch:<remoteKey>`다 — 스레드 스코프를 그대로 쓰면 그 턴이 busy로 보여서 다음 사람 메시지가 새 run 대신 이 배경 턴으로 steer된다. 그래서 양보 판정도 대화 단위다: `getState(remoteKey)`가 IDLE이고, 그 세션에 진행 중 작업이 없고, lane이 비어 있어야 답한다. lane은 검사만 하고 기다리지 않는다 — lane 대기는 상한이 없고 그 사이 heartbeat 전체가 잠긴다. 세션 row는 실제로 답하기로 정한 뒤에만 만든다: remote-bound 세션은 나중에 지울 수 없다. PUT `/api/heartbeat`는 UI가 모르는 runner와 mentionWatch 필드를 job id 기준 merge-by-id로 보존한다.

### heartbeat-mention-watch.ts (244L)

`runMentionWatchTick()`은 설정 채널과 tick 시점의 Slack allowlist를 다시 교집합하고 항목마다 PABCD, agent busy, `messageQueue`, pending replay를 재확인한다. 에이전트는 답변 본문만 만들고 서버가 `sendChannelOutput()`으로 원문 스레드에 보낸다. 전송 성공 뒤에만 `mention_watch_seen`을 기록하므로 실패 항목은 다음 tick에서 다시 시도하며 보장 수준은 at-least-once다. `mention_watch_cursor`의 `resume_before`가 끝나지 않은 history walk를 잇고, `mention_watch_rotation`이 다음 시작 채널을 정한다. seen prune은 건수가 아니라 전진한 cursor를 기준으로 한다.

### mention-watch-ledger.ts (104L) / legacy-mention-watch-quarantine.ts (115L)

receipt/cursor/rotation 장부의 유일한 접근 경로다. 모든 읽기·쓰기가 `WatchNamespace = (jobId, workspaceId, userId)`를 받고 SQL predicate에 세 파트를 전부 싣는다. Slack은 사람을 `(team_id, id)`로 식별하고 한 런타임이 재시작 없이 다른 workspace로 재인증할 수 있어서, job만으로 키를 잡으면 한 사람의 cursor가 다른 사람에게 넘어간다. workspace id는 `src/slack/verified-workspace.ts`가 bot token으로 `auth.test`를 1회 호출해 토큰별로 캐시한 값이며 `settings.slack.teamId`를 신뢰하지 않는다(그 값은 비어 있을 때만 기록되고 이후 토큰과 대조되지 않는다). 조회 실패는 추측 대신 그 tick을 건너뛴다. 모듈 경유가 predicate 누락을 구조적으로 막아 주지는 않으므로 최종 보증은 `tests/unit/mention-watch-ledger.test.ts`의 A/B 대칭 테스트다 — 같은 job/channel/ts 위에 workspace나 user만 다른 두 namespace를 만들어 서로를 보거나 건드릴 수 없음을 확인한다.

v1 장부 행에는 workspace/user가 없어서 v2 키로 옮기려면 소유자를 추측해야 하고, 그 추측이 곧 v2가 막으려는 오배정이다. 그렇다고 그냥 새로 시작하면 cursor 없는 watch가 도달 가능한 history를 거꾸로 훑어 이미 답한 것을 다시 답한다. 그래서 v1 행이 남은 job은 `heartbeat.json`의 `enabled`와 무관하게 스케줄에서 보류된다. 보류 marker는 SQLite에 있다 — 파일은 운영자의 의도이고 보류는 시스템의 판단이라, 한 곳에 적으면 서로를 덮어쓰고 파일 재작성을 탐지 시점의 테이블 생성과 원자적으로 묶을 수도 없다. 탐지는 `INSERT OR IGNORE`로 매 load마다 돌며(업그레이드 당시 없던 job이 같은 id로 돌아오는 경로를 one-shot 검사는 놓친다), 구버전으로 downgrade해 v1 행이 다시 생기면 `resolved`를 `pending`으로 재격리한다. 해제는 `POST /api/heartbeat/:jobId/mention-watch-fresh-start`뿐이고 새 `since`를 요구하며, 한 트랜잭션에서 CAS를 먼저 claim한 뒤 v1 행을 archive하고 삭제한다. 순서가 중요한 이유는 better-sqlite3 transaction이 `return`으로는 rollback되지 않아서다 — 파괴적 단계를 먼저 두면 실패를 보고한 승인의 archive/delete가 그대로 commit된다.

### indexing.ts / keyword-expand.ts / bootstrap.ts

index 준비, BM25/expansion, bootstrapping/import 흐름을 담당한다.

### worklog.ts / shared.ts

작업 스냅샷, 공통 타입/헬퍼, history persistence에 쓰인다.

### advanced.ts

이관 호환용 1-line shim.

---

## src/browser/ — Chrome CDP 제어

Chrome CDP 제어, 완전 독립 모듈.

| connection.ts (215L) | actions.ts (179L) |
| --- | --- |
| `findChrome()` | `snapshot(port, opts)` |
| `launchChrome(port)` | `screenshot(port, opts)` +dpr |
| `connectCdp(port)` | `click(port, ref, opts)` |
| `getActivePage(port)` | `type(port, ref, text)` |
| `getCdpSession(port)` | `press(port, key)` |
| `listTabs(port)` | `hover(port, ref)` |
| `getBrowserStatus(port)` | `navigate(port, url)` |
| `closeBrowser()` | `evaluate(port, expr)` |
|  | `getPageText(port, fmt)` |
|  | `mouseClick(port, x, y)` |

### vision.ts (204L) — Vision Click pipeline

| Function | 역할 |
| --- | --- |
| `extractCoordinates(path, target)` | provider 분기 좌표 추출 |
| `codexVision(path, target)` | Codex exec -i + NDJSON parse |
| `visionClick(port, target, opts)` | screenshot → vision → DPR 보정 → click → verify |

### launch-policy.ts (51L) — Browser launch policy

module-level policy로 `browser start` mode 정규화 + agent/debug/manual launch policy를 관리한다.

`index.ts` (13L) — re-export hub (mouseClick + visionClick 포함)

---

## lib/mcp-sync.ts — MCP 통합 관리 (1212L)

소스: `~/.cli-jaw/mcp.json`

| Function | 역할 |
| --- | --- |
| `loadUnifiedMcp()` | 통합 MCP 설정 로드 |
| `toClaudeMcp(config)` | Claude/Gemini `.mcp.json` 변환 |
| `toCodexToml(config)` | Codex `config.toml` 변환 |
| `toOpenCodeMcp(config)` | OpenCode `opencode.json` 변환 |
| `toCopilotMcp(config)` | Copilot `~/.copilot/mcp-config.json` 변환 |
| `syncToAll(config, workDir)` | 통합 → 지원 MCP-aware CLI 설정 동기화 |
| `copyDefaultSkills()` | 2×3 분류 + Codex 폴백 + registry.json 동기화 |
| `propagateSkillsToInstances()` | base `skills_ref`를 `~/.cli-jaw-*` instances로 동기화하고, 각 instance의 synced `skills_ref` 기준으로 default active skills를 활성화 (`baseActive` fallback 포함) |
| `installMcpServers(config)` | npm -g / uv tool install |
| `ensureSymlinkSafe(target, linkPath, opts)` | symlink 보호 모드 |
| `safeMoveToBackup(pathToMove)` | 충돌 디렉토리 백업 이동 |
| `ensureSkillsSymlinks(workingDir, opts)` | 스킬 심링크 + 보호 결과 반환 |

Antigravity MCP sync is an existing config target at `~/.gemini/antigravity/mcp_config.json` via `lib/mcp/format-converters.ts`. It remains separate from the AGY runtime registry key `agy`; adding AGY runtime support does not register `agy` as a wrapper provider.

### symlink 보호 정책

- 실디렉토리 충돌 시 `fs.rmSync` 대신 `renameSync`로 백업
- 백업 경로: `~/.cli-jaw/backups/skills-conflicts/<timestamp>/`
- 결과가 로그/API 응답에 기록됨 (`status: ok/skip`, `action: noop/backup/create/conflict`)

## lib/quota-copilot.ts — Copilot Quota & Auth (328L)

Copilot 할당량 조회 + 인증 토큰 관리. env → file cache → `gh auth token` → macOS keychain 4단계 폴백.

| Function | 역할 |
| --- | --- |
| `hasCopilotAuthSync()` | 동기 인증 상태 확인 |
| `readCopilotTokenSync()` | 토큰 읽기 |
| `refreshCopilotFromKeychain()` | keychain 실패 리셋 + 캐시 클리어 + 재시도 |

## lib/stt.ts — Voice STT Engine (231L)

음성인식 엔진. Gemini REST API 직접 호출 → Whisper fallback. settings.json 연동.

| Function | 역할 |
| --- | --- |
| `transcribeVoice(path, mimeType)` | 음성 파일 → 텍스트 변환 |
| `getSttSettings()` | settings.json → env var 폴백 체인 |

## lib/upload.ts (184L)

파일 업로드 처리 + Telegram 다운로드.

---

## src/routes/ — API registration cluster (36 files, 6700L)

`server.ts`는 이제 보안 미들웨어와 base routes만 유지하고, 실제 API surface는 이 디렉터리의 registrar/helper로 나눈다.

| Module | 역할 |
| --- | --- |
| `types.ts` | `AuthMiddleware` shared type |
| `employees.ts` | employee CRUD |
| `heartbeat.ts` | heartbeat read/write |
| `skills.ts` | skill list/enable/disable/reset |
| `jaw-memory.ts` | jaw memory search/read/list/save/init/reflect/flush/soul |
| `avatar.ts` | avatar summary + image upload/delete/read |
| `i18n.ts` | locale bundle endpoints |
| `orchestrate.ts` | PABCD reset/state/workers/snapshot/queue steer/dispatch/worker result |
| `memory.ts` | memory status/KV/files/settings |
| `settings.ts` | settings/prompt/heartbeat-md/MCP/registry/status/quota/copilot |
| `messaging.ts` | upload/file-open/voice/telegram/channel/discord send |
| `browser.ts` | browser runtime endpoints |
| `quota.ts` | `/api/quota` helper readers imported by `settings.ts` (direct provider usage where supported, wrapper runtime delegation for `codex-app`, reverse-engineered AGY Gem/Cla windows when `antigravity-usage --json` is available, and status-only metadata for Cursor/Grok/OpenCode or CLIs without quota windows) |

핵심 포인트:
- `server.ts`는 `register*Routes(app, requireAuth, ...)` 호출만 남기고 635L 글루 레이어로 유지된다. 현재 mutation endpoint는 모두 `requireAuth` 미들웨어를 거쳐 인증 없는 상태 변경을 차단한다.
- `settings.ts`가 `/api/quota`를 소유하며, `quota.ts`는 route registrar가 아니라 helper module이다.
- `messaging.ts`가 `assertSendFilePath()`와 `execFileSync()` 기반 file open/send 보안을 담당한다.

---

## src/security/ — 보안 입력 검증 [P9.1]

**의존 없음** — server.ts에서 라우트 핸들러 진입 시 호출.

### path-guards.ts (111L)

| Function | 역할 |
| --- | --- |
| `assertSkillId(id)` | skill id 검증 + path segment 차단 |
| `assertFilename(f, opts)` | 확장자 화이트리스트 + path separator 차단 + 길이 제한 |
| `assertMemoryRelPath(input, opts)` | nested relative path 허용 + traversal 차단 |
| `assertSendFilePath(filePath, workingDir?)` | `JAW_HOME`/`workingDir`/OS temp 아래 파일만 전송 허용 |
| `safeResolveUnder(base, rel)` | `path.resolve` 후 base 디렉토리 탈출 검증 |

### decode.ts (21L)

| Function | 역할 |
| --- | --- |
| `decodeFilenameSafe(s)` | `decodeURIComponent` + 길이 제한 (512) + 에러 시 원본 반환 |

#### 적용 라우트

| 라우트 | 적용 guard |
| --- | --- |
| `/api/memory-files/:filename` | `assertFilename` + `safeResolveUnder` |
| `/api/upload` | `decodeFilenameSafe` |
| `/api/skills/enable`, `disable` | `assertSkillId` |
| `/api/jaw-memory/read`, `save` | `assertMemoryRelPath` + `normalizeAdvancedReadPath` |
| `/api/telegram/send`, `/api/channel/send` | `assertSendFilePath` |

---

## src/http/ — 응답 계약 [P9.2]

**의존 없음** — Express 라우트에서 직접 사용.

### response.ts (25L)

| Function | 역할 |
| --- | --- |
| `ok(res, data)` | `{ ok: true, ...data }` 200 응답 |
| `fail(res, status, error, extra)` | `{ ok: false, error, ...extra }` 에러 응답 |

### async-handler.ts (14L)

| Function | 역할 |
| --- | --- |
| `asyncHandler(fn)` | `Promise.catch(next)` 래퍼 |

### error-middleware.ts (26L)

| Function | 역할 |
| --- | --- |
| `notFoundHandler` | 404 → `fail(res, 404, 'not_found')` |
| `errorHandler` | 글로벌 에러 → 500 + 로깅 |

---

## bin/commands/ — CLI Subcommands

### bin/cli-jaw.ts — CLI Entrypoint

> 서브커맨드 라우터 + `--home` flag 처리 (manual `indexOf`, NOT parseArgs)
> `--home` → `process.env.CLI_JAW_HOME` 설정 후 config.ts 동적 import
> known-command guard: `--home` 사용 시 알려진 명령어는 `bin/cli-jaw.ts`의 `_knownCmds`와 같다 (`serve` … `slack`, `messaging` 포함). 경로 누락과 서브커맨드를 구분한다

현재 subcommand router는 `bin/cli-jaw.ts` switch와 같다. Messaging operator surface: `jaw messaging ingress list|show|replay|audit`. SQLite maintenance surface: `jaw db maintain` (manual only).

### bin/commands/serve.ts

> Source/dist 자동 감지 foreground server 실행.

| Option | Env |
| --- | --- |
| `--port` | `PORT` |
| `--host` | `HOST` |
| `--open` / `--no-open` | `JAW_OPEN_BROWSER` |
| `--lan` | `JAW_LAN_MODE` |
| `--remote` | `JAW_REMOTE_ACCESS_MODE=direct` |
| `--trust-proxy` | `JAW_TRUST_PROXY` |
| `--trust-forwarded` | `JAW_TRUST_FORWARDED` |

### bin/commands/dashboard.ts

> `jaw dashboard serve [--port 24576] [--from 3457] [--count 50] [--no-open]`.
> `jaw dashboard service`는 현재 “later phase”로 거절된다.
> Electron app의 implicit manager spawn은 `24577-24590` lane을 사용하며 Web/CLI 기본 manager `24576`을 스캔하거나 공유하지 않는다.

| Option | Env |
| --- | --- |
| `--port` | `DASHBOARD_PORT` |
| `--from` | `DASHBOARD_SCAN_FROM` |
| `--count` | `DASHBOARD_SCAN_COUNT` |
| `--open` / `--no-open` | `JAW_DASHBOARD_OPEN` |

### bin/commands/clone.ts (165L)

> `jaw clone` — JAW_HOME 환경 복제. source 디렉토리 검증(존재 + settings.json 포함).
> `--from <path>`: 소스 지정. `--with-memory`: memory/ 디렉토리도 복사. `--link-ref`: skills_ref/ 심볼릭 링크.
> 복제 후 subprocess `regenerateB` 호출로 프롬프트/스킬 재생성.

| Function | 역할 |
| --- | --- |
| `cloneHome(args)` | 소스 검증 → 디렉토리 복사 → regenerateB 호출 |

### bin/commands/launchd.ts (163L)

> macOS launchd 서비스 관리. Multi-instance 지원.

| Function | 역할 |
| --- | --- |
| `instanceId()` | JAW_HOME → label 식별자 (`default` / `<name>-<md5hash8>`) |
| `xmlEsc(s)` | XML 특수문자 이스케이프 |
| `generatePlist(port)` | launchd plist XML 생성 |

- `parseArgs({ strict: false })` + manual unknown-key guard
- PLIST_PATH 더블-쿼팅으로 경로 공백 안전 처리
- `launchctl load/unload` 명령으로 서비스 시작/중지

### bin/commands/browser.ts / memory.ts

- `getServerUrl(undefined)` 패턴: PORT env 우선, 없으면 DEFAULT_PORT(`3457`)
- memory.ts: init 경로 `${JAW_HOME}/memory/` (하드코딩 `~/.cli-jaw` 제거)

### Saved permission policy at startup

Server startup loads and preserves the configured `permissions` value (`auto`, `safe` or a custom list). The selectors display `auto` as Auto (YOLO). The obsolete Safe-to-Auto coercion is removed so an explicit sidebar choice survives a restart. `tests/unit/server-permission-startup.test.ts` executes the startup source with isolated persistence and stubbed external effects across two starts.

### Draft pull request CI

Tests and Postinstall Platform Checks skip every job on draft pull requests,
including their aggregates. Skipped jobs are not passing test evidence.
`ready_for_review` restores normal PR validation. Existing push and manual
`workflow_dispatch` behavior is unchanged. A dependent draft chain can defer
hosted verification until its completed top branch, then dispatch the workflows
on that exact ref and verify each run's head SHA and producer conclusions.

### Retired runtime package boundary

The build no longer copies Jawcode TUI bundles, Bun shims or `pi_natives` payloads.
The obsolete Electron Jawcode source tree and `jaw jwc` installer module are gone.
The retired-runtime package smoke and staged/platform sidecar absence guards
check forbidden payloads while preserving ordinary Node/Jaw/native dependency
checks. Negative fixtures prove the guards reject a forbidden payload. An absent
staged sidecar is unverified and must not be reported as package absence proof.
Existing external installations and user files are never cleaned by retirement.
