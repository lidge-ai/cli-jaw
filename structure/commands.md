---
created: 2026-03-28
tags: [cli-jaw, slash-command, cli, discord]
aliases: [CLI-JAW Commands, slash commands registry, commands.md]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · **슬래시 커맨드** · [서버 API](server_api.md)

# src/cli/ — Slash Command Registry & Dispatcher

> `commands.ts`(621L) + `handlers.ts`(448L) + `handlers-runtime.ts`(507L) + `handlers-completions.ts`(103L) + `handlers-workflows.ts`(505L) + `handlers-search.ts`(34L) + `handlers-skill-invoke.ts`(36L) + `api-auth.ts`(45L) + `command-context.ts`(144L) + `registry.ts`(254L) + `acp-client.ts`(382L) + `claude-models.ts`(84L) + `compact.ts`(143L)
> slash registry는 55개 커맨드이며 non-hidden은 54개다(`/file`만 hidden). interface별 가시성은 CLI 50 / Web 44 / Telegram 41 / Discord 41 / Slack 41이고, root cmdline에는 workflow/interactive hidden set을 제외한 28개가 보인다. root CLI는 `bin/cli-jaw.ts` 기준 `provider`/`design`/`hooks`를 포함한 dynamic import branch를 가진다. `chat search`, `browser web-ai`, `dashboard memory`, `dashboard chat search`처럼 grouped subcommand까지 포함하면 28개 user-facing surface로 문서화한다. helper까지 포함한 `bin/commands/*.ts` top-level 파일은 33개다. `browser web-ai`는 `browser-web-ai.ts`, `dashboard memory`는 `dashboard-memory.ts`, dashboard chat federation은 `dashboard-chat.ts`, task root command는 `task.ts`, dispatch unwrap 보조는 `dispatch-helpers.ts`, batch summary 보조는 `dispatch-batch-summary.ts`로 분리되어 있다.
> 모델/CLI 선택은 `registry.ts` 단일 소스를 따른다. 현재 registry 런타임은 `pi`, `agy`, `claude`, `codex`, `codex-app`, `cursor`, `grok`, `kiro-code`, `opencode`, `copilot` 10개다.

---

## 핵심 함수

| Function | 역할 |
| --- | --- |
| `parseCommand(text)` | `/cmd args` 파싱. 파일 경로(`/tmp/x`)는 command로 오인하지 않음 |
| `executeCommand(parsed, ctx)` | interface/capability 검사 후 handler 실행, `normalizeResult()` 적용 |
| `getCompletions(partial, iface)` | `/name` 문자열 목록 반환 |
| `getCompletionItems(partial, iface)` | command palette용 상세 completion 항목 |
| `getArgumentCompletionItems(...)` | command별 인자 completion |
| `COMMANDS` | command registry 단일 소스 |

## Web Slash Dropdown Help

- `public/js/features/command-info.ts`의 `COMMAND_TOPIC_MAP`이 slash-command row `?` 도움말의 단일 매핑 소스다.
- `public/js/features/slash-commands.ts`는 `COMMAND_TOPIC_MAP[cmd.name]`이 있을 때만 `.cmd-info-btn`을 렌더링하고, 클릭 시 `openHelpDialog(topicId)`를 호출한다.
- Web에서 보이는 모든 command와 alias는 `COMMAND_TOPIC_MAP`에 있어야 한다. 단, legacy compatibility command set(`fast`, `context`, `tools`, `retry`, `export`, `resume`)은 follow-up help topic 전까지 계약 테스트에서 명시적으로 제외된다.
- `tests/unit/help-dialog-contract.test.ts`는 `COMMANDS`와 `COMMAND_TOPIC_MAP`을 대조해 `/review`, `/task`, `/fork`, `/h` 같은 누락이 재발하지 않도록 막고, parity-stub exemption만 허용한다.

---

## Registry Snapshot

### Command 목록 (55 total / 54 non-hidden)

```text
help, commands, settings, status, clear, purge, compact, reset,
plan, interview, deliberate, planaudit, review, search, goal, goalplan, gd, team,
model, cli, fallback, forward, thought, flush,
version, skill, employee, mcp, memory, browser, prompt, quit, file, steer, queue,
ide, orchestrate, project, task, new, switch, sessions, fork,
effort, fast, context, tools, redraw, retry, export, resume, hotkeys
```

### 인터페이스 가시성

| Interface | Visible (`interfaces` 기준) | 비고 |
| --- | ---: | --- |
| `cli` | 50 | `file` hidden. `steer`는 `interfaces`에서 `cli` 제외(프로세스 경계, STR-001)라 이 카운트에는 빠지지만 `capability.cli:'full'`로 CLI 완성/도움말에는 노출되고 `/api/message`로 forward됨 |
| `web` | 44 | `commands`, `settings`, `quit`, `file`, `ide`, `hotkeys` 미지원 |
| `telegram` | 37 | remote-safe command set |
| `discord` | 37 | remote-safe command set |

### 카테고리

- `session`: `help`, `commands`, `status`, `clear`, `purge`, `compact`, `reset`, `steer`, `new`, `switch`, `sessions`, `fork`, `context`, `retry`, `export`, `resume`
- `workflow`: `plan`, `interview`, `deliberate`, `planaudit`, `review`, `jaw-search`, `jaw-goal`, `goalplan`, `gd`, `team`
- `model`: `model`, `cli`, `fallback`, `forward`, `thought`, `flush`, `effort`, `fast`
- `tools`: `skill`, `employee`, `mcp`, `jaw-memory`, `jaw-browser`, `prompt`, `ide`, `orchestrate`, `project`, `task`, `tools`
- `skills`: not a slash category. Active skills are picked inline with `$<skill>` — typing `$` in the web or TUI composer lists them — and the server expands each mention into the prompt (`src/core/skill-mentions.ts`). `/skill:<id>` still executes as a hidden compatibility alias and is not listed.
- `cli`: `settings`, `version`, `quit`, `file`, `redraw`, `hotkeys`

`/settings` is CLI-only. In fullscreen `jaw chat`, selecting it opens the
Appearance MVP screen in the main content region; it does not expose unsupported
engine-specific `Context` settings. Line-mode still returns the generic command result.

Interactive rich TUI uses Activity by default. Appearance → Presentation switches
only `presentation.mode` between Activity and Legacy; it does not select transport
or permissions. Fullscreen Ctrl+O toggles the latest uncommitted Activity before
legacy tool details/background tasks. F6 opens read-only retained history:
Up/Down records, Left/Right runs, Enter record detail, A saved answer, R reload,
N next descriptor window, PageUp/PageDown/Home/End scroll, Esc/F6 close. Pasted
control sequences remain paste, including during inspector close/reset. This is
a server-active-chat client: F6 selection never changes message/Stop routing.
Classic Ctrl+O keeps background tasks; `--simple` and piped `--raw` receive no
Activity reads or new output/termination behavior.

---

## Root CLI Surface (`bin/cli-jaw.ts` + `bin/commands/*.ts`)

소스 기준 entrypoint는 `bin/cli-jaw.ts`(284L)다. 현재 소스 트리에서 root command router는 `provider`/`design`/`hooks`를 포함한 dynamic import branch를 가진다. 아래 표는 grouped subcommand(`chat search`, `browser web-ai`, dashboard federation 등)를 포함한 user-facing surface다. 파일 수 기준으로는 `browser-web-ai.ts`, `dashboard-memory.ts`, `dashboard-chat.ts`, `dispatch-helpers.ts`, `dispatch-batch-summary.ts`, `task.ts`, `bgtask.ts` helper/command가 포함되어 `bin/commands/*.ts` top-level은 40개다 (`messaging.ts` 포함).

### Global options

| Option | 동작 |
| --- | --- |
| `--home <path>` / `--home=<path>` | command parsing 전에 `CLI_JAW_HOME` 설정 |
| `--help` / `-h` | root help 출력 |
| `--version` / `-v` | `cli-jaw v{package.version}` 출력 |

Explicit desktop QA is an environment opt-in, not a new global CLI command.
With a validated `CLI_JAW_ISOLATED_QA_ROOT`, `dashboard serve` inherits the fixed
Manager/worker/count-one values when omitted and rejects conflicting raw flags
before normalization. Its child receives the scrubbed role environment. See
[isolated desktop QA](infra.md#isolated-desktop-qa); the supervisor must reject
escaped `--home` values before launching any DB-bearing CLI imports.

### 실제 서브커맨드 / 옵션

| Command | 파일 | 실제 옵션 / 하위 명령 |
| --- | --- | --- |
| `serve` | `bin/commands/serve.ts` | `--port <port>`, `--host <host>`, `--no-open`, `--lan`, `--remote`, `--trust-proxy`, `--trust-forwarded` |
| `init` | `bin/commands/init.ts` | `--help`, `--non-interactive`, `--safe`, `--dry-run`, `--force`, `--working-dir <path>`, `--cli <name>`, `--channel <telegram\|discord\|slack>`, `--telegram-token <t>`, `--allowed-chat-ids <ids>`, `--discord-token <t>`, `--discord-guild-id <id>`, `--discord-channel-ids <ids>`, `--slack-bot-token <t>`, `--slack-app-token <t>`, `--slack-team-id <id>`, `--slack-channel-ids <ids>`, `--skills-dir <path>`; Slack 환경변수 모드에서는 credential flags를 거부하고 연결값을 파일에 쓰지 않는다 |
| `slack` | `bin/commands/slack.ts` | `manifest` (app manifest YAML 출력), `setup [--bot-token <t>] [--app-token <t>] [--team-id <id>] [--channel-ids <ids>] [--non-interactive] [--skip-validate]`, `history <channel> [--thread <ts>] [--limit N] [--json]`, `members <channel> [--limit N] [--json]`, `users [--limit N] [--include-bots] [--include-deleted] [--json]` (history/members/users는 실행 중인 서버를 경유하므로 CLI 프로세스가 봇 토큰을 만지지 않는다); guided Slack 앱 설정 — 매니페스트 생성 + auth.test/apps.connections.open 라이브 검증 + settings 병합(`channel` 미변경). Slack 연결 환경변수가 있으면 file/UI credentials와 혼용하지 않고 setup을 거부한다. Slack은 xapp- 토큰이 UI 전용이고 PKCE localhost 흐름이 bot scope를 거부하므로 OAuth 원클릭은 구조적으로 불가 |
| `messaging` | `bin/commands/messaging.ts` | `ingress list [--channel --state --older-than --limit --json]`, `ingress show <channel> <accountId> <eventId> [--json]`, `ingress replay <channel> <accountId> <eventId> --reason <text> [--force]`, `ingress audit [--limit --json]`, `doctor [--json]`. Local process only. Replay marks the journal `received`; the next vendor redelivery is what re-runs the handler. `--reason` required. completed default-deny; discarded payload hard-deny. `doctor` reports local journal counts, not the server ring. |
| `doctor` | `bin/commands/doctor.ts` | `--json`, `--repair-shared-paths`, `--tcc`, `--fix`, `--prime`; `--json` 페이로드는 `platform` (`windows-native\|wsl\|linux\|darwin\|other`, `src/core/platform-kind.ts` 판정)과 WSL 전용 `wsl` 객체를 포함 |
| `db` | `bin/commands/db.ts` | `maintain`; `wal_checkpoint(TRUNCATE)` 후 `VACUUM`, 전후 `page_count`/`freelist_count` 출력. 자동 실행 없음. |
| `provider` | `bin/commands/provider.ts` | provider registry/config helper root command |
| `chat` | `bin/commands/chat.ts` | `process.argv.slice(3)`를 TUI로 전달. 기본/`--raw`/`--simple` 모드. TUI transport는 `bin/commands/tui/channel.ts`에서 SSE-first inbound(`GET /api/events`) + legacy WS fallback(pre-X-01 server only)을 제공하고, outbound는 REST `POST /api/message` / `POST /api/stop`을 사용 |
| `chat search` | `bin/commands/chat-search.ts` | `<query> [--days N] [--recent N] [--context N] [--limit N]`; 채팅 메시지 히스토리 검색 |
| `ask` | `bin/commands/ask.ts` | `"<prompt>" \| -` (stdin), `[--json] [--timeout <sec>] [--port <port>]`; TTY 없이 프롬프트 하나를 보내고 답을 받는다. `GET /api/events`를 **먼저** 구독한 뒤 `POST /api/message`를 보내고 `request_settled`에서 자기 requestId를 기다린다 — 순서를 바꾸면 빠른 응답을 놓친다(SSE는 커서 없는 신규 구독자에게 재생하지 않음). 종료코드: 0 완료/steered, 1 실패, 2 usage, 124 timeout. 서버가 바쁠 때는 `steered`(진행 중 턴에 주입됨, 별도 답변 없음)로 정직하게 끝낸다 (#276) |
| `employee` | `bin/commands/employee.ts` | `list [--port 3457] [--json]`, `reset [--port 3457]`, `sessions-reset [--port 3457]`; `help`/`--help`/`-h` |
| `reset` | `bin/commands/reset.ts` | `[--yes] [--port 3457]`; `confirm`도 확인값으로 허용 |
| `mcp` | `bin/commands/mcp.ts` | `install <package> [--pypi\|--npm]`, `sync`, `reset [--force]`, `list` |
| `skill` | `bin/commands/skill.ts` | `install <name> [--force]`, `remove <name>`, `info <name>`, `list`, `reset [hard\|--hard] [--force]` |
| `status` | `bin/commands/status.ts` | `--port <port>`, `--json` |
| `jaw-browser` | `bin/commands/browser.ts` | `start [--port <auto>] [--headless] [--agent]`, `stop`, `status`, `reset [--force]`, `fetch <url> [--json] [--trace] [--browser auto\|never\|required] [--allow-third-party-reader]`, `snapshot [--interactive]`, `screenshot [--full-page] [--ref <ref>]`, `click <ref> [--double]`, `mouse-click <x> <y> [--double]`, `vision-click <target> [--provider codex] [--double] [--prepare-stable] [--region <name>] [--clip x y w h] [--verify-before-click] [--no-reconcile] [--no-occlusion-check] [--bypass-sandbox]` (`--no-occlusion-check`는 ref 경로 전용이다. 히트 테스트는 해석된 대상과 비교해야 성립하므로 좌표 클릭에는 적용되지 않는다), `type <ref> <text> [--submit]`, `press <key>`, `hover <ref>`, `navigate <url>`, `open <url>`, `tabs`, `text [--format text\|html]`, `evaluate <js>` |
| `browser web-ai` | `bin/commands/browser-web-ai.ts` | `render`, `status`, `send`, `poll`, `query`, `watch`, `watchers`, `sessions`, `sessions-prune`, `resume`, `reattach`, `notifications`, `capabilities`, `stop`, `diagnose`/`doctor`, `context-dry-run`, `context-render`, `code`, `code-extract`; vendor는 `chatgpt\|gemini\|grok`, code/code-extract는 ChatGPT 전용 |
| `design` | `bin/commands/design.ts` | design workspace command surface |
| `jaw-memory` | `bin/commands/memory.ts` | `search <query> [--chat]`, `read <file> [--lines N-M]`, `save <file> <content>`, `list`, `init`, `context <file> [--window N]`, `reflect [--sinceDays N]`, `flush`, `cleanup [--days N]` |
| `hooks` | `bin/commands/hooks.ts` | pre-prompt context hooks management (+ `hooks policy`: runtime policy hooks/flags inspection) |
| `launchd` | `bin/commands/launchd.ts` | `[--port PORT] [status\|unset\|cleanup]` |
| `clone` | `bin/commands/clone.ts` | `<target-dir> [--from <source>] [--with-memory] [--link-ref]` |
| `orchestrate` | `bin/commands/orchestrate.ts` | `[I\|P\|A\|B\|C\|D\|status\|reset] [--force] [--json] [--port <port>]` |
| `dispatch` | `bin/commands/dispatch.ts` | `(--agent <name> \| --virtual <name>) --task <task> [--role <role>] [--cli <cli>] [--model <model>] [--mutable | --read-only] [--no-descendants] [--scope <path>] [--port <port>] [--watch] [--quiet] [--json]`; human output follows bounded safe worker progress by default; `--quiet`/`--json` suppress live progress; `--batch --agents '<JSON array>'` where each entry accepts `agent` or `virtual` and prints grouped safe summaries with `runId` recovery commands instead of full worker text |
| `jaw-goal` | `bin/commands/goal.ts` | `set <objective>`, `plan [hint]`, `refine <objective>`, `status`, `update <summary>`, `done [note]`, `cancel [reason]`, `pause`, `resume`, `clear`, `reset`, `history [limit]`; `--json`; plan-mode stores hints as `planHint` and requires refine before checkpoints; status exposes derived `pauseGate` when an agent pause audit is pending |
| `worker` | `bin/commands/worker.ts` | `status [agent\|runId] [--recent N] [--json]`, `watch [agent\|runId] [--json]`, `read <runId> [--offset N] [--limit N] [--tail N] [--json]`, `--port <port>`; status/watch use safe summaries (`snapshot.workers` is running-only; `--recent` reads durable safe records), while read is the explicit raw worker-output surface backed by `/api/orchestrate/worker-runs/:runId/output` |
| `service` | `bin/commands/service.ts` | `[--port PORT] [--backend launchd\|systemd\|docker] [status\|stop\|restart\|unset\|logs]`; standalone `serve`는 `<JAW_HOME>/jaw.pid.json` ownership 검증 후 해당 인스턴스만 제어하고, 등록된 launchd/systemd 인스턴스는 native service manager에 위임 |
| `dashboard` | `bin/commands/dashboard.ts` | `serve [--port 24576] [--from 3457] [--count 50] [--no-open]`, `memory {search\|instances\|read\|config\|state\|estimate\|reindex\|help} [--instance <ids>] [--limit N] [--json] [--port <port>]`, `chat search "<query>" [--instance <ids>] [--limit N] [--days N] [--json]` |
| `connector` | `bin/commands/connector.ts` | `board add/update/list`, `notes write/list`, `reminders add/list/done`, `audit [--limit N] [--json]` |
| `reminders` | `bin/commands/reminders.ts` | `list`, `add`, `done`; `--json`, `--priority`, `--due`, `--remind`, message/thread link flags |
| `project` | `bin/commands/project.ts` | `set <path>[, <path>...]`, `reset`/`clear`, `list` (instance projectDirs 관리) |
| `task` | `bin/commands/task.ts` | `add/edit/list/start/done/assign/clear`; dashboard-visible atomic checklist |
| `bgtask` | `bin/commands/bgtask.ts` | `add/list/show/cancel`; server-owned background task registration and inspection. Human list output keeps native status and appends the shared runtime status category as `native/category` when the server provides it. |
| `lock` | `bin/commands/lock.ts` | `[--port 3457]`; instance lock (stopAll 보호). `unlock`도 동일 파일 처리 |
| `unlock` | `bin/commands/lock.ts` | `[--port 3457]`; instance unlock |
| `history` | `bin/commands/history.ts` | `search "<query>" [--limit N]`; 채팅 히스토리 검색 (65L) |

---

### Retired runtime command

`jaw jwc` returns a retirement diagnostic. It never installs, cleans, probes an
external SDK or falls through to a chat prompt. Choose an available runtime with
`/cli <runtime>` in Jaw; Code has its own native per-session runtime picker.

## Command Behavior Notes

### Remote `/stop` `/queue` `/approve` `/deny`

- `/new` `/status`는 기존처럼 세 채널 catalog에 있다. Slack 앱 매니페스트만 `/status`를 빼 둔다 — Slack이 그 이름을 예약한다. 파서/카탈로그에는 그대로 있다. M4-A1이 `/stop` `/queue` `/approve` `/deny`를 같은 catalog에 올린다.
- `/stop`은 현재 conversation run만 interrupt한다. `quit`/프로세스 종료가 아니다.
- `/queue` remote는 해당 session scope의 list/drop이다. TUI `/queue` intercept와 별개다.
- `/approve` `/deny` 텍스트는 `<jti> <digest>`가 필요하고, `/deny`는 기존 `cancel` store transition이다. native 버튼은 M4-A2.
- 이 네 이름만 messaging access-policy를 탄다. `/help` `/status`는 채널 allowlist만 탄다.

### `jaw messaging ingress`

- `jaw messaging doctor --json`은 같은 SQLite 파일의 ingress counts와 이 프로세스 ring의 `log.event`만 본다. 서버 메모리 메트릭은 `/api/health`에 있다.
- 서버와 같은 SQLite journal(`ingress_events`)을 로컬 프로세스에서 읽는다. HTTP replay route는 없다.
- `list` / `show` / `replay` / `audit`. `replay`는 `--reason`이 없으면 저널을 건드리지 않는다.
- 성공한 replay는 row를 `received`로만 되돌린다. 이 프로세스 안에서 handler를 다시 돌리지 않는다. 실제 재실행은 Telegram offset / Slack retry / Discord resume 재전송이 `admitIngress`를 다시 탈 때다.
- completed는 기본 거부. `--force`여도 completion이 `payload_json`을 지운 tombstone은 `payload_discarded`로 거부한다.
- 성공 replay만 `$JAW_HOME/messaging-ingress-audit.jsonl`에 prior→new + reason을 append한다.

### `jaw service stop|restart`

- 반드시 제어할 인스턴스와 같은 `--home`을 지정한다. 다중 인스턴스에서는 필요하면 `--port`도 함께 지정한다.
- standalone `jaw serve`는 `<JAW_HOME>/jaw.pid.json`의 home, PID 생존 여부, OS process start time, start-time source가 모두 일치할 때만 `SIGTERM`을 보낸다. stale/foreign/unverifiable pidfile은 신호 없이 거부한다.
- `restart`는 기존 PID 종료를 확인한 뒤 같은 home/port로 detached `serve --no-open`을 시작한다.
- launchd/systemd에 실제 등록된 인스턴스는 기존 native service restart/stop 경로로 위임한다.
- Windows에서 `Get-Process node | Stop-Process` 같은 전역 종료는 다른 cli-jaw 인스턴스와 Codex app-server까지 종료할 수 있으므로 사용하지 않는다.

### `/clear`

4-tier cleanup system (`/clear` < `/clear all` < `/purge` < `/reset confirm`):

- `/clear` — session clear only. CLI/Web에서는 `code: 'clear_screen'` 반환으로 UI clear도 유도.
- `/clear all` — skills reset + employees reset + MCP sync + session reset.
- `/purge` — session clear + memory wipe.
- `/reset confirm` — full factory reset.

### `/model [name]` / `/cli [name]`

- 값이 없으면 현재 상태 조회.
- 값이 있으면 `settings.perCli[activeCli].model` 또는 `settings.cli`를 갱신한다.
- `/model` 인자 completion은 기본 registry 모델을 쓰되, ocx가 active이고 `healthz`가 ok이면 `~/.opencodex/runtime-port.json`의 포트에서 `/v1/models`를 읽어 Codex/Codex App 모델 목록을 routed 모델까지 확장한다. ocx inactive/헬스 실패/모델 조회 실패 시 Codex 기본 4개(`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`)만 보여준다.

### `/fallback [cli1 cli2...|off]`

- `fallbackOrder`를 설정하거나 해제한다.

### `/forward [on|off]`

- 현재 remote channel 또는 active channel의 `forwardAll` 값을 조정한다.

### `/thought [status|on|off]`

- Gemini thought visibility toggle. `settings.showReasoning`을 저장한다.

### `/flush [cli] [model] | off`

- memory flush 전용 CLI/model override를 설정한다.

### Workflow slash commands

- `/plan [request|status|copy]`: PABCD P 안내 compatibility command.
- `/interview <request>`: IPABCD I(Interview) 상태 머신으로 진입.
- `/deliberate <request-or-plan>`: Planner/Architect/Critic 관점으로 계획을 점검.
- `/planaudit [plan]`: PABCD A에서 직원에게 보낼 읽기 전용 감사 task text를 만든다.
- `/review [focus] [--fix] [--dispatch]`: `projectDirs` 또는 최근 맥락에서 검증한 git 프로젝트 디렉토리를 리뷰한다. JAW_HOME/`process.cwd()` fallback은 금지한다. 사용자가 `/review 프롬프트`처럼 focus text를 주면 이를 최우선 scope signal로 반영한다. 리뷰 범위는 현재 대화에서 논의 중인 작업 초점을 먼저 잡고, 최근 goal/chat context, 커밋 히스토리, diff, worktree, untracked 파일은 그 범위를 검증하는 근거로 사용한다. `origin/master..HEAD` 같은 git range에 있다는 이유만으로 무관한 최근 커밋을 포함하지 않는다. 결과 Markdown report에는 `Scope Resolution` 근거를 저장한다. `--fix`는 검증된 프로젝트 루트 안의 Critical/High만 현재 `HEAD` 위 새 working-tree patch로 자동 수정하며 기존 커밋을 rewrite하지 않는다.
- `/search <query>`: active search skill 정책을 강제하는 routing command다. local repository search와 external/current/public lookup을 먼저 분류하고, 외부 검색이면 1-3개 focused query로 재작성해 native search로 candidate URL을 찾는다. `browser fetch/open/text/get-dom/snapshot`은 candidate URL이 생긴 뒤 evidence verification에만 사용하며, natural-language query를 그대로 `browser fetch`에 넘기지 않는다.
- `/goal [set|plan|refine|status|run|done|cancel|pause|resume|clear|reset|history] [args...]`: Persistent goal lifecycle management. `/goal plan [hint]` and `/goalplan [hint]` create a pending plan-mode goal, store the raw hint separately as `planHint`, and require `/goal refine <specific objective>` or `cli-jaw goal refine "<specific objective>"` before checkpoints/execution evidence are accepted. Agent pause remains a two-tap audited gate; after first tap, status output and `--json` show derived `pauseGate` while the persisted goal status stays `active`.
- `/gd [note]`: `/goal done --force [note]`의 축약어. `/goal done`의 completion evidence gate를 우회하는 명시적 quick-complete command다.
- `/team [plan|audit|status|collect|stop] [args...]`: 여러 worker를 병렬로 쓰는 team orchestration helper.

### `jaw dispatch`

- The CLI reads `GET /api/orchestrate/access` to choose direct full-local, existing Boss-token, or operator-approval dispatch. Every POST checks authority again. Qualified local Auto workers may dispatch without inheriting a Boss token; Safe/non-qualified callers retain the old credential/approval path.
- `--read-only` preserves an explicit read-only assignment; `--no-descendants` forbids child delegation. Full defaults may write when the task permits, while explicit parent constraints remain. Worker calls carry their complete current scope/chat/run selector tuple; stale or incomplete selectors fail rather than switching to another conversation. Untagged local-operator dispatch without parent context creates an independent chat without changing the active chat. A separately valid Boss token retains its legacy context path.
- Approval records remain target/task/scope/audience-bound and single-use. Full direct dispatch does not manufacture human approval, `approvedBy`, or an approval token.
- Named employees use `jaw dispatch --agent "Backend" --task "..."`.
- Ephemeral virtual employees use `jaw dispatch --virtual "security" --task "..."` or `--virtual "Reviewer" --role "Review rollback gaps" --task "..."`.
- Virtual employees are synthetic dispatch rows only; they do not appear in `jaw employee list` and do not write durable `employee_sessions`.
- If `--cli`/`--model` are omitted for virtual dispatch, the server resolves the current CLI and uses the registry default model for that CLI.
- Human dispatch output follows live safe worker progress by default. Use `--quiet` for final-result-only output, or `--json` for parseable machine output without human progress lines.
- On dispatch polling timeout/disconnect, recovery output is run-aware when possible: `cli-jaw worker status <runId>` for safe progress and `cli-jaw worker read <runId> --tail 80` only as an explicit raw-output follow-up.
- Batch dispatch prints one bounded summary per worker. It does not inline full employee stdout; each row carries `runId`, status/preview, and an explicit `cli-jaw worker read <runId> --tail 120` recovery command when raw output is needed.

### `/steer <prompt>`

- Native Cursor는 `replaceTurn` 훅을 쓴다. 원래 prompt의 취소 응답과 drain 뒤
  같은 native session에 재요청하는 `cancel-reprompt`이며, native-input은 아니다.
  원래 요청·수락된 추가 지시·제한된 부분 출력을 문맥으로 복원한다. 입력 기록은
  로컬 전송 완료와 소유권 재검사 뒤 한 번만 한다. 진행 중인 replacement는 후속 입력을
  큐로 보낼 수 있지만, 불확실한 전송·기록 실패는 자동 재시도하지 않는다.
  Stop으로 취소된 대기 지시는 `cancelled`로 끝내며, 큐에 되살리지 않는다.
- Native Grok도 같은 취소 응답·drain·idle 경계와 `replaceTurn` 훅을 쓰되,
  Cursor의 문맥 재주입은 적용하지 않는다. Stop으로 취소된 입력은 실제 enqueue
  직전까지 보호하며 다시 제출하지 않는다. Stop 이후의 새 입력은 받을 수 있다.
- `/queue steer <n>`은 별도 큐 항목 우선 실행이다. 기존 항목 제거·interrupt·exit-settle·
  salvage 뒤 새 run을 시작하며, 같은 세션 replacement로 바꾸지 않는다.
- Web/Telegram/Discord/Slack에서 실행 가능. CLI slash registry에는 노출되지 않는다.
- 실행 중 agent가 없으면 에러.
- 런타임이 in-band steer를 지원하면(steer 가능한 turn이 진행 중인 codex-app)
  **kill 없이** 진행 중 턴에 주입된다. codex-app은 app-server `turn/steer`로 같은 턴에
  합류하므로 이전 맥락 손실이 없다. 주입이 불가한 경우(턴 종료 race, review/compact 턴)
  kill 대신 follow-up 큐로 간다.
- 위 native Cursor/Grok와 in-band 경로를 제외한 런타임은 kill 후 재지시(kill-path). 이때 중단된 턴의 부분 출력이 salvage되어
  follow-up run 프롬프트에 구조화 블록으로 주입된다 (wp1: exit-settle 배리어 +
  `withSteerContext`). 즉 kill-path에서도 "이전 맥락"이 모델에 도달한다.

### `/fork`

- 현재 채팅 세션의 메시지를 새 세션으로 복사하고 그 세션으로 전환한다.
- `/new`, `/switch`, `/sessions`와 같은 session category 표면이며 CLI/Web/Telegram/Discord/Slack에서 사용 가능하다.

### `/orchestrate` (alias: `/pabcd`)

- PABCD explicit entry. `jaw orchestrate P|A|B|C|D|I|status|reset`는 root CLI transition/control surface.
- `I → P` 전환은 기존 orchestration ctx를 유지한다. 첫 Plan 생성 전에도 `interview.request`가 pinned `originalPrompt` fallback이 되므로, 사용자의 "진행/계속" 같은 짧은 승인 문구가 planning task를 덮어쓰지 않는다.

### `/memory`

| Form | 동작 |
| --- | --- |
| `/memory` 또는 `/memory list` | memory file list |
| `/memory <query...>` | search |
| `/memory status` | runtime status |
| `/memory bootstrap` | core/markdown/kv/claude import bootstrap |
| `/memory reindex` | memory reindex |
| `/memory flush` | memory flush trigger |
| `/memory adv ...` | integrated memory runtime 상태/초기화/bootstrap/reindex 래퍼 |
| `/memory embed status` | embedding state (state/mode/provider/chunks/DB size) |
| `/memory embed estimate` | embedding cost estimate (chunks/batches/seconds/cost) |

### `/browser [status|tabs]`

- 브라우저 상태 또는 열린 탭을 요약한다.

---

## Registry.ts — CLI / Model Source of Truth

`src/cli/registry.ts` (224L)

현재 CLI registry는 10개 top-level runtime을 갖는다.
Codex 기본 registry는 ocx inactive fallback용 모델만 보유하며, live surface는 `src/cli/registry-live.ts`와 `src/cli/opencodex-models.ts`가 ocx `/v1/models`를 병합한다.
모델 목록뿐 아니라 **모델별 reasoning effort**도 함께 병합되어 `effortsByModel`/`defaultEffortByModel`로 노출되며, `max`/`ultra`는 이를 지원하는 모델에서만 선택할 수 있다.

| CLI | Default Model | Default Effort |
| --- | --- | --- |
| `pi` | `grok-composer-2.5-fast` | `medium` |
| `agy` | *(TUI-managed)* | `''` |
| `claude` | `sonnet` | `medium` |
| `codex` | `gpt-5.5` | `medium` |
| `codex-app` | `gpt-5.5` | `medium` |
| `cursor` | `composer-2.5` | `medium-fast` |
| `grok` | `grok-build` | `''` |
| `kiro-code` | `auto` | `''` |
| `opencode` | `opencode-go/kimi-k2.6` | `''` |
| `copilot` | `claude-sonnet-4.6` | `high` |

`CLI_KEYS`, `buildDefaultPerCli()`, `buildModelChoicesByCli()`가 `/cli`, `/model`, `/flush` completion과 settings 기본값 생성에 모두 재사용된다.

---

## CommandContext 통합

`src/cli/command-context.ts` (140L)

### 공통 필드

- `interface`, `locale`, `version`
- `getSession()`, `getSettings()`, `updateSettings()`, `getRuntime()`
- `getSkills()`, `clearSession()`, `resetSession()`, `getCliStatus()`
- MCP / Memory / Browser / Employees / Skills / Prompt helpers

### remote settings patch 제한

Telegram/Discord/Slack은 아래 키만 patch 가능하다:

```text
fallbackOrder, cli, perCli, showReasoning, memory, telegram, discord
```

---

## Command Contract (`src/command-contract/`)

`catalog.ts` + `policy.ts` + `help-renderer.ts`

### Capability

| Value | 의미 |
| --- | --- |
| `full` | 실행 가능 |
| `readonly` | 조회만 허용 |
| `hidden` | 목록/실행 모두 숨김 |
| `blocked` | 목록은 가능할 수 있으나 실행 차단 |

### `cmdline` hidden 세트

```text
help, clear, model, cli, fallback, status, reset,
skill, employee, mcp, memory, browser, prompt, version
```

Workflow category commands (`plan`, `interview`, `deliberate`, `planaudit`, `review`, `jaw-search`, `jaw-goal`, `goalplan`, `gd`, `team`)도 `cmdline`에서 hidden 처리된다.

---

## CLI API Auth (`api-auth.ts`, 45L)

| Export | 역할 |
| --- | --- |
| `getCliAuthToken(portOrBase?)` | `GET /api/auth/token` 호출 후 base별 token cache |
| `authHeaders(extra?)` | `Authorization: Bearer <token>` 병합 |
| `cliFetch(url, init)` | origin 기준 token 확보 후 fetch |

---

## `jaw dashboard memory` (federation search)

L2 cross-instance read-only memory search.

| Subcommand | 동작 |
| --- | --- |
| `search <query...>` | FTS5 BM25 + trigram fan-out search across instances |
| `instances` / `list` | List discovered instances with DB status |
| `read <instanceId:path>` | Read a `.md` memory file from a specific instance |
| `config get` | Get embedding provider configuration |
| `config set [--provider X] [--api-key X] [--mode X] [--enabled\|--disabled]` | Set embedding provider configuration |
| `state` / `embed-state` | Embedding state (state/mode/provider/chunks/DB size/last sync) |
| `estimate` / `embed-estimate` | Embedding cost estimate (chunks/batches/seconds/cost) |
| `reindex --embedding` | Trigger full re-embedding of all memory chunks |

| Option | 동작 |
| --- | --- |
| `--instance <ids>` | Comma-separated instance filter |
| `--limit <N>` | Max results (default: 50, max 200) |
| `--json` | Raw JSON output |
| `--port <port>` | Dashboard manager port (default: 24576) |

---

## Root CLI release gates

```text
gate:typecheck, gate:tests, gate:truth-table-fresh,
gate:mcp-scope-frozen, gate:no-experimental-in-readme-ready-section, gate:all
```

Use `npm run gate:all` as the broad docs/release sanity command.

### Slack history pagination

`jaw slack history <channel> [--thread <parent-ts>] [--limit N] [--cursor C] [--oldest TS] [--latest TS] [--inclusive] [--json]` forwards page and time bounds to the server. JSON preserves the response envelope; text includes pagination metadata. Stop on exhausted, missing or repeated cursor and report `partial`/`contentTruncated` independently.

Qualified direct-local calls to an Auto instance need no Slack grant or operator header. This works independently of native reuse, print resume, steer or worker role. Safe/non-qualified calls keep the existing scoped grant or explicit `--operator` credential path; ordinary HTTP bearer alone does not confer that scoped authority. Do not copy operator credentials to evade a non-full refusal. The page maximum is 200, not a total-thread limit. JSON retains fetched rows and cursor metadata; the text renderer has a separate 12,000-character budget and reports truncation. A Jaw `slack_turn_grant_required` error is not a Slack retention or rate-limit response.

`jaw slack capabilities [--operator]` reports implemented, granted, available and verified tools separately. `jaw slack tool --input-json <JSON> [--operator]` calls typed source and action tools; [operation inputs and limits](../docs/slack-tools.md) cover reactions, own-message changes, schedules, pins, bookmarks, Canvas and Lists. Example shape: `{ "operation":"quote", "invocationId":"unique-id", "source":{"channel":"C123","ts":"1700000000.123456"} }`. `search.quote` accepts query/scope bounds and returns only new Slack output receipts; read the quotes in Slack instead of trying to bypass restricted history. Raw RTS export is unavailable.

`jaw slack send <channel> --file <path> [--thread <parent-ts>] [--caption <text>] [--json] [--operator]` returns a file-upload receipt. The explicit channel is required; omitted thread means root. Uncertain completion and legacy bare success exit nonzero and are never retried automatically.
