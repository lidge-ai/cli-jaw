---
created: 2026-03-28
tags: [cli-jaw, telegram, messaging, heartbeat]
aliases: [Telegram and Heartbeat, CLI-JAW Telegram, messaging runtime]
---

> 📚 [INDEX](INDEX.md) · [에이전트 실행 ↗](agent_spawn.md) · [인프라 ↗](infra.md) · **텔레그램 & 하트비트**

# Telegram & Heartbeat — telegram/bot.ts · telegram/forwarder.ts · telegram/telegram-file.ts · discord/forwarder.ts · messaging/runtime.ts · messaging/send.ts · messaging/thread-target.ts · messaging/extract-images.ts · manager/telegram-hub/* · memory/heartbeat.ts · memory/heartbeat-schedule.ts

> Telegram transport (standalone + hub-member) + Dashboard forum-topic hub + shared messaging runtime + text/image forwarder lifecycle + origin filtering + voice STT
> 현재 Telegram/Discord/Slack은 `src/messaging/`을 공유하며, settings restart는 `core/runtime-settings.ts`에서 한 번에 처리된다
> Slack 설정 명령과 API는 [Commands](commands.md)와 [Server API](server_api.md)를 참조

Slack Socket Mode의 app-level token은 사용자 공용 `~/.cli-jaw-shared/slack-claims` lease로 home 간 단일 connected consumer를 선출한다. 다른 canonical home의 `connected:true` claim이 90초 이내이고 PID가 살아 있다는 positive evidence가 모두 있을 때만 inbound를 거절하며, realpath·파일 IO·PID probe가 불확실하면 fail-open한다. 연결 전/재연결 중 `connected:false` presence는 다른 home을 막지 않고, lease는 exact `claimId` generation만 해제한다. 충돌한 home은 inbound만 끄고 Slack Web API outbound는 유지하며 `CLI_JAW_SLACK_ALLOW_SHARED_TOKEN=1`이 명시적 process-level opt-out이다. 장기 서버의 Socket 재접속 한도는 기본 unlimited다 — 유한 `maxReconnectAttempts`는 테스트/원샷 호출자 opt-in이고, `link_disabled`는 여전히 terminal이다.
> v5 Update: `forwardAll` 토글은 Telegram/Discord 각각의 channel setting으로 분리됨
> v6 Update: forum **topic-aware** programmatic send (P0) + Dashboard **Telegram Hub** — one bot, many topics → many instances (P0–P4; per-topic `model`/`systemPrompt` overrides)

---

## Full local tool authority

Auto instances authorize qualified direct-local Jaw API calls without manually copied tool credentials. Slack history and typed tools share that policy with explicit file/channel sends and full dispatch. It is independent of native reuse or print resume. Full sends must keep an explicit destination; inbound allowlists, provider scopes, source/privacy exclusions and truthful receipts remain. Safe/custom and forwarded/proxy requests retain the existing scoped/operator path. See [full-local API semantics](../docs/slack-tools.md#full-local-api-access).

## 공통 메시징 레이어

### Request-scoped destination (#742/#745)

A completion event carries the conversation it belongs to. `src/messaging/run-pin.ts`
captures `origin`, `requestId`, `scope`, `sessionId`, `remoteKey` and the admitted
`target` once, at spawn; every `agent_done` spreads that block. `resolveForwarderTarget`
in `src/messaging/forwarder-origin.ts` reads the destination off the event and returns
null when it is missing or names another channel — null means do not send, never
"fall back to something". The Slack, Discord and Telegram forwarders take no
`getLastTarget`/`getLastChatId` option, so the last-active lookup cannot return.

Consequence: a web or CLI turn is no longer mirrored into a chat room. Its answer is
on the surface that asked for it. Mirroring guessed a room from a global slot that any
concurrent conversation could move, which is how a web run's internal ticket summary
reached a Slack thread that had asked something else (#742).

Heartbeat destinations follow the same rule through
`src/memory/heartbeat-destination.ts`: `resolveHeartbeatBinding` returns `bound` or
`held`. Slack needs a non-empty `threadId` or an explicit `scope: "channel_root"`; an
absent destination is `unbound_destination` and sends nothing. `GET /api/heartbeat`
surfaces the hold and `PUT` refuses to write a new incomplete Slack destination while
still inheriting an existing one. `authorizeExplicitTarget` in `src/messaging/send.ts`
vouches for a send without rewriting its address: it no longer returns the last-active
target's thread for an explicitly addressed channel-root post. A bound heartbeat
destination send then sets `fullAccess: true` with `allowActiveFallback: false` so the
operator-written conversation is reachable even when it is outside `slack.channelIds`
and nobody recently addressed the bot there. That flag is not an HTTP JSON voucher;
mention-watch's server post of a hit does not copy it.

Threaded Slack heartbeat jobs also prove the pair live before any main, employee or
script runner starts. `verifyHeartbeatThreadBindingLive` reads
`conversations.replies(channel, threadId, limit=1)`; the first row must be the
configured parent ts. A missing/stale parent, a channel or permission mismatch, rate
limit, missing credential, malformed response or transport failure holds that tick
before inference and before send. The live reason is retained for `GET /api/heartbeat`
and the UI while the enabled timer remains armed to recover on a later tick; editing the
destination invalidates the old reason immediately. The read is not retried and positive
results are not cached. `channel_root` and non-Slack destinations need no Slack read. Mention-watch is
separate: its destination is the hit thread it just discovered.

Every Slack heartbeat runner reserves a server-owned tool grant for the same target.
The grant carries `enforceDestination: true` and lives for 25 minutes, longer than the
20-minute collector ceiling. `spawnAgent` activates it before any runtime branch:
print and employee children inherit the header; Cursor/Grok use a request-lifetime
native process; Codex App, Claude and Pi use a fresh acquisition; script runners receive
the same header in their explicit child environment. `POST /api/channel/send` therefore
supplies an omitted destination and rejects a different one even under Auto/full-local.
Interactive turn grants omit this flag and unrelated Auto sends are never
process-globally locked.

Mention-watch **answer** turns reserve the same `enforceDestination` grant, but bind
`destination` to `slackThreadTarget(hit)`, `scope` to `mention-watch:<remoteKey>`,
and `chatSessionId` to that thread's session. A reserve failure throws
`slack_grant_unavailable`: the tick increments `failed` and does not record the hit
as seen or quiet. The turn is not started ungated. The server post of the collected
text already uses that hit target with `allowActiveFallback: false`. Job destination
still gates whether the watch may run; it does not choose the answer thread.

Outbound omit-target falls into three classes (no new `ChannelSendRequest` field):

| Class | Who | Omit-target |
|---|---|---|
| Interactive | live operator / agent reply | last-active / `turnTarget` / latest-seen (#397, #474) |
| Scheduled | reminders, web-ai drain, alerts | configured allowlist/home only; empty → silence |
| Producer-owned | heartbeat job, mention-watch server post, channel forwarders | explicit dest or silence; never last-active |

Scheduled callers set both `preferConfiguredTarget: true` and
`allowActiveFallback: false`. The pair is what closes last-active; preferring
configured dest alone still last-resorts.

### Slack group DMs and scope observations

The manifest subscribes to [`message.mpim`](https://docs.slack.dev/reference/events/message.mpim/)
and requests [`mpim:history`](https://docs.slack.dev/reference/scopes/mpim.history/)
for group DMs the app has joined. Slack delivers these as `type: message` with
`channel_type: mpim`; an exact bot mention follows this event directly instead of
being discarded while waiting for a channel `app_mention` twin.

Group DMs retain the conversation allowlist, bot/self/subtype filters, mention-only
policy and owned-versus-joined thread rules. They do not receive the one-to-one DM
allowlist bypass. Mention ACKs use the same classification. Top-level MPIM context
uses the existing bounded history budget (up to 50 messages before the current
message), while threaded context keeps the parent timestamp. Missing history scope
or budget leaves the current message usable without invented history.

`mpim:history` is the scope Slack documents as required for the `message.mpim`
event, so an install without it receives no group-DM traffic at all — the gap is
not merely missing history. It remains an optional capability for the install as
a whole: its absence is returned in `missingCapabilities` and logged at info as
a group-DM reception limitation, and it does not change the core credential-validation
result. Missing required scopes still fail validation. No observed OAuth header
means unknown; a present empty header means a known empty grant. Updating the
manifest does not update an installed app: add the event and scope in Slack and
reinstall when group-DM access is wanted. No automatic scope grant is attempted.

### Slack progress and reply ownership

`src/slack/bot.ts` owns direct and live queued reply delivery. Its standing
queued-reply forwarder covers requests without a live waiter and uses the
captured token, target and lifecycle generation. The existing table/rich-message
verification, native empty-body guard and self-delivery claim remain authoritative.

`progress-lifecycle.ts` installs request-correlated observers before orchestration.
Print tool events require the admitted request; native tool events additionally
require an exact private run/session/scope binding from `runtime/liveness.ts`.
A bounded prebinding buffer holds only projected categories/statuses and validated
activity metadata. Raw commands, file contents, reasoning, absolute host paths and approval contents never become
Slack progress text. Explicit shell tool-call descriptions are a separate bounded purpose field,
rendered with English actions and validated targets by `progress-detail.ts`. Supported
shell reads/searches/tests/scripts and literal `cd` prefixes are summarized without
executing or exposing command bodies, environment values, headers or arbitrary args.
Unknown syntax retains only a safe supplied purpose and tool/executable name.
`progress-files.ts` owns shared path projection. Sparse same-ID completion preserves
observed purpose/targets; the text fallback also includes the bounded recent rows.
Known read/write/edit events may carry a bounded filename: relative
to the captured request working directory, or basename-only outside it. Structured
native file fields and print-parser single-path detail are validated before projection;
native detail/output never substitutes for missing structured input. Unknown tools
and unsafe metadata remain category-only. Same-tool terminal updates retain the
observed filename without inventing a running state. Presentation events never select final answers.

Persistence gaps use the same private run/session/scope binding before showing an activity-unavailable notice. Prebinding gap candidates are bounded and expire for binding after 30 seconds. A gap never counts as tool activity, renews the run deadline, changes the model outcome or leaks stored content. The notice remains visible through final delivery. Captured workflows use neutral response-ended wording: a response and its delivery receipt do not certify production success. General-chat outcome wording, ACKs and native final values remain unchanged; business status comes from the production system, never from parsing model prose.

Projection truncation/capacity also emits that gap. Exact private runtime I/O signals show their own last-seen age, independently of last tool activity and stored preview rows. Display timers never manufacture liveness. A running observer has no five-minute lifetime; queued-start and pending-steer bounds remain separate from the running idle deadline.

When Slack definitively returns `message_not_in_streaming_state`, status updates switch to `chat.update` on the same owned channel/timestamp. No new stream/message is posted; fallback pacing, shared Retry-After and bounded request deadlines remain in force. A terminal-only discovery makes one same-message edit within the existing finish deadline. `stopped_by_user` remains distinct, and cancellation prevents late fallback resurrection. This follows Slack's [documented timestamp fallback](https://docs.slack.dev/tools/python-slack-sdk/reference/web/chat_stream.html). API success confirms an accepted status edit, not visual readback or production-task success; final answer delivery keeps its separate owner.

`progress.ts` streams a native plan containing a summary, at most six recent
observation slots and an optional delivery card. Only replaceable task titles
and statuses are updated: Slack task details append, so they are not a snapshot
channel. Explicit unsupported-capability errors permit one updated-message
fallback; ambiguous startup never causes a replacement post. Operations have
bounded timeouts and shared credential/method Retry-After restrictions. Native
heartbeat and per-stream refresh run every second, with a process-local shared
667ms append spacing (at most 90/minute per credential). Concurrent streams or
Slack/network backpressure may slow visual updates. Fallback edits remain 3.2s.
Snapshots are serialized at actual dispatch, unchanged cards are omitted, and
finish cancels undispatched update waits while joining already-started HTTP.
The plan title also contains elapsed time; clock ticks never count as work activity.

The card carries two independent axes and they must not be collapsed into one.
`QUIET_MS` (20s without tool activity) flips the phase from `running` to
`waiting`: nothing is happening right now. `LONG_RUNNING_SECONDS` (300s of wall
clock) adds a separate long-running line: this has been going a while. Both are
routinely true at once, so the long-running copy is appended to the card lines
and never replaces the phase description — overwriting it would hide the quiet
notice exactly when it matters. The threshold sits below the watchdog's 600s
`absoluteMs` default so the card can say "still in progress" while the run is
healthy; it is not a timeout warning (#673).

The standing target-reply forwarders share one admission,
`messaging/target-reply-guard.ts`. Which orphan identities a channel accepts
stays per-channel DATA, because it is a real decision: Slack takes
`fromQueue`/`fromSteer`/`replyViaTarget`, Telegram only `replyViaTarget`, and
Discord only `fromQueue`. A channel whose dispatch path already answers ordinary
turns must not answer them here too, or the user sees the reply twice —
unifying the lists would double-post on Telegram and Discord.
`observeSlackReplyControl` stays OUTSIDE that admission: it acts on
`steer_started`/`queue_update`/`queued_run_started`/`request_settled`, not on
`orchestrate_done`. The guard also does not drop empty native bodies, because
Telegram and Discord drop them at admission while Slack drops them inside its
delivery lane, after the ledger is entered (#699).

Queued requests start the same stream in queued state. The observed start resets
activity age and replaces the five-minute queue-wait deadline with a twenty-minute
owned-liveness window. Foreign activity cannot extend it. Cancelled, removed and
merged requests close their own tracking; started cancellation preserves a later
salvaged body. Tracking expiry does not claim that execution was killed.
Slack queue items retain their admitted chat session across enqueue, persistence
and execution even when multi-session is disabled. Switching the active chat
cannot redirect the queued run or invalidate its native reply identity.

Final status follows body delivery. Known execution failure/cancellation cannot
produce a success ACK merely because a diagnostic or salvage body was sent; the
delivery card independently requires a posted message ID or self-delivery claim.
A failed/ambiguous receipt is labelled unconfirmed. Legacy process exits carry
failure/interruption provenance independently of body text; native outcomes retain
their own authority. Optional image relay cannot
hold or overwrite the already selected body/ACK outcome.

`reply-delivery.ts` retains observed start anchors and delivery claims independently
of display expiry. Same-request completions join one pending workflow; a completed
or ambiguous attempt is not an implicit retry. Metadata is bounded to 1,024 records
for four hours plus the self-delivery retention window. Pending sends remain owned
until settlement. Missing start proof preserves fail-open posting, never a guessed
self-delivery suppression. These are process-local bounds, not distributed
exactly-once guarantees.

Confirmed status IDs use the existing durable notice store. `progress-restore.ts`
captures token/store/generation, skips live requests, and stops then neutrally
rewrites old status messages. Unknown failures retain recovery ownership. Disposal
seals observers and aborts restore/body IO before waiting for ingress, and starts
bounded progress cleanup immediately.

Close rule change from the legacy queue notice: a successful answer no longer deletes
the Slack status message — the card stays as the terminal status and only the durable
notice record closes (onTerminalConfirmed). Shutdown drain is bounded at 1.5s and a
drain timeout is never treated as confirmed cleanup; leftover cards are neutrally
rewritten by progress-restore on the next boot. Superseded callbacks cannot rearm the
transport; current outbound-only initialization remains supported.

The [native task stream API](https://docs.slack.dev/reference/methods/chat.startStream/)
is independent of the final structured sender. In-band steered input remains owned
by its original run. A physical Slack restart carries its captured target and
request identity into the replacement orchestration. Provider execution and
kill/wait scheduling remain independent of progress presentation.
The admission bridge retains at most 256 pending contexts for five minutes and
accepts only matching control identities. Actual start receipts set the delivery
anchor before model activity. Queued/restarted body workflows reserve a detached
session lane synchronously; display expiry releases presentation ownership while
the reply ledger still protects a later orphan completion.

### `src/messaging/runtime.ts`

- `registerTransport('telegram' | 'discord', ...)`로 각 transport의 init/shutdown을 등록한다
- `settings.messaging.lastActive/latestSeen`를 저장하고, `hydrateTargetsFromSettings()`로 복원한다
- `restartMessagingRuntime()`는 enabled channel set, per-channel config, 또는 locale이 바뀔 때 영향받는 채널만 재시작한다. home channel만 바뀌면 transport를 재시작하지 않는다
- `clearTargetState()`는 stale routing을 지우고, `send.ts`가 fallback target을 다시 계산하게 만든다
- restart 전에 stale target을 비우므로 이전 thread/channel로 재전송되는 것을 막는다

### `src/messaging/send.ts`

- `sendChannelOutput()`는 `explicit target → validated turn address → validated lastActive → validated latestSeen → configured fallback` 순으로 target을 고른다. 턴 주소는 인바운드 턴 프롬프트의 `reply_to=` 를 에이전트가 `turn_conversation` 으로 돌려준 값이다 (#474)
- `validateTarget()`는 Telegram allowedChatIds와 Discord channelIds / thread parent 허용을 둘 다 검사한다
- `registerSendTransport()`로 채널별 outbound sender를 주입한다


### `src/messaging/durable-ingress.ts`

- 세 채널 inbound가 공유하는 SQLite journal. Telegram poller는 handler 전에 `admitIngress`, offset 전진 전에 `settleIngress`를 부른다.
- 운영 조회/재생은 `jaw messaging ingress`. replay는 row를 `received`로 표시할 뿐이고, 재실행은 vendor 재전송이다.
- 운영자 Telegram DM의 dispatch approval은 Approve/Deny 버튼(`appr:`/`aprd:` opaque id)을 붙인다. Discord·Slack 운영자 DM도 같은 opaque 버튼을 붙인다. Slack 일반 keyboard send는 여전히 unsupported다.

### `src/messaging/thread-target.ts`

- `threadIdNumber(target)` — programmatic Telegram sends용 `message_thread_id` 추출
- `threadId`가 없거나 General topic (`'1'`)이면 `undefined` → wire payload에서 필드 생략 (DM/비포럼 그룹 동작 불변)
- 실제 topic id는 `n > 1`일 때만 전달
- 사용처: `telegram/bot.ts` `telegramSendHandler`, legacy `/api/telegram/send`, hub `sendToTopic`

### `src/messaging/extract-images.ts` (36L)

- `extractLocalImagePaths(markdown)`는 remark AST의 실제 image node만 문서 순서대로 읽는다. code fence 안의 image 문법은 대상이 아니다.
- 절대 로컬 PNG/JPG/JPEG/GIF/WebP만 받고 HTTP(S), data, protocol-relative, relative, `/media/`, `/api/`, SVG/비디오 경로는 제외한다.
- 동일 경로를 중복 제거한 뒤 최대 4개까지 반환한다.
- 이 helper는 Markdown 후보 추출만 소유한다. `relayTelegramImages()`와 `relayDiscordImages()`가 각 후보를 `assertSendFilePath()`로 canonicalize해 JAW_HOME/workingDir/projectDirs 밖 경로를 경고 후 건너뛰고, 통과한 파일만 기존 채널 file-send transport로 전달한다.

### Remote channel structured elicitation guard

- 21 Elicitation은 Web UI main DOM 전용 상호작용이다.
- Discord/CLI origin은 `src/orchestrator/pipeline.ts`에서 per-turn prompt guard를 받아 `elicitation` / `choice-buttons` / `search-results` fenced block 출력을 금지한다.
- **Telegram origin은 single_select `elicitation` fence 1개를 허용한다** — guard가 "inline keyboard로 렌더된다"고 안내하고, pipeline이 평문화 전에 raw spec을 추출해 `orchestrate_done`에 `elicitationSpecs`로 싣는다. `src/telegram/elicitation-buttons.ts`가 질문별 inline keyboard 메시지를 만들고(`elic:<q>:<o>` callback_data, 옵션 ≤8), `bot.callbackQuery(/^elic:/)`가 답을 수집해 전 질문 완료 시 결합 답변을 `tgOrchestrate`로 재주입한다. pending 세션은 chatId당 1개, TTL 10분, 일반 텍스트 입력 시 폐기(단 `/command`는 유지). multi_select/rank_priorities 혼합 spec은 기존 plain text fallback 그대로.
- A1 system prompt는 이 채널별 규칙 때문에 수정하지 않는다. prompt-cache 안정성을 유지하기 위해 origin-aware guard는 user prompt 조립 경로에서만 붙는다.
- 모델이 그래도 remote 응답에 `elicitation` / `choice-buttons` fence를 출력하면 `orchestrate_done` broadcast 직전에 plain text numbered question fallback으로 변환한다.
- 모델이 remote 응답에 `search-results` fence를 출력하면 raw JSON fence를 그대로 보내지 않고 일반 텍스트 검색 결과 목록 또는 경고 fallback으로 변환한다.
- Discord message components는 구현하지 않는다. Discord native buttons는 후속 별도 기능이다.

### `core/runtime-settings.ts`

- `applyRuntimeSettingsPatch()`는 `telegram`, `discord`, `messaging` 패치를 deep merge 하고 runtime restart를 트리거한다
- workingDir 변경이 있으면 MCP/skills/regenerateB까지 함께 갱신한다

---

## telegram/bot.ts — Telegram Bot + Forwarder Lifecycle + Voice + Hub-member relay (795L)

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성, allowlist, mention gating, handlers, forwarder lifecycle |
| `shutdownTelegram()` | bot stop + forwarder detach |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성, `applyRuntimeSettingsPatch()` 경로 사용 |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 default + locale `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 (`threadId` = `message_thread_id` when present) |
| `attachTelegramForwarder()` / `detachTelegramForwarder()` | broadcast listener lifecycle |
| `invalidateTelegramSendClient()` | send-only bot cache 무효화 (`runtime-settings` patch 시) |

### Thread-aware programmatic send (P0)

- `registerSendTransport('telegram', telegramSendHandler)` 경로가 `threadIdNumber(req.target)`로 `message_thread_id`를 text/file send에 전달한다
- Interactive `ctx.reply`는 grammY가 자동으로 thread를 유지하므로 handler 경로와 분리된다
- `telegram-file.ts` `sendTelegramFile(..., { threadId })`도 동일 semantics
- Markdown image relay도 `validateFileSize(path, 'photo')`와 `sendTelegramFile(..., 'photo', { threadId })`를 재사용하므로 기존 20MB gate, retry/error 결과, forum topic routing을 그대로 따른다

### Hub-member outbound relay (P2b)

`settings.telegramHub.mode === 'hub-member'`이고 `req.target.channel === 'telegram'`이면 인스턴스 자체 봇 대신 Dashboard hub callback으로 relay:

```text
  telegramSendHandler (hub-member):
  base = resolveHubCallback(settings.telegramHub.hubCallbackUrl)  // src/telegram/hub-callback.ts
  POST {base}/api/dashboard/telegram-hub/outbound
    body { chatId, threadId, type, text?, filePath?, caption?, reply_markup? }
```

- `resolveHubCallback()` — loopback `http:` only; https·credentials·non-loopback → `http://127.0.0.1:24576` fallback
- Hub mode invariant: forum 그룹의 **동일 bot token**은 long-poll **한 곳**만 가능 (409). Hub 그룹에 묶인 인스턴스는 `telegram.enabled=false` 유지

### 현재 동작

```text
initTelegram():
  1. detachTelegramForwarder()
  2. 기존 bot stop + null
  3. Grammy Bot 인스턴스 생성
  4. allowlist / allowedChatIds 로드
  5. group/supergroup @botUsername gating
  6. logging/allowlist/mention gating middleware 등록
  7. bot.command('start'/'id') + text/photo/document/voice handlers 등록
  8. settings.telegram.forwardAll !== false → attachTelegramForwarder(bot)
  9. syncTelegramCommands()
  10. bot.api.getMe() → botUsername 캐시
  11. bot.start()
```

- 실제 bot command handler는 `/start`, `/id` 2개다. 나머지 slash command는 `message:text`에서 `parseCommand()` → `executeCommand()`로 처리한다
- text handler는 `@botUsername` 멘션을 자동 제거한다
- photo/document handler는 Telegram file download → `saveUpload()` → `buildMediaPrompt()` → `tgOrchestrate()`로 이어진다
- voice handler는 `telegram/voice.ts` → guarded `downloadTelegramFile()` → `lib/stt.ts` → `tgOrchestrate()`로 이어진다
- inbound photo/document downloads pass media-specific size hints to `downloadTelegramFile()` before files are saved.
- standalone inline keyboard handler는 `bot.callbackQuery(/^elic:/)`가 `handleElicitationCallback()`을 호출하고, 모든 질문 완료 시 combined answer를 `tgOrchestrate()`로 재주입한다.
- Telegram-origin `tgOrchestrate()` 응답은 queue 완료와 direct result 경로 모두 text를 먼저 보낸 뒤 같은 `responseTarget`으로 허용된 로컬 이미지를 photo relay한다. global forwarder의 origin skip으로 중복 전송하지 않는다.
- `applySettings()`는 `bumpSessionOwnershipGeneration()` 이후 `applyRuntimeSettingsPatch()`를 호출한다
- `markChatActive()`는 `allowedChatIds` 자동 저장과 `lastActive/latestSeen` 갱신을 같이 처리한다
- transport/send transport 등록은 모듈 로드 시점에 즉시 일어난다

### 의존 모듈

`core/bus` · `core/config` · `core/main-session` · `core/runtime-settings` · `core/employees` · `agent/spawn` · `orchestrator/pipeline` · `orchestrator/collect` · `cli/commands` · `messaging/runtime` · `messaging/send` · `lib/upload`

---

## telegram/forwarder.ts — Telegram Forwarder (236L)

| Function | 역할 |
| --- | --- |
| `createForwarderLifecycle()` | attach/detach 중복 등록 방지 |
| `createTelegramForwarder()` | `agent_done`를 Telegram 채널로 forward |
| `relayTelegramImages()` | Markdown의 허용된 로컬 이미지 후보를 realpath guard + size gate 후 photo로 전송 |
| `markdownToTelegramHtml()` | Markdown → Telegram HTML 변환 |
| `chunkTelegramHtmlMessage()` | Telegram HTML tag token/balance 보존 분할 |
| `chunkTelegramMessage()` | 4096자 단위 분할 |
| `escapeHtmlTg()` | Telegram HTML escape |

### 핵심 포인트

- `shouldSkip(data)`로 Telegram-origin 결과를 제외한다
- `broadcast` listener는 named handler 기준으로 제거된다
- `forwardAll`이 꺼져 있으면 bot 메시지는 받고, agent_done forward는 하지 않는다
- outbound 텍스트는 Telegram HTML로 변환한 뒤 4096자 청크로 보내고, 전송 시도 뒤 추출된 이미지를 순서대로 photo relay한다
- Telegram `agent_done` forwarder reads the run pin's `target` (or sends nothing). It does not call `getLastTarget()` / `getLastChatId()`.

---

## discord/forwarder.ts — Discord Forwarder (82L)

| Function | 역할 |
| --- | --- |
| `chunkDiscordMessage()` | 2000자 제한에 맞춰 줄바꿈 우선 분할 |
| `relayDiscordImages()` | Markdown의 허용된 로컬 이미지 후보를 realpath guard 후 `sendDiscordFile()` attachment로 전송 |
| `createDiscordForwarder()` | `agent_done` text chunk 전송 뒤 이미지 attachment relay |

### 핵심 포인트

- global forwarder skips errors and `shouldSkip(data)` Discord-origin results. When `forwardAll !== false` it sends text → attachment to the run pin's Discord `target`, or nowhere. It does not read last-active.
- Discord-origin `dcOrchestrate()`는 queue 완료와 direct result 경로에서 text chunk를 먼저 보낸 뒤 `relayDiscordImages()`를 호출한다. global origin skip과 분리되어 원래 채널 reply에도 이미지가 붙는다.
- attachment 전송은 새 채널 API를 만들지 않고 기존 `sendDiscordFile()`의 target resolution/text-channel check와 `{ ok, error }` 결과를 재사용한다. guard/전송 실패 이미지는 warn 후 건너뛰며 text 응답은 유지된다.

---

## telegram/voice.ts — Voice Message STT Handler (40L)

| Function | 역할 |
| --- | --- |
| `handleVoice(ctx)` | voice 메시지 → Telegram API download → `lib/stt.ts` 전사 → `tgOrchestrate(ctx, text)` |

### 흐름

```text
bot.ts on("message:voice"):
  1. ctx.reply("🎤 ...")
  2. getFile() → download URL 생성
  3. node-fetch로 .ogg 다운로드 → tmp 저장
  4. transcribeVoice(tmpPath, 'audio/ogg')
  5. 빈 결과 → ctx.reply(t('tg.voiceEmpty'))
  6. 성공 → tgOrchestrate(ctx, transcribedText)
  7. finally → tmp 파일 삭제
```

### 의존 모듈

`lib/stt` · `lib/upload` · `telegram/bot` (`tgOrchestrate`)

---

## telegram/telegram-file.ts — Telegram File Send (149L)

| Export | 역할 |
| --- | --- |
| `TELEGRAM_LIMITS` | file size limits |
| `validateFileSize(path, type)` | 20MB size gate |
| `classifyUpstreamError(err)` | upstream error classification |
| `sendTelegramFile(...)` | file send + exponential backoff retry; optional `{ threadId }` for forum topics |

---

## telegram/hub-callback.ts — Hub callback URL SSRF guard (19L)

| Export | 역할 |
| --- | --- |
| `resolveHubCallback(configured?)` | hub-member outbound의 callback origin 결정; loopback `http`만 허용 |

- Default: `http://127.0.0.1:24576` (`DASHBOARD_DEFAULT_PORT`)
- Path/query는 strip; origin만 반환

---

## Telegram Hub (Dashboard) — Telegram topic/thread → instance routing

> Dashboard manager server(`src/manager/server.ts`, port `24576`)가 **단일 bot token + 단일 hub chat**을 소유하고, topic/thread(`message_thread_id`)별로 managed instance(3457–3506)에 라우팅한다. Hub chat은 forum supergroup(`-100...`) 또는 topics/thread mode가 켜진 bot private chat(`823...`)일 수 있다. **Mode A**(per-instance bot + P0 thread-aware send)와 공존.

### Two operating modes

| Mode | Who polls Telegram | Inbound | Outbound |
| --- | --- | --- | --- |
| **Standalone** (`telegram.enabled=true`) | Each instance's `initTelegram()` | Instance bot handlers | Instance `telegramSendHandler` (thread-aware) |
| **Hub** (dashboard `telegramHub.enabled`) | `startHubBot()` only | Hub `hub-bot.ts` → `POST /api/message` on mapped port | Instance `hub-member` send → `POST …/telegram-hub/outbound` → hub `sendToTopic` |

### Module map

| Path | 역할 |
| --- | --- |
| `src/manager/telegram-hub/types.ts` | `TelegramHubConfig`, `ThreadRoute` |
| `src/manager/telegram-hub/routing-store.ts` | Registry `telegramHub` CRUD |
| `src/manager/telegram-hub/hub-bot.ts` | Hub grammY bot: inbound intercept, instance forward, `sendToTopic` |
| `src/manager/routes/telegram-hub.ts` | Loopback-only REST: config CRUD + outbound relay |
| `public/manager/src/settings/pages/TelegramHub.tsx` | Manager settings UI |

### Routing model

```text
threadKey(message_thread_id): id > 1 → String(id); else → '1' (General)

Inbound (hub-bot):
  1. chatId must equal config.chatId
  2. Hub slash commands → handleHubCommand (no @mention gate)
  3. route = resolveRoute(chatId, threadId) — none → "미연결" (no defaultPort auto-route)
  4. route hit → hub keeps sendChatAction('typing') alive for that topic/thread
  5. POST http://127.0.0.1:{port}/api/message { prompt, target, model?, systemPrompt? }  // P4 overrides from ThreadRoute
     - private bot-topic chats use `target.peerKind='direct'`
     - group/forum topics use `target.peerKind='group'`

Target response:
  1. /api/message marks hub-forwarded turns with replyViaTarget=true
  2. pipeline/queue carry target, requestId, replyViaTarget into orchestrate_done
  3. target instance installTelegramTargetReplyForwarder() calls canonical sendChannelOutput({ channel:'telegram', target })
  4. hub-member telegramSendHandler relays to hub callback /api/dashboard/telegram-hub/outbound
  5. hub sendToTopic() stops typing and sends into the original topic/thread

Outbound: hub-member → POST /api/dashboard/telegram-hub/outbound → sendToTopic (rich-first: sendTelegramMarkdown)
```

Native target replies additionally require the hub's server-generated `bodyDelivered` receipt. Private helper observers report actual successful body sends and invalidate the receipt if a later chunk is rejected or formatted away. No request-side flag can forge it. A native member treats older hubs without this receipt as delivery-unconfirmed and does not automatically retry; untagged legacy `ok` behavior stays unchanged.

### Hub elicitation callbacks

- Hub mode also owns an inline keyboard handler: `src/manager/telegram-hub/hub-bot.ts` registers `bot.callbackQuery(/^elic:/)`, resolves `(chatId, threadId)` to the mapped instance, and forwards `{ chatId, callbackData, target }` to `http://127.0.0.1:{port}/api/elicitation/callback`.
- The target instance route `POST /api/elicitation/callback` calls `handleElicitationCallback()`. Progress replies only acknowledge the tapped option; complete replies re-submit the combined answer by calling `submitMessage(result.combinedAnswer, { origin:'telegram', target, chatId, replyViaTarget: Boolean(target) })` directly (not via the `/api/message` HTTP route).
- The standalone handler and hub handler both clear the tapped message keyboard after acknowledgement so the selected answer reads as committed.

### P4 — per-topic model and system prompt

- `ThreadRoute` optional fields: `model`, `systemPrompt` (`src/manager/telegram-hub/types.ts`).
- Hub `forwardToInstance()` passes overrides into instance ingest when route defines them.
- Manager `TelegramHub.tsx` routes table shows per-topic `model` / `systemPrompt`.
- Outbound text is rich-first by default: `src/telegram/rich-message.ts` `sendTelegramMarkdown()` sends raw markdown via Bot API 10.1 `sendRichMessage` (32000-char chunks, grammy ≥1.44), falling back per chunk to `parse_mode:'HTML'` (4096 re-chunk) then tag-stripped plaintext. Same helper serves `telegramSendHandler`, tg replies (`tgOrchestrate`/queue), `createTelegramForwarder`, and hub `sendToTopic`.

### Watchdog diagnostics relay

- When `src/agent/watchdog.ts` kills a stalled turn, kill diagnostics are preserved and surfaced back through the originating Telegram `target` (direct chat or forum topic) so operators see why the turn ended.

### Hub bot commands

| Command | Auth | Behavior |
| --- | --- | --- |
| `/setthread` | read | 현재 topic 바인딩 표시 |
| `/setthread <port>` | private chat owner or group admin | `(chatId, threadId) → port` upsert + target hub-member settings ensure; port ∈ 3457–3506 |
| `/setthread off` | private chat owner or group admin | 현재 topic route 삭제 |
| `/threads` | read | 현재 hub chat의 전체 route 목록 |
| `/hubhelp` | read | command help |

### Hub HTTP API (loopback-only)

Mounted at `/api/dashboard/telegram-hub` (`loopbackOnly` middleware).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/` | — | `{ ok, config, runtime }` — token redacted; `runtime = getHubBotStatus()` |
| `PUT` | `/` | `{ enabled?, token?, chatId?, defaultPort? }` | patches registry; restarts hub bot |
| `POST` | `/routes` | `ThreadRoute` | upsert route |
| `DELETE` | `/routes/:chatId/:threadId` | — | remove route |
| `POST` | `/outbound` | `{ chatId, threadId, type, text?, filePath?, caption?, reply_markup? }` where `type:'keyboard'` permits Telegram `reply_markup` | instance → hub → topic relay; requires bound hub chat and enabled `(chatId, threadId)` route |

### Dashboard settings UI (`TelegramHub.tsx`)

- Sidebar: **Settings → Channels → Telegram Hub**
- Fields: Enable hub, Bot token, Hub chat ID, Default port
- Routes table: read-only list with per-topic **model** / **systemPrompt** columns + Delete; add/bind는 Telegram `/setthread`만

### Hub chat ID choices

- Bot private topic mode: set `chatId` to the private Telegram chat id (for example `8231528245`).
- Forum supergroup topic mode: set `chatId` to the supergroup id (usually `-100...`).
- Hub-member instances with a non-empty `telegram.allowedChatIds` allowlist must include this same hub `chatId`, because hub forwarding enters the instance through `/api/message` with a Telegram target.

### Instance hub-member settings (auto-ensured by `/setthread`)

```jsonc
{
  "telegram": { "enabled": false, "allowedChatIds": ["<hub chat id>"] },
  "telegramHub": { "mode": "hub-member", "hubCallbackUrl": "http://127.0.0.1:24576" }
}
```

- `telegram.enabled=false` prevents duplicate long-polling with the dashboard hub bot token.
- `telegram.allowedChatIds` must include the bound hub chat id so explicit Telegram target validation passes.
- `telegramHub.hubCallbackUrl` is loopback-only validated; the default manager port is `24576`.

---

## cli/command-context.ts — Remote Patch Whitelist

| Telegram/Discord 허용 패치 | 설명 |
| --- | --- |
| `{ fallbackOrder: [...] }` | fallback order 변경 |
| `{ memory: { ... } }` | memory 설정 patch |
| `{ telegram: { ... } }` | Telegram channel setting patch |
| `{ discord: { ... } }` | Discord channel setting patch |

- `telegram` / `discord` / `slack` 인터페이스는 위 whitelist만 허용한다
- 허용되지 않은 패치는 `tg.` / `dc.` / `sl.settingsUnsupported`로 거절된다
- **런타임 선택(`cli`, `perCli`, `activeOverrides`)은 원격에서 변경할 수 없다**.
  한 인스턴스의 모든 세션이 하나의 CLI·모델을 공유하므로, 원격 채널에서 바꾸면 인스턴스 웹과
  다른 모든 세션의 선택이 함께 움직인다. 소유자는 인스턴스 웹(`PUT /api/settings`)이고,
  거절 문구 `cmd.runtimeSelectionInstanceWide`가 어디서 바꿔야 하는지 안내한다
- 실제 merge는 `core/settings-merge.ts` + `core/runtime-settings.ts`가 담당한다

---

## cli/handlers-runtime.ts — `/forward` Handler

| Function | 역할 |
| --- | --- |
| `forwardHandler(args, ctx)` | `/forward on|off`로 현재 인터페이스의 `forwardAll` 토글 |

- Telegram 인터페이스에서는 `settings.telegram.forwardAll`
- Discord 인터페이스에서는 `settings.discord.forwardAll`
- `src/cli/handlers.ts`는 이 핸들러를 re-export만 한다

---

## memory/heartbeat.ts — Scheduled Jobs (969L)

| Function | 역할 |
| --- | --- |
| `startHeartbeat()` | cron-like 주기 작업 시작 |
| `nextIntervalDelay(anchor, periodMs, now)` | 앵커 기준 다음 경계까지의 ms — 항상 `(0, periodMs]` |
| `getHeartbeatIntervalAnchor(jobId)` | 그 작업의 인터벌 격자 기준 시각 (진단/검증용) |
| `stopHeartbeat()` | 세대 증가 + abort + 대기 큐 비우기 + 타이머 해제 (cron 슬롯은 유지) |
| `runHeartbeatJob(job)` | 단일 작업 실행 (in-flight skip + busy guard + 세대 포착) |
| `getHeartbeatRunRecord(jobId)` | 그 작업의 마지막 **승인된** 틱 결과 (프로세스 로컬) |
| `drainPending()` | 대기 큐 1건 실행 — 스케줄이 해제된 상태에서는 아무것도 하지 않는다 |
| `watchHeartbeatFile()` | fs.watch debounce — 파일 변경시 재로드 |

### 의존 모듈

`core/config` · `orchestrator/collect` · `messaging/send` · `memory/heartbeat-schedule`

### 작업 스케줄

- 설정: `~/.cli-jaw/heartbeat.json`
- 각 작업: `id`, `name`, `enabled`, `schedule`, `prompt`
- `schedule`은 `{ kind: 'every', minutes }` 또는 `{ kind: 'cron', cron, timeZone? }`
- busy guard: 다른 작업이 실행 중이면 버리지 않고 `pendingJobs` 큐에 넣는다. 단 **같은**
  작업이 이미 실행 중이면 큐에 넣지 않고 건너뛴다 — 큐에 넣으면 끝나는 실행의 `finally`가
  그 사본을 다시 실행해 같은 보고가 두 번 전달됐다.
- 실행이 받아들여지는 시점에 그 작업의 대기 사본은 제거된다. PABCD 중 연기된 틱은 이후의
  정상 틱이 수행한 것으로 충족된 것이므로 다시 재생하지 않는다.
- `stopHeartbeat()`는 세대를 올리고 진행 중인 실행을 abort 하며 대기 큐를 비운다. 세대가
  바뀐 실행은 전송·앵커·ledger 기록과 drain을 수행하지 않는다. `drainPending()`은 외부
  (`orchestrator/pipeline`, `routes/orchestrate`, `cli/handlers-runtime`, `agent/spawn/queue`)
  에서도 호출되므로, 타이머가 없으면 스스로 아무 일도 하지 않는다.
- cron 슬롯 맵은 재로드를 넘어 살아남는다. `startHeartbeatCronLoop`가 arm 즉시 현재 분을
  실행하므로, 슬롯을 비우면 저장 + 파일 감시 재빌드로 같은 분이 두 번 발사된다.
- `every` 작업은 `setInterval`이 아니라 **앵커 기반 `setTimeout` 체인**으로 arm 된다.
  `setInterval`은 arm 시점부터 재는데 `startHeartbeat()`는 부팅(`server.ts`), 모든
  `PUT /api/heartbeat`, 감시자가 보는 모든 `heartbeat.json` 쓰기, mention-watch fresh
  start 마다 다시 arm 한다. 주기보다 자주 저장되는 홈에서는 그 작업이 **한 번도 발사되지
  않았고**, 매 arm이 각각으로는 정상으로 보였기 때문에 아무것도 기록되지 않았다.
  앵커 맵은 cron 슬롯과 같은 이유로 `stopHeartbeat()`를 넘어 살아남는다.
- 단 **주기가 바뀌면 다시 앵커한다**. 옛 기준점을 새 주기에 그대로 쓰면 다음 경계가
  몇 밀리초 뒤에 올 수 있어 60m → 61m 수정이 즉시 틱을 유발한다 — `setInterval`은 못 하던
  일이고, 앵커를 얻자고 치를 값이 아니다. 시계가 뒤로 간 경우의 대기도 한 주기로 잘린다.
- 파일에서 사라진 작업의 `intervalAnchors` · cron 슬롯 · live destination hold 는
  `startHeartbeat()` 끝에서 정리된다. 기준은 `enabled`가 아니라 **파일에 없음**이다 —
  비활성화했다 다시 켠 작업은 리듬을 유지해야 한다.
- mention watch 틱은 스케줄러의 `AbortSignal`을 받는다. 이미 `deps.signal`을 읽고
  `stoppedBecause: 'aborted'`를 보고하던 경로가 이제 실제로 연결돼 있다.
- mention watch 틱에는 **답변 단계 wall-clock 예산**(10분)이 있다. 틱 전체가 아니라
  스캔이 끝난 시점부터 잰다 — 스캔은 60채널 × 4윈도우 × 2초 페이싱으로 정당하게 수 분을
  자므로, 전체 틱 기준이면 답변 0건으로 예산이 만료될 수 있다. 예산은 **시작되는 것**을
  제한하지 총 시간을 제한하지 않는다: 1밀리초 남기고 승인된 답변은 자기 idle 상한까지
  돌기 때문에 정직한 최악은 예산 + 1턴이다. 검사는 `deps.answer` **앞**에 있어서
  만료된 예산은 에이전트 턴을 한 번도 쓰지 않는다. 답 못 한 hit 은 receipt 을 남기지
  않으므로 다음 틱이 가져간다.
- 틱 결과는 스캐너가 계산해 놓고 버려지던 두 신호를 싣는다. `scanIncomplete` 는 "어떤
  채널의 역방향 walk 이 커서까지 못 갔다" 이며 **backlog 가 아니다** — 윈도우 예산 소진,
  429, 네트워크 오류, abort, 진행 불가 페이지 전부 포함한다. `hitCapReached` 는 전역
  hit 상한이 채널 루프를 끊은 경우로, 이때 `scanIncomplete` 는 **false 로 남는다**.
  따라서 "다 따라잡았다" 는 둘 다 false 일 때만 참이다. 불리언 하나가 조용히 두 가지를
  뜻하게 만든 것이 원래 `truncated` 를 못 쓰게 만든 이유다.
- 승인된 틱은 **반드시 하나의 run record** 를 남긴다. `execution`(`ok`/`error`/`skipped`)과
  `delivery`(`delivered`/`not_delivered`/`suppressed`/`not_requested`)를 분리한다 —
  "모델이 끝났다" 와 "수신자가 받았다" 는 다른 주장이고, 합치면 초록색 실행이 증거로서
  의미를 잃는다. 전송 실패는 `execution: 'ok'` 이고 실패 streak 를 올리지 않는다.
  전송이 **예외를 던져도** delivery 실패로 분류한다 — 그러지 않으면 크래시한 러너와
  같은 catch 에 떨어져 작업 탓이 된다.
- 카운터는 둘이다. `consecutiveFailures`(error)와 `consecutiveSkips`(skipped). 매 틱
  거부하는 작업 — 검증 불가한 workspace, 예약되지 않는 grant — 은 streak 0 에 머물러
  영원히 안 보이게 되기 때문이다. 임계값(5)에 닿으면 `getHeartbeatRuntimeState().failing`
  에 나타난다. **타이머는 끄지 않는다** — live destination hold 와 같은 이유로, 조용히
  멈추는 것이 #745 가 막으려던 실패다.
- 세대가 교체된(superseded) 실행은 결과를 기록하되 두 카운터를 그대로 통과시킨다.
  뒤늦은 `ok` 가 streak 를 리셋하거나 abort 후 throw 가 올리는 것은, 운영자가 이미 바꾼
  설정을 서술하는 일이다.
- 승인 **이전** 의 이탈(이미 실행 중·busy·agent busy)은 기록하지 않는다. 그건 실행이
  아니고, 이미 `heartbeat_pending` 으로 방송되며, 기록하면 진짜 실행의 결과를 덮는다.
- 기록은 프로세스 로컬이다. 재시작하면 잊는다. 영속화는 anchor 스키마를 건드리는
  별도 유닛이다.
- 실행 프롬프트 앞에는 memory search 지시가 자동으로 붙는다
- 결과 전송은 작업에 바인딩된 목적지로만 간다. 활성 채널로 보내는 경로는 없다 —
  목적지는 완결돼 있거나 보류되며, 자세한 규칙은 이 문서 위쪽
  `heartbeat-destination.ts` 절에 있다.
- bound 바인딩은 `verification` 을 함께 싣는다: `unverified`(순수 파싱 — 검사를 한 적
  없음), `verified`(`conversations.replies` 가 실제로 통과), `unsupported`(그 형태에
  live 검사가 **존재하지 않음** — 비-Slack 대상과 Slack `channel_root`). 불리언이 아닌
  이유는 "검사가 없다" 와 "검사가 실패했다" 가 같은 단어가 되면 안 되기 때문이다.
  불리언이었다면 모든 Discord·Telegram 잡이 영원히 `false` 를 달고 다니며 멀쩡히 도는
  틱이 실패한 조회처럼 보였을 것이다.
- 스크립트 러너는 부모 환경변수를 **그대로 물려주지 않는다**. `SLACK_` · `TELEGRAM_` ·
  `DISCORD_` 접두사는 제외된다. 이 경로의 설계 자체가 스코프된 grant 하나만 넘기는
  것인데, 그 밑으로 원시 봇 토큰까지 흘러가면 grant 는 장식이 된다. 접두사 기준이라
  나중에 추가되는 채널 변수도 기본 제외다. 의도적으로 약간 넓어서 `SLACK_CHANNEL_IDS`
  같은 allowlist 도 빠진다 — 필요하면 명시적으로 주면 된다. grant 는 필터 **이후** 에
  적용되므로 정작 필요한 비밀은 살아남는다.
- 비-Slack 목적지로 도는 잡은 destination-bound authority **없이** 돈다는 사실을 잡마다
  한 번 경고하고 `getHeartbeatRuntimeState().unenforcedDestinations` 로 노출한다.
  `enforceDestination` grant 는 Slack 전용이고, 그 사실을 런타임이 말한 적이 없어서
  Discord 틱이 로그상으로는 보호되는 Slack 틱과 똑같아 보였다.

**알려진 크로스채널 공백 (이 유닛에서 고치지 않음).** `src/discord/bot.ts` 의 전송
채널 결정은 `req.chatId || req.target?.threadId || req.target?.targetId` 순서라, 바인딩된
Discord 하트비트의 target 이 `threadId` 를 갖고 있으면 잡이 지정한 대화가 아니라 그
id 로 간다 — 하트비트 쪽 바인딩은 완결돼 보이므로 보류도 걸리지 않는다. 이 순서는
예약 전송만이 아니라 모든 Discord 전송을 떠받치므로 별도 감사가 필요하다.

### `settings.heartbeat` 는 스케줄러가 읽지 않는다

`settings.json` 의 `heartbeat` 블록(`enabled`, `every`, `activeHours`, `target`)은
`src/core/config.ts` 의 기본 스키마에 선언돼 있고 Manager 설정 페이지가 편집·저장하지만,
`src/` 와 `bin/` 어디에서도 읽지 않는다. 스케줄러가 보는 것은 `~/.cli-jaw/heartbeat.json`
의 per-job 설정뿐이다.

실질적인 의미: 여기서 조용한 시간대(`activeHours`)를 설정해도 틱은 그대로 돌고,
`enabled`를 꺼도 작업은 멈추지 않는다. 이 블록을 제거할지 실제로 연결할지는 기존 설치의
동작을 바꾸는 결정이라 아직 내려지지 않았다 — 그때까지 이 문단이 사실관계다.

---

## memory/heartbeat-schedule.ts — Schedule Parsing & Validation (410L)

| Function | 역할 |
| --- | --- |
| `normalizeHeartbeatSchedule()` | `every`/`cron` 입력 정규화 |
| `validateHeartbeatScheduleInput()` | API 저장 전 스케줄 검증 |
| `describeHeartbeatSchedule()` | 사람이 읽는 schedule 문자열 생성 |
| `matchesHeartbeatCron()` | timezone-aware cron 매칭 |
| `formatHeartbeatNow()` | 잡 프롬프트용 현재 시간 문자열 생성 |

### API 표면

- `GET /api/heartbeat`는 현재 `heartbeat.json`을 반환한다
- `PUT /api/heartbeat`는 schedule 검증 후 저장하고 `startHeartbeat()`를 다시 호출한다
- `watchHeartbeatFile()`는 `heartbeat.json` 파일 변경을 debounce 후 자동 재로드한다

Slack file CLI uses an explicit conversation and completion-only upload receipts (`sent: boolean|unknown`, no auto retry or caption fallback); cancellation preserves known/unknown delivery. Sync commands/API/Slack docs.
