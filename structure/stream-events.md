---
created: 2026-03-28
tags: [cli-jaw, sse, websocket, ndjson, stream-events, parser]
aliases: [CLI Stream Event Reference, stream events, SSE event channel, NDJSON parser]
---

# CLI Stream Event Reference (SSE + Legacy WS + Provider Streams)

> 각 CLI의 NDJSON/ACP/stream-json 이벤트를 `src/agent/events/`가 파싱하고, AGY plain-text output은 `spawn.ts`가 직접 처리한다. X-01 이후 current server의 public Web delivery는 `src/core/event-bus.ts` + `GET /api/events` SSE channel이 담당한다. WebSocket은 current server broadcast path가 아니라 `/api/events`가 한 번도 열리지 않는 pre-X-01 server용 client/TUI fallback이다.
> 마지막 코드 대조: 2026-06-27 (`src/core/event-bus.ts`, `src/agent/lifecycle-handler.ts`, `src/goal/heartbeat.ts`, `src/agent/events/claude.ts`, `public/js/features/process-block.ts`, `public/js/ws.ts`)

---

## 1. 전체 흐름

Print providers also feed the canonical journal through accepted parser hooks and `runtime/print-activity.ts`. This observer does not replace `agent_output`, `agent_tool` or lifecycle-selected `agent_done`. Unknown text remains unknown; only explicit provider phase tags or the lifecycle's application-final establish their respective meanings. Synthetic narration/thought cards are not observed twice. Trace failure produces degradation without another send/inference. Exact-pointer tool recovery and `merge-tool-log.ts` converge terminal details; only print opts into explicit terminal-to-terminal updates. Native terminal defaults and messaging listeners remain unchanged. See `runtime-integration.md` for storage and omission semantics.

```text
CLI spawn / ACP session
  → raw stdout/stderr lines
  → AGY: spawn.ts plain-text branch
  → Other standard CLIs: src/agent/events/*
      - logEventSummary()
      - extractFromEvent()
      - extractOutputChunk()
  → broadcast(type, data, audience)  // src/core/bus.ts
      - public SSE topic/event publish through src/core/event-bus.ts
      - internal listeners regardless of audience
  → public/js/event-channel.ts
      - EventSource singleton
      - Last-Event-ID / ?lastEventId replay
      - replay_gap notice
      - legacy WebSocket fallback only when /api/events is unavailable
  → public/js/ws.ts
      - shared UI event handlers
      - legacy WebSocket compatibility only for pre-X-01 servers
  → bin/commands/tui/channel.ts
      - SSE-first terminal chat transport
      - outbound REST to /api/message and /api/stop
      - legacy WebSocket fallback only for pre-X-01 servers
  → orchestrator listeners
      - collect.ts
      - telegram/discord forwarders
```

`broadcast()`는 `audience === 'public'`일 때 SSE event bus에 publish한다. X-01 이후 서버의 legacy WebSocket public broadcast path는 제거되었다. audience와 무관하게 internal listener callback은 수행된다. Employee/internal 이벤트는 public SSE를 건너뛰지만 collector/forwarder listener에는 전달된다.

`GET /api/events`는 data-only SSE wire format이다. 서버는 `event:` field를 쓰지 않고, `data:` JSON payload 안에 `{ topic, event, ...payload }`를 넣는다. 클라이언트는 단일 `onmessage` handler로 모든 topic/event를 받아 dispatch한다.

SSE behavior:

| Surface | Contract |
| --- | --- |
| Endpoint | `GET /api/events` |
| Replay cursor | `Last-Event-ID` header or `?lastEventId=` query |
| Ring buffer | `src/core/event-bus.ts` `RING_SIZE = 1000` |
| Listener cap | `MAX_SSE_LISTENERS = 256`, overflow returns `503 { error: "SSE_CAPACITY" }` |
| Heartbeat | `data: {"topic":"system","event":"ping"}` every 15 seconds; no `id`, so it does not advance replay cursors |
| Replay gap | `data: {"topic":"system","event":"replay_gap"}` |

> Replay gap은 **evict된 것으로만** 판정한다 (075). ring은 모든 scope가 공유하므로 남아 있는
> entry의 id 간격은 다른 scope의 번호일 뿐 증거가 아니다. bus는 evict마다 delivery class별
> 워터마크(`NONE`은 기록 안 함 / `GLOBAL` / `<scope>` / 전체용 `ALL`)를 갱신하고,
> `hasReplayGap(lastId, scopeFilter?)`이 그것만 본다. 분류는 `deliveryKeyForEntry`
> (`src/core/event-scope.ts`)가 delivery 규칙과 같은 순서로 정하며,
> `registerEventsRoutes()` 진입부에서 bus에 주입된다 — core와 manager 양쪽이 그 함수를 부른다.
> 워터마크는 지우지 않는다: 오래된 커서로 재접속하는 탭이 언제든 있고, 항목 하나를 버리는 비용이
> gap을 놓치는 비용보다 크다.
| Client fallback | `public/js/event-channel.ts` fires unavailable once when SSE errors before first open, then `public/js/ws.ts` uses legacy WebSocket fallback |
| Transient drop UX | `public/js/ws.ts` waits `CHANNEL_DOWN_TOAST_GRACE_MS = 8000` before showing a disconnected system message; fast SSE reconnects stay silent |

### Manager worker SSE bridge

`jaw dashboard serve` does not make the React manager browser subscribe directly to every worker's EventSource. The manager server starts `src/manager/worker-events.ts`, which listens for worker lifecycle changes and uses `src/manager/worker-sse-client.ts` to subscribe to each live worker's `http://127.0.0.1:{port}/api/events` stream. Worker SSE updates feed a debounced latest-message cache used by manager/Jaw CEO surfaces; the React manager still consumes manager HTTP polling endpoints such as `/api/manager/events` and `/api/dashboard/instances`.

---

## 2. 실제 Broadcast / SSE / WebSocket 이벤트 Surface

### Canonical runtime side channel

Classic history catch-up uses fixed-through HTTP pages and a per-run replay barrier;
unrelated live runs continue rendering. Restore keeps stored scope separate from
current live admission. Snapshot revision fencing prevents an older A read from
rehydrating over newer live B. Saved MESSAGE owns final text; recovery metadata is
local UI state, never a fabricated stream terminal. SSE outage state stays distinct
from successful manual reads. Historical requests remain non-actionable.

Grok native main supplies the passive usage mapper through the existing runtime-session hook. It accepts only the original prompt response's aggregate `_meta.usage`; cached-read tokens are reported separately, missing counts stay absent and invalid optional counters suppress only telemetry. It does not infer cost or substitute top-level last-call totals. Core tool/message projection and final selection remain independent. Optional Grok completion notifications cannot emit a terminal or settle a cancellation; unsupported executable extensions are refused.

Cursor native main sends tool/message/reasoning previews through the same canonical emitter, never provisional `agent_output`. Its raw authoritative result is claimed before application persistence; `onRuntimeEnd` finalizes the captured turn after output policy/stop precedence. A private `SpawnLifecycle.onActivity` identity callback connects owned native I/O to its collector independently of journal success. It carries no text, is not an SSE/messaging event, cannot refresh another request or a completed collector, and retains explicit mention-watch scope/chat ownership with multi-session off.

Cursor cancel-reprompt keeps that same logical run/turn identity while native prompt attempts change. Intermediate cancellation drains old updates and callbacks without emitting another logical `turn-end` or assistant MESSAGE. The existing `steer_started` receipt reports `mode: cancel-reprompt` and `localDispatch: true`; it is a local-write fact, not a model ACK. User input is committed once before the final lifecycle, with current main/canonical ownership rechecked. No-start may queue, fatal failure does not. Input context is application-reinjected and bounded; anonymous frames after the next attempt starts still rely on ACP v1 ordering.

An undispatched redirect invalidated by Stop is not a queueable no-start. It settles the existing `request_settled` outcome as `cancelled`, without a B user row or another prompt; slash and gateway consumers must not recreate it after Stop's queue purge. Already-dispatched input and its one commit remain distinct from this cancellation case.

Pi RPC also feeds this channel: prompt-owned raw callbacks provide tool start/update/end snapshots, while accepted legacy text/reasoning callbacks preserve echo suppression. Its raw trace retention is delta-only for repeated message snapshots and bounded separately from canonical delivery. Budget omission is explicitly recorded in a small trace control row; it does not send a canonical gap or interfere with the existing final/abort lifecycle. Native steer behavior is not added by this observer.

Codex app-server's accepted owner-scoped notifications also feed `src/agent/runtime/codex-projection.ts`. Bounded/redacted snapshots are stored as immutable `source=runtime` trace rows before `agent_runtime` is published directly on the SSE agent topic. This side channel deliberately bypasses `addBroadcastListener`. Slack has a separate bounded display-only tool observer, enabled only after private request/run identity binding; it does not forward raw events or choose final answers. Telegram/Discord delivery remains independent. `agent_runtime_gap` marks the first projection failure and stops further canonical writes in that run; legacy lifecycle delivery remains independent. TUI already uses SSE through its channel adapter; no new WebSocket server path is required.

The version1 envelope carries jaw `sessionId`, routing `scope`, `runId`, logical `turnId`, committed noncontiguous `seq`, and an allowlisted body. Provider IDs are private. Finality comes from lifecycle, not the last tool/text event. Optional native compatibility fields `runtimeFinality: present|absent`, `runtimeStatus: done|error|stopped`, and `stopCause: watchdog|user_stop|steer_kill|unattributed` retain model-final meaning without broadcasting `runtimeOutcome` or `partialText`. Empty native terminals still perform web/TUI cleanup, but cannot fall back to streamed previews.

Classic's live Activity dispatcher admits against the existing snapshot bridge's captured session/scope, with independently suspended stream admission. Pre-admission runtime events and projection-gap notices share a256-entry/1MiB queue; gaps retain their original identity. The bridge's live non-replayed terminal schedules its existing request GET to recover a missed settlement notice, never a POST. Closed Activity does not hide live decision controls.

The journal's canonical terminal is redacted; a later owned public native-present or print answer can correct the same rendered/cache row without repeating lifecycle or notification. Native-absent diagnostics remain separate from that answer. Missing journal frames never disable compatibility final delivery. Same-turn native-input and same-session cancel-reprompt steer receipts do not terminate the current Activity. Cold journal hydration and TUI display are separate from this Classic live consumer.

Owner-bound `activity-journal.ts` now persists immutable canonical events before SSE publication. Internal append is allowed without public replay. Storage/budget loss stops canonical append and remains visible on bounded history reads; finals and interrupted salvage stay independent. Runtime/gap broadcasts bypass all messaging listeners and require original nonempty run/session/scope before ambient-scope stamping. Discovery/replay use explicit-session trace routes and fixed sparse high-water cursors; no old event can re-open a live decision. Private control metadata and whole-prefix retention are documented in `runtime-integration.md`.

`src/core/bus.ts`의 `broadcast(type, data, audience = 'public')`가 단일 fan-out 지점이다. Current server의 public Web delivery는 SSE-only이며, `src/routes/events.ts`의 `formatSse()`가 `{ ...entry.data, topic, event }`를 `data:` JSON payload로 쓴다. 내부 listener(`addBroadcastListener`)는 public/internal 여부와 무관하게 호출된다. Legacy WebSocket payload shape `{ type, ...payload }`는 client/TUI fallback이 pre-X-01 server에 붙을 때만 의미가 있다.

### `broadcast()` public events

Interactive TUI consumes the same canonical side channel with snapshot-owned
identity. Unknown foreign compatibility frames are rejected before legacy input/
clock/IDE mutation. Canonical terminal status does not promote journal text into
an answer: the exact chat/run MESSAGE read refines an admitted compatibility
receipt, including missing-journal runs. Snapshot-owned newer runs retain lifecycle
ownership even without a canonical model. F6 records are read-only; inspecting an
approval never answers it. Raw pipe retains existing NDJSON/agent_done termination.

아래 표는 2026-07-06 code read 기준 `broadcast(type, data)` 또는 `broadcast(..., 'public')`로 public SSE bus에 들어갈 수 있는 event inventory다. Hard count는 Phase 2 generated hook으로 대체 예정이라 여기서는 수동 숫자를 고정하지 않는다.

| Type | 대표 payload | 발행 위치 / 용도 |
| --- | --- | --- |
| `agent_status` | `{ running? \| status?, agentId, cli?, isEmployee?, phase?, phaseLabel? }` | `spawn.ts`, `lifecycle-handler.ts`, `orchestrator/distribute.ts`; agent 실행/종료/worker phase |
| `agent_tool` | `{ agentId, icon, label, toolType?, detail?, stepRef?, status?, isEmployee? }` | `agent/events.ts`, `spawn.ts`; CLI/ACP tool, thinking, search, subagent step |
| `agent_output` | `{ agentId, cli, text, isEmployee? }` | `spawn.ts`; live preview chunk, including AGY plain stdout |
| `agent_done` | `{ text, toolLog?, error?, errorKind?, cli?, origin?, isEmployee? }` | `lifecycle-handler.ts`, `spawn.ts`, `server.ts`; authoritative final/error. `errorKind` (`rate_limit|auth|stall|connection|exit`) + `cli` 는 분류된 실패에만 실리며, Slack/Discord forwarder 는 이 필드가 없는 error 페이로드를 채널로 내보내지 않는다 (#519). 네이티브 터미널도 `classifyExitError` 에 `ctx.stallReason` 을 넘긴다 — 넘기지 않으면 watchdog 종료가 `stall` 이 아니라 `exit` 로 분류돼 `messaging/error-block.ts` 의 ACTION 문구가 "런타임이 비정상 종료했습니다"로 나간다(#673). `:1217`/`:1232` 의 후속 분류 호출은 아직 넘기지 않는다. |
| `agent_retry` | `{ cli, delay, reason, attempt?, maxRetries?, isEmployee? }` | 429/transient retry 안내. Main runs use exponential backoff up to 3 attempts; employee transient retries use a shorter backoff up to 2 attempts. |
| `agent_fallback` | `{ from, to, reason, isEmployee? }` | fallback CLI 전환 안내 |
| `agent_smoke` | `{ cli, confidence, reason, agentId, isEmployee? }` | smoke response auto-continue 안내 |
| `queue_update` | `{ pending }` | `spawn.ts`; message queue 길이 |
| `new_message` | `{ role, content, source, cli?, fromQueue?, external? }` | `spawn.ts`, `orchestrator/gateway.ts`, `routes/orchestrate.ts`, `lifecycle-handler.ts` (goal boundary, `source:'goal'`); remote/queued/externally-relayed user bubble — web UI live-renders `telegram|discord|bgtask|cli|goal`, `external:true`, `fromQueue:true` |
| `orchestrate_done` | `{ text, error?, executionFailed?, executionInterrupted?, runtimeFinality?, runtimeStatus?, stopCause?, origin?, chatId?, target?, requestId? }` | `orchestrator/pipeline.ts`, `gateway.ts`, `spawn.ts`; orchestration/queued result; `executionFailed:true` comes only from the final selected result, not an intermediate retry failure. 네이티브 실행은 `runtimeFinality`/`runtimeStatus` 를 싣고, 이 둘이 `messaging/native-body.ts` 의 술어가 읽는 태그다. 기계 상태는 여전히 `runtimeStatus:'stopped'` 하나다. 채널 문장을 가르는 값은 선택 필드 `stopCause` (`watchdog`/`user_stop`/`steer_kill`/`unattributed`)다. 없으면 수집기는 `tg.stopped` 를 쓴다. `unattributed` 는 Jaw 가 죽이기 전에 런타임이 종료된 경우다. |
| `orc_state` | `{ state, title?, scope?, taskAnchor?, resolvedSelection? }` | `orchestrator/state-machine.ts`; PABCD 상태 |
| `clear` | `{}` | `server.ts`, `core/main-session.ts`; UI clear |
| `session_reset` | `{ cli, model }` | `core/main-session.ts`; history-preserving session reset |
| `agent_added` | `Employee` | `routes/employees.ts`; 직원 생성 |
| `agent_updated` | `Employee \| {}` | `routes/employees.ts`, `core/employees.ts`; 직원 수정/reset |
| `agent_deleted` | `{ id }` | `routes/employees.ts`; 직원 삭제 |
| `memory_status` | `buildMemorySyncPayload(reason)` | `routes/jaw-memory.ts`; memory sidebar refresh |
| `heartbeat_pending` | `{ pending, deferredPending, agentBusyPending, reason?, policy?, jobId?, jobName? }` | `memory/heartbeat.ts`; heartbeat busy/defer queue. `reason` may be `busy`, `pabcd_active`, or `agent_busy` |
| `system_notice` | `{ code, text }` | `core/compact.ts`, `lifecycle-handler.ts`; compact/session refresh notice |
| `alert_escalation` | `{ message?, reason?, ... }` | `agent/alert-escalation.ts`; repeated failure / capacity fallback escalation |
| `settings_change` | `{ ... }` | settings/project/workspace refresh signal |
| `steer_started` | `{ prompt, origin? }` | `handlers-workflows.ts`, `routes/orchestrate.ts`; accepted steer prompt |
| `session_switched` | `{ sessionId }` | session switch broadcast |
| `session_created` | `{ session }` | session create broadcast |
| `session_list` | `{ sessions }` | session list refresh |
| `goal_done` | `{ ... }` | durable goal completion |
| `goal_done_rejected` | `{ ... }` | completion evidence gate rejection |
| `goal_cancel` | `{ ... }` | durable goal cancellation |
| `goal_pause_detected` | `{ ... }` | pause 2-tap gate detection |
| `goal_pause_gate_pending` | `{ goalId, reason }` | armed pause gate remains after a goal-continuation audit turn; no further automatic continuation is scheduled |
| `goal_continuation` | `{ ... }` | goal continuation kick; when pause gate is armed (`pause_gate_pending`), one audit/finalizer continuation may run, then further automatic continuation is suppressed if the gate remains armed |
| `goal_continuation_failed` | `{ ... }` | goal continuation failure |
| `goal_continuation_limit` | `{ ... }` | bounded continuation limit |
| `schedule_wakeup` | `{ ... }` | ScheduleWakeup accepted |
| `schedule_wakeup_failed` | `{ ... }` | ScheduleWakeup failed |
| `worker_stalled` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker stall; progress snapshot `attention.kind=stalled` |
| `worker_disconnected` | `{ agentId, exitCode, isEmployee: true }` | `orchestrator/distribute.ts`; worker disconnect; progress snapshot `attention.kind=disconnected` |
| `worker_timeout` | `{ agentId, employeeName, isEmployee: true }` | `orchestrator/distribute.ts`; worker timeout; progress snapshot `attention.kind=timeout` |
| `worker_run_started` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, taskPreview }` | `orchestrator/worker-run-store.ts`; durable run started safe event |
| `worker_run_progress` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, tools, toolCount }` | `orchestrator/worker-run-store.ts`; sanitized tool progress snapshot; no raw output |
| `worker_run_attention` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, attention }` | `orchestrator/worker-run-store.ts`; safe attention metadata |
| `worker_run_done` / `worker_run_failed` / `worker_run_cancelled` | `{ runId, agentId, employeeName, status, statusCategory, outputBytes, seq, completedAt, safeSummary? }` | `orchestrator/worker-run-store.ts`; completion event; raw output path/content excluded |
| `request_settled` | `{ requestId, outcome, scope, text?, error?, mergedInto?, reason? }` | `orchestrator/request-registry.ts`; topic은 `system`(이미 public allowlist). 요청 하나당 정확히 하나 발생하며, `settleOnce()`가 멱등이라 중복이 구조적으로 불가능하다. `outcome`은 `completed｜steered｜merged｜failed｜cancelled｜dropped｜skipped`. `orchestrate_done`을 대체하지 않고 추가된다 — steer 성공처럼 완료 이벤트 자체가 없는 경로를 커버하기 위한 것이다 (#276) |

### Direct topic `publish()` events

이 이벤트들은 `broadcast()`를 거치지 않고 `src/core/event-bus.ts`의 `publish(topic, event, data)`로 직접 SSE bus에 들어간다. Public allowlist는 topic 단위이며 `code`는 native Code 세션의 public topic이며 `trace`는 internal-only다.

| Topic | Event | 대표 payload | 발행 위치 / 용도 |
| --- | --- | --- | --- |
| `code` | `code_item` / `code_item_update` / `code_session` | `{ sessionId, sequence, ... }` | `src/code-mode/host.ts`; persisted native session events; compact updates apply once in contiguous sequence |
| `worker` | `instance-status-changed` / `worker_settings_change` | worker diff/settings metadata | manager-side worker cache invalidation and settings change bridge |

Worker run events, delayed replay notices, and batch dispatch summaries are safe metadata surfaces. They may carry bounded previews and recovery commands, but they do not embed raw employee stdout; raw worker output remains an explicit `/api/orchestrate/worker-runs/:runId/output` / `cli-jaw worker read <runId>` read path.

`bgtask_update` frames stay on topic `bgtask` and expose `running[]` plus `changed`; both entries keep native bgtask `status` and add shared `statusCategory`. Worker runs and bgtasks do not share storage, but Manager can compare their status buckets without reimplementing per-surface mappings.

### Web client handling

현재 Web UI는 `public/js/event-channel.ts`를 통해 SSE payload를 받고, topic/event subscription을 `public/js/ws.ts`의 기존 handler path로 연결한다. legacy WebSocket fallback도 같은 handler set을 사용하므로 UI event 처리 코드는 transport와 분리되어 있다.

An opened channel's disconnect clears the current tool presentation synchronously
inside `handleChannelDown`, using the existing UI import. It must not schedule an
unowned import callback that can later clear a restored/new turn. Initial
never-open failure still takes the separate unavailable/fallback path; reconnect
hydration remains owned by `snapshotReady`, and the disconnect-toast grace is unchanged.

### 백엔드 emit은 있으나 Web UI 직접 분기는 없는 이벤트

| Type | 현재 처리 경로 |
| --- | --- |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | `public/js/ws.ts`에서 disconnected/timeout/stalled handler로 처리하고, manager server는 worker-SSE bridge/cache로 별도 추적한다. 현재/이전 worker progress API는 UI hydration용 safe `attention` metadata도 제공한다 |
| `worker_run_*` | safe SSE/replay와 `/api/orchestrate/worker-runs*` read API용 backend contract다. Manager Worker Runs 패널은 기존 frontend worker progress EventSource bridge로 이 이벤트를 refresh invalidation으로 소비하고, raw output은 명시 클릭 시 `/output` route로만 읽는다 |
| `system_notice` | SSE public emit은 되지만 `public/js/ws.ts` 직접 분기는 없다 |
| `goal_pause_detected` / `goal_pause_gate_pending` | lifecycle/goal heartbeat가 pause 2-tap gate 상태를 broadcast. `goal_pause_gate_pending`은 armed gate가 남은 채 goal-continuation audit turn이 끝났고 **추가 automatic continuation이 스케줄되지 않음**을 뜻함(P0 2026-06-27). Main Web UI `ws.ts`에는 전용 handler 없음 — Manager / `GET /api/goal` / CLI 관측 |

### Web UI에 legacy 분기만 남은 타입

`worklog_created`, `round_start`, `round_done`은 `public/js/ws.ts` 분기가 남아 있지만 현재 `server.ts`/`src/**/*.ts`의 실제 `broadcast(...)` emit surface에는 없다.

---

## 3. Claude Code CLI

### Internal native SDK projection

Native SDK objects are normalized once by `runtime/claude-sdk-events.ts`; they do not pass through the print parser. Text deltas and completed block snapshots replace the same canonical message item. A successful result alone supplies final text; missing/null stays absent and explicit empty remains empty. Parent partial text is retained independently for error/Stop, never inferred from tool output, reasoning or child narration. Provider plaintext reasoning has separate items; signatures and encrypted payloads are not decoded or published. Tool-input JSON is parsed only after bounded completion and sanitized before preview clipping. Existing RuntimeProjection owns item IDs, committed trace sequence and one terminal; incomplete previews do not authorize another inference or successful final. Native Claude main/workers defer final publication until shared-host claim and lifecycle completion. Foreground children retain parentItemId without becoming parent finals; completed child ID history survives until retirement while permission eligibility ends. Full visual Activity remains a separate rollout. External messaging retains its existing final/ACK/queue owners.

`agent_runtime_requests_changed` is a transient SSE-only hint, not a canonical runtime event or journal row. Its payload is `{version:1,sessionId,scope}` where scope is server-resolved presentation delivery scope. Live GET entries and POST replies retain their original execution scope and other captured IDs. The request panel accepts same-chat live entries, distinguishes stream health from manual REST freshness and never replays a POST. Initial SSE-unavailable invalidates native form freshness even if legacy WebSocket fallback never opens; only SSE-open restores native stream health. Neither the hint nor a historical request display authorizes an operation.

호출 플래그:

```text
--print/-p --output-format stream-json --verbose --include-partial-messages
```

Plaintext `thinking_delta`는 headless `--print`/`-p` stream에서 partial message streaming이 켜져야 온다.

### top-level 타입

| type | 설명 | jaw 처리 |
| --- | --- | --- |
| `system` | init/status/subtype metadata | model/tools/version 저장, compacting 상태 감지 |
| `stream_event` | Anthropic streaming wrapper | 아래 세부 규칙 적용 |
| `assistant` | 완성된 assistant message | stream_event가 없을 때 text/tool fallback |
| `user` | tool_result 포함 user message | tool_use 완료 상태(done/error) 반영 |
| `result` | 최종 결과 | cost/turns/duration/session/usage 저장 |
| `rate_limit_event` | quota/retry 신호 | warning tool label broadcast |

### `stream_event` 내부 처리

| inner type | 세부 | 처리 |
| --- | --- | --- |
| `content_block_start` | `tool_use` | 일반 tool은 `🔧 {name}`, `Agent` tool은 `🤖 subagent`; 둘 다 `stepRef=claude:tooluse:{id}` |
| `content_block_start` | `thinking` | placeholder는 내보내지 않고 버퍼 시작 |
| `content_block_delta` | `thinking_delta` | `claudeThinkingBuf`에 축적 |
| `content_block_delta` | `text_delta` | plain `claude` runtime: `appendAssistantRawText()` → live `agent_output` (`claudeStreamedText` guard on complete `assistant` prevents doubling) |
| `content_block_delta` | `input_json_delta` | `claudeInputJsonBuf`에 축적 |
| `content_block_delta` | `signature_delta` | 의도적으로 무시 |
| `message_delta` | `usage.output_tokens` | output token 갱신 |
| `content_block_stop` | — | thinking/input_json flush |

### Claude buffer flush

```text
thinking_delta → claudeThinkingBuf 축적
input_json_delta → claudeInputJsonBuf 축적
content_block_stop →
  1. thinking을 💭 step으로 broadcast
  2. input_json을 JSON.parse
  3. summarizeToolInput()로 마지막 tool label detail 보강
stream close →
  flushClaudeBuffers()로 잔여 버퍼 정리
```

### 추가 상태

- `system.status === 'compacting'` 또는 subtype compacting:
  `🗜️ compacting...`
- compact boundary:
  `✅ conversation compacted`
- `user.message.content[].tool_result`:
  동일 `stepRef`의 tool을 `done` 또는 `error`로 갱신
- `system.subtype === 'task_started'`:
  `🤖 subagent: {description}` + `toolType=subagent` + `status=running` + `stepRef=claude:task:{task_id}`.
- `system.subtype === 'task_notification'`:
  같은 `claude:task:{task_id}` step을 `✅ done` 또는 `❌ error`로 갱신하고 summary/output_file/usage detail을 붙인다.

---

## 4. Codex CLI (`--json`)

| event.type | 조건 | jaw 처리 |
| --- | --- | --- |
| `thread.started` | — | session/thread id 추출 |
| `turn.started` | — | trace에 turn boundary 기록 |
| `item.started` | `command_execution` | `🔧 {command}` + `status=running`, `stepRef=codex:item:{id}` |
| `item.completed` | `command_execution` | `⚡` 또는 `❌` + detail + exit code |
| `item.completed` | `reasoning` | `💭` thinking |
| `item.completed` | `web_search` + `search` | `🔍 {query}` |
| `item.completed` | `web_search` + `open_page` | `🌐 {hostname}` |
| `item.started` | `collab_tool_call` + `spawn_agent`/`wait` | `🤖 {tool}...`, `toolType=subagent`, `status=running`, `stepRef=codex:collab:{id}`, `ctx.hasActiveSubAgent=true` |
| `item.completed` | `collab_tool_call` + `spawn_agent`/`wait` | `✅ {tool} done`, same `stepRef`, receiver/agent state detail, `ctx.hasActiveSubAgent=false` |
| `item.completed` | `agent_message` | final text 누적 |
| `turn.completed` | `usage` | input/output/cached_input token 저장 |

### 참고

- command 실행 step은 running과 done/error를 같은 `stepRef`로 연결한다.
- `ctx.hasActiveSubAgent`가 true이면 `spawn.ts`가 lifecycle activity를 `heartbeat`로 터치해 subagent wait 동안 stall 판정을 피한다.
- `agent_output` 라이브 chunk는 `extractOutputChunk()`가 `agent_message`에서 뽑는다.

---

## 3z. 어댑터 공통 계약 — narration 경계 (NARRATION-BOUNDARY-01)

외부 채널(Slack/Telegram/Discord)이 받는 최종 텍스트는 `ctx.fullText` 에서 나온다
(`src/agent/lifecycle-handler.ts` 가 `resolve({ text: ctx.fullText })` 로 돌려주고
`src/orchestrator/pipeline.ts` 가 `orchestrate_done.text` 로 만든다). 라이브 UI 는
`pendingOutputChunk`/`agent_output` 으로 따로 받는다. 그래서 진행 서술을 `fullText`
에서 막지 못하면 하류에 걸러줄 층이 없다. 아래 규칙은 전부 durable 텍스트에 대한 것이고
라이브에는 항상 전부 보인다.

1. **경계는 구조적 신호여야 한다.** 프로토콜이 주는 메시지 정체성(아이템/메시지 id,
   메시지 시작 이벤트, phase 태그, step 경계)만 쓴다. 문장 패턴으로 서술을 추측하지
   않는다 — 같은 문장이 진짜 답변의 일부일 수 있다.
2. **경계에서 보호되지 않은 durable 누적을 버린다 (LAST-WINS).**
3. **연속 신호는 경계가 아니다.** 델타, 접두사가 일치하는 누적 스냅샷, 같은 메시지 id
   의 성장은 모두 같은 메시지의 계속이다.
4. **명시적 final 출처는 보호된다.** 프로토콜이 "최종 답변"이라고 말해준 텍스트는 이후
   아이템이 지울 수 없다.
5. **dedupe 기준선의 운명은 리셋 이유에 달렸다.** 교체된 메시지 기준으로 남기면 새
   메시지의 접두사가 잘리므로 버린다. 뒤따르는 텍스트가 같은 메시지의 누적 스냅샷일 수
   있으면 유지한다(cursor 툴 경계).
6. **경계 신호가 없으면 고치지 않는다.** 억지 경계는 정상 답변을 자른다. 결함과 한계를
   문서와 테스트로 남기고 코드는 그대로 둔다.

"서술 → 답변"과 "답변 조각 2개"가 구별 불가능한 경계에서는 **마지막만 남긴다.**
어댑터마다 다른 답을 주면 사용자가 CLI 를 바꿀 때마다 동작이 달라진다.

| 어댑터 | 경계 신호 | final 보호 | 상태 |
|--------|-----------|-----------|------|
| codex (NDJSON) | 태그 없는 `agent_message` 아이템 | `channel` 태그 | 적용 |
| codex-app | `item/started`(agentMessage) 또는 델타 `itemId` 변화 | `phase: final_answer` | 적용 |
| cursor | 툴 시작 + 비-델타 메시지 경계 | 없음 | 적용 |
| claude | `message_start`(스트리밍), 이어지지 않는 스냅샷(스냅샷/fallback) | 없음 | 적용 |
| opencode | `step_start` (last-step-wins) | 없음 | 적용 |
| acp | `agent_message_chunk.messageId` 변화 | 없음 | 적용(id 있을 때) |
| grok | **없음** — 프로토콜에 메시지 정체성 부재 | — | 미적용(한계) |
| agy (transcript) | final planner row 로 **교체** | `agyFinalPlannerSeen` | 이미 안전 |
| agy (stdout fallback) | **없음** — 전송 청크는 메시지가 아님 | — | 미적용(한계) |

공유 헬퍼는 만들지 않았다. 어댑터마다 리셋해야 하는 상태 집합이 다르고(claude 는 앵커와
스냅샷 기준선까지 8개), 공통분모는 `fullText`/`outputTextStarted` 두 개뿐이라 헬퍼가
"이것만 부르면 된다"는 착시를 만든다. 일관성은 이 표와 각 어댑터의 주석 어휘로 유지한다.

## 4b. Codex AppServer (`codex-app`)

`codex-app` 경로는 `codex app-server --listen stdio://`의 JSON-RPC notification을 `agent_tool`/`agent_output` 경로로 맞춘다.

Reasoning config:

| 위치 | 값 |
| --- | --- |
| `thread/start.config.model_reasoning_summary` | `detailed` |
| `thread/start.config.hide_agent_reasoning` | `false` |
| `thread/start.config.show_raw_agent_reasoning` | `true` |
| `turn/start.summary` | `detailed` |
| `turn/start.effort` | 현재 UI/설정 effort |

| method | 조건 | jaw 처리 |
| --- | --- | --- |
| `item/started` | `reasoning` + 빈 `summary/content` | placeholder 없이 무시 |
| `item/started` | `reasoning` + 기존 `summary/content` 있음 | 초기 reasoning을 `💭` thinking buffer에 축적 |
| `item/reasoning/textDelta` | raw reasoning delta | `💭` thinking buffer에 축적 |
| `item/reasoning/summaryTextDelta` | summary delta | `💭` thinking buffer에 축적 |
| `item/reasoning/summaryPartAdded` | summary index 증가 | thinking buffer에 줄바꿈 삽입 |
| `item/completed` | `reasoning` + 기존 buffer 있음 | thinking buffer flush |
| `item/completed` | `reasoning` + buffer 없음 | completed item의 string/object-shaped `content[]` 우선, 없으면 `summary[]` fallback 표시 |
| `item/started` | `agentMessage` | `phase`(→ sticky channel) + `itemId` 기록, 메시지 경계 표시 |
| `item/agentMessage/delta` | `commentary` | live `agent_output` 으로만 브로드캐스트, `fullText` 제외 |
| `item/agentMessage/delta` | 그 외 | `fullText` 에 raw 축적 (토큰 단위라 세그먼트 포매터 우회) |
| `thread/tokenUsage/updated` | token usage | input/output/cached token 저장 |

raw `textDelta`는 app-server/모델 조합이 제공할 때만 온다. 확인된 `gpt-5.4-mini` app-server smoke에서는 raw `textDelta` 대신 `summaryTextDelta` detailed stream이 왔다.

### agentMessage 채널 판정과 LAST-WINS

외부 채널(Slack/Telegram/Discord)이 받는 최종 텍스트는 `ctx.fullText` 에서 나온다
(`src/agent/lifecycle-handler.ts` 가 `resolve({ text: ctx.fullText })` 로 돌려주고
`orchestrate_done.text` 가 된다). 그래서 진행 서술을 `fullText` 에서 막지 못하면
하류에 걸러줄 층이 없다.

판정은 `src/agent/codex-app-events.ts` 의 `applyCodexAppTextEvent` 가 소유한다
(`spawn.ts` 인라인이 아니라 순수 함수라 테스트 가능):

1. **프로토콜 `phase` 우선.** app-server v2 스키마의 `AgentMessageThreadItem` 은
   `channel` 이 아니라 `phase`(`commentary | final_answer`)를 싣는다. `commentary` 는
   live 전용, `final_answer` 는 sticky `final` 로 정규화한다. 레거시 `channel` 과
   `annotations.channel` 은 비표준 빌드 fallback 으로 남는다.
2. **아이템 경계 LAST-WINS.** 스키마가 `phase` 를 nullable 로 두고 "providers do not
   emit this consistently" 라고 명시하므로, 태그 없는 `agentMessage` 아이템이 새로
   시작되면 직전 누적을 버린다. 태그 없는 서술 여러 개가 최종 답변에 이어붙던 것이
   이 규칙으로 끊긴다.
3. **`final` 출처는 보호된다.** `codexAppDurableIsFinal` 이 서면 이후 아이템은
   누적만 하고 리셋하지 않는다 — 답변 뒤에 붙는 commentary 가 답변을 지우지 못한다.
4. **`item/started` 유실 대비.** 델타의 `itemId` 가 바뀌면 그것만으로 경계를 잡고,
   그 아이템의 phase 는 unknown 이므로 sticky 를 비운다(직전 `commentary` 가 답변을
   삼키는 것 방지). `item/completed` 는 `agentMessage` 에 대해 null 을 반환하므로
   경계 신호로 쓸 수 없다.

---

## 5. Antigravity / AGY CLI (`-p`)

**경계(NARRATION-BOUNDARY-01):** transcript 앵커 경로는 이미 안전하다 — close 시
`ctx.fullText` 를 final planner row 텍스트로 **교체** 한다(이어붙이지 않는다). 반면
stdout fallback 은 전송 청크를 이어붙이므로 메시지 경계가 없고, 청크를 경계로 쓰면 한
답변이 두 번에 나뉘어 읽혔을 때 뒤쪽만 남는다. 규칙 6 에 따라 고치지 않는다. 현재 방어인
`isAgyIntermediatePlannerText` 는 인식된 planner 접두사로 **시작하는 전체 본문** 만
덮고, 일반 서술이나 앞에 다른 출력이 붙은 경우는 못 덮는다. fallback 이 쓰이는 조건은
timeout 도 provider 에러도 아닌 close 인데 final planner row 를 못 본 경우다.

AGY is not an NDJSON runtime in cli-jaw. It uses direct print mode; optional flags are capability-probed before emission (`--model` is observed in AGY 1.0.12):

```text
agy -p <prompt> [--model <id>] --print-timeout 10m --log-file <tmp> [--dangerously-skip-permissions] [--add-dir <dir>...]
agy --conversation <sessionId> -p <prompt> [--model <id>] --print-timeout 10m --log-file <tmp> [...]
```

`spawn.ts` routes AGY stdout as plain text: each chunk is appended to `ctx.fullText`, scanned for `--conversation=<id>` resume hints, recorded as a trace `plain_text` event, emitted through `agent_output`, and skipped from `events.ts` JSON parsing. Because `agy -p` normally prints only the answer, close handling also scans the per-run log for `Created conversation <id>` / `conversation=<id>` before removing that log. `spawn-env.ts` sets `NO_COLOR=1` by default so chunks remain preview-safe. Decoded AGY stdout and non-empty AGY stderr refresh the stall watchdog at the spawn integration layer; transcript watcher activity also refreshes it when native transcript rows arrive. AGY can ingest native active-directory `AGENTS.md`/`GEMINI.md`, but cli-jaw still supervises wrapper-injected operational context, exact resume, transcript anchoring, quota UI, and post-compaction retention as separate runtime contracts.

Timeout handling is stdout-based and anchored to the transcript final-planner signal. If AGY prints only `Error: timed out waiting for response`, or prints progress text followed by that timeout before a fresh final `PLANNER_RESPONSE` row is observed, `agy-runtime.ts` classifies the run as effective exit code `124`, records a trace `runtime_error`, clears final text, and lets lifecycle/fallback/smoke handling see the timeout as a runtime failure. Once a fresh final planner row is seen, its `content` is the authoritative final text; this strips native resume replay such as previous-turn answers before persistence. A trailing timeout can be stripped only after that final-planner anchor has been seen, preserving completed answers without saving progress-only resume turns as completion.

## 6. Cursor CLI (`--output-format stream-json`)

호출 플래그:

```text
cursor-agent -p --trust --output-format stream-json --model <resolvedModelId> [--force]
cursor-agent --resume <chatId> -p --trust --output-format stream-json --model <resolvedModelId> [...]
```

Cursor CLI는 separate effort flag가 없으므로 `src/agent/cursor-runtime.ts`가 model+effort를 full model id로 먼저 해석한다. `system` 이벤트에서 `session_id`와 model metadata를 저장하고, `assistant` message/content text는 snapshot/delta 중복을 줄여 `pendingOutputChunk`로 flush한다.

| event.type | jaw 처리 |
| --- | --- |
| `system` | session id, model, raw cursor metadata 저장 |
| `assistant` | text delta/snapshot을 `fullText`와 `agent_output` chunk로 누적. 단 **새 메시지 경계**에서는 `fullText` 를 버린다 (아래) |
| `tool_call` | `🔧 {name}` running/done/error step, `stepRef=cursor:tool:{call_id}` |
| `result` | session id, token usage, duration, cost, finish reason 저장; rejected/error result는 tool error로 기록 |

### cursor LAST-WINS: 툴 경계 + 메시지 경계

cursor stream-json 에는 채널 태그가 없어서 구조적 경계 두 개를 쓴다.

- **툴 경계**: 새 `tool_call`(running) 앞의 텍스트는 계획 서술로 보고 `fullText` 를
  비운다. 완료 업데이트(`done`/`success`)는 비우지 않는다 — 이미 시작된 답변을
  지우면 안 되기 때문. dedupe 기준선(`cursorAssistantText`)은 유지한다: 뒤따르는
  누적 스냅샷이 같은 메시지일 수 있어서다.
- **메시지 경계**: 툴이 하나도 없는 턴, 또는 마지막 툴 이후의 서술을 잡는다. 델타는
  정의상 연속이므로 **절대** 경계가 되지 않는다(cursor 의 message id granularity 가
  미확인이라 id 우선 규칙은 답변을 마지막 청크로 잘라낼 위험이 있다). 비-델타
  이벤트에서 `message.id` 가 바뀌거나, 스냅샷이 직전 텍스트를 이어받지 않으면
  새 메시지로 본다. 이때는 dedupe 기준선도 함께 버린다 — 교체된 메시지를 기준으로
  접두사를 자르면 새 메시지의 앞부분이 날아간다.

이어지지 않는 스냅샷 두 개는 "서술→답변"과 "답변 조각 2개"를 구별할 수 없다.
마지막만 남기는 쪽을 택했고(codex NDJSON 어댑터와 동일한 트레이드오프), 관측된
실패는 전부 앞쪽 모양이다. 델타로만 흐르고 id 가 없는 턴은 이 규칙으로 고쳐지지
않는다 — 알려진 한계다.

---

## 7. Gemini CLI (`-o stream-json`)

| event.type | jaw 처리 |
| --- | --- |
| `init` | model/session id 저장 |
| `tool_result` | `✅` 또는 `❌` + same `stepRef` |
| `message` (assistant) | fullText 누적 |
| `result` | duration/tool_calls/token stats 저장 |


---

## 8. Grok CLI (`--output-format streaming-json`)

호출 플래그:

```text
-p <prompt> --output-format streaming-json --no-alt-screen
```

`grok-build`는 현재 `--effort` / `--reasoning-effort`를 서버가 거부하므로 cli-jaw는 Grok 경로에 effort 또는 system-prompt override 플래그를 넘기지 않는다. 프로젝트 지침은 Grok CLI가 cwd의 instruction files를 읽는 쪽에 맡기고, 대화 히스토리는 `-p` prompt 문자열에 합쳐 넣는다.

| event.type | jaw 처리 |
| --- | --- |
| `thought` | 기본적으로 final text에 넣지 않는다. `showReasoning`이 켜진 경우에만 buffer 후 `end`에서 💭 thinking step으로 flush |
| `text` | `data`/`text` delta를 `fullText`와 `agent_output` live chunk에 그대로 누적 |
| `end` | `sessionId`, `stopReason`, `requestId`를 세션/metadata에 저장 |
| `error` | final text에 섞지 않고 `❌` tool step으로 기록, `stepRef=grok:error:{requestId or run}` |

Grok `streaming-json`은 실제 tool을 실행해도 일부 버전에서 live stdout에 `tool_use`/`tool_result`를 내보내지 않는다. cli-jaw는 `end.sessionId`가 있는 정상 종료 후 `grok trace --local --json <sessionId>`를 실행하고 trace archive의 `chat_history.jsonl`에서 `tool_calls`/`tool_result`를 backfill해 최종 `agent_done.toolLog`에 반영한다. 이 보강은 direct `grok`에 적용된다. Valid Grok NDJSON activity refreshes the stall watchdog before event discriminator filtering on the direct `grok` path, so schema-unknown but active Grok output does not trip an absolute timeout.

Grok CLI 런타임과 `browser web-ai --vendor grok`는 별도 표면이다. 전자는 local CLI process/streaming-json, 후자는 `grok.com` 브라우저 자동화다.

**경계 없음 (NARRATION-BOUNDARY-01 규칙 6):** grok 스트림에는 메시지 정체성이 없다.
`text` 이벤트에 id 가 없고, `thought` 는 가시 텍스트 뒤에도 올 수 있으며, 일부 버전은
tool 이벤트를 아예 내보내지 않고, `end` 는 모든 텍스트가 이어붙은 뒤에 도착한다.
따라서 서술과 최종 답변이 한 턴에 오면 **현재는 이어붙는다.** 억지 경계는 정상 답변을
자르므로 고치지 않고 한계로 기록한다 (`tests/events.test.ts` 의
"grok has no message boundary" 테스트가 이 계약을 고정한다). 상류가 메시지 id 나 별도
final 이벤트를 주기 시작하면 그때 적용한다.

## 9. Copilot ACP

ACP 자체는 NDJSON이 아니라 `session/update` 이벤트를 사용한다. 현재 Copilot ACP task/subagent 관측 wire shape은 `tool_call`의 `rawInput.agent_type === 'task'`이며, 완료는 같은 `toolCallId`의 `tool_call_update`로 온다.

| update type | jaw 처리 |
| --- | --- |
| `agent_thought_chunk` | `💭` thinking |
| `tool_call` | 일반 tool은 kind 기반 `📖/✏️/⚡/🔍/🌐` 또는 `🔧`, `stepRef=acp:callid:{toolCallId}` |
| `tool_call` + `rawInput.agent_type='task'` | `🤖 subagent: {title/description/name}`, `toolType=subagent`, `status=running`, same `stepRef` |
| `tool_call_update` | status map: `pending→⏳/pending`, `running|in_progress→🔧/running`, `completed→✅/done`, `failed→❌/error`, unknown→`❔/{raw status}` |
| `agent_message_chunk` | fullText 누적. `messageId` 가 바뀌면 **새 메시지** 로 보고 직전 누적을 버린다 (NARRATION-BOUNDARY-01). id 없는 청크는 신호가 없으므로 그대로 누적 |
| `plan` | `📝 planning...` |
| `session_cancelled` / `cancelled` | `⏹️` cancellation tool entry |
| `request_permission` | `🔐 permission: ...`, `status=pending` audit entry |

권한 요청은 parser가 아니라 `src/cli/acp-client.ts`에서 자동 승인한다.

`extractFromAcpSubagent()`는 `subagent.started/completed/failed/selected/deselected` 보조 매핑을 유지하지만, 21.x Copilot task 표시의 주요 경로는 `tool_call(rawInput.agent_type='task')` + `tool_call_update`다.

---

## 10. OpenCode CLI (`--format json`)

| event.type | jaw 처리 |
| --- | --- |
| `tool_use` + `part.tool === 'task'` | `🤖/✅/❌ subagent[{subagent_type}]: {description}`, `toolType=subagent`, `stepRef=opencode:call:{callID}` |
| `tool_use` | 일반 tool은 `🔧/✅/❌ {tool}` |
| `tool_result` | 일반 tool은 `✅ {tool}`; task `callID`가 ctx에 등록된 경우 기존 subagent step을 갱신 |
| `text` | fullText 누적 |
| `step_start` | trace/model metadata 기록 |
| `step_finish` | sessionId/tokens/cost/time 누적 + step 텍스트 커밋 |

**경계(NARRATION-BOUNDARY-01):** `step_start` 는 직전 step 이 커밋한 durable 텍스트를
무조건 버린다(last-step-wins). `reason: 'stop'` 은 step 루프를 끝내므로 그 뒤에
`step_start` 가 오지 않고, 만약 온다면 그 존재 자체가 직전 텍스트가 최종이 아니었음을
증명한다. 툴 실패 설명처럼 뒤에 step 이 없는 텍스트는 그대로 남는다.

OpenCode는 여러 step에 걸친 token/cost를 누적합으로 저장한다. `step_finish` 시 pending running tools를 done/error로 finalize하고, task tool output은 `<task_result>...</task_result>`를 정리해 detail에 넣는다.

---

## 11. `agent_output`와 최종 응답

### 라이브 출력 bullet 정렬 (`appendAssistantTextSegment`)

Codex/Claude/Gemini/Cursor/OpenCode는 `src/agent/events/helpers.ts`의 `appendAssistantTextSegment()`로 live chunk를 누적한다.

| 규칙 | 결과 |
| --- | --- |
| 첫 assistant segment (tool 없음) | raw text |
| 첫 assistant segment (tool 이미 있음) | `- {text}` |
| 이후 segment | `\n- {text}` (공백/구두점 경계 예외는 helpers 참고) |

Plain-text runtime은 raw stdout(`fullText`)과 display-normalized preview(`liveOutputText`)를 분리한다. 표시용 preview는 `normalizeAssistantDisplayText()`를 거쳐 JSON-style escaped newline (`\n`, `\r\n`, `\r`)이 UI에 literal text로 새지 않게 한다.

| CLI | raw capture | formatted `agent_output` |
| --- | --- | --- |
| `agy` | stdout → `fullText` | normalized stdout delta → `liveOutputText` + `agent_output` |
| `pi` | RPC text delta → `fullText` | normalized RPC text delta → `liveOutputText` + `agent_output` |
| `kiro-code` | stdout → `fullText` (kiro-runtime) | normalized `assistant_delta` → `liveOutputText` (no `-` inject; Kiro has native `- Completed` / numbered lines) |
| `grok` | NDJSON handler → `fullText` | raw delta concat → `pendingOutputChunk` (paragraph bullets deferred) |
| `copilot` (ACP) | ACP chunks → `fullText` | `appendAssistantTextSegment` + `agent_output` broadcast |

Web UI는 ProcessBlock(아이콘 - 라벨) 아래 markdown list bullet(`- ...`)로 흘러나오는 assistant preview를 기대한다.
Final `agent_done` body도 `resolveSpawnOutputText()`에서 normalized display candidates를 raw escaped candidates보다 우선해 streaming 중 고친 줄바꿈이 완료 시점에 되돌아가지 않게 한다.

### 라이브 출력

- `src/agent/spawn.ts`는 일부 CLI 경로에서 `broadcast('agent_output', { text })`를 실제로 보낸다.
- `public/js/ws.ts`는 이를 받아 `appendAgentText()`로 preview를 갱신한다.

### authoritative final

- 최종 텍스트는 `src/agent/lifecycle-handler.ts`의 `broadcast('agent_done', { text, toolLog, origin })`가 기준이다.
- Web UI도 주석대로 live stream은 preview-only이고, `agent_done`을 authoritative 결과로 취급한다.

### collect.ts와의 drift

`src/orchestrator/collect.ts`에는 아직 "no broadcast emits agent_output" 주석이 남아 있지만, 현재 `spawn.ts`는 실제로 `agent_output`을 emit 한다. 즉 이 부분은 코드 주석이 stale이고, 동작 기준은 `spawn.ts` + `ws.ts`다.

---

## 12. ProcessBlock 연동

`public/js/ws.ts`가 `agent_tool`을 받으면 `showProcessStep()`을 호출한다.

### step type 매핑

| `agent_tool.toolType` | UI step type |
| --- | --- |
| `thinking` | `thinking` |
| `search` | `search` |
| `subagent` | `subagent` |
| 그 외 | `tool` |

### ProcessStep 주요 필드

| Field | 용도 |
| --- | --- |
| `icon` | `💭`, `🔧`, `✅`, `❌`, `🔍`, `🌐` 등 |
| `rawIcon` | 원본 emoji 보존용. 없으면 frontend가 `icon`을 rawIcon으로 저장 |
| `label` | 짧은 요약 라벨 |
| `detail` | 자세한 입력/출력 preview |
| `toolType` | `thinking`, `search`, `subagent`, `tool` semantic 분류 |
| `stepRef` | running ↔ done/error 매칭 키 |
| `status` | `running`, `done`, `error`, 그리고 ACP에서 온 `pending`, `cancelled`, `unknown` 같은 raw 상태도 통과 가능 |
| `detailPreview` / `detailLength` / `detailTruncated` | compact storage + lazy `<pre>`; `detailLength>0` → `data-had-detail` |
| `traceRunId` / `traceSeq` / `detailAvailable` | Trace drawer 버튼; server-side raw retention metadata |

### Hydrated ProcessBlock + `agent_done.toolLog`

Live path: `agent_tool` → `ws.ts` `showProcessStep()` → live `ProcessBlockState`.

History path: persisted/`agent_done.toolLog` → `buildProcessBlockHtml()` → virtual-scroll lazy mount.

Long blocks(>80 steps)는 DOM에 head/tail만 있고 middle은 elided. Hydrated/recycled block에서 `[data-expand-steps]`는 `reconstructStepsFromBlock()`이 `dataset.processStepIds` + in-memory meta store로 middle 복원(WeakMap miss fallback). Virtual-scroll unmount는 `releaseProcessBlockDetails()`로 detail store 해제; `detailLength>0` step은 `data-had-detail` placeholder로 blank expand 방지.

Grok CLI는 live stdout에 tool event가 없을 수 있어 §8 trace backfill 후 `agent_done.toolLog`에 step이 들어온다. ProcessBlock history hydrate는 이 backfill된 log를 다른 CLI와 동일하게 렌더한다.

### Goal pause gate ↔ continuation (P0 2026-06-27)

Agent pause는 2-tap gate: 첫 `cli-jaw goal pause --agent --audit` → `agentPauseCount = 1`; 둘째 → `pauseGoal()`.

| Surface | Behavior |
| --- | --- |
| `buildGoalContinuation()` | armed gate면 audit/finalizer prompt를 위해 `shouldContinue: true`, `reason: "pause_gate_pending"` |
| `lifecycle-handler.ts` | `_isGoalContinuation` turn 종료 시 gate still armed면 `goal_pause_gate_pending` broadcast, 다음 automatic continuation 미스케줄 |

---

## 13. `stepRef`

동일 tool step의 상태 전이를 안정적으로 연결하는 키.

| CLI | 형식 | 예시 |
| --- | --- | --- |
| Claude | `claude:tooluse:{id}` | `claude:tooluse:toolu_...` |
| Claude task lifecycle | `claude:task:{task_id}` | `claude:task:task-1` |
| Codex | `codex:item:{item.id}` | `codex:item:abc123` |
| Codex collab subagent | `codex:collab:{item.id}` | `codex:collab:collab-1` |
| Cursor | `cursor:tool:{call_id}` | `cursor:tool:call-1` |
| OpenCode | `opencode:tool:{tool}` / `opencode:call:{callID}` | `opencode:call:task:0` |
| ACP tool/task | `acp:callid:{toolCallId}` | `acp:callid:toolu_1` |
| ACP subagent helper | `acp:subagent:{toolCallId}` / `acp:subagent:selection:{agentName}` | `acp:subagent:tool-1` |

running step과 done/error step이 같은 `stepRef`를 쓰면, parser/runtime이 기존 running 항목을 찾아 교체한다. ACP branch dedupe도 `icon:label:stepRef:status`를 쓰므로 같은 이름의 반복 tool/subagent 호출을 보존한다.

---

## 14. `summarizeToolInput()`

도구 입력을 한 줄 detail로 축약하는 함수.

| Tool | 요약 방식 |
| --- | --- |
| `bash`, `Bash` | `input.command` |
| `read`, `Read` | `input.file_path` |
| `edit`, `Edit` | `{file_path}:{old_str}->{new_str}` preview |
| `write`, `Write` | `input.file_path` |
| `grep`, `Grep` | `{pattern} in {path}` |
| `glob`, `Glob` | `input.pattern` |
| `WebSearch` | `input.query` |
| `WebFetch` | `input.url` |
| 기타 | JSON stringify preview |

Claude의 `input_json_delta` flush, Gemini tool detail, ACP tool detail 생성이 이 함수를 공유한다.

### Cursor tool-call purpose metadata

Accepted Cursor shell `agent_tool` entries may include `description`, copied from the actual
tool-call args/event, bounded and redacted before trace/bus publication. This is tool
purpose metadata, not reasoning or final output. Same-ID description-only running
updates may refresh trace/UI metadata without clearing accepted assistant text. An
owned trace pointer can recover a description omitted by the live tool-log sanitizer;
missing evidence is not synthesized. Slack applies its own stricter projection before
rendering. Existing trace hydration remains additive, while durable tool-log sanitization
and canonical print Activity keep their existing field selection.
