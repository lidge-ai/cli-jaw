# cli-jaw

System-level AI agent with full computer control via CLI wrapping (pi, agy, claude, codex, codex-app, cursor, kiro-code, gemini, grok, opencode, copilot).

Native Code API: `/api/code` is composed by `src/code-mode/host.ts` and `src/routes/code-native.ts`. Keep per-backend storage, captured turn ownership, full snapshots/compact replay, byte limits, native approval capabilities, and observed process-exit proof aligned with `structure/runtime-integration.md` and `server_api.md`. It uses direct native adapters rather than Jaw orchestration or its runtime pools. Compact replay's one carve-out is Claude conversation rollback: it removes items and their events, replay below the replay floor answers `invalid_sequence`, and a higher `historyGeneration` requires a new snapshot.

Native Code interruption seals callbacks before persisting accepted buffered content under the captured store owner. Worker and Manager share the Code JSON body policy in `src/routes/code-body-parser.ts` (1MiB decoded prompt, 6MiB + 4KiB envelope); generic API limits stay separate. Settings navigation guards the drafts actually being discarded, including keyboard and desktop subscriptions.

## Repository Structure

```
lidge-ai/cli-jaw              ← public (this repo)
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public reference skills)
├── officecli/   (submodule)   ← lidge-jun/OfficeCLI (public)
└── .npmignore                 ← npm publish 시 submodules 제외
```

### Remote / 브랜치 정책 (푸시 전 필수)

`origin`은 `https://github.com/lidge-ai/cli-jaw.git` 이다. 체크아웃에 따라
`lidge-jun/cli-jaw` 나 `bitkyc08-arch/cli-jaw` 로 남아 있을 수 있는데, 둘 다 **같은 저장소의 옛 이름**이라
GitHub이 리다이렉트해 준다. 동작은 하지만 `gh`(항상 `lidge-ai/cli-jaw` 로 해석)와
이름이 갈려서 "이슈는 A에, 푸시는 B에" 처럼 보이는 착시를 만든다. 발견하면 고칠 것:

```bash
git remote -v                                                    # 확인
git remote set-url origin https://github.com/lidge-ai/cli-jaw.git
```

`dev`는 유일한 장기 브랜치이자 기본 및 릴리스 브랜치다. 피처 브랜치에서 작업하고 PR을 `dev`로 병합한다. 스택 PR은 아래부터 squash 병합하고 부모가 들어갈 때마다 `scripts/restack-pr.sh`로 자식을 옮긴다 (CONTRIBUTING.md §Stacked pull requests).

**PR 은 최소 계약만, 크로스플랫폼 CI 는 `dev` push(post-merge)가 담당한다** (opencodex
모델). `pull_request` 에서 `test.yml` 은 `changes` → { `test 1..4/4`
(`tests/run.mts --scope root,unit --shard i/4` 로 root+unit 4분할), `integration`
(`npm run build` + 3457 서버 위에서 `--scope integration,manager,bin` + fresh-install smoke),
`gates` (`gate:all` 과 나머지 스캔 1회) } → 필수 체크 `ci-aggregate` 의 리눅스 세트만 돌린다.
`windows-unit` 과 `macos-unit` 은 PR 을 스케줄하지 않고, 집계는 그 이벤트에서 두 레인의
skip 을 정상으로 읽는다. 피처 브랜치는 여전히 PR 을 열어야 이 최소 계약이 돈다.

`dev` push와 `workflow_dispatch`에서는 전체 그래프가 돈다. 위 리눅스 잡에 `windows-unit`(매니페스트 `scripts/ci/windows-unit-manifest.txt`, windows-latest)과 `macos-unit`(`scripts/ci/macos-unit-manifest.txt`, macos-latest)이 붙는다. `dev` push CI가 빨갛게 깨지면 fix-forward 한다.

`postinstall-platform.yml`은 `dev` push(`paths:` 필터 적용)와 `workflow_dispatch`에서 돈다. 릴리스에는 정확한 SHA의 성공한 플랫폼 런이 항상 필요하다.

두 매니페스트는 각각 `scripts/ci/{windows,macos}-unit-manifest.mjs` 가 Linux(gates 잡 + 단위
테스트)와 본 레인 양쪽에서 검증한다 — 이름이 바뀐 테스트는 레인에서 조용히 빠지지 않고 CI 를
깬다. 집계 규칙은 `scripts/ci/aggregate-check.sh` 가 갖고
`tests/unit/ci-aggregate-rules.test.ts` 가 진리표를 돌린다: 통과로 읽히는 skip 은 docs-only
(code=false) 와 pull_request 의 크로스플랫폼 레인 뿐이고, 그 외 skip/failure/cancelled 는 실패다.
자문용 `coverage` 는 `coverage-advisory.yml`(주간 스케줄 + dispatch)로 빠져 있어 집계에 들어가지 않는다.

### 릴리스 절차 (dev → tag → npm)

`bash scripts/release.sh`로 stable, `bash scripts/release.sh --preview`로 preview를 릴리스한다. `--major`, `--minor`, `--patch` 또는 명시적 `X.Y.Z` base를 선택할 수 있다. 스크립트는 깨끗한 최신 dev와 미게시 버전, 빌드·게이트를 확인하고 버전 커밋을 dev에 푸시한다. 정확한 SHA의 CI를 기다린 뒤 stable에는 설치 증거를 필수로 검사한다 (preview는 `--require-evidence`로 필수화). 이후 불변 `v<version>` 태그를 그 SHA에 만들고 `publish.yml`을 태그로 dispatch해 request-id로 해당 런을 찾아 완료까지 기다린다.

`publish.yml`은 실제 게시에서 태그만 받으며 dev ref는 dry-run에만 허용한다. 인증에는 정확한 SHA의 성공한 `dev` push Tests와 성공한 Postinstall Platform Checks가 항상 필요하다. 게시를 직렬화하고 새 버전의 dist-tag 순서를 검사하며, 두 채널의 GitHub release와 SHA를 지정한 desktop 빌드를 만든다.

#### 게이트가 막을 때

- 푸시 후 CI 실패: 실패한 런을 재실행한 뒤 미게시 커밋에서 `bash scripts/release.sh --resume <sha>`를 실행한다. 또는 fix-forward 후 새 버전을 만든다. 버전은 재사용하지 않는다.
- publish 실패·취소: 스크립트가 출력한 명령을 같은 태그로 다시 dispatch한다.
- 게시 후 GitHub release 또는 desktop 누락: 같은 태그로 다시 dispatch한다. 이 복구는 npm provenance로 게시된 패키지와 SHA의 일치를 검증한다.
- 자세한 절차는 `structure/infra.md` § 릴리스 파이프라인과 부분 실패 복구를 따른다.

#### 배포 확인은 npm 버전만으로 부족하다

설치 호스트에서 **실행 중인 프로세스가 새 `dist/` 를 로드했는지**까지 본다.
`npm i -g` 는 파일만 교체하고 서비스는 옛 코드를 계속 돌린다:

```bash
ssh <host> 'export PATH=~/.local/bin:$PATH; jaw --version'
ssh <host> 'grep -c <new-symbol> ~/.local/lib/node_modules/cli-jaw/dist/src/<path>.js'
ssh <host> 'export PATH=~/.local/bin:$PATH; jaw service restart'
ssh <host> 'ps -o lstart= -p $(sed -n "s/.*pid.: *\\([0-9]*\\).*/\\1/p" ~/.cli-jaw/jaw.pid.json|head -1)'
```

프로세스 시작 시각이 `dist/` mtime 보다 이르면 아직 옛 코드가 돌고 있다는 뜻이다.
비대화형 `ssh` 는 `.zshrc` 를 읽지 않으므로 PATH 를 직접 줘야 `jaw` 를 찾는다.

### Clone

```bash
# 코드만
git clone https://github.com/lidge-ai/cli-jaw.git

# 코드 + 공개 서브모듈 (skills, OfficeCLI)
git clone --recursive https://github.com/lidge-ai/cli-jaw.git
```

**Windows**: 추적 경로 길이는 `npm run check:path-length` 가 150자로 묶는다 (`gate:all` 포함).
상한이 260(MAX_PATH)이 아닌 이유는 실패 지점에 맞추면 clone 위치가 한 단계만 깊어져도
다시 깨지기 때문이다 — #430 의 경로는 223자였고, 200 상한에서도 74자 접두사 + 186자 경로가 다시 260에 걸렸다(#432). 150이면 74자 접두사 기준 224라 여유가 있다.

이 게이트가 있어도 예전 커밋을 체크아웃하면 긴 경로를 만날 수 있다. 그때 clone 은
**절반만 실패한다**: 앞선 서브모듈은 정상이고 하나만 비어 있어 워킹트리가 멀쩡해 보인다.

```bash
git -c core.longpaths=true clone --recursive https://github.com/lidge-ai/cli-jaw.git
```

### Submodule Update

서브모듈 수정 후 반드시 메인 레포에서도 ref 커밋:

```bash
cd skills_ref  # 또는 officecli
git add -A && git commit -m "update" && git push
cd ..
git add skills_ref && git commit -m "chore: update skills_ref ref" && git push
```

### Private records boundary

Private plans, audits, evidence, and development history belong only in a separate sibling clone of [cli-jaw-internal](https://github.com/lidge-jun/cli-jaw-internal). Request collaborator access through an [issue](https://github.com/lidge-ai/cli-jaw/issues).

Never create private records inside this checkout, including `devlog`, `_plan`, `_fin`, or `.jwc` aliases at any depth. This boundary overrides generic skill defaults. `docs/` and `structure/` hold public product documentation only; do not put private logs or private record paths in public docs or source. Agent harness state under the gitignored `.codexclaw/` (sessions, goalplans, ledgers) is local tool state, not a record store: plans, audits and reviews never go there either.

Before any public push, run `npm run check:private-boundary` for the index and `node scripts/check-private-boundary.mjs --range <remote-base> HEAD` for every outgoing commit tree. Follow [contributor hook setup](CONTRIBUTING.md#local-private-path-check) to enable `.githooks/pre-push` for this checkout; it invokes `--pre-push` using Git's stdin. Review content as well as paths and do not bypass the hook. CI is a backstop after upload, not a pre-disclosure guard.

The check enumerates submodule contents and fails on what it finds there, because `ls-files` stops at a gitlink and a record committed inside a submodule ships when that submodule is published. `JAW_PRIVATE_BOUNDARY_SUBMODULES=warn` downgrades that to reporting; it exists for a finding that must be fixed in the other repository first, and is not a setting to leave on. A submodule that is cloned and used on its own needs a check of its own — `skills_ref` has one in `validate_public_surface.py` — because a gate here can refuse to publish a submodule but cannot stop a commit landing inside it.

The same boundary check also rejects a `pr-assets` directory at any depth: PR screenshot evidence never lands on a code branch (see below).

### Pull request screenshots

A PR that changes rendered UI — `public/` (the manager dashboard / web frontend the Electron shell loads) or the Electron rendered surface (`electron/src/preload/`, markup/style/component files under `electron/`; pure test files excluded — exact rules in `.github/scripts/pr-screenshot.cjs`) — must embed a screenshot in its description. `pull_request_target` workflow `pr-screenshot-gate.yml` runs check `screenshot-gate` and fails otherwise — the workflow file executes from the repository's default branch, so the check activates once it reaches the default branch (`dev`). It reads the body for a rendered image (`![alt](url)`, `<img src>`, or a defined reference image — comments and code spans/fences do not count) and never checks out PR head code.

**Never commit screenshot evidence to the PR branch.** Agents and CLI uploads with push access push images to the orphan `pr-assets` branch and link by commit SHA:

```text
https://raw.githubusercontent.com/lidge-ai/cli-jaw/<sha>/<pr-or-date-slug>/<name>.png
```

Waivers: the `ui-screenshot-waived` label counts only when the label actor has write/maintain/admin access (checked via the issue event timeline), or a comment asserting no UI change ("no UI changes", "UI 변경 없음") posted after the latest push by someone with write/maintain/admin access (verified via `repos.getCollaboratorPermissionLevel`).

### Kanban

프로젝트 보드: https://github.com/users/lidge-jun/projects/2/views/1

### Architecture Docs Sync

Detailed architecture contract notes have moved to `structure/AGENTS.md` §Root contract notes.

Owner map (keep these docs synchronized when the surface changes):

- Desktop release / signing / notarization / staple → `structure/infra.md`
- Channel forwarders / Slack group DMs / Socket Mode / Slack progress / text & file sends / connection env ownership → `structure/telegram.md` + `structure/server_api.md`
- `permissions:auto` authority → `docs/slack-tools.md` + `structure/server_api.md`
- Manager sidebar / terminal / settings → `structure/frontend.md`
- Sidecar builds / isolated desktop QA → `structure/infra.md`
- Native event foundation / runtime selection / Claude native / Cursor native → `structure/runtime-integration.md` + `structure/stream-events.md`
- `structure/` reading map → `structure/INDEX.md`
- Sync rule: keep `README.md`, root `AGENTS.md`, root `CLAUDE.md`, and `structure/AGENTS.md` aligned when command/API/orchestration surfaces change.

Electron Builder 26 copies sidecar `node_modules` through an explicit `extraResources` FileSet with the sidecar exclusions preserved; local default/signed macOS commands and every desktop release matrix leg must smoke the packaged server tree after packaging and before upload.

### Native decisions

The Classic permission selector offers Auto (YOLO) / Safe choices, stored as literal `auto` / `safe`. Server startup preserves the saved policy; never reintroduce the obsolete safe-to-auto coercion. Existing runtime-specific policy support and settings invalidation still apply.

Pi capability preparation owns one asynchronous, completed-close version probe
per RPC instance; preparing input is not dispatched or treated as legacy yet.
Keep both capability getters live and typed finality unchanged. Direct Stop and
RPC exit enter the same bounded paired cleanup owner; persistent first failure
claims its result before cleanup. Pi worker deletion requires both the immutable
physical receipt and captured fresh-directory identity, never live workingDir
inequality. Uncertainty retains data, with no late automatic deletion. The old
3s resolver and opaque-wrapper/aggregate-shutdown limits remain explicit.
`PiRuntimeSession` is the native adapter: ACP claim/finalize, host `turnId`,
two-outcome `cancel()` (pooled `cancelLease` / oneshot abort-then-kill),
`runPiTurn` arm-then-`start()`, employee `openPiRpc` then `send`. `PiLease.retire`
and acquire `AbortSignal` are test-only this slice. Do not route pooled Pi
through `runNativeRuntime`. Sync runtime-integration and root notes; do not add
numeric tree signals or a registry.

Pi resolved stderr stays in a bounded private classifier buffer; caught error
diagnostics are redacted before bounding and never annotate stopped outcomes.
Captured-turn observers cannot alter immutable finals. Captured internal kill
reasons keep generic stopped wording instead of falling through to user Stop.

Interactive TUI Activity is implemented in `src/cli/tui/activity*.ts` and
`bin/commands/tui/activity*.ts`. Default Activity/explicit Legacy is independent of
transport. Snapshot owns live admission; F6 is read-only history, never a message/
Stop target selector. Journal text is redacted, not final: exact saved MESSAGE wins
over compatibility and preserves null/empty/whitespace. Keep missing-journal receipt
binding shared by live and replay, bounded GET/queue lifetime, native-absent diagnostic
separation, newer-run cleanup guards and draft-preserving late line output. Release
payload only after actual scrollback flush; raw/simple paths receive no new reads.
Sync commands/frontend/stream/tui-scrollback docs; broader visual/cross-runtime and
final integrated Electron QA have separate owners and are not implied by TUI tests.

Classic retained Activity uses `activity-history.ts` and the shared fixed-through
reader; the turn header is one `summary` row (chevron · status · latest action/steps ·
optional steer pill · count) with notices and the `Open in Trace` footer inside the
disclosure body. The recorded-run discovery disclosure was removed (260908 wp1).
Preserve original stored scope, bounded per-run replay,
focus-aware eviction and rejection of nested copied host keys. MESSAGE loading opts
into `withSession=1`; `/api/messages/by-trace/:runId?session=...` returns a unique
exact saved answer (16MiB,409 ambiguity), never grants source Trace access to forks.
Cache/VS IDs are not server MESSAGE IDs. Keep raw Trace at80 rows with paging and
honor denied/unverified actions. See frontend/API docs; TUI request records remain read-only.

`presentation.mode` accepts only activity/legacy; absence defaultsActivity for fresh/upgraded homes, explicitLegacy survives reload, and perCli.transport is independent. Explicit known mode and/or eligible transport-only API patches preserve admitted-run ownership and skip fallback reset/singleton sync. Keep legacy presentation-subtree skips separately, and retain serialization, persistence rollback and messaging dispatch. Mixed execution-changing/unknown/empty leaves retain invalidation; external-file transport edits still invalidate while API self-write echoes are ignored. Classic preference refresh uses the existing bounded reader and shared load/event generation; never replace native-request-bridge with the old Web donor. Manager Display owns singleflight, disabled/guarded edits, captured dirty acknowledgement and client/port epochs. Classic live and retained Activity consume the canonical stream and journal; Manager and TUI have separate instance and input lifecycle owners. Keep bounded views, current-run final ownership and independent request controls.

Print Activity uses `runtime/print-projection.ts` and `print-activity.ts` as observers, never final selectors. Only accepted parser text enters; stderr/control output stays raw. Lifecycle supplies the application-final and existing bypass/retry paths close once. Preview loss is non-fatal: one `projection_degraded` control loss and scoped `agent_runtime_gap` mark replay incomplete while later bounded rows and the lifecycle-selected turn-end continue, though new items may be omitted; only journal write/integrity failure or real admission caps seal (`run_limit` is 4096 rows/4MiB). `RuntimeProjection.close()` latches reentrancy for every owner and falls back to a status-only terminal tool row when even a trimmed terminal row cannot fit the preview budget. `merge-tool-log.ts` reconciles exact run/ref or run/seq identities; unknown workers never borrow boss identity. Bounded snapshot hydration retains known RAM omission with the sanitizer's explicit max-overlap option; default append/storage counting is unchanged. Only print opts into terminal tool refresh; native default freeze/enrichment, Claude pending-worker cancellation and Slack final/ACK/queue owners remain intact.

Activity journal: `src/trace/activity-{journal,control,retention}.ts` owns bounded immutable runtime rows and private control metadata. Capture durable chat/scope on all trace starts; internal append is allowed, public replay is not. Session discovery/replay and owned raw routes require the explicit original session under existing instance auth. Only original message links backfill owners; forks cannot acquire source traces. Keep `onlyIfRunning` close ordering, first-loss metadata, whole-prefix retention and final/Slack independence. Sync `structure/runtime-integration.md`, `server_api.md`, `stream-events.md`; timeline/default/print presentation are separate layers.

`src/agent/runtime/requests.ts` and `acp/callbacks.ts` own bounded pending decisions, opaque native-option mapping and cancellation latches. `GET /api/runtime/requests?sessionId=...` and `POST /api/runtime/requests/:id` use the existing instance auth policy (including loopback/LAN bypass), never a current-session fallback. Match run/session/scope/turn and current ownership before answering. Canonical sanitization and the32KiB event preflight precede insertion; global128/120s and per-connection32 bounds apply. An admitted ACP selected write cannot be retracted: cancellation during dispatch retires the connection. Route-owned `agent_runtime_requests_changed` is an SSE-only metadata hint: its scope routes to the captured chat's presentation surface, while live GET/POST retain original execution scope. The Classic request panel keeps stream health separate from manual REST freshness and never retries POST automatically. Do not broadcast notices to messaging or infer Activity defaults/history from this panel. Sync `structure/runtime-integration.md` and `structure/server_api.md`.

Native quota readers follow the OpenCodex source contract: Codex window duration/plan policy, Spark and reset-credit metadata; Claude model-scoped windows and credential-scoped cache. Missing measurements remain unknown, 429 alone never means 100%, and upstream bodies are bounded. See `docs/migration/quota-reader-parity.md`.

### Concurrent inbound gateway (M1)

- Settings schema v4 replaces top-level `channel` with `messaging.enabledChannels` (array) and `messaging.homeChannel`. New installs start with an empty enabled set; existing v3 `channel` is migrated to a one-element enabled set and matching home channel, then deleted from persisted settings.
- `/api/settings` still returns `channel` as a deprecated read-only alias of `messaging.homeChannel` for one major version. PUT `{channel}` is translated into `enabledChannels: [channel]` + `homeChannel: channel` with a `Deprecation` response header.
- `src/messaging/runtime.ts` exposes `getEnabledChannels()`, `getHomeChannel()`, `initEnabledMessagingRuntimes()`, and per-channel `startMessagingTransport()`/`stopMessagingTransport()`. `restartMessagingRuntime()` restarts only channels affected by an enabled-set, per-channel config, or locale change; a home-only change does not restart transports.
- `src/messaging/channel-health.ts` adds `activeInboundChannels` (running channels) while keeping the legacy scalar `activeInbound` as `homeChannel` for backward compatibility. Both Classic and Manager parsers prefer the new array and fall back to the legacy scalar.
- Outbound routing in `src/messaging/send.ts` resolves `target.channel > explicit channel > homeChannel`; proactive sends with no target use `homeChannel`.

### Mid-run steer (기본 정책)

- Claude unleased acquisition cleanup stays attached to its captured main/worker control after logical settlement; rejected cleanup is not physical completion. Late completion must not replay lifecycle or run main through worker-directory cleanup. Main steer, slash fallback and queue steer use the main-only wait while inclusive scoped/global shutdown still counts workers; preserve the following exit-settle/salvage barrier. See `structure/runtime-integration.md` and `structure/prompt_flow.md`.

- `multiSession.midRunPolicy` 기본값은 `'steer'`다. steer 가능한 Codex App turn은 in-band 입력을 받는다. Native Cursor와 Grok은 `replaceTurn` 훅으로 원래 prompt 취소 응답·업데이트·callback을 모두 처리한 뒤 같은 native session에 다시 요청한다. 이는 `cancel-reprompt`이며 native-input이 아니다. Cursor는 원래 요청·수락된 추가 지시·제한된 부분 출력을 읽기 전용 문맥으로, 현재 운영 지침을 활성 지침으로 복원한다. Grok에는 이 재주입을 적용하지 않는다.
- Native Cursor와 Grok은 전송 완료 뒤에도 main 객체·세대·정규 소유권을 재검사하고 입력을 한 번만 기록한다. 진행 중인 replacement의 후속 입력은 큐로 갈 수 있지만, 취소·전송·기록 실패는 자동 재시도하지 않는다. Stop으로 무효화된 입력은 실제 enqueue까지 보호하고 `cancelled`로 끝내며, 이후 새 입력은 받을 수 있다. 나머지 런타임의 기존 in-band/kill-steer 동작과 `followup`/`collect` 대기는 유지한다.
- `/steer`는 런타임 훅을 사용한다. 별도 `/queue steer <n>`은 기존 항목을 중단 후 우선 실행하는 동작을 유지한다. Kill 경로의 제한된 부분 출력은 pre-kill MAX(id)와 정확한 exit-settle 배리어 뒤 `withSteerContext`로 복원한다. 전체 과거 맥락 보존을 보장하지 않는다. 정책 표는 `structure/prompt_flow.md`를 참고한다.
- `/api/code` Claude sessions accept one in-band follow-up per streaming turn; jaw kill/resume unchanged.

### Korean Content Skill Routing

Korean promotional/content writing (홍보 쓰레드, 인스타 카드뉴스, 링크드인, 웹/블로그 게시물)는 active `k-writing` skill이 소유한다. 임의 산문으로 바로 작성하지 말고 channel routing → mandatory pre-search → hook 3안 scoring → tone/module formatting → anti-AI-tell + 인간다움 checklist를 거친다. `k-thread-gen`은 retired label로만 언급하고 새 라우팅 이름으로 쓰지 않는다.

**생성과 수정의 경계**: `k-writing`은 플랫폼용 콘텐츠를 **생성**한다. 이미 쓴 한국어를
**고치는** 일(윤문)은 `jaw-dev-write`가 소유하고, 사람에게 보낼 답변을 **구성**하는 일은
`jaw-dev-speech`가 소유한다. 셋은 배타적이다 — `k-writing`이 초안을 만들면 `jaw-dev-write`가
그 초안에 윤문 프로토콜을 건다. 순서는 생성 → 윤문이며 반대가 아니다. 두 새 스킬은
`skills_ref/registry.json`에 `category: orchestration`으로 등록되어 자동 활성 대상이다.

### Build & Deploy Contract (서버 코드 변경 시 필수)

**실행 중인 서버는 TS 소스가 아니라 컴파일된 `dist/`를 실행한다** (`jaw serve` → `dist/server.js`, CLI → `dist/bin/cli-jaw.js`). 소스만 커밋하고 빌드를 빼먹으면 서버를 재시작해도 변경이 반영되지 않는다 (260610 `/api/project/pick` 404 사고의 원인).

서버/CLI 코드(`server.ts`, `src/**`, `bin/**`)를 변경했다면:

```bash
npm run build           # tsc → dist/ atomic swap (prebuild: ensure:native 포함)
npm run build:frontend  # public/js·public/manager 변경 시 (→ public/dist)
```

- 변경 반영 단위 = **커밋 + 해당 빌드 + 서버 재시작** 3종 세트. 빌드 없이 "재시작하면 됩니다"라고 안내하지 말 것.
- 프론트엔드(`public/js/*.ts`, `public/manager/src/**`)는 `build:frontend`만으로 충분하며 서버 재시작 없이 브라우저 새로고침으로 반영된다 (`public/dist` 정적 서빙).
- 반영 여부 검증: `grep <new-symbol> dist/...` 또는 해당 엔드포인트 curl로 확인 후 안내.

이건 로컬 빌드/재시작 계약이고, 배포(release)는 별개다. 릴리스 경로는 `dev → v<version> tag → publish.yml`이며 스크립트는 게시 런의 완료를 기다린다. 부분 실패·롤백 복구 절차는 `structure/infra.md` § 릴리스 파이프라인과 부분 실패 복구를 따를 것.

### Test Scope (`npm test`는 전체가 아니다)

`npm test`는 root와 `tests/unit/`만 실행한다 (`tests/run.mts`의 파일 수집). `tests/integration/`·
`tests/manager/`·`tests/bin/`은 **포함되지 않으므로**, "전체 스위트 통과"를 근거로 삼기 전에 범위를 확인할 것.
CI 는 그 세 디렉터리를 `integration` 잡에서 실제 서버(3457)와 함께 돌린다 (#565); provider 인증이 필요한
`agy-print-smoke`·`codex-app-multiplex-activation` 두 파일만 opt-in 격리(quarantine)로 남는다.

```bash
npm test                         # root + tests/unit/ (integration 제외)
npm run test:shard -- 1/4        # 위 집합의 결정적 1/4 (CI 의 test i/4 와 같은 분할)
npm run test:integration:all     # tests/integration + manager + bin (CI integration 잡과 같은 집합; TEST_PORT 서버 필요)
npm run test:all                 # 전부
npx tsx --experimental-test-module-mocks tests/run.mts --scope unit --shard 2/4 --list   # 실행 없이 선택 파일만 출력
```

- 회귀 판정은 깨끗한 baseline과 `comm -13`으로 비교해 **신규 실패 0건**을 증명한다.
- 테스트 파일은 각자 별도 프로세스로 돌고, 파일마다 새 `CLI_JAW_HOME`(= 새 `jaw.db`)을 받는다
  (`tests/run.mts` 가 `execArgv` 로 `tests/setup/test-home.ts` 를 자식마다 다시 import). 한 파일 안에서
  DB 를 공유하는 케이스는 여전히 한 파일에 모으거나 주입 지점으로 DB 를 우회할 것.
- 샤드 분할은 바이트 순 정렬 + `index % N` 이라 파일이 추가되면 배정이 옮겨진다; 새로 CI 에서만 깨지는 파일은
  `--list` 로 같은 샤드 동료를 확인한 뒤 로컬에서 그 샤드를 그대로 돌려 재현한다.
- 소스를 정규식으로 검사하는 테스트는 리팩터링 때마다 의미 없이 깨진다. 새로 만들지 말고,
  기존 것이 깨지면 문자열을 갱신하기 전에 **동작 검증으로 교체할 수 있는지** 먼저 볼 것.

### File Tree Format (`str_func.md`)

`str_func.md` 의 파일 트리는 **멤버십 지도**다. 줄 수·파일 수 같은 파생값은 적지 않는다
(스택 병합마다 충돌을 만들던 원인이었다).

```
├── server.ts          ← 설명
```

- 검증: `bash structure/verify-counts.sh` — 모든 파일 항목이 실제 파일을 가리켜야 통과 (`gate:doc-drift` 가 CI 에서도 실행)
- 새 파일은 항목을 추가하고, 지운 파일은 항목도 지운다. 항목이 없는 추적 파일은 `--verbose` 로 볼 수 있다 (권고, 실패 아님)

### OfficeCLI (On-Demand)

OfficeCLI is NOT bundled with cli-jaw postinstall. It is installed on-demand when skills need L1/L2 features or HWP support.

- **Format support**: .docx, .xlsx, .pptx, .hwpx, .hwp (HWP via rhwp sidecars)
- **Install (forked, CJK + rhwp)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh"`
- **Install (upstream, vanilla)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh" --upstream`
- **Smoke test**: `officecli --version && officecli capabilities --json`
- **Binary priority**: `OFFICECLI_BIN` env → global `officecli` → not available
- **Fork**: `lidge-jun/OfficeCLI` (CJK-enhanced, rhwp sidecars) vs. `iOfficeAI/OfficeCLI` (vanilla)
- **Safety**: Never run parallel officecli processes on the same file
- **Which repo**: the fork is required only for CJK font handling and HWP. For general
  .xlsx/.docx/.pptx work use `--upstream` — the fork's latest release (`v1.0.98`, checked
  2026-08-12) publishes only `officecli-mac-arm64`, so a fork install cannot succeed on
  Windows, Linux, or macOS x64. The installer now checks the release asset list and fails
  with that explanation instead of a bare 404 (#280).
- **Never use `officecli import`**: it writes ZERO cells while reporting an accurate row and
  column count, and `officecli validate` then passes on the empty workbook. Reproduced on
  upstream 1.0.143 for every input shape, so upgrading is not an escape (#279, #295, #301).
  Load cells through `officecli batch --input <file>` and prove the result with
  `officecli view <file> stats` (Total Cells > 0). Use `--input`, not `--commands '<json>'`:
  PowerShell strips the inner quotes and the parser error then blames the JSON (#296).

### Windows shell hazards (agent-authored scripts)

Three failures that all look like something else. None is a bug in a fixed cli-jaw
code path — they bite whatever the agent writes at runtime, so they belong here
rather than in a module.

- **Write `.ps1` files with a UTF-8 BOM.** Windows PowerShell 5.1 reads a BOM-less
  file as the ANSI code page — CP949 on a Korean host — so every non-ASCII string
  literal is corrupted *before* the script runs. It either dies with a parser error
  or, worse, runs with silently mangled data. Prepend `\uFEFF`, or use
  `Set-Content -Encoding UTF8`. PowerShell 7+ defaults to UTF-8 and does not need
  it, but the shipped Windows shell is 5.1 (#302).
- **Probe for tools with the right shell's verb.** `command -v` is not a PowerShell
  builtin or cmdlet: it prints nothing, sets no exit code, and raises no error, so a
  working install reads as missing. Use `Get-Command <tool> -ErrorAction
  SilentlyContinue`, or `<tool> --version` portably (#298).
- **Pass JSON to a CLI through a file, not an inline argument.** PowerShell strips
  the inner double quotes from `--commands '<json>'` before the process sees them,
  and the resulting parser error blames the JSON, which was fine. Use
  `--input <file>` (#296).

```bash
officecli create file.docx                                          # create blank
officecli view file.docx text                                       # view content
officecli add file.docx /body --type paragraph --prop text="..."    # add content
officecli set data.xlsx /Sheet1/A1 --prop value="42"                # set cell
officecli add deck.pptx / --type slide --prop title="Title"         # add slide
officecli create file.hwpx                                          # create blank HWPX
officecli hwp doctor --json                                         # HWP/rhwp readiness
officecli create file.hwp --json                                    # create blank HWP when rhwp-field-bridge is ready
officecli add file.hwp /text --type paragraph --prop value="..." --prop output=out.hwp --json
officecli view file.hwp pdf --out out.pdf --json                    # export HWP through rhwp sidecars
officecli set file.hwp /native-op --prop op=split-paragraph --prop output=out.hwp --json
officecli validate file.docx                                        # validate
officecli get file.docx / --json                                    # JSON output
echo '[...]' | officecli batch data.xlsx --json                     # batch ops
```

#### OfficeCLI Rebase Hygiene

When rebasing the `officecli` submodule fork onto `iOfficeAI/OfficeCLI`, preserve the HWP/rhwp commits and keep generated Rust outputs out of history.

```bash
cd officecli
git fetch upstream
git status --short --branch
git branch backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
git tag backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
```

- Rebase onto `upstream/main`, then resolve conflicts by preserving upstream OfficeCLI core changes plus local HWP/rhwp routing, help, capability, fixture, and bridge code.
- If `src/rhwp-field-bridge/target/` or any Rust `target/` output blocks rebase/cherry-pick, move or delete that generated directory before continuing. It is build output, not source.
- If an old commit accidentally stages Rust build artifacts, stop before committing and run `git rm -r --cached src/rhwp-field-bridge/target` plus `rm -rf src/rhwp-field-bridge/target`; commit only source, fixtures, tests, and docs.
- After every rebase, verify `git ls-files 'src/rhwp-field-bridge/target/*' | wc -l` returns `0`.
- Required checks before force-pushing the rebased feature branch:
  - `dotnet build officecli.slnx`
  - `cargo build --manifest-path src/rhwp-field-bridge/Cargo.toml`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --filter FullyQualifiedName~HwpBridge --no-build`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --no-build`
- Push rebased `feat/hwpx` with `git push --force-with-lease origin feat/hwpx`, then commit the updated `officecli` submodule pointer in this repo.

### Retired runtime boundary

JWC, Claude E (`claude-e`) and AI-E (`ai-e`) are recognized stored tombstones,
never executable CLI keys. Preserve the saved selection and unrelated settings;
report `retired_runtime:jwc`, `retired_runtime:claude-e` or
`retired_runtime:ai-e` before any fallback or admission. Do not silently select
another provider. Manager/Classic show the retired selection without making it
selectable. TUI uses local `src/cli/tui/presentation.ts`; keep SDK, helper
crates, bundles and installer payloads absent.

- Boss user prompts include host-local civil dates and Monday–Sunday ranges via `src/agent/calendar-context.ts`; the timestamp and calendar share one clock sample. Explicit user timezone/week conventions take precedence; system-prompt caching and worker/internal prompts stay unchanged.

- Optional pinned local services use `scripts/service-artifact.mjs` with an externally anchored manifest digest and an immutable package tree. Activation and registration remain explicit; keep the prior registration for rollback. See `docs/pinned-service-artifacts.md`.

Slack file CLI uses an explicit conversation and completion-only upload receipts (`sent: boolean|unknown`, no auto retry or caption fallback); cancellation preserves known/unknown delivery. Sync commands/API/Slack docs.

Slack `trustedBotTriggers` lets one named bot start a turn here: a fully validated rule plus a self-mention opens exactly the `bot_message` subtype, `allowBots` and `mention_via_app_mention` refusals, and nothing else. One malformed rule voids the whole list, and `isSlackMention` stays narrow because it also decides thread ownership. See `structure/infra.md` §`src/slack/`.

Optional `workflowSkill` selects the operator-configured execution route only after the actual sender/channel/bot-user/marker match and self-mention. Load only the selected enabled skill, bounded to 64 KiB; unverified sender/request context or unavailable or ambiguous skill selection is visibly blocked with no model fallback. Four-key rules keep legacy behavior. Empty or standalone `SILENT` workflow results require an unconfirmed notice and failure ACK, with no automatic rerun because effects may already exist. Preserve normal approval, tool grants and source permissions; an AI reply is not business-completion proof. See `docs/slack-tools.md`.

Opted-in workflow requests use the `followup` queue when busy; never steer or collect them into an unrelated running turn. Read the selected skill at admission and preserve its captured content, hash and source metadata across queueing and restart. Silent outcomes settle the workflow request as unconfirmed/failed while preserving provider/native final text and status; never automatically rerun.
- Aside: Settings Agent/Model defaults use explicit account and read-only `/api/aside/models`; account saves clear stale overrides. Experimental main-only CLI, explicit `perCli.aside.account=uN`/`host=local`; capture concrete catalog model/effort and cwd/policy before awaits. Safe→guard, Auto→full-access; other policies/workers/internal flush/images/Code/pools/automatic retry/fallback unsupported. Normal steer and `/steer` queue; `/queue steer` rejects. Owned replay selects exact finals; logs are diagnostics. Uncertain cleanup retains captured scope and blocks queue draining. After external reconciliation, authenticated `POST /api/orchestrate/aside/reconcile` `{sessionId, acknowledgementToken, acknowledged:true}` validates exact chat/run token and captured child close, purges input and permits fresh input only. See `structure/runtime-integration.md`.
