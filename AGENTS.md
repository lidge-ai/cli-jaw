# cli-jaw

System-level AI agent with full computer control via CLI wrapping (pi, agy, claude, codex, codex-app, cursor, kiro-code, gemini, grok, opencode, copilot).

Native Code API: `/api/code` is composed by `src/code-mode/host.ts` and `src/routes/code-native.ts`. Keep per-backend storage, captured turn ownership, full snapshots/compact replay, byte limits, native approval capabilities, and observed process-exit proof aligned with `structure/runtime-integration.md` and `server_api.md`. It uses direct native adapters rather than Jaw orchestration or its runtime pools.

Native Code interruption seals callbacks before persisting accepted buffered content under the captured store owner. Worker and Manager share the Code JSON body policy in `src/routes/code-body-parser.ts` (1MiB decoded prompt, 6MiB + 4KiB envelope); generic API limits stay separate. Settings navigation guards the drafts actually being discarded, including keyboard and desktop subscriptions.

## Repository Structure

```
lidge-jun/cli-jaw              ← public (this repo)
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public reference skills)
├── officecli/   (submodule)   ← lidge-jun/OfficeCLI (public)
└── .npmignore                 ← npm publish 시 submodules 제외
```

### Remote / 브랜치 정책 (푸시 전 필수)

`origin`은 `https://github.com/lidge-jun/cli-jaw.git` 이다. 체크아웃에 따라
`bitkyc08-arch/cli-jaw` 로 남아 있을 수 있는데, 이건 **같은 저장소의 옛 이름**이라
GitHub이 리다이렉트해 준다. 동작은 하지만 `gh`(항상 `lidge-jun/cli-jaw` 로 해석)와
이름이 갈려서 "이슈는 A에, 푸시는 B에" 처럼 보이는 착시를 만든다. 발견하면 고칠 것:

```bash
git remote -v                                                    # 확인
git remote set-url origin https://github.com/lidge-jun/cli-jaw.git
```

**작업은 전부 `dev` 에서 한다. `main` 과 `preview` 는 머지만 받는 브랜치다.**
거기에 직접 커밋하지 않는다.

**`dev` 는 항상 `main` 위에 fast-forward 가능한 상태로 유지한다.** merge 커밋으로
main 을 끌어와 히스토리를 갈래지게 만들지 말고, rebase 로 main 바로 위에 올린다:

```bash
git fetch origin
git branch -f backup/dev-pre-rebase-$(date +%y%m%d) HEAD   # 되돌릴 지점
git rebase origin/main
git merge-base --is-ancestor origin/main HEAD && echo ff-able
git push --force-with-lease origin dev
```

rebase 중 만나는 충돌은 대개 두 종류이고 해소법이 정해져 있다.

- **버전 파일**(`package.json`, `package-lock.json`, `electron/*`): main 쪽을 취한다
  (`--theirs`). 이건 릴리스 장부이지 작업 산출물이 아니다. 오래된 preview 승격
  커밋이 replay 되려 하면 `git rebase --skip` — 버전을 되돌리는 것 말고 하는 일이 없다.
- **`structure/str_func.md`**: 어느 쪽도 고르지 말고 실제 트리에서 다시 만든다.
  줄 수는 파생값이다 — `bash structure/verify-counts.sh --fix` 후 재검증.

**`dev` 푸시는 `test.yml` 을 돌린다 (#521부터).** 예전에는 아무것도 돌지 않아서
`a241c6222` 같은 커밋이 check-run 0개로 `dev` 위에 앉아 있었다. 다만
`postinstall-platform.yml` 은 여전히 `preview`/`main` push 와 `pull_request` 에만
반응하므로 **설치 표면(installer surface) 증거는 `dev` 푸시로 얻을 수 없고**,
피처 브랜치는 여전히 PR 을 열어야 CI 가 돈다.

`test.yml` 은 샤딩된 잡 그래프다 (#565, opencodex `ci.yml` 이식):
`changes` → { `test 1..4/4` (root+unit 을 `tests/run.mts --scope root,unit --shard i/4` 로 4분할),
`integration` (`npm run build` + 3457 서버 위에서 `--scope integration,manager,bin` + fresh-install smoke),
`gates` (`gate:all` 과 나머지 스캔 1회), `windows-unit`, 자문용 `coverage` } → 필수 체크 `ci-aggregate`.
Windows 레인의 파일 목록은 `scripts/ci/windows-unit-manifest.txt` 에 있고 Linux 에서도 검증된다
(`scripts/ci/windows-unit-manifest.mjs`). 집계 규칙은 `scripts/ci/aggregate-check.sh` 가 갖는다 —
docs-only 변경에서만 producer skip 이 통과로 읽히고, 그 외 skip/failure/cancelled 는 실패다.
`coverage` 는 `dev` push 와 `workflow_dispatch` 에서만 돌고 집계에 들어가지 않는다.

`dev` 가 릴리스 브랜치가 된 것은 아니다. `publish.yml` 은 인증 런을 SHA 로 찾되
**`preview`/`main` 런만** 받아들이고(`:76` 의 `headBranch` 필터, #521 에서 좁힘),
승격은 `--branch preview` 로 찾는다(`scripts/promote-to-main.sh:28-34`). 이 필터가
필요한 이유는 위 ★ 단계가 매 사이클 `dev` 를 preview head 로 맞추기 때문이다 —
같은 SHA 에 양쪽 런이 생기므로, 필터가 없으면 `dev` 런이 릴리스를 인증할 수 있었다.
확인은 어느 경우든 SHA 대조로 한다:

```bash
git rev-parse HEAD
gh pr checks <n>
gh run view <run-id> --json headSha,conclusion
```


### 릴리스 절차 (dev → preview → main → npm)

개발은 `dev` 에서만 한다. `preview` 와 `main` 은 이 절차를 통해서만 움직인다.

```bash
git checkout dev && git fetch origin
git rebase origin/main                      # ff-able 유지
bash scripts/release-preview.sh             # 버전 범프 + gate:all + preview 푸시 + preview publish
git push origin dev                         # dev 를 preview head 와 같게 맞춘다  ★
bash scripts/promote-to-main.sh             # preview CI 인증 확인 → main 승격 → stable publish
```

**★ 를 빼먹으면 다음 사이클이 어긋난다.** `release-preview.sh` 는 버전 범프를
현재 브랜치에 커밋하고 `HEAD:preview` 로 푸시한다. 그 커밋을 `dev` 에도 올리지
않으면 origin/dev 만 뒤처진 채 남는다.

#### 승격은 fast-forward 다 (#480)

`promote-to-main.sh` 는 stable 버전 범프를 **preview 위에** 커밋하고, preview 를
거기까지 ff 한 뒤, CI 인증이 끝나면 `main` 을 **같은 커밋으로** ff 한다. PR 도
squash 도 없다. 그래서:

- `main` 은 preview 에 없는 커밋을 절대 갖지 않는다. 조상 관계가 정의상 유지되므로
  재정렬이라는 단계 자체가 없다.
- npm 에 발행되는 SHA 가 CI 가 인증한 SHA 와 **문자 그대로 같다.** 같은 트리의 복사본이
  아니다. `publish.yml` 의 `certified-sha` 우회 장치가 필요 없어진 이유다.
- 스크립트 말미가 `dev` 도 같은 커밋으로 ff 한다. dev 가 이미 앞서 있으면 건드리지
  않고 `NOTE:` 를 남기므로, 그때는 `git merge origin/main` 으로 dev 에 릴리스 선을
  들여놓는다.

`main` 푸시는 `--force` 를 쓰지 않는다. non-ff 를 git 이 스스로 거부하는 것이 이
구조의 실제 보증이므로, 실패하면 강제로 밀지 말고 왜 갈라졌는지부터 볼 것.

예전에는 squash 승격이 매 사이클 조상 관계를 끊었고, 그 복구가 수동이라 #418 의
durable queue-notice store 가 통째로 사라진 채 `cli-jaw@2.17.13` 이 발행됐다.
#468 이 자동 재정렬로 그 증상을 막았지만 dev 와 preview 에 각각 다른 커밋을 만들어
두 브랜치를 영구히 갈라놓았다(쌍둥이 8개 누적). ff 승격은 그 원인을 없앤다.

#### 게이트가 막을 때

- **`origin/main is not an ancestor of the certified preview SHA`** — preview 를
  force-push 해서 main 이 조상에서 빠졌거나, **승격이 이미 끝난 뒤 스크립트를 다시
  돌린** 경우다. `git log --oneline origin/preview..origin/main` 으로 main 이 이미
  그 버전을 갖고 있는지부터 볼 것. 갖고 있으면 승격은 성공한 것이고 재실행할 일이
  아니다 — `promote-to-main.sh` 는 승격 후 재실행을 지원하지 않는다.
- **`No successful Postinstall Platform Checks run found for <sha>`** — 승격이
  preview 의 CI 를 기다린 뒤 main 을 ff 하므로 보통은 나지 않는다. 그래도 났다면
  해당 SHA 의 preview push 런이 실패했거나 아직 안 끝난 것이다. 런이 끝나기를
  기다렸다가 publish 만 다시 dispatch 하면 된다. 승격을 되돌릴 필요는 없다.
- **`! [rejected] ... (non-fast-forward)`** — main 이 preview 에 없는 커밋을 갖고
  있다는 뜻이다. **강제로 밀지 말 것.** 무엇이 main 에만 들어갔는지
  (`git log --oneline origin/preview..origin/main`) 부터 확인하고, 그것을 preview 로
  가져와 다시 ff 가 되게 만든다.

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
git clone https://github.com/lidge-jun/cli-jaw.git

# 코드 + 공개 서브모듈 (skills, OfficeCLI)
git clone --recursive https://github.com/lidge-jun/cli-jaw.git
```

**Windows**: 추적 경로 길이는 `npm run check:path-length` 가 150자로 묶는다 (`gate:all` 포함).
상한이 260(MAX_PATH)이 아닌 이유는 실패 지점에 맞추면 clone 위치가 한 단계만 깊어져도
다시 깨지기 때문이다 — #430 의 경로는 223자였고, 200 상한에서도 74자 접두사 + 186자 경로가 다시 260에 걸렸다(#432). 150이면 74자 접두사 기준 224라 여유가 있다.

이 게이트가 있어도 예전 커밋을 체크아웃하면 긴 경로를 만날 수 있다. 그때 clone 은
**절반만 실패한다**: 앞선 서브모듈은 정상이고 하나만 비어 있어 워킹트리가 멀쩡해 보인다.

```bash
git -c core.longpaths=true clone --recursive https://github.com/lidge-jun/cli-jaw.git
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

Private plans, audits, evidence, and development history belong only in a separate sibling clone of [cli-jaw-internal](https://github.com/lidge-jun/cli-jaw-internal). Request collaborator access through an [issue](https://github.com/lidge-jun/cli-jaw/issues).

Never create private records inside this checkout, including `devlog`, `_plan`, `_fin`, or `.jwc` aliases at any depth. This boundary overrides generic skill defaults. `docs/` and `structure/` hold public product documentation only; do not put private logs or private record paths in public docs or source.

Before any public push, run `npm run check:private-boundary` for the index and `node scripts/check-private-boundary.mjs --range <remote-base> HEAD` for every outgoing commit tree. Follow [contributor hook setup](CONTRIBUTING.md#local-private-path-check) to enable `.githooks/pre-push` for this checkout; it invokes `--pre-push` using Git's stdin. Review content as well as paths and do not bypass the hook. CI is a backstop after upload, not a pre-disclosure guard.

The check enumerates submodule contents and fails on what it finds there, because `ls-files` stops at a gitlink and a record committed inside a submodule ships when that submodule is published. `JAW_PRIVATE_BOUNDARY_SUBMODULES=warn` downgrades that to reporting; it exists for a finding that must be fixed in the other repository first, and is not a setting to leave on. A submodule that is cloned and used on its own needs a check of its own — `skills_ref` has one in `validate_public_surface.py` — because a gate here can refuse to publish a submodule but cannot stop a commit landing inside it.

The same boundary check also rejects a `pr-assets` directory at any depth: PR screenshot evidence never lands on a code branch (see below).

### Pull request screenshots

A PR that changes rendered UI — `public/` (the manager dashboard / web frontend the Electron shell loads) or the Electron rendered surface (`electron/src/preload/`, markup/style/component files under `electron/`; pure test files excluded — exact rules in `.github/scripts/pr-screenshot.cjs`) — must embed a screenshot in its description. `pull_request_target` workflow `pr-screenshot-gate.yml` runs check `screenshot-gate` and fails otherwise; it reads the body for a rendered image (`![alt](url)`, `<img src>`, or a defined reference image — comments and code fences do not count) and never checks out PR head code.

**Never commit screenshot evidence to the PR branch.** Agents and CLI uploads with push access push images to the orphan `pr-assets` branch and link by commit SHA:

```text
https://raw.githubusercontent.com/lidge-jun/cli-jaw/<sha>/<pr-or-date-slug>/<name>.png
```

Waivers: the `ui-screenshot-waived` label counts only when the label actor has write/maintain/admin access (checked via the issue event timeline), or a maintainer comment negates UI impact ("no UI changes").

### Kanban

프로젝트 보드: https://github.com/users/lidge-jun/projects/2/views/1

### Architecture Docs Sync

- The canonical desktop release workflow must Developer ID-sign macOS with Team `U9ATA49N28`, notarize, staple, verify the final app, and verify channel metadata plus the update ZIP SHA-512 before upload. `electron:dist:mac:signed` is the equivalent opt-in local path; ordinary `electron:dist:mac` remains ad-hoc. Windows remains unsigned. Keep README and `structure/infra.md` aligned; fixture tests do not prove a signed/notarized artifact, and the first signed release is a manual-DMG bootstrap before in-app updates can be trusted.

- Channel forwarders deliver to the destination captured when a run was admitted, never to a per-channel last-active slot. `src/messaging/run-pin.ts` builds the identity block (origin/requestId/scope/sessionId/remoteKey/target) that every `agent_done` carries, and `resolveForwarderTarget` refuses an event with no destination or one addressed to another channel. Slack, Discord and Telegram forwarders no longer accept a `getLastTarget`/`getLastChatId` option, so web and CLI turns are not mirrored into chat rooms. Heartbeat destinations are complete or held: a Slack destination needs a thread or an explicit `scope: "channel_root"`, an absent destination sends nothing, threaded jobs verify `conversations.replies` before runner work, a bound destination send carries `fullAccess` after binding (not an HTTP JSON voucher; mention-watch hit posts do not copy it), and a 25-minute server-owned `enforceDestination` grant is injected into print, native, employee and script runtimes before work so omitted targets pin and mismatches fail without process-global locking. Live hold reasons remain visible to GET/UI until recovery. `authorizeExplicitTarget` vouches for a send without rewriting its address. Slack progress cards end their live loop on `message_not_found`/`cant_update_message` or three consecutive failures rather than retrying a dead message. See `structure/telegram.md` and `structure/server_api.md`.

- Auto (`permissions:auto`) grants qualified direct-local Jaw API authority across supported runtimes, independently of per-turn secrets. Keep actual/effective loopback, exact browser origin, proxy provenance, explicit outbound destinations and server-only resource options. Safe/custom keep existing scoped/operator paths; full API authority is instance-wide, distinct from provider Safe and task scope. Preserve no-descendant/read-only assignments, captured worker context and honest capability/receipt evidence. See `docs/slack-tools.md` and `structure/server_api.md`.
- Slack group DMs use `message.mpim` and optional `mpim:history`; exact `channel_type: mpim` mentions retain channel allowlist and thread policy, never the one-to-one DM bypass. An install without `mpim:history` receives no group-DM traffic at all; that gap is reported in `missingCapabilities` and logged as a reception limitation rather than failing credential validation. An absent scope header is unknown and a present empty header is a known empty grant. Keep `structure/telegram.md` and the validation API docs synchronized.

- Slack Socket Mode app-token ownership is coordinated across homes by a connected, fresh, live-PID claim; uncertainty fails open, conflicts disable inbound only, and the runtime notice/activation epoch must remain generation-bound. A long-running server keeps retrying Socket reconnects until Slack answers (finite `maxReconnectAttempts` is caller opt-in; `link_disabled` stays terminal). A bound heartbeat destination send uses `fullAccess` after `resolveHeartbeatBinding` and never last-active retarget; `/api/channel/send` does not accept `fullAccess` from JSON. See `structure/telegram.md` and `structure/server_api.md`.

- Manager sidebar selection and Sessions/Stop/Open use separate interactive targets. Keep list navigation scoped to the focused row selector, stable session-disclosure links, and preferred width separate from viewport clamping. Pointer and keyboard resize completion persist the latest value; see `structure/frontend.md`.
- Manager terminal presentation preserves backend PTY ownership across hide/unmount. Keep hydration-first bounded creation, explicit recovery, stable tab identity and focus ownership separate from native Code API sessions; theme updates must not recreate shells. See `structure/frontend.md`.

- Linux `/api/file/open` acknowledges asynchronous `xdg-open` launch, not desktop application success. Keep detached/ignored-stdio dispatch and launch-error handling; never wait synchronously for the opener. See `structure/server_api.md`.

- Sidecar builds use exclusive owned staging/source snapshots and retained failure evidence; preserve the existing compiled-asset/prune/native/no-JWC gates. Smoke executes a byte-matched copy outside checkout dependency ancestors with the target Node, strict process/IPC/listener/HTTP/close checks and evidence before cleanup. Never equate timeout/skipped with pass, relabel retained roots as deleted, adopt unknown output, or force-remove locks. Input relative contained symlinks are preserved verbatim; output fingerprinting is local provenance, not a signature. Final builder-filtered native UI remains separate. See `structure/infra.md`.

- Isolated desktop QA is explicit via `CLI_JAW_ISOLATED_QA_ROOT`; `src/shared/isolated-qa.ts` owns fixed role homes, strict W/M/P ports and fresh child environment. The supervisor validates before imports; Electron applies paths before lock/session and suppresses global registration/installer actions. QA Manager rejects foreign scans/peers and lifecycle actions before side effects; ordinary mode is unchanged. Preserve captured policy and lifetime-safe QA cleanup. This is controlled launch containment, not an arbitrary-command sandbox or packaged/native QA certification. Sync `structure/infra.md`, README and root/structure notes.

- Native event foundation: `src/shared/runtime-contract.ts` + `src/agent/runtime/*` own canonical Codex/Pi projections and optional explicit outcomes. `agent_runtime`/`agent_runtime_gap` publish directly to SSE, bypassing messaging listeners. Native compatibility terminals carry finality/status, optional `stopCause` on stopped `orchestrate_done`, and existing trace identity; no public partial/outcome object. Preserve legacy final selection when outcome is absent, and interrupted MESSAGE salvage before exit settlement. See `structure/runtime-integration.md` and `structure/stream-events.md`; Classic live Activity and its default preference are implemented separately from this event foundation; Classic history has its own bounded restoration owner; Interactive TUI has its own scoped consumer described below.
- Runtime selection: only Cursor/Grok/Claude accept `perCli.<cli>.transport`; existing homes migrate absent/print to native once (`nativeTransportMigration`) and post-stamp print is operator intent. Native switchable keys prefix the whole legacy bucket with `native-v1:` and never overwrite the print singleton. Capture transport/bucket once, forward through lifecycle persistence/compact, and keep scoped resets exact. Unsupported main/worker native adapters fail before print/fallback work; compiled support in `/api/cli-status` is separate from cached auth/binary readiness. Codex App/Pi keys remain unchanged.
- Claude native: the optional SDK, shared pool/host and existing lifecycle own sequential main turns, fresh worker assignments, immutable terminal claims, hard Stop and interrupted MESSAGE before exit-settle. Default steer remains kill/resume, never advertised as in-band. Auto (YOLO) / Safe decisions use live requests; deny/unknown profiles fail before preparation, including the memory extractor. Images are bounded and child activity is foreground-only. Child declarations reconcile from both parent/child frames; their ID ownership survives child completion and is not the same as live permission eligibility. Pre-start failure/Stop use one cached fallback before compatibility output; `onlyIfRunning` preserves finished trace headers. Background tasks are unavailable: the pool seeds `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` when the caller left it unset, because the PreToolUse hook refuses only an explicit `run_in_background:true` while Claude backgrounds a long foreground Bash command on its own, which ended the turn. A mid-turn session failure now fills `ctx.runtimeDiagnostic` from `facade.lastError`, and lifecycle prefers that sentence over the stderr classification so a failed turn with no text reports a cause instead of `tg.noResponse`.

- Cursor native main: explicit native/auto only; restrictive permissions and unsupported workers fail before `regenerateB`, bucket/bootstrap/snapshot, detection or pool work. `AcpRuntimeSession` keeps raw final/partial independent of bounded Activity and claims an immutable logical result before lifecycle; passive finalization survives main-map removal. Native run cleanup holds the exact lease through application settlement and uses captured exit-barrier identity. Server-explicit scope/chat bindings survive multi-session off; private identity-only I/O liveness keeps the owning collector alive without messaging content. Preserve legacy/manual compact while excluding print-era automatic compact/count heuristics from explicit native outcomes.
- `structure/` is the current public architecture-doc hub.
- Keep `README.md`, root `AGENTS.md`, root `CLAUDE.md`, and `structure/AGENTS.md` synchronized when command/API/orchestration surfaces change.
- Recent non-strict hotspots: explicit `/continue`, workflow helper slash commands (`/plan` as PABCD P compatibility guide, `/interview`, `/deliberate`, `/planaudit`, `/review`, `/search`, `/goal`, `/goalplan`, `/team`, `/task`, `/fork`, `/gd`; forward PABCD transitions require `cli-jaw orchestrate <phase> --attest '{"from","to","did",...}'`), pre-prompt context hooks (`context-hooks.json`, `cli-jaw hooks`), bounded local search contract (narrow-path Grep/rg; external search via active search skill), Telegram Hub P0–P4 (`structure/telegram.md`, `/api/dashboard/telegram-hub`), goal pause gate continuation suppression (`goal_pause_gate_pending`), `tests/run.mts` programmatic test driver, `/goal plan` and `/goalplan` store user direction as `planHint` and require `/goal refine` before checkpoints; agent pause first-tap state is exposed as derived `pauseGate` on status/API surfaces while persisted status remains `active`; bounded automation is `/goal run ...`, not top-level `/autopilot`), Codex App clean-install default with opt-in migration for existing settings, bounded child-backed nullable CLI status, read-only OpenCodex root-URL/live-health diagnostics, Pi top-level `pi --mode rpc` runtime with isolated `PI_CODING_AGENT_DIR` profiles, AGY `-p` print-mode runtime with capability-probed optional `--model` (observed in AGY 1.0.12), Grok weekly quota via native credentials and JSON credits, then bounded Grok Build gRPC-web and legacy monthly fallbacks, SSE-first `GET /api/events` event channel with WebSocket fallback, bounded tool-log sanitizer, worker progress query/watch, canonical `/api/channel/send`, heartbeat `every`/`cron` schedules, heartbeat Slack mention watch inside `runHeartbeatJob` (`mentionWatch`, optional `userIds`/`conditions` for mention|talk while default remains mention-of-`userId` and inbound `mentionOnly` stays separate, bot-token `conversations.history` scan instead of user-token-only `search.messages`, frontier/resume/round-robin/429 stop/60-channel cap, per-item busy yield, server-owned thread send then seen receipt, at-least-once delivery; the ledger is keyed by `(jobId, workspaceId, userId)` with the workspace id taken from a per-token `auth.test` rather than `settings.slack.teamId`, pre-v2 rows hold a job in a durable SQLite quarantine cleared only by `POST /api/heartbeat/:jobId/mention-watch-fresh-start` with a new `since`, and a duplicate job id in one PUT is a 400; the answer turn carries the answered thread's `chatSessionId` but runs in a dedicated `mention-watch:<remoteKey>` scope so inbound Slack cannot steer it, with a per-conversation guard of `getState(remoteKey) === 'IDLE'` + `hasChatSessionWork` + non-blocking `sessionLanes.hasPending`, and the thread session is minted only on admission)
, browser runtime diagnostics/session lifecycle, Electron Node sidecar packaging, private active `k-writing` routing for Korean promotional/content writing, inbound ACK reactions and queue-notice lifecycle owned by `src/messaging/ack-reaction.ts` + `src/messaging/queue-notice.ts` (channels supply transport factories only; the notice is deleted only AFTER a successful answer and rewritten on timeout/shutdown; `QueueNoticeRegistry.drain` bounds shutdown and actually aborts; ACK settles immediately after successful text delivery and BEFORE the optional image relay, because uploads are uncancellable and would otherwise strand the reaction on `running` after the answer is already visible), canonical platform classification via `src/core/platform-kind.ts` (`windows-native|wsl|linux|darwin|other`; `process.platform` decides first and `WSLENV` is never a WSL signal), and `npm run gate:all`.
  Workbench modernization uses a one-row Activity header with Codex-style expanded rows/groups; the Workbench Settings tab is replaced by a ZCode-style full settings page that swaps the workspace (header gear / Meta+,, `← Back to workspace`, grouped icon nav, card content), persisted as Manager registry `ui.instanceSettingsOpen`. A unified settings registry separates Instance/Manager scopes and the same page is served standalone from `dist/settings` behind the Classic header gear (the right-panel 설정 tab is gone); Classic uses the t3 token shell. Preserve per-page save owners, dirty guards, Preview iframe identity and independent live Requests; see `structure/frontend.md`.
- Standalone lifecycle is home-scoped: `jaw --home <path> service stop|restart [--port N]` verifies `<JAW_HOME>/jaw.pid.json` before signalling; registered launchd/systemd instances delegate to their native manager. Never recommend killing every Node process.
- Slack connection environment variables own their matching fields at runtime. Settings exposes only variable names and conservatively locks connection editing/reset while any are present; CLI setup refuses mixed input. Generic settings writes reject only env-owned paths, and persistence strips only those fields so env values never enter `settings.json` or erase unrelated file-backed credentials.
- Slack text sends preserve Markdown and explicit Block Kit `blocks`, splitting multiple tables into separate messages. `ok:true` means every chunk was posted, independently of rendering verification. Inspect `delivery.verification` (`verified`, `failed`, or `unavailable`) and `delivery.messages` for each posted chunk's timestamp, verification error, table-content status, and feature evidence. A persisted mismatch is `failed`; missing permission, unavailable/malformed readback, or a missing timestamp is `unavailable`. Neither stops remaining posts or triggers reposting. Actual validation/POST failures retain `ok:false`; partial receipts include `postedChunks`, `totalChunks`, and `sent:true, retryable:false`. Never blindly resend posted chunks. `tableContent` compares ordered text, numeric value/display, links and supported styles; ordinary Markdown character references decode once while code and escaped ampersands stay literal. `richContent` and `sourceAccuracy` remain `not_checked`, and readback stays bounded to 1 MiB.
- File sends across Slack, Telegram and Discord share one confirmation vocabulary. A send the vendor will not name is refused, not reported as delivered: Slack keeps its `files[]` echo requirement, Telegram requires a `message_id` greater than zero, and Discord requires a readable Create Message body. Those cases are `ok:false` with `confirmation: 'unconfirmed'`, replacing the older `ok:true, ambiguous:true` that no consumer read. Callers that forward a file result must preserve `confirmation`; dropping it makes a caption post twice. See `structure/infra.md` and `structure/telegram.md`.

- Slack progress uses one bounded native task plan for direct and queued requests, with exact request/run correlation and no raw tool details. Native elapsed time updates every second when the shared API budget permits; only changed cards are sent. Known file tools show bounded, sanitized project-relative filenames (outside the captured project: basename only). Cursor shell tool-call purposes and bounded English action/target summaries distinguish shell-based reads, searches, tests and scripts; raw command bodies and argument values remain excluded. Final delivery stays with the verified sender; known failure/cancellation cannot become a success ACK. Restore and shutdown use captured ownership and bounded cleanup. See `structure/telegram.md`.

- Slack-triggered Boss turns receive `channel_id` and parent `thread_ts` in the per-turn user prompt regardless of multi-session state; agents must use that explicit context for Slack lookup/send APIs instead of parsing session labels.
- Optimization/score-maximization goals follow the optimization-loop discipline (LOOP-PHASE-DEATH/CONTINUITY/CANDIDATE-ANCHOR/INSTANCE-CHECK + GATE-ORACLE-VALIDITY):
  classify candidate changes, ban a class after 3 consecutive discards, force evaluator-gate work on repeated D-phase deaths.
  Canonical: dev-pabcd §10, dev-testing §9.5; injected via orchestration template and goal continuation.
- `structure/` reading map: start at `structure/INDEX.md`; depth — `telegram.md` (Hub), `prompt_flow.md` (attest/hooks/bounded search), `stream-events.md` (pause gate/SSE), `infra.md` (test scripts), `commands.md` + `server_api.md` (slash/API surfaces). Concurrent inbound gateway docs: `structure/INDEX.md` §gateway, `structure/infra.md` §`src/messaging/`, `structure/telegram.md` §common messaging layer; legacy `settings.channel` is a deprecated read-only alias for one major version.

- Grok main native ACP requires literal auto, existing advertised authentication/model/effort, and no leader. Its optional common replacement strategy waits for original cancellation and drain, preserves one logical final, commits input only after local dispatch with current ownership, and never queues fatal failures. Restrictive policies and workers fail before preparation. Sync `structure/runtime-integration.md`.

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

Print Activity uses `runtime/print-projection.ts` and `print-activity.ts` as observers, never final selectors. Only accepted parser text enters; stderr/control output stays raw. Lifecycle supplies the application-final and existing bypass/retry paths close once. `merge-tool-log.ts` reconciles exact run/ref or run/seq identities; unknown workers never borrow boss identity. Bounded snapshot hydration retains known RAM omission with the sanitizer's explicit max-overlap option; default append/storage counting is unchanged. Only print opts into terminal tool refresh; native default freeze/enrichment, Claude pending-worker cancellation and Slack final/ACK/queue owners remain intact.

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

이건 로컬 빌드/재시작 계약이고, 배포(release)는 별개다. 릴리스 경로는 `feature → preview → main` 뒤 `workflow_dispatch` npm publish이며 `dev`는 릴리스 경로가 아니다. `scripts/promote-to-main.sh`는 publish를 dispatch한 뒤 결과를 확인하지 않고 종료하며, 승격 성공 후에는 다시 실행할 수 없다. 부분 실패·롤백 복구 절차는 `structure/infra.md` § 릴리스 파이프라인과 부분 실패 복구를 따를 것.

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

### Line Count Format (`str_func.md`)

File tree の行数は **`(NNNL)`** 형식으로 기재. 두 가지 변형 허용:

```
├── server.js          ← 설명 (757L)           ← 단순 형식
├── chat.js            ← 설명 (3모드, ..., 843L) ← 다중 메타 형식
```

- 숫자 + `L` + `)` 또는 `,` 로 끝나야 detection 가능
- 검증: `bash structure/verify-counts.sh` (exit code = 불일치 수; 현재는 `str_func.md` 파일 트리의 모든 `(NNNL)` 파일 항목도 검사)
- 자동 수정: `bash structure/verify-counts.sh --fix`
- **파일 수정 후 반드시 verify-counts 실행해서 문서 동기화**

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
