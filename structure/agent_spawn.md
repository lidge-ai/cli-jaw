---
created: 2026-03-28
tags: [cli-jaw, agent-runtime, orchestration, acp]
aliases: [CLI-JAW Agent Spawn, agent runtime, ACP orchestration]
---

> 📚 [INDEX](INDEX.md) · **동기화 체크리스트** · [커맨드](commands.md) · [서버 API](server_api.md) · [str_func](str_func.md)

# Agent Spawn — agent/ · orchestrator/ · cli/acp-client · goal/

> CLI spawn + ACP 분기 + Pi RPC + 스트림 + 큐 + 메모리 flush + PABCD 오케스트레이션 + goal-mode autonomy
> 현재 기준: `src/agent/` 46개 TS 파일, `src/orchestrator/` 15개 파일 (+`attestation.ts`), `src/goal/` 5개 파일 (+`pause-gate.ts`), `src/cli/acp-client.ts`

---

## src/agent/* — Spawn & Session

### Print Activity observation

`runtime/print-projection.ts` owns only counters/accepted-content mapping; `print-activity.ts` composes canonical bounds and bypass close. Generic print and legacy Copilot ACP branches capture `activityIdentity` and create one observer; native branches keep their existing projection. Accepted Kiro/AGY/Copilot output and provider parser boundaries feed the observer, never raw stderr. Existing lifecycle supplies the application-final. `merge-tool-log.ts` reconciles exact run/ref or run/seq tools, with primary-first order and terminal precedence. Best-effort trace finalization/linkage cannot discard a correct inserted answer or add delivery attempts. Failed linkage remains explicitly incomplete, not atomic.

Completed Codex `web_search` items (search, page open, and fallback) emit `done`. A provider item ID supplies `codex:item:<id>` as the stable step reference; absent IDs remain anonymous rather than sharing a query-derived identity. The print observer therefore closes successful searches without a missing-terminal diagnostic.

### Native Claude ownership

`claude-runtime-run.ts` adapts the optional SDK to the shared native host and
existing lifecycle. Main turns reuse a pooled query; workers own one fresh query
and a unique instruction directory. `claude-run-controls.ts` retains logical
cancellation/completion before acquisition and after process-map removal, while
`hasActiveAgent` joins real process and native control status. Targeted/all Stop
and existing shutdown waits include these controls; cleanup never invents a PID.

Native auto/safe supports live decisions, bounded images and foreground child
activity. Deny/unknown profiles refuse before preparation, including actual
memory-flush callers; print options are unchanged. Child owner history is retained
independently of live permission eligibility, with bounded reconciliation for both
parent/child declaration order. Runtime finality, interrupted MESSAGE/exit-settle
and print/native session buckets remain under their existing owners. See
[runtime integration](runtime-integration.md) for limits and decision delivery.

| File | Role |
| --- | --- |
| `src/agent/spawn.ts` | spawn entry, standard CLI (stream/DB/broadcast) path, backend dispatch + queue drain 핵심 |
| `src/agent/lifecycle-handler.ts` | child lifecycle, fallback, retry, queue resume, goal continuation |
| `src/agent/args.ts` | CLI별 신규/재개 인자 생성 |
| `src/agent/pi-runtime.ts` | Pi profile normalization, isolated `PI_CODING_AGENT_DIR` config generation, model discovery, JSONL RPC parser/spawner |
| `src/agent/kiro-runtime.ts` | kiro-code plain-text stdout parser (tool lines, assistant blocks, parallel tool merge, tail-buffer flush) |
| `src/agent/kiro-auth.ts` | Kiro CLI data path resolution, session ID extraction from v2 sqlite store, conversation listing |
| `src/agent/kiro-models.ts` | `kiro-cli chat --list-models --format json` dynamic model inventory |
| `src/agent/codex-app-client.ts` | Codex App stdio server client (JSON-RPC thread/turn) |
| `src/agent/codex-app-events.ts` | Codex App turn/tool/message/reasoning event adapter |
| `src/agent/cursor-runtime.ts` | Cursor installed model inventory + model/effort → full model-id resolver |
| `src/agent/memory-flush-controller.ts` | memory flush lock + post-response trigger |
| `src/agent/opencode-diagnostics.ts` | OpenCode binary/permission 점검 + raw event 버퍼 |
| `src/agent/grok-trace-backfill.ts` | Grok streaming-json tool_calls/tool_result backfill from trace archive |
| `src/agent/spawn-env.ts` | AGY plain-text `NO_COLOR=1`, OpenCode/Gemini 전용 env/permission 보정 |
| `src/agent/agy-capabilities.ts` | AGY `--help`/`--version` capability probe + cached optional flag support map |
| `src/agent/smoke-detector.ts` | smoke response 감지 + auto-continue 판단 |
| `src/agent/watchdog.ts` | idle/progress watchdog; progress extends deadline within 4h hard cap |
| `src/agent/resume-classifier.ts` | CLI별 stale session regex |
| `src/agent/alert-escalation.ts` | alert escalation event helper |
| `src/agent/session-persistence.ts` | main session persistence gate |
| `src/agent/live-run-state.ts` | active run snapshot / hydrate helper |
| `src/agent/error-classifier.ts` | stderr/result 기반 에러 분류 helper |
| `src/agent/tool-timeout.ts` | tool inactivity timeout helper |
| `src/agent/agy-runtime.ts` | AGY timeout stdout/close-text 판별 + 최종 planner 기준 timeout suffix 정규화 + session id 추출 + intermediate planner(`my_tool_call_analysis:`) 최종답 차단 (#251) |
| `src/agent/cli-helpers.ts` | Claude-like CLI 판별 helper |

### src/agent/spawn/ — Extracted Submodules

| File | Role |
| --- | --- |
| `spawn/backend-native-acp.ts` | Cursor/Grok native ACP main backend, dispatched from `spawnAgent` |
| `spawn/backend-copilot.ts` | Copilot ACP backend |
| `spawn/backend-pi.ts` | Pi RPC backend |
| `spawn/backend-codex-app.ts` | Codex AppServer backend |
| `spawn/backend-context.ts` | Readonly `SpawnBackendLocals` (values captured at dispatch) and `SpawnBackendHost` (spawn.ts module state/helpers) |
| `spawn/types.ts` | Shared spawn types (`MainRunState`, `SpawnOpts`, `SpawnResult`, …), re-exported from spawn.ts |
| `spawn/queue.ts` | Message queue controller (factory pattern, fair policy, race fix) |
| `spawn/resume.ts` | ACP heartbeat helper + resume bucket decision (pure functions) |
| `spawn/process-kill.ts` | Recursive process tree kill via `pgrep -P` (no shell injection) |

### src/agent/events/ — Event Adapters

| File | Line count | Role |
| --- | ---: | --- |
| `events/index.ts` | 353L | Event dispatcher + public API (extractSessionId, extractOutputChunk, extractFromEvent) |
| `events/helpers.ts` | 322L | syncLiveTools, emitAgentTool, pushTrace, buildPreview, `appendAssistantRawText` (plain `claude` text_delta), `resolveSpawnOutputText` |
| `events/tool-labels.ts` | 343L | tool label extraction + summarizeToolInput |
| `events/grok.ts` | 344L | Grok streaming-json text/thought/end/error + duplicate suppression |
| `events/claude.ts` | 264L | Claude complete-message parsing + `text_delta` live path + rate limit handling |
| `events/codex.ts` | 96L | Codex NDJSON event adapter |
| `events/cursor.ts` | 196L | Cursor stream-json event adapter |
| `events/acp.ts` | 219L | ACP `session/update` / subagent lifecycle mapping |
| `events/opencode.ts` | 196L | OpenCode event adapter |
| `events/summary.ts` | 139L | logEventSummary helper |
| `events/types.ts` | — | Type-only re-export boundary |

---

### `spawn.ts` 핵심 흐름

```text
실행 중 체크 → cli/model/effort 결정 (opts → activeOverrides → perCli → default) → origin 설정
→ mainManaged / employeeSessionId / forceNew 판정
→ resume면 buildResumeArgs, 아니면 buildArgs
→ history는 `working_dir` 스코프 + legacy `NULL` row fallback으로 조회
→ employee spawn이면 tmp cwd + AGENTS.md/CLAUDE.md/GEMINI.md/CONTEXT.md + .claude/CLAUDE.md 주입
→ copilot면 ACP branch, `codex-app`면 app stdio branch, `pi`면 Pi RPC branch, `kiro-code`면 plain stdout branch, 아니면 일반 stdio branch
→ 종료 시 session 저장 / smoke auto-continue / goal continuation / fallback retry / processQueue
```

- `buildHistoryBlock(currentPrompt, workingDir)`는 최근 기록을 읽고, compact marker를 만나면 요약을 넣은 뒤 중단. 누적 상한 `maxTotalChars = 8000`.
- `workingDir`는 히스토리 조회, 메시지 저장, 세션 persistence, 메모리 flush의 공통 스코프.
- `enqueueMessage()`는 queue push 직후 `processQueue()`를 즉시 재호출 (race fix).
- `processQueue()`는 `queueProcessing` 플래그 + `queueMicrotask` 재드레인으로 중복 방지, `source+target` 첫 그룹만 처리하는 fair policy.
- `killProcessTree()`는 `execFileSync`를 사용 (shell injection 방지).

### Copilot ACP branch

- `~/.copilot/config.json`에 `model`과 `reasoning_effort`를 동기화.
- `AcpClient({ model, workDir, permissions, env })`를 생성, `initialize()` 후 resume/new session 분기.
- `loadSession()` 성공 시 replay 모드, 실패 시 `createSession()` + `withHistoryPrompt()` fallback.
- `session/update`는 `extractFromAcpUpdate()`로 변환. subagent는 `tool_call` + `rawInput.agent_type === 'task'`로 감지.
- `acp.shutdown()` 전에 `persistMainSession()` 선행.

### Codex AppServer branch

- `CodexAppClient`는 `codex app-server --listen stdio://`를 띄우고 JSON-RPC 사용.
- thread config: `model_reasoning_summary="detailed"`, `hide_agent_reasoning=false`, `show_raw_agent_reasoning=true`.
- `codex-app-events.ts`는 reasoning summaryTextDelta/textDelta/summaryPartAdded를 `toolType:"thinking"`으로 정규화.

### Kiro-code branch

- `kiro-cli chat --no-interactive` plain stdout 표면.
- Fresh run은 cli-jaw operational context + `withHistoryPrompt()` bounded history를 args prompt에 포함한다.
- Resume run은 `--resume-id <sessionId>`와 현재 prompt만 전달한다. Kiro native session이 이전 대화 상태를 이미 보유하므로 operational context/history를 매 턴 다시 붙이지 않는다.
- `kiro-runtime.ts`가 tool line(`using tool:`), completion marker, `>` assistant block + continuation lines, parallel tool merge, tail-buffer flush를 파싱해 `agent_tool` + `agent_output`으로 브로드캐스트.
- Live preview는 raw delta (`liveOutputText`, bullet inject 없음), session/finalize용 raw capture는 `fullText`, authoritative body는 `resolveSpawnOutputText()` (parsed Kiro 우선).
- 동적 모델 목록은 `kiro-cli chat --list-models --format json` (`kiro-models.ts`).
- Quota는 `quota-kiro-reverse.ts` (CodeWhisperer GetUsageLimits) 경로.
- Session ID는 stdout regex 또는 v2 sqlite store에서 추출 (`kiro-auth.ts`).
- Resume 인자는 런타임별로 분리된다. Native `kiro-code`는 resume turn에서 `kiro-cli chat --no-interactive --resume-id <sessionId> ...`를 사용한다.

### Pi RPC branch

- `pi`는 top-level runtime이다.
- `src/agent/pi-runtime.ts`가 `settings.pi` profile을 정규화하고, `JAW_HOME/pi/runtime/<profileId>` 아래 `models.json` + `settings.json`을 생성한다.
- 실행은 `pi --mode rpc --no-session --no-context-files --provider <profileId> --model <model> --api-key <key>` 형태다.
- binary resolution은 `PI_CODING_AGENT_BIN` → PATH `pi` → `npm exec --yes --package @earendil-works/pi-coding-agent pi --` 순서이며, npm fallback은 shell string이 아니라 command/baseArgs tuple로 spawn된다.
- RPC stdin은 `get_state`, optional `set_thinking_level`, `prompt` JSONL 명령을 보내고, stdout JSONL 이벤트에서 `message_update`, `tool_execution_*`, `agent_end`를 파싱해 `agent_output`/`agent_tool`/completion으로 매핑한다.
- 이 구현은 per-run RPC child다. `agent_end` 뒤 stdin을 닫고 grace window 이후 남은 child를 종료한다. persistent Pi RPC daemon은 후속 과제다.

### Standard CLI branches

| CLI | 표면 | 특이사항 |
| --- | --- | --- |
| `pi` | `pi --mode rpc` | isolated `PI_CODING_AGENT_DIR`, profile/model from `settings.pi`, npm-exec fallback |
| `claude` | stdin에 `withHistoryPrompt()` + `stream-json` | `text_delta` → `appendAssistantRawText` → live `agent_output`; `claudeStreamedText` prevents duplicate on complete `assistant` |
| `agy` | `agy -p <prompt> [--model <id>] --print-timeout 10m --log-file <tmp>` | plain text stdout; optional flags are emitted only when `agy-capabilities.ts` detects support (`--model` observed in AGY 1.0.12); session id from stdout/log; resume `--conversation <id>` |
| `cursor` | `cursor-agent -p --trust --output-format stream-json --model <resolvedModelId>` | effort는 full model id로 해석, `runtimeModel` session bucket |
| `kiro-code` | `kiro-cli chat --no-interactive [--resume-id <id>]` | fresh: operational context + `withHistoryPrompt()`; resume: current prompt only |
| `codex` | stdin에 `[User Message]` 블록 (fresh only) | — |
| `grok` | `-p`, optional `-m`, `--output-format streaming-json`, `--no-alt-screen` | trace backfill on exit |
| `opencode` | diagnostics + raw event buffer | — |

### Session persistence / resume classifier

- `persistMainSession()`는 `forceNew`, `employeeSessionId`, `!sessionId`, `isFallback`, 비정상 exit를 모두 차단.
- 저장: `cli`, `sessionId`, `model`, `permissions`, `workingDir`, `effort`.
- `shouldInvalidateResumeSession()`는 `code === 0`이면 무조건 false, 실패 시 generic + CLI별 matcher 검사.
- Resume 무효화: `claude`, `agy`, `codex`, `cursor`, `grok`, `opencode`, `copilot`, `kiro-code` 각각 분기.
- AGY guarded native resume (#261): 기본은 native resume OFF(DB history 유지). `perCli.agy.nativeResume: "guarded"` opt-in 시 `canGuardedAgyResume()`(`src/agent/spawn/resume.ts`) 전 가드 통과에서만 `--conversation` 재개 — capability probe, TTL 72h, model+cwd identity, `session_buckets.last_run_clean=1`(plannerOnly/checkpointSeen false), fresh-bootstrap 아님. stale conversation 출력 감지 시 bucket clear 후 fresh 경로로 1회 재시도. replay stripping은 무조건 유지.

---

### Tool-log safety boundary

`src/shared/tool-log-sanitize.ts`가 live/persisted tool UI의 공유 cap/truncate boundary:

| Surface | Sanitization path |
| --- | --- |
| WS `agent_tool` | `core/bus.ts` → `sanitizeToolLogEntry()` |
| WS `agent_done.toolLog` | `core/bus.ts` → `sanitizeToolLogForDurableStorage()` |
| `/api/orchestrate/snapshot.activeRun.toolLog` | `routes/orchestrate.ts` → `getSafeLiveRun()` |

### Retry and trace redaction boundary

`lifecycle-handler.ts` uses `_retryAttempt` rather than a boolean retry flag.
Main 429 retries use exponential backoff up to `MAIN_MAX_RETRIES = 3`; employee
429/Claude-rate-limit/transient-startup retries use a shorter exponential
backoff up to `EMP_MAX_RETRIES = 2`. Public `agent_retry` events include
attempt/max retry metadata so the UI can distinguish first retry from exhausted
attempts.

`src/trace/redact.ts` is the trace-storage redaction boundary for structured
trace values and previews. It redacts AWS `AKIA...` keys, Anthropic
`sk-ant-*` keys, JWT-like tokens, and secret-looking object keys before values
are persisted or displayed through trace helpers.

---

## src/cli/acp-client.ts — Copilot ACP JSON-RPC Client (382L)

| Method | Role |
| --- | --- |
| `buildSpawnArgs()` | `--acp` + model + permission flags |
| `spawn()` | `copilot --acp` 생성 + stdout NDJSON 파싱 |
| `request()` | JSON-RPC request/response |
| `requestWithActivityTimeout()` | idle + absolute 이중 타임아웃 |
| `_handleLine()` | response / notification / agent request 분기 |
| `initialize()` | protocolVersion 1 handshake |
| `createSession()` | `session/new` |
| `loadSession()` | `session/load` |
| `prompt()` | `session/prompt` + activity timeout |
| `shutdown()` | `shutdown` 후 kill |

- `permissions === 'auto'` 또는 `'yolo'`이면 `--allow-all-tools --allow-all-paths --allow-all-urls`.
- `prompt()` activity timeout: idle 1200000ms, max 14400000ms.
- `session/request_permission`은 항상 자동 승인.

---

## src/goal/* — Goal-Mode Autonomy (5 files)

| File | Line count | Role |
| --- | ---: | --- |
| `goal/store.ts` | 158L | active goal CRUD, checkpoint, history, completion evidence gate |
| `goal/heartbeat.ts` | 92L | goal-aware heartbeat continuation builder (stale detection, worker/orc state check) |
| `goal/pause-gate.ts` | 26L | derived armed gate: `active` + `agentPauseCount >= 1` → `pause_gate_pending` |
| `goal/runtime.ts` | 55L | goal runtime helpers |
| `goal/types.ts` | 42L | GoalState, GoalHistory, GoalCheckpoint, GoalBudget types |

- `lifecycle-handler.ts`는 agent 종료 후 active goal이 있으면 `buildGoalContinuation()`으로 자동 재스폰 판단.
- **Pause gate (P0 2026-06-27):** armed gate (`describeGoalPauseGate()`)이면 `buildGoalContinuation()` returns `shouldContinue: true` with `reason: "pause_gate_pending"` for one audit/finalizer turn; if a goal-continuation turn exits with the gate still armed, `goal_pause_gate_pending` is broadcast and further automatic continuation is not scheduled. `agentPauseCount`는 productive goal events에서만 reset — assistant text alone does not clear gate.
- `completeGoal()`은 `goalHasCompletionEvidence()`가 true일 때만 goal을 완료 처리 (verification evidence gate).
- Goal continuation은 `GOAL_CONT_MAX_ATTEMPTS = 20` 회 제한, goal ID 변경 시 카운터 리셋.

---

## src/orchestrator/* — PABCD Orchestration (18 files)

| File | Line count | Role |
| --- | ---: | --- |
| `orchestrator/pipeline.ts` | 657L | PABCD sole entry point + interview first-turn init + `<interview_tracker>` 추출 |
| `orchestrator/state-machine.ts` | 692L | IPABCD state + prompts + interview tracker → OrcContext + audit/verification verdict + attestation gate |
| `orchestrator/attestation.ts` | 178L | `--attest` / `<phase_attestation>` parse + `checkAttestationGate()` (narrative `did`, C→D `checkOutput`) |
| `orchestrator/distribute.ts` | 615L | employee dispatch + parallel safety |
| `orchestrator/worker-registry.ts` | 241L | worker ownership + replay registry + sanitized progress snapshots |
| `orchestrator/gateway.ts` | 155L | queue / intent gateway |
| `orchestrator/parser.ts` | 176L | legacy subtask JSON 파서 + intent matcher + numeric reference + verdict 파서 |
| `orchestrator/seed.ts` | 107L | ontology schema + seed metadata for interview-driven planning |
| `orchestrator/workspace-context.ts` | 136L | task에서 repo path hint 추출, project root resolve |
| `orchestrator/friction.ts` | 76L | friction signature ledger + retry/escalate/stop verdict |
| `orchestrator/collect.ts` | 66L | orchestrate 결과 수집 |
| `orchestrator/worker-progress.ts` | 58L | worker progress safe-summary sanitizer + snapshot types |
| `orchestrator/worker-monitor.ts` | 58L | stall/disconnect/timeout monitor |
| `orchestrator/sanitize.ts` | 52L | `stripInterviewTracker()` — interview tracker/perspective tags from visible text |
| `orchestrator/scope.ts` | 86L | remote binding key + channel gate + local session scope + captured execution binding; legacy `findActiveScope()`만 `'default'` 반환 |

### `pipeline.ts` 실제 흐름

```text
orchestrate(prompt, meta)
  ├─ pending worker replay drain
  ├─ scope resolution (`workingDir` 포함) + current state read
  ├─ PABCD entry는 explicit only
  ├─ 첫 planning turn이면 `getStatePrompt('P')` + 원본 요청 조합
  ├─ prompt prefix injection
  ├─ `buildMemoryInjection()`에서 boss snapshot 추출
  ├─ spawnAgent(prompt, { origin, _skipInsert, memorySnapshot })
  └─ result broadcast + worklog/state update
```

- PABCD 진입은 명시적 (`/orchestrate`, `/pabcd`, LLM tool call).
- `state === 'P'`이고 `ctx.plan`이 비어 있으면 `resolveNumericReference()`로 사용자 지시를 직전 numbered list에서 치환.
- `buildApprovedPlanPromptBlock()`이 `A/B/C` 상태에서 `ctx.plan`을 prompt 최상단에 붙임.
- `orchestrateContinue()`는 active PABCD면 continue prompt, IDLE이면 worklog-based resume.
- `orchestrateReset()`는 agent/worker/queue/registry/employee session/state/worklog 모두 reset.

### State machine

- `OrcStateName`: `IDLE | P | A | B | C | D`.
- `OrcContext`: `auditStatus`, `verificationStatus`, `userApproved`, `worklogPath`, `planHash`, `planUpdatedAt`, `taskAnchor`, `resolvedSelection`, `interview`(request/round/known/unknown).
- Interview(I): 라운드당 1~3개 질문, `<interview_tracker>` 블록을 정규식 파싱 → `ctx.interview` 갱신 → `orc_state` WS payload로 Web UI 전달.

### Worker registry / monitor

- `claimWorker()` → `running`, `finishWorker()` → `done + pendingReplay=true`.
- `worker-progress.ts`로 thinking/detail 제거한 안전 요약만 노출.
- `startWorkerMonitor()`: `stallThresholdMs: 120_000`, `maxDurationMs: 600_000`.

### Employee resume-session recovery

- Persisted employee resume sessions are targeted by `employeeSessionId`; fresh
  retry paths must not become Boss main-managed runs.
- If an employee resume exits before SessionStart, lifecycle handling clears
  only that employee's stored session row and retries once with `_skipResume`.
- `spawn.ts` treats `_skipResume` as disabling employee `employeeSessionId`
  reuse, and `mainManaged` stays false whenever `opts.agentId` is present.
- Generic employee transient backoff remains for non-resume failures, but is
  suppressed after the one-shot fresh-session retry.

### Friction ledger (`friction.ts`)

- `recordFriction(tool, error)` → normalized error fingerprint → count 기반 verdict (`retry`/`escalate`/`stop`).
- 같은 tool+error 패턴이 반복되면 자동 escalate/stop.

### Seed / Ontology (`seed.ts`)

- Interview 결과에서 ontology schema (entities, relationships, invariants)와 seed metadata를 구조화.
- Planning phase에서 interview evidence를 structured plan input으로 변환.

---

## prompt/builder.ts — System Prompt & Skills (946L)

| Function | Role |
| --- | --- |
| `loadActiveSkills()` | 활성 스킬 로드 |
| `loadSkillRegistry()` | skills_ref registry 로드 |
| `getMergedSkills()` | active + ref 병합 |
| `initPromptFiles()` | A-1/A-2/HEARTBEAT 프롬프트 초기화 |
| `getSystemPrompt()` | 메인 시스템 프롬프트 구성 |
| `loadRecentMemories()` | flush memory 로드 |
| `getEmployeePrompt(emp)` | 경량 실행자 프롬프트 |
| `getEmployeePromptV2(emp, role, phase)` | v2 employee prompt (phase/role-aware skill) |
| `regenerateB()` | B 프롬프트 + workspace `AGENTS.md` 재생성 |

- promptCache 키: `empId/name:cli:role:phase:workingDir:mutability:scope:taskTags:mcpHash`. CLI별 employee prompt, mutable/read-only override, scope, task tag attachment, MCP tool summary changes가 모두 cache invalidation에 들어간다.
- Boss prompt는 `cli-jaw dispatch --agent ... --task ...` 경로만 설명.
- Employee prompt는 CLI 자체 sub-agent(Task/Agent tool)를 내부 병렬화 용도로 허용.

---

## Memory Flush Controller (`memory-flush-controller.ts`, 184L)

| Export | Role |
| --- | --- |
| `incrementMemoryFlush()` | `memoryFlushCounter` 증가 (compact 턴 수 추정용, 단조 증가) |
| `countTurnForFlush(threshold)` | 전역 플러시 트리거 카운터. 임계 도달 시 리셋하고 true |
| `triggerMemoryFlush()` | 자동 플러시 — 미플러시 세션 전부를 합쳐 extractor 1회 |
| `triggerMemoryFlushForCurrentSession()` | 수동 플러시 — 현재 세션 단독, 세션 헤딩 유지 |
| `setSpawnRef(fn, procs)` | circular import 회피용 forward reference 설정 |

- `_flushLock`으로 동시 flush 방지. 막힌 자동 플러시는 `_pendingMergedFlush` 한 비트로 합쳐져 lock 해제 시 한 번 재시도된다.
- `_lastFlushedMessageId`(세션별)로 중복 flush 방지. 합본이어도 각 세션은 자기 마지막 담긴 행까지만 전진한다.
- `lifecycle-handler.ts`가 agent 종료 후 전역 턴 카운터 기준으로 flush 트리거. `memoryFlushCounter` 는 여기서 쓰이지 않는다 — compact 임계(25/35턴) 추정용이라 리셋되면 안 되기 때문이다.
- 반환값은 `'started' | 'insufficient' | 'locked'`.
- Dashboard home resolution으로 flush 결과를 dashboard notes에도 반영 가능.

---

## Lifecycle Handler 주요 책임 (1072L)

| 관심사 | 구현 |
| --- | --- |
| Session persistence | `persistMainSession()` 호출 + bucket 저장 |
| Smoke auto-continue | `buildContinuationPrompt()` → 같은 엔진 재스폰 |
| Goal continuation | active goal + completion evidence 미충족 시 `buildGoalContinuation()` → 재스폰 (max 20회) |
| Fallback retry | error classification → retry with different model/effort |
| Grok trace backfill | 정상 종료 후 `grok trace --local --json` 호출 |
| Memory flush trigger | 전역 턴 카운터(`countTurnForFlush`) 기준 `triggerMemoryFlush()` |
| Queue resume | `processQueue()` 호출 |
| Interview tracker strip | `stripInterviewTracker()` from broadcast text |
| Tool-log sanitize | `sanitizeToolLogForDurableStorage()` before DB insert |
| Trace finalization | `finalizeTraceRun()` + `linkTraceRunToMessage()` |
| Kiro output resolution | `resolveSpawnOutputText()` (parsed Kiro body 우선) |
