---
created: 2026-03-28
tags: [cli-jaw, server, api, express]
aliases: [CLI-JAW Server API, server.ts reference, server_api]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · [커맨드 ↗](commands.md) · **서버 API**

# server.ts — Glue + Route Registration (757L)

> Express/SSE bootstrap + localhost/LAN opt-in 보안 가드 + `src/routes/*` registrar + mounted sub-router 등록.
> Route-module inventory and the endpoint contracts below describe the surface; aggregate handler counts are not maintained by hand.
> mutation route(`POST`/`PUT`/`DELETE`)는 모두 `requireAuth`를 거친다. 단, `requireAuth()`는 loopback 요청을 토큰 없이 통과시키고, `lanAllowed()`가 true일 때 private IP도 LAN bypass로 통과시킨다.
> `GET /api/auth/token`은 Bearer bootstrap 전용이며 `Sec-Fetch-Site`가 `same-origin` 또는 `none`이 아닐 때 `403`을 반환한다.

---

## Route Module Architecture

### Saved Activity answer lookup

`GET /api/messages?withSession=1` returns `{sessionId,messages}` inside the existing
ok/data envelope, using the actual resolved conversation. Without literal1 the
legacy array remains unchanged. This metadata opt-in does not change final selection.

`GET /api/messages/by-trace/:runId?session=<id>` requires explicit nonempty session
and a valid public run ID under existing instance auth. It reads assistant MESSAGE
rows through the existing trace index, independent of the optional reverse trace
link. A unique match returns `{message:{id,role,content,trace_run_id,session_id}}`;
zero matches returns `{message:null}`; two matches returns409. Content and exact
serialized response are bounded to16MiB (413); repository failure returns generic503.
All responses use no-store. A copied fork MESSAGE is readable in its own chat, but
this endpoint never grants permission to read the original chat's journal or raw Trace.

`GET/PUT /api/settings` includes `presentation: {mode: 'activity'|'legacy'}`. Missing mode defaultsActivity; explicitLegacy persists. Malformed presentation objects/modes return400 at existing ingress validation, with no settings side effects. Partial blocks preserve siblings. A presentation-only PUT does not reset fallback, rewrite the provider singleton, change permissions or restart messaging transports; existing serialization, dispatcher and rollback remain. GET keeps its existing direct compatibility fields plus ok/data envelope. No new endpoint or tenant policy is added.

Live `/api/orchestrate/snapshot` tool hydration now reads up to400 newest durable rows even when RAM has the same count; in-place tool completion can change content without changing count. It merges all RAM fallback, preserves exact run/item identity and retains known omission when DB only has a suffix. The snapshot-only sanitizer option uses max-overlap rather than summing source omissions. `/api/messages` uses the same latest merge and synthesized durable pointers while preserving worker blob mirrors and existing bounds. No new endpoint, tenant policy or final-delivery path is introduced.

| Module | Lines | Routes | 역할 |
| --- | ---: | ---: | --- |
| `server.ts` | 761L | mount glue | Helmet/CORS/Host/rate-limit/SSE bootstrap + static middleware + route/sub-router registration |
| `src/routes/static.ts` | 160L | 4 | root HTML + `/media/:filename` upload media serve + guarded `/api/image` local media serve + `/api/widgets/:chatId/:widgetId` inert widget file serve |
| `src/routes/system.ts` | 149L | 5 | health/session/runtime/auth-token/slack-manifest |
| `src/routes/messages.ts` | 187L | 5 | message list/count/search/latest and exact saved Activity answer |
| `src/routes/command.ts` | 259L | 4 | slash command execution, command palette, normal message submit, Telegram elicitation callback relay |
| `src/routes/instance.ts` | 53L | 3 | instance lock GET/POST/DELETE |
| `src/routes/chat-sessions.ts` | 65L | 4 | session list/create/switch/delete (전 route requireAuth) |
| `src/routes/search.ts` | 95L | 1 | `/api/search` 통합 검색 (requireAuth, corpus 검증, cursor 400) |
| `src/routes/wiki.ts` | 150L | 3 | 옵트인 위키 status/enable/configure (requireAuth, root 충돌 400, scaffold 실패 시 disabled 유지, 040) |
| `src/routes/task.ts` | 59L | 2 | agent-native task list/action API |
| `src/routes/events.ts` | 140L | 1 | `/api/events` data-only SSE event channel |
| `src/routes/settings.ts` | 756L | 24 | settings/prompt/default-runtime migration/project pick/git summary/heartbeat-md/MCP/CLI registry/quota/copilot/Pi profile registration |
| `src/routes/memory.ts` | 191L | 13 | memory runtime + KV memory + memory files |
| `src/routes/browser.ts` | 489L | 43 | browser primitive/tab/debug/doctor/cleanup routes + adaptive fetch + web-ai render/send/poll/watch/sessions/capabilities/code/context routes |
| `src/routes/jaw-memory.ts` | 362L | 12 | jaw memory search/read/save/context/list/init/reflect/flush/soul/soul-activate/bootstrap |
| `src/routes/orchestrate.ts` | 1222L | 18 | reset/state/workers/worker-progress/worker-runs/snapshot/queue cancel/hold/queue steer async accept/dispatch/batch dispatch/worker result/state PUT |
| `src/routes/goal.ts` | 183L | 3 | durable goal state get/history/set-update-complete-cancel-pause-resume-clear-reset |
| `src/routes/goal-run.ts` | 83L | 3 | bounded goal-run state/preflight/start-pause-resume-stop |
| `src/routes/messaging.ts` | 522L | 7 | upload/file-open/voice/telegram/channel/discord send + 온보딩 크리덴셜 검증 |
| `src/routes/employees.ts` | 123L | 5 | employee CRUD + reset |
| `src/routes/skills.ts` | 90L | 5 | skills list/read/enable/disable/reset |
| `src/routes/avatar.ts` | 147L | 4 | avatar summary + agent/user image upload/delete/read |
| `src/routes/traces.ts` | 167L | 3 | public trace summary/event read routes |
| `src/routes/runtime-requests.ts` | 35L | 2 | exact-bound ephemeral native decisions; existing instance auth |
| `src/routes/runtime-request-notices.ts` | 22L | — | captured chat to presentation-scope SSE notice mapping |
| `src/routes/link-preview.ts` | 300L | 2 | Rich link preview metadata fetch + guarded image proxy |
| `src/routes/heartbeat.ts` | 305L | 4 | heartbeat GET + validated PUT + mention-watch hold read/fresh-start |
| `src/routes/jaw-ceo.ts` | 321L | 20 | Jaw CEO coordinator: state/message/query/docs-edit/settings/events/pending/watch/audit/voice/confirmations |
| `src/routes/runtime-context.ts` | 46L | 4 | runtime context entry CRUD (ephemeral prompt injection), mounted at `/api/runtime-context` |
| `src/routes/security-audit.ts` | 18L | 2 | security audit log entries + verify, mounted at `/api/security-audit` |
| `src/routes/i18n.ts` | 35L | 2 | language list + locale bundle |
| `src/routes/quota.ts` | 634L | — | `settings.ts`가 호출하는 quota/auth/status reader helper |
| `src/routes/quota-kiro-reverse.ts` | 201L | — | Kiro/CodeWhisperer reverse-engineered usage-limits reader (`fetchKiroUsage`) |
| `src/routes/quota-agy-reverse.ts` | 233L | — | Antigravity quota snapshot reader (`fetchAgyUsage`) |
| `src/routes/quota-cursor-dashboard.ts` | 334L | — | Cursor dashboard session/usage reader (`fetchCursorUsage`) |
| `src/routes/types.ts` | 3L | — | shared `AuthMiddleware` type |

### Dashboard Board/Schedule (P3, mounted in server.ts)

| Module | Routes | 역할 |
| --- | ---: | --- |
| `src/manager/board/routes.ts` | 99L / 5 | board tasks CRUD + from-message |
| `src/manager/schedule/routes.ts` | 112L / 5 | scheduled work CRUD + dispatch |

### 등록 순서 (`server.ts`)

```text
static → employees → heartbeat → skills → jaw-memory → orchestrate
→ goal → task → events(SSE) → instance → chat-sessions → messages
→ system → agent-control → command → goal-run → memory → settings
→ messaging → avatar → traces → link-preview → jaw-ceo → runtime-context
→ security-audit → dashboard board/schedule → browser → code → runtime-requests → i18n
```

라우트 모듈은 `server.ts:298-396` 부근에서 등록된다.

---

## Native Runtime Decisions

Manager's explicit [isolated QA launch profile](infra.md#isolated-desktop-qa)
changes no endpoint shape. It rejects foreign stored/custom/single scan ranges
before reads, suppresses peer discovery, and rejects both HTTP and direct
Manager lifecycle actions. Normal instances retain their existing behavior;
this controlled profile is not authorization to use arbitrary worker/service APIs.

| Method | Path | Contract |
| --- | --- | --- |
| `GET` | `/api/runtime/requests?sessionId=<jaw-id>` | Explicit nonempty session ID, at most240 characters. Returns `{ok:true,data:{requests:[...]}}`; never substitutes the active session. |
| `POST` | `/api/runtime/requests/:id` | Body contains only `runId`, `sessionId`, `scope`, `turnId`, `response`. Exact stored binding and current ownership required. Returns `{ok:true,data:{accepted:true}}`. |

The live list is session-scoped and may contain multiple execution scopes. A
presentation hint never replaces those IDs: the Classic/Manager chat panel POSTs
the selected live entry unchanged. Registry insertion/removal triggers the
route-owned SSE-only `agent_runtime_requests_changed` metadata hint, mapped to the
captured chat's display scope without active-chat fallback. It bypasses messaging
listeners and does not contain tool input, answers or native provider IDs.

`GET /api/orchestrate/snapshot?session=<id>` adds server-owned `activityIdentity`
and `Cache-Control: no-store`. Malformed supplied session values return400;
unknown named sessions return404 when multi-session is enabled. With that feature
disabled, existing active/default snapshot behavior remains. Snapshot identity
does not grant response authority or replace a pending entry's execution binding.

Both routes use the same existing requireAuth and global Host/Origin guards as the worker. Loopback and configured LAN bypass remain unchanged; these routes do not introduce per-session user ACLs. Missing/malformed input or an invalid choice returns400; missing, expired, stale, already answered or mismatched requests return409 `request_not_current`. A bad choice does not consume a current request. No top-level requests alias exists.

Each listed request has the four binding fields, `requestId`, `requestType`, `view`, and `expiresAt`. Views contain canonical sanitized labels and opaque jaw field/option handles. For ACP permissions, send `response:{optionId:<displayed-handle>}` or `{optionId:null}` to cancel, never a provider-native ID. Raw provider mappings and callbacks are private. Limits are128 pending requests globally,120-second expiry and32 per ACP connection; view admission must fit the32KiB event record. Accepted records a decision, not a provider tool result, and concurrent cancellation can still win before dispatch.

Cursor/Grok activation and Activity controls are separate from this API foundation. Unsupported client-side filesystem, terminal and unproven question extensions are refused; messaging final/ACK/queue paths are unchanged.

## Base Route Surface (`server.ts`)

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/` | `public/dist/index.html`이 있으면 Vite build를 서빙, 없으면 static fallback |
| `GET` | `/api/health` | **liveness.** `{ ok, version, uptime, channels, agentRuntime }`. `ok`는 상수다 — Docker HEALTHCHECK가 컨테이너를 재시작하고 manager scan이 인스턴스를 목록에서 제거하는 신호이므로 CLI 미해석을 여기서 표현하지 않는다. 에이전트 런타임 준비 상태는 가산 필드 `agentRuntime: { cli, ready, state, path?, error?, checkedAt }`로만 노출한다 (#471). `channels.slackScopes.ok`는 관측된 필수 스코프 gap이 있을 때만 false다. 미관측은 `ok: true, unknown: true`를 유지하고, `missingCapabilities`(`mpim:history` 포함)는 `ok`를 실패시키지 않는다 (#758). `channels.ingress.processing`은 현재 in-flight admit만 센다. `oldestOpenReceivedAt`은 `received`/`processing`의 최솟값이며 `completed`와 `dead_letter`는 빼다. 부팅 때 오래된 `processing`은 age-only로 `dead_letter`(`abandoned_stale_processing`)가 된다 (#760) |

`channels.slack.reason: "token_shared_other_home"`은 다른 cli-jaw home이 같은 app-level token의 fresh connected lease를 소유해 이 instance의 Slack inbound가 꺼졌음을 뜻한다. 이때 `activeInbound:false`지만 bot-token outbound의 `sendCapable` 판정은 그대로 유지한다. claim 파일, canonical home, freshness, live PID 중 하나라도 확정할 수 없으면 reason을 만들지 않고 fail-open하며, `CLI_JAW_SLACK_ALLOW_SHARED_TOKEN=1`은 inspection과 acquisition을 모두 생략한다. API에는 owner token, token hash, claim path를 노출하지 않는다.
| `GET` | `/api/ready` | **readiness.** 설정된 CLI가 spawn 가능한지 답한다. `state:"unavailable"`일 때만 **503**, 그 외 200. `unknown`(CLI 미설정 또는 probe 예외)은 503이 아니다 — 신규 설치와 probe 버그가 무의미한 재시작을 유발하면 안 된다. 워치독은 본문 파싱 없이 상태 코드만 소비할 수 있다 (#471) |
| `GET` | `/api/slack/manifest` | 설정 페이지 "매니페스트 복사"용 canonical Slack 앱 매니페스트. 선택 `?name=`은 1~35자 앱 표시명을 받고 봇 표시명은 자동 파생한다. `{ ok, data: { yaml, json, botDisplayName } }` (비밀값 없음, unauthenticated) |
| `POST` | `/api/channels/validate` | 온보딩 마법사 라이브 크리덴셜 검증 `{ channel, botToken, appToken?, guildId? }` → `{ ok, identity?, teamId?, missingCapabilities? }` 또는 `{ ok:false, error, missing? }`. `mpim:history` 누락은 group-DM 수신/기록의 선택 기능 gap이며 기존 IM/channel 검증을 실패시키지 않는다. 저장하지 않고 검증만 수행 |
| `GET` | `/api/session` | 현재 main session row 반환 |
| `GET` | `/api/messages` | `includeTrace=1|true|yes`면 trace 포함 메시지 조회. `?limit=N`(1–5000)이면 최근 N개만 ascending 반환; 생략 시 전체 history |
| `GET` | `/api/messages/search` | 메시지 본문 검색 결과 반환. `?q=`, `?days=N`(1-365), `?recent=N`(1-5000), `?context=N`(0-5), `?limit=N`(1-50) |
| `GET` | `/api/messages/latest` | 가장 최근 메시지 스냅샷 반환 |
| `GET` | `/api/runtime` | uptime, activeAgent, queuePending |
| `GET` | `/api/auth/token` | same-origin/CLI용 Bearer token bootstrap |
| `POST` | `/api/command` | slash command 실행 |
| `GET` | `/api/commands` | 인터페이스별 command palette 데이터 |
| `POST` | `/api/message` | 일반 프롬프트 제출. Optional `target: RemoteTarget` when Dashboard hub forwards a forum topic message (`origin:'telegram'`). Shape validated by `isValidHubTarget` + `validateTarget`. Optional `external: true` — manager/preview relay 등 외부 주입 표시; `new_message` broadcast에 실려 web UI가 유저 말풍선을 라이브 렌더. |
| `POST` | `/api/elicitation/callback` | Telegram Hub inline-keyboard `elic:*` callback relay. Hub bot forwards the tap to the mapped worker; worker completes `handleElicitationCallback()` and re-submits the combined answer via `submitMessage()` when all answers are collected. |
| `POST` | `/api/stop` | 현재 실행 중 agent 모두 종료 |
| `POST` | `/api/clear` | UI-only clear broadcast, DB 메시지는 유지 |
| `POST` | `/api/session/reset` | 메시지 삭제 + session reset |
| `GET` | `/media/:filename` | 미디어 파일 서빙 |
| `GET` | `/api/image?path=<absolute path>` | `requireAuth` + `assertSendFilePath()` realpath guard로 JAW_HOME/workingDir/projectDirs 아래 이미지·비디오를 서빙. PNG/JPEG/GIF/WebP/MP4/WebM/MOV/OGG만 허용하고 SVG는 제외한다. 잘못된 입력·확장자는 `400`, 허용 루트 밖은 `403`, 미해결 경로·디렉터리는 `404`; 성공 응답은 `no-store` + `nosniff`. |
| `GET` | `/api/instance/lock` | 인스턴스 잠금 상태 조회 |
| `POST` | `/api/instance/lock` | 인스턴스 잠금 (stopAll 보호) |
| `DELETE` | `/api/instance/lock` | 인스턴스 잠금 해제 |
| `GET` | `/api/chat-sessions` | 채팅 세션 목록. `data.capabilities.createInactive: true` advertises inactive creation. |
| `POST` | `/api/chat-sessions` | 새 채팅 세션 생성. Optional `activate: boolean` defaults to `true`; `false` preserves the active session and emits no switch event, returning `data: { id, seq, activated: false }`. Default/`true` retains `{ id, seq }`. Invalid flag types return `400 invalid_activate` before mutation. |
| `POST` | `/api/chat-sessions/:id/switch` | 활성 세션 전환 |
| `DELETE` | `/api/chat-sessions/:id` | 세션 삭제 — `'default'` 400, 진행 중/원격 바인딩 409, 성공 시 메시지 동시 삭제 (071) |
| `GET` | `/api/search` | 통합 검색 — `corpus=chat\|memory\|wiki\|all`, 세션 횡단 기본 + `sessionFilter`, cursor 페이지네이션 (031) |
| `GET` | `/api/wiki/status` | 위키 상태 — enabled/root/promptDigest/provider. 기본 OFF, 디스크를 만들지 않는다 (040) |
| `POST` | `/api/wiki/enable` | 위키 활성화 — scaffold 후 provider ready 확인이 끝나야 설정을 기록한다 (040) |
| `GET` | `/api/wiki/entities` | 위키 entity 인덱스 (읽기 전용) — disabled면 디스크를 만지지 않고, root가 옮겨졌으면 부분 결과 대신 error다 (041) |
| `POST` | `/api/wiki/configure` | 위키 설정 변경 — 비활성화는 vault와 Git history를 보존한다 (040) |

---

## REST API

| Category | Endpoints |
| --- | --- |
| Core/Auth | `GET /api/health` `GET /api/ready` `GET /api/slack/manifest` `GET /api/session` `GET /api/messages` `GET /api/messages/count` `GET /api/messages/search` `GET /api/messages/latest` `GET /api/messages/by-trace/:runId` `GET /api/runtime` `GET /api/auth/token` `GET /media/:filename` `GET /api/image` `GET /api/widgets/:chatId/:widgetId` `POST /api/message` `POST /api/stop` `POST /api/clear` `POST /api/session/reset` |
| Commands | `POST /api/command` `GET /api/commands?interface=` `POST /api/elicitation/callback` |
| Events | `GET /api/events` |
| Chat Sessions | `GET /api/chat-sessions` `POST /api/chat-sessions` `POST /api/chat-sessions/:id/switch` `DELETE /api/chat-sessions/:id` |
| Instance Lock | `GET /api/instance/lock` `POST /api/instance/lock` `DELETE /api/instance/lock` |
| Search | `GET /api/search` |
| Settings/Prompt | `GET/PUT /api/settings` `POST /api/settings/slack/reset` `POST /api/settings/runtime-default-migration` `POST /api/settings/multi-session-default-migration` `POST /api/project/pick` `GET /api/project/git-summary` `GET/PUT /api/prompt` `GET /api/prompt-templates` `PUT /api/prompt-templates/:id` `GET/PUT /api/heartbeat-md` |
| MCP/CLI/Quota | `GET/PUT /api/mcp` `POST /api/mcp/sync` `POST /api/mcp/install` `POST /api/mcp/reset` `GET /api/mcp/registry` `GET /api/cli-registry` `GET /api/cli-status` `GET /api/quota` `POST /api/copilot/refresh` `POST /api/pi/profiles/register` `GET /api/pi/models` |
| Runtime Context | `GET /api/runtime-context` `POST /api/runtime-context` `DELETE /api/runtime-context/:id` `DELETE /api/runtime-context` |
| Native Runtime Decisions | `GET /api/runtime/requests` `POST /api/runtime/requests/:id` |
| Security Audit | `GET /api/security-audit/entries` `GET /api/security-audit/verify` |
| Heartbeat | `GET/PUT /api/heartbeat` `GET /api/heartbeat/:jobId/mention-watch-hold` `POST /api/heartbeat/:jobId/mention-watch-fresh-start` |
| Browser | `POST /api/browser/start` `POST /api/browser/stop` `GET /api/browser/status` `GET /api/browser/doctor` `POST /api/browser/cleanup-runtimes` `GET /api/browser/snapshot` `POST /api/browser/screenshot` `POST /api/browser/act` `POST /api/browser/vision-click` `POST /api/browser/navigate` `POST /api/browser/reload` `POST /api/browser/resize` `GET /api/browser/tabs` `GET /api/browser/active-tab` `POST /api/browser/tab-switch` `POST /api/browser/tab-new` `POST /api/browser/tab-close` `POST /api/browser/tab-cleanup` `POST /api/browser/evaluate` `GET /api/browser/text` `GET /api/browser/dom` `GET /api/browser/console` `GET /api/browser/network` `POST /api/browser/fetch` `POST /api/browser/wait-for-selector` `POST /api/browser/wait-for-text` `POST /api/browser/web-ai/render` `POST /api/browser/web-ai/context-dry-run` `POST /api/browser/web-ai/context-render` `GET /api/browser/web-ai/status` `POST /api/browser/web-ai/send` `GET /api/browser/web-ai/poll` `GET /api/browser/web-ai/watch` `GET /api/browser/web-ai/watchers` `GET /api/browser/web-ai/sessions` `POST /api/browser/web-ai/sessions/prune` `GET /api/browser/web-ai/notifications` `GET /api/browser/web-ai/capabilities` `POST /api/browser/web-ai/query` `POST /api/browser/web-ai/code` `POST /api/browser/web-ai/code-extract` `POST /api/browser/web-ai/stop` `GET /api/browser/web-ai/diagnose` |
| Code Mode | `GET /api/code/models` `GET /api/code/sessions` `GET /api/code/sessions/:id` `GET /api/code/sessions/:id/events` `GET /api/code/sessions/:id/items` `POST /api/code/sessions` `PATCH /api/code/sessions/:id` `POST /api/code/sessions/:id/prompt` `POST /api/code/sessions/:id/cancel` `POST /api/code/sessions/:id/attach` `POST /api/code/permissions/:id` `GET /api/code/git-info` `POST /api/code/workspace/pick` |
| Orchestrate | `POST /api/orchestrate/reset` `GET /api/orchestrate/state` `GET /api/orchestrate/workers` `GET /api/orchestrate/worker-progress` `GET /api/orchestrate/worker-progress/:agentId` (also accepts a current/recent `runId`) `GET /api/orchestrate/worker-runs` `GET /api/orchestrate/worker-runs/:runId` `GET /api/orchestrate/worker-runs/:runId/events` `GET /api/orchestrate/worker-runs/:runId/output` `GET /api/orchestrate/snapshot` `DELETE /api/orchestrate/queue/:id` `POST /api/orchestrate/queue/:id/hold` `DELETE /api/orchestrate/queue/:id/hold` `POST /api/orchestrate/queue/:id/steer` `GET /api/orchestrate/access` `POST /api/orchestrate/dispatch/pending` `GET /api/orchestrate/dispatch/pending/:jti` `POST /api/orchestrate/dispatch` `POST /api/orchestrate/dispatch/batch` `GET /api/orchestrate/worker/:agentId/result` (also accepts a current `runId`) `PUT /api/orchestrate/state` |
| Background Tasks | `GET/POST /api/bgtask` `GET/DELETE /api/bgtask/:id` |
| Goal | `GET /api/goal` `GET /api/goal/history` `POST /api/goal` |
| Goal Run | `GET /api/goal-run` `GET /api/goal-run/preflight` `POST /api/goal-run` |
| Task | `GET /api/task` `POST /api/task` |
| Employees | `GET /api/employees` `POST /api/employees` `PUT /api/employees/:id` `DELETE /api/employees/:id` `POST /api/employees/reset` `POST /api/employees/sessions/reset` |
| Skills | `GET /api/skills` `GET /api/skills/:id` `POST /api/skills/enable` `POST /api/skills/disable` `POST /api/skills/reset` |
| Memory Runtime / KV / Files | `GET /api/memory/status` `POST /api/memory/reindex` `POST /api/memory/bootstrap` `GET /api/memory/files` `GET /api/memory` `POST /api/memory` `DELETE /api/memory/:key` `GET /api/memory-files` `GET /api/memory-file` `GET /api/memory-files/:filename` `DELETE /api/memory-file` `DELETE /api/memory-files/:filename` `PUT /api/memory-files/settings` |
| Jaw Memory | `GET /api/jaw-memory/search` `GET /api/jaw-memory/read` `POST /api/jaw-memory/save` `GET /api/jaw-memory/context` `GET /api/jaw-memory/list` `POST /api/jaw-memory/init` `POST /api/jaw-memory/reflect` `POST /api/jaw-memory/flush` `GET /api/jaw-memory/soul` `POST /api/jaw-memory/soul/activate` `POST /api/jaw-memory/soul` `POST /api/soul/bootstrap` |
| Jaw CEO | `GET /api/jaw-ceo/state` `POST /api/jaw-ceo/message` `POST /api/jaw-ceo/query` `POST /api/jaw-ceo/docs/edit` `GET /api/jaw-ceo/settings` `PUT /api/jaw-ceo/settings` `POST /api/jaw-ceo/events/ingest` `POST /api/jaw-ceo/events/refresh` `GET /api/jaw-ceo/pending` `POST /api/jaw-ceo/pending/:completionKey/continue` `POST /api/jaw-ceo/pending/:completionKey/summarize` `POST /api/jaw-ceo/pending/:completionKey/ack` `POST /api/jaw-ceo/pending/:completionKey/dismiss` `POST /api/jaw-ceo/watch` `GET /api/jaw-ceo/audit` `POST /api/jaw-ceo/voice/connect` `POST /api/jaw-ceo/voice/:sessionId/close` `POST /api/jaw-ceo/confirmations` `POST /api/jaw-ceo/confirmations/:confirmationId/confirm` `POST /api/jaw-ceo/confirmations/:confirmationId/cancel` |
| Messaging | `POST /api/upload` `POST /api/file/open` `POST /api/voice` `POST /api/telegram/send` `POST /api/channels/validate` `POST /api/channel/send` `POST /api/discord/send` `POST /api/slack/send` `GET /api/slack/history` `GET /api/slack/members` `GET /api/slack/users` `GET /api/slack/tools/capabilities` `POST /api/slack/tools` |
| Wiki | `GET /api/wiki/status` `GET /api/wiki/entities` `POST /api/wiki/enable` `POST /api/wiki/configure` |
| Avatar | `GET /api/avatar` `POST /api/avatar/:target/upload` `DELETE /api/avatar/:target/image` `GET /api/avatar/:target/image` |
| Traces | `GET /api/traces/activity-runs?session=<id>` `GET /api/traces/:runId/activity?session=<id>` `GET /api/traces/:runId` `GET /api/traces/:runId/events` `GET /api/traces/:runId/events/:seq` |

All trace routes set `Cache-Control: no-store` before auth/parsing. Activity discovery accepts explicit `session` and optional lexical run-ID `after` (40 runs/page). Replay accepts explicit `session`, decimal `after`/optional fixed `through`, and `limit`1–40; pages are also capped at256KiB. Responses retain `{ok,data}` and include sparse cursor/high-water, status, events and explicit loss/incomplete metadata. Malformed queries return400, wrong/internal/deleted owners404, future or reversed cursors409, storage failures503. Existing instance auth still applies. Owned raw summary/list/detail routes also require the original `session`; only truly ownerless legacy rows retain old access. Session-only historical backfills can use raw diagnostics but cannot invent a canonical scope. Replay is read-only and cannot submit historical decisions.
| Debug | `GET /api/debug/mem` |
| Link Preview | `GET /api/link-preview?url=` `GET /api/link-preview/image?url=` |
| Dashboard Board | `GET /api/dashboard/board/tasks` `POST /api/dashboard/board/tasks` `PATCH /api/dashboard/board/tasks/:id` `DELETE /api/dashboard/board/tasks/:id` `POST /api/dashboard/board/tasks/from-message` |
| Dashboard Schedule | `GET /api/dashboard/schedule/work` `POST /api/dashboard/schedule/work` `PATCH /api/dashboard/schedule/work/:id` `DELETE /api/dashboard/schedule/work/:id` `POST /api/dashboard/schedule/work/:id/dispatch` |
| i18n | `GET /api/i18n/languages` `GET /api/i18n/:lang` |

> AST 추출기가 현재 인식하는 범위는 총 244개 route handler다. 이 추출 범위의 API 엔드포인트는 243개이고 `/` 엔트리는 1개다. 전체 API 총수는 아니다. `registerNativeCodeRoutes()` 내부의 `router.*`와 `app.use(prefix, router)` 연결은 아직 집계하지 못한다. 별도로 동작하는 native Code 핸들러 11개는 아래 [Native Code API](#native-code-api) 표에 명시하며, 이전 경로의 410 응답 핸들러도 추출 집계에서 빠져 있다. Browser API 43개는 `src/routes/browser.ts`, Jaw CEO 20개는 `src/routes/jaw-ceo.ts`에서 등록된다.

`PUT /api/heartbeat`의 job은 `mentionWatch: { channel: "slack", userId: "U...", channelIds: ["C..."], maxHits?, since?, userIds?, conditions? }`를 선택적으로 받는다. `userIds`와 `conditions`는 생략하거나 빈 배열이면 오늘과 같이 `userId` 멘션만 본다. `conditions`의 `match`는 `mention` 또는 `talk`(말한 사람이 subject일 때만)이고 inbound `mentionOnly`와는 다른 게이트다. `channelIds`는 비어 있지 않아야 하고 저장 시 `slack.channelIds` allowlist의 부분집합이어야 하며, 실행 tick 직전 현재 allowlist와 다시 교집합한다. job id가 같은 기존 값에 대해 필드가 없으면 상속하고, `null`이면 삭제하며, 잘못된 값은 `400 invalid heartbeat mention watch`다. 파일 로드 정규화에서 잘못된 `mentionWatch`는 해당 job을 `enabled: false`로 내린다. 기본 운영값은 비활성이고, 설정된 watch는 별도 daemon이 아니라 기존 `runHeartbeatJob`에서 실행된다.

일반 heartbeat job의 `destination`은 Slack에서 `{ channel:"slack", targetId, threadId }` 또는 명시적 채널 루트 `{ channel:"slack", targetId, scope:"channel_root" }`다. 없거나 불완전하면 `GET /api/heartbeat`가 `held: unbound_destination|incomplete_destination|malformed_destination`을 보이고 tick은 전송하지 않는다. threaded job은 runner 시작 전에 `conversations.replies`로 부모 ts가 해당 채널에 실제 존재하는지 읽는다. stale, 채널 불일치, 권한/429/인증/전송 실패는 각각 `stale_thread|thread_channel_mismatch|live_lookup_failed`로 그 tick을 fail-closed한다. live reason은 다음 성공 tick까지 GET/UI에 남되 enabled timer는 복구 확인을 위해 유지되고, destination을 편집하면 즉시 무효화된다. 성공 결과를 캐시하지 않고 어떤 오류도 tick 안에서 재시도하지 않는다. 바인딩이 `bound`이면 scheduled send는 `fullAccess: true`와 `allowActiveFallback: false`로 그 목적지에만 보낸다 — 권한은 operator가 쓴 `heartbeat.json` destination이지 last-active/allowlist voucher가 아니고, `/api/channel/send` HTTP JSON이 `fullAccess`를 배울 수 있는 경로가 아니다. mention-watch 서버 전송은 hit thread 허용목록 교집합만 쓰며 `fullAccess`를 복사하지 않는다. mention-watch는 방금 찾은 hit thread가 목적지라 이 검사 대상이 아니다.

모든 Slack heartbeat runner는 같은 target에 25분짜리 `enforceDestination` grant를 예약한다(collector 상한 20분보다 길다). `spawnAgent`가 runtime 분기 전에 활성화하고 print/employee child, request-lifetime Cursor/Grok, fresh Codex App/Claude/Pi acquisition에 header를 주입한다. script도 명시적 child env로 같은 header를 받는다. 그래서 Auto/full-local에서도 target 생략은 저장 목적지로 고정되고 다른 target은 `slack_destination_mismatch`다. 일반 interactive Auto grant는 이 flag가 없고, heartbeat가 도는 동안에도 unrelated Auto send를 process-global로 잠그지 않는다.

같은 job id를 한 요청에 두 번 보내면 `400 duplicate heartbeat job id`다. id는 ledger namespace의 일부라서, 두 job이 한 id를 쓰면 뒤쪽이 앞쪽의 cursor를 물려받아 그 아래 구간을 통째로 건너뛴다.

`since`는 bootstrap 전용 floor다. 이미 cursor가 있는 watch에서는 cursor가 이기므로, `since`만 바꿔서 과거를 다시 읽게 만들 수는 없다.

`GET /api/heartbeat/:jobId/mention-watch-hold` → `{ jobId, held, state }`. v1 ledger가 남은 job은 `heartbeat.json`의 `enabled`와 무관하게 스케줄에서 보류(hold)된다. v1 행에는 workspace/user가 없어서 v2 키로 옮기려면 소유자를 추측해야 하고, 그 추측이 곧 v2가 막으려는 오배정이기 때문이다.

`GET /api/heartbeat`의 각 job은 마지막 **승인된** 틱의 결과를 `lastRun`으로 함께 싣는다: `{ jobId, startedAt, finishedAt, execution: "ok"|"error"|"skipped", delivery: "delivered"|"not_delivered"|"suppressed"|"not_requested", reason?, superseded, consecutiveFailures, consecutiveSkips }`. `held`와 같은 의미의 additive 필드라 모르는 클라이언트는 그대로 동작한다. 실행 상태와 전달 상태를 분리하는 이유는 전송 실패가 작업 실패가 아니기 때문이고, 그래서 전송 실패는 `execution: "ok"`로 남으며 실패 streak를 올리지 않는다. 거부(skipped)는 자체 카운터를 갖는다 — 매 틱 거부하는 job이 streak 0에 머물러 영원히 보이지 않는 것이 이 기록이 없애려는 상태다. 어느 카운터든 임계값에 닿으면 `getHeartbeatRuntimeState().failing`에 나타나지만 타이머는 유지된다. 기록은 프로세스 로컬이므로 재시작 이후 한 번도 틱하지 않은 job에는 `lastRun`이 **없다** — 낡은 값 대신 부재가 정직한 답이다.

`POST /api/heartbeat/:jobId/mention-watch-fresh-start` `{ since }` → 보류 해제. 빈 `since`는 `400`이다(floor 없는 watch는 도달 가능한 history를 거꾸로 훑어 이미 답한 것을 다시 답한다). workspace 검증(`auth.test`)이 유일한 await이고 그 뒤는 전부 동기다 — 검증 전에 hold와 파일을 snapshot한 뒤 await하면, 패배한 승인이 낡은 파일 사본으로 재개해 승자의 floor를 덮어쓴다(DB는 그 뒤에야 conflict를 알려 주므로 파일 손상은 이미 끝나 있다). 순서는 파일 저장(temp+rename) → 단일 트랜잭션(`pending`→`resolved` CAS → v1 archive → delete) → `startHeartbeat()`이며 교환 불가다. 사이에서 죽으면 새 floor만 저장되고 보류는 남으므로 재시도로 복구된다. 반대 순서는 옛 floor가 살아 있는 채로 보류를 풀어 backlog를 replay한다. 같은 `since`로 재시도하면 `already-resolved`, 다른 `since`면 `409`, 보류 이력이 없으면 `404`다. 일반 `PUT`의 `enabled: true`는 승인으로 읽지 않는다 — 모든 UI가 `mentionWatch`를 생략해 보내므로, 저장 클릭을 동의로 해석하면 무관한 편집이 보류를 풀어 버린다.

`POST /api/channel/send`에서 `channel`은 `telegram|discord|slack|active` transport다. 대화 ID는 `chat_id` 또는 `target.targetId`에 넣는다. Slack thread를 명시할 때 `target.threadId`는 reply ts가 아닌 parent message ts다. request-scoped turn grant가 있으면 target 생략은 그 grant의 대화와 thread로 고정된다. full-local은 명시적 주소가 필요하며, server-owned `enforceDestination` grant만 생략 주소를 공급한다. 빈 `slack.channelIds`는 임의 explicit channel을 열지 않으며, `lastActive/latestSeen`은 같은 대화에 보낼 수 있는지 확인하는 근거일 뿐 명시 주소의 thread를 바꾸지 않는다.
새 채널 공지의 최상위 메시지는 `target.threadId: ""` 또는 threadId 없는 명시 target으로 보낸다. 게시된 루트의 주소를 확인한 뒤 답글의 부모 ts로 사용한다.


Slack text sends preserve Markdown and explicit Block Kit `blocks`, splitting multiple tables into separate messages. `ok:true` means every chunk was posted, independently of rendering verification. Inspect `delivery.verification` (`verified`, `failed`, or `unavailable`) and `delivery.messages` for each posted chunk's timestamp, verification error, table-content status, and feature evidence. A persisted mismatch is `failed`; missing permission, unavailable/malformed readback, or a missing timestamp is `unavailable`. Neither stops remaining posts or triggers reposting. Actual validation/POST failures retain `ok:false`; partial receipts include `postedChunks`, `totalChunks`, and `sent:true, retryable:false`. Never blindly resend posted chunks. Every chunk posts before any readback begins, and callers receive an onPosted hook at that point so the ACK reaction and queue notice settle at transport success instead of waiting on verification; a readback hit by its own timeout is reported as slack_readback_timeout, never slack_send_aborted. Persisted markdown blocks, data_table rows, and stored image blocks all count as delivery evidence on readback. `tableContent` compares ordered text, numeric value/display, links and supported styles; ordinary Markdown character references decode once while code and escaped ampersands stay literal. `richContent` and `sourceAccuracy` remain `not_checked`, and readback stays bounded to 1 MiB.



`delivery.messages` contains only successfully posted chunks, with zero-based `index`, optional `ts`, `verification`, optional bounded `error`, `expectedTables`/`verifiedTables`, `tableContent`, and `expectedFeatures`/`verifiedFeatures`. Plain chunks use per-message `verification:not_checked`. Aggregate verification prioritizes a known `failed` comparison over `unavailable`; it is `verified` only when all chunks were posted and every required check passed. `tableContent` is `not_checked` when no tables were requested, `failed` for a known cell/shape mismatch, `unavailable` for incomplete evidence, and `verified` only when all expected tables match. `comparisonVersion:1` identifies the table comparison contract; it is not a source-accuracy guarantee. Successful transport with failed/unavailable verification still records the existing self-delivery claim, so dispatch does not duplicate an agent's API send.



`turn_conversation`은 인바운드 턴 프롬프트가 준 `reply_to=` 값을 그대로 돌려주는 필드다. target을 조립할 수 없을 때 생략하는 대신 이걸 echo 하면 그 턴이 답하는 대화로 배달된다 — 생략은 "가장 최근에 말한 대화"로 풀리고, 동시 턴에서는 그게 다른 대화일 수 있다 (#474). 우선순위는 `target` > `turn_conversation` > `lastActive` > `latestSeen`이며, `turn_conversation`도 동일한 allowlist 검증을 받는다. 잘못된 값은 예외 대신 없는 것으로 처리된다. 스케줄 송신(reminders / web-ai / alerts)은 `preferConfiguredTarget: true`와 `allowActiveFallback: false`를 함께 쓴다. 설정된 allowlist/home이 없으면 last-active로 보내지 않고 `No target available`로 끝난다.

---

## Security / Guards

### 네트워크 가드

- 기본 서버 bind는 `127.0.0.1`이지만 `settings.network.bindHost`, `JAW_LAN_MODE=1`, reverse-proxy mode에 따라 `0.0.0.0` bind가 가능하다.
- `ALLOWED_HOSTS`/`ALLOWED_ORIGINS`는 loopback을 기본 허용하고, LAN mode/bypass가 켜졌을 때 private network origin/host를 허용한다.
- Legacy/client fallback WebSocket paths and manager-side note WebSocket surfaces must apply the same host/origin guard model; the current core public event path is SSE.

### 인증

- mutation route는 모두 `requireAuth`로 보호된다.
- 다만 로컬 동일 머신 사용성을 위해 loopback 요청은 Bearer 없이 허용된다. LAN bypass가 켜진 private IP 요청도 토큰 없이 통과할 수 있으므로 trusted network 전용이다.
- `/api/auth/token`은 cross-origin token theft 방지를 위해 `Sec-Fetch-Site`를 검사한다.

### 경로/파일 보안

| Surface | Guard |
| --- | --- |
| Jaw Memory | `assertMemoryRelPath()` + `normalizeAdvancedReadPath()` |
| Memory files | `assertMemoryRelPath()` / `assertFilename()` / `safeResolveUnder()` |
| Skills | `assertSkillId()` |
| Upload / avatar | `decodeFilenameSafe()` |
| Telegram / channel send | `assertSendFilePath()` |
| Local inline media (`GET /api/image`) | `assertSendFilePath()` canonical realpath boundary + explicit media-extension allowlist (SVG 제외) |
| Avatar image serve | `safeResolveUnder(UPLOADS_DIR, basename(...))` |

- `/api/image`는 `path`가 단일 절대경로인지 먼저 검사한 뒤 guard를 실행한다. 존재하지 않아 canonicalize할 수 없는 경로는 `404`, JAW_HOME/workingDir/projectDirs 밖 또는 symlink 탈출은 `403`이며, guard 통과 뒤에도 allowlist와 regular-file 검사를 거친다.

### 기타

- Rate limit: in-memory, IP 기준 `120 req/min`.
- `helmet()` 사용, CSP/COEP는 현재 비활성.

---

## Selected Route Notes

### `/api/command`

- body `text`를 `WEB_COMMAND_TEXT_LIMIT`(30,000자)까지 자른 뒤 `parseCommand()`로 해석한다.
- locale은 body/query/Accept-Language/settings 순으로 정해지고 `Content-Language`가 세팅된다.
- command가 아니면 `400 { code: 'not_command' }`.

### `/api/elicitation/callback`

- Dashboard Telegram Hub의 `bot.callbackQuery(/^elic:/)`가 mapped instance로 `POST /api/elicitation/callback`을 호출한다.
- body `{ chatId, callbackData, target? }`를 받아 `handleElicitationCallback(chatId, callbackData)`로 pending single-select 답변을 갱신한다.
- 모든 질문이 완료되면 combined answer를 `submitMessage(..., { origin:'telegram', target, chatId, replyViaTarget })`로 다시 주입하고 `{ ok:true, kind:'complete', ack, submit }`을 반환한다.

### `/api/goal` — action-based POST

- `GET /api/goal` returns `{ ok, goal, pauseGate }`; `pauseGate` is derived from `active + agentPauseCount >= 1` and stays present with `armed:false` when no goal is active.
- `POST /api/goal` body `{ action }` 분기: `set`, `refine-objective`, `update`, `done`, `cancel`, `pause`, `resume`, `clear`, `reset`.
- `set` may receive `goalMode: "plan"` and `planHint`; plan-mode stores a pending objective and rejects normal checkpoint updates until `refine-objective` replaces it with a concrete objective.
- `done` action은 `goalHasCompletionEvidence()` gate를 거치며, evidence 없으면 `409`를 반환한다. `force:true`로 override 가능.
- agent `pause` 첫 번째 audited 시도는 `409`와 `pauseGate:{ armed:true, reason:"pause_gate_pending" }`를 반환한다. 두 번째 audited 시도는 goal을 `paused`로 전환하고, productive `update`는 pending gate를 해제한다.
- `resume` action은 이미 active이면 `{ alreadyActive:true }`를 반환하고, paused goal을 resume하면 `kickGoalContinuation()`을 즉시 트리거한다.

### `/api/orchestrate/access`

`GET` uses ordinary instance authentication and returns the captured permissions,
full-local qualification and `dispatch.path` (`direct`, `boss`, or `approval`).
It grants nothing by itself; dispatch POSTs recheck. Qualification is computed
once per request. No credentials are returned.

### `/api/orchestrate/dispatch/pending`

- `POST`는 일반 `requireAuth` 클라이언트가 action-scoped dispatch를 제출하는 전용 경로다. 응답은 `202 { jti, digest, expiresAt }`이며 bearer나 boss token을 반환하지 않는다.
- 서버는 설정된 `dispatchApproval.operators`의 Slack/Telegram/Discord 운영자 DM에 target, project root, task digest, mutable scope, fan-out cap, server-instance audience, JTI, digest, expiry를 보낸다. allowlist가 비거나 설정된 운영자 전달 중 하나라도 실패하면 pending을 취소하고 fail-closed 한다.
- 승인은 HTTP로 받지 않는다. 검증된 Socket Mode/polling/gateway 이벤트에서 운영자가 `approve <jti> <digest>`를 보내야 한다. pending은 기본 120초, 최대 300초, 부팅 세대별, 원자적 single-use다. settings API는 300초 초과를 거부하고 store 경계도 300초로 clamp한다.
- `GET /api/orchestrate/dispatch/pending/:jti`는 CLI polling용 상태/결과 조회이며 승인 기능은 없다.

### `/api/orchestrate/dispatch`

- Qualified direct-local Auto authority or the existing Boss credential permits dispatch. Known worker calls require a complete, current `scopeKey` / `chatSessionId` / `requestId` tuple. Explicit stale/invalid tuples fail; they never fall back to an unrelated active context. Without a selected parent or valid legacy Boss context, a local operator gets an independent `local:<chat>` binding even when multi-session is off; creating it does not activate that chat.
- Captured permissions and task constraints follow the assignment into worker metadata and launch options. `mutable:false` and `noDescendants:true` remain effective; full authority is separate from provider Safe and is never inferred from body/metadata. Single and batch validate task scope before worker admission. The Boss token remains excluded from worker environments.
- body는 정확히 하나의 target을 받는다: `{ agent, task }` 또는 `{ virtual, task, role?, cli?, model? }`.
- `virtual` target은 `src/core/employees.ts`의 `security`/`testing` 프리셋 또는 자유 role 문자열로 `SyntheticEmployeeRow`를 만들고, DB employee row로 저장하지 않는다.
- virtual dispatch에서 `cli`/`model`이 생략되면 현재 CLI와 `src/cli/registry.ts`의 registry default model을 사용한다.
- A plan from the validated selected parent or legacy Boss context may be injected as `## Approved Plan`; independent dispatch never borrows the active web plan.
- `wait:false` async dispatch `202`, `worker_busy` `409`, and result polling payloads include both stable `agentId` and per-dispatch `runId`. The `agentId` remains the same-employee concurrency guard; `runId` identifies a specific worker run in memory progress history.
- `GET /api/orchestrate/worker-runs*` exposes durable worker-run safe metadata/events and bounded raw output reads. List/get/events are safe-only and include both native `status` plus shared `statusCategory` (`running|succeeded|failed|cancelled|orphaned`) for comparison with background tasks; `/output` is the only raw-text worker-run route and requires explicit `runId` plus offset/limit. `jaw worker read <runId>` is the CLI consumer of that explicit raw-output route; `worker status/watch` remain safe-summary surfaces.
- `GET/POST /api/bgtask` and `GET/DELETE /api/bgtask/:id` keep the existing background-task schema and add `statusCategory` to public task payloads. `statusCategory` is additive; bgtask storage and worker-run storage remain separate and no bgtask migration is performed.
- `POST /api/orchestrate/dispatch/batch` uses the same full-local-or-Boss admission policy for multiple worker/virtual tasks. 각 entry는 `agent` 또는 `virtual` 중 하나를 가진다. 응답은 full worker text를 기본 포함하지 않고 `{ agent, ok, runId, status, preview, recoveryCommand, outputBytes, error? }` 형태의 safe summary metadata를 반환한다. raw output은 `runId`로 `/api/orchestrate/worker-runs/:runId/output` 또는 `jaw worker read <runId>`에서 명시적으로 읽는다. 구버전 manager가 이 route 없이 HTML 404를 반환하면 `jaw dispatch --batch`는 JSON parse 예외 대신 stale/missing route 진단을 출력한다.

### `/api/jaw-ceo/*`

- `requireAuth` 보호 sub-router로 `/api/jaw-ceo` 아래 마운트.
- Core: state read, message send, query (dashboard/cli_readonly/web/github_read source), docs edit.
- Settings: OpenAI API key management for voice.
- Events: ingest manager events, refresh with port/cursor filter.
- Pending: list/continue/summarize/ack/dismiss completions.
- Watch/Audit: watch completion on port, audit log with kind/port filter.
- Voice: WebRTC connect via OpenAI Realtime API, session close.
- Confirmations: create/confirm/cancel action confirmations.

### `/api/quota`

- All provider reads, including Grok, start concurrently. A thrown provider error becomes that row's generic `quota_fetch_failed` result without suppressing successful peers; wrappers retain their underlying provider outcome.

- OpenCode Go reads canonical `usage.rolling/weekly/monthly` directly from `/zen/go/v1/usage`, retaining legacy window shapes. A successful usage response needs no models preflight; unavailable usage may probe model authentication without treating transient failure as invalid credentials.

- Native Claude/Codex readers normalize upstream windows with `quota-native-window.ts` and bounded JSON from `quota-wire.ts`. Codex honors `CODEX_HOME`, declared short/monthly durations, Spark weekly limits and additive read-only `resetCredits`; missing readings do not create a zero bar. Claude supports Fable and weekly-scoped model limits; its 30-second fresh and 5-minute 429 fallback caches are credential-scoped. A 429 without a measured same-credential snapshot returns an error with no fabricated quota bar.

- 응답 키: `pi`, `agy`, `claude`, `codex`, `codex-app`, `cursor`, `gemini`, `grok`, `opencode`, `copilot`, `kiro-code` (`CLI_KEYS` 순서).
- `pi`는 Settings의 Pi profile registration을 통해 endpoint/model/key를 검증하고, quota 자체는 auth/status-only로 표시한다.
- `agy` reads native IDE-local status plus the selected antigravity-usage account through read-only helpers. Matching account/project quota uses Google summary, then models on transient/unavailable responses; auth rejection and redirects stop. No automatic npm acquisition, OAuth refresh, token write or account switching occurs. Native local availability remains supported, and local/Google account mismatches never trigger remote credential use.
- AGY native local snapshot이 `remainingPercentage`를 정밀 소수점 대신 `0`/`1`로만 반환하면 window는 `precision: "binary"`와 `status: "available" | "exhausted"`를 포함한다. backend의 `percent`는 호환 필드일 뿐이며, UI는 exact percent bar 대신 `Available` / `Exhausted` 상태 텍스트를 표시해야 한다. upstream이 다시 정밀 퍼센트를 주면 기존 fractional path가 그대로 사용된다.
- `cursor` reads its selected native OAuth store (or direct auth token), probes period usage → summary → legacy usage, then retains explicitly configured dashboard-cookie fallback. An API-key override suppresses unrelated stored OAuth reads. Keychain/memory/file selection follows the native CLI; credentials are never returned in quota rows.
- `grok` reads native OIDC key/user identity, then requests JSON `/v1/billing?format=credits` weekly usage. It preserves fractional and omitted-zero readings, with bounded gRPC weekly compatibility and validated monthly fallback. Each failed request is isolated; session usage remains separate.
- `kiro-code` reads a selected native social/OIDC token in a read-only SQLite snapshot and calls `management.<validated-region>.kiro.dev` GetUsageLimits. Profile is optional; malformed optional profile data does not discard a valid token. Allowance selection prefers AGENTIC_REQUEST then CREDIT and keeps free-trial pools separate.

### Wiki lifecycle ownership

- `wiki.enabled` and `wiki.root` are owned by `POST /api/wiki/enable` and `POST /api/wiki/configure`. The enable route scaffolds the vault, verifies provider readiness, and only then persists the lifecycle configuration.
- Generic `PUT /api/settings` rejects either lifecycle field with `409 wiki_configuration_requires_wiki_route`; `wiki.promptDigest` remains writable there. External `settings.json` reloads ignore the two lifecycle fields and emit a warning instead of bypassing the wiki routes.
- At server startup, a persisted enabled vault whose provider is not ready emits `[jaw:wiki] enabled but unavailable at startup (...)` without logging the vault path. Repair it through `POST /api/wiki/enable`, or disable it through `POST /api/wiki/configure`.

### `/api/project/git-summary`

- `GET /api/project/git-summary`는 Settings의 `projectDirs[0]`만 읽는 read-only header helper다.
- `POST /api/settings/runtime-default-migration`은 `requireAuth` 뒤에서 정확히 `{ "action": "accept" | "keep" }`만 받는다. `settingsSchemaVersion`과 `runtimeDefaultMigration`은 server-owned라 generic `PUT /api/settings`에 포함하면 `400`이다. 이미 terminal인 migration은 `409 runtime_default_migration_terminal`과 최신 settings snapshot을 반환한다. 성공 `200`과 conflict `409`의 snapshot은 모두 `GET/PUT /api/settings`와 같은 redaction을 거친다.
- `POST /api/settings/multi-session-default-migration`은 같은 계약을 따르며 다중 세션 기본 ON 전환(schema v3)을 소유한다. `multiSessionDefaultMigration`도 server-owned이므로 generic `PUT`에 포함하면 `400`이고, terminal이면 `409 multi_session_default_migration_terminal`이다. **런타임 migration과 별도 route인 이유**는 두 전환이 서로 다른 시점에 서로 다른 이유로 롤백될 수 있고, v1 문서는 둘이 동시에 pending이기 때문이다 — 한 쪽 응답이 다른 쪽 답으로 읽히면 안 된다. `accept`는 `enabled:true`와, 현재 `maxConcurrent`가 1일 때 `20`을 함께 적용한다(동의 문구가 그 둘을 말한다). 1이 아닌 유효 값은 그대로 둔다.
- Slack 연결 환경변수(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_TEAM_ID`, `SLACK_CHANNEL_IDS`)는 각자 대응하는 설정 필드를 런타임에서 소유한다. `SLACK_BOT_TOKEN`은 `enabled|botToken`, `SLACK_APP_TOKEN`은 `appToken`, `SLACK_TEAM_ID`는 `teamId`, `SLACK_CHANNEL_IDS`는 `channelIds`를 소유한다. `GET /api/settings`는 `slackEnvironmentVariables`에 변수 이름만 싣고 연결값을 redaction한다. generic `PUT`은 요청에 포함된 env-owned path만 `409 slack_connection_managed_by_environment`로 거부하며, 전체 연결을 비우는 `POST /api/settings/slack/reset`은 환경변수가 하나라도 있으면 계속 409다. Settings UI와 CLI setup도 혼합 변경을 보수적으로 막는다. 직렬화는 env-owned 필드만 제거하므로 환경값이 `settings.json`으로 복사되지 않고 metadata-only override가 파일 토큰을 지우지 않는다. 동작 설정(`forwardAll`, `allowBots`, `mentionOnly`, `replyInThread`)은 계속 저장할 수 있다.
- Telegram·Discord 연결도 같은 모델을 공유한다. `TELEGRAM_TOKEN`은 `enabled|token`, `TELEGRAM_ALLOWED_CHAT_IDS`는 `allowedChatIds`, `DISCORD_TOKEN`은 `enabled|token`, `DISCORD_GUILD_ID`는 `guildId`, `DISCORD_CHANNEL_IDS`는 `channelIds`를 소유한다. `GET /api/settings`는 `telegramEnvironmentVariables`/`discordEnvironmentVariables`에 변수 이름만 싣고, generic `PUT`은 env-owned path를 `409 telegram_connection_managed_by_environment`/`discord_connection_managed_by_environment`로 거부한다. 파일 watch reload는 env-owned 필드를 무시하고, 직렬화는 그 필드를 `settings.json`에서 제거하므로 UI 저장 전후와 재시작 후의 effective 값이 같다. Manager/Classic의 채널 설정도 env 변수가 있으면 연결 컨트롤을 잠그고 변수 이름만 표시한다. 동작 설정(`forwardAll`, `allowBots`, `mentionOnly`)은 계속 저장할 수 있다.
- `runtime.codexApp.multiplex`는 사용자 소유 boolean gate이며 실행 기본값은 `false`다. raw settings에 키가 없으면 `GET /api/settings`의 실행 snapshot은 `false`를 제공하지만 다음 저장에서도 키와 그 결과 비는 `codexApp`/`runtime` container를 만들지 않는다. explicit `false`/`true`는 보존한다. generic `PUT /api/settings`에서 문자열·숫자·`null`은 `400 invalid_settings_field`, host probe 소유인 `runtime.codexApp.laneMode`는 값과 무관하게 기존 호환 오류 `400 server_owned_settings_field`로 거부한다.
- `GET /api/cli-status`는 cold에서 nullable `probeState:"checking"`, stale에서 즉시 이전 snapshot을 반환한다. binary/PATH, auth, capability detection은 request event loop가 아니라 finite-lifetime child worker에서 수행된다.
- probe가 실패하면 `probeState:"failing"` + `probeError`/`probeFailures`/`nextRetryAt`을 실어 보낸다. `failing`은 "포기"가 아니라 "계속 실패 중, 사유는 이것"이며 캐시는 재시도를 이어간다 (첫 재시도 즉시, 이후 지수 백오프 최대 5분). 실패 기록은 남아 있는 snapshot보다 우선한다 — 그래야 동작하는 것처럼 보이는 stale 응답으로 실패를 감추지 않는다 (#277).
- `GET /api/cli-status?force=1`은 백오프 창을 건너뛴다. 재시도는 타이머가 아니라 요청 시점에 일어나므로, 원인을 고친 사용자가 새로고침을 눌러도 백오프가 끝날 때까지 낡은 실패를 계속 보게 되는 것을 막는다.
- `runtimeSelection` is additive on Cursor/Grok/Claude and builtin Codex App/Pi rows only: configured/physical `transport`, `nativeAdapterImplemented`, and independent `nativeWorkerImplemented`. These flags describe compiled implementation, not binary/auth readiness; cached probe fields and other rows are preserved. `PUT /api/settings` validates explicit switchable `perCli.<cli>.transport` values (`print|native`) before writes; invalid fields return400. Existing missing or print fields migrate to native once per migration id on load (`nativeTransportMigration`, v2 re-runs over v1 stamps) where permissions let native run; GET may include the two nullable stamps. Print chosen after the v2 stamp is operator intent, independent of Activity display defaults.
- `lastStartFailure` is an optional sibling on those same rows: `{ code, at }` for the last native runtime that failed before acquiring a lease. `code` is one provider-independent identifier admitted by the runtime layer's safe-code shape, never provider text; `at` is epoch milliseconds. It is a live per-turn record, so it is neither a cached probe field nor a member of `runtimeSelection`, and it is omitted rather than null when nothing is recorded. It appears only while the row's resolved `transport` is still `native`, because only a native run records one. A later start that reaches its lease clears it; `?force=1` does not, since a forced refresh re-reads probe state and says nothing about a past start. Consumers present it through `describeNativeStartFailure`, separately from the probe presentation, because a runtime can probe fresh while every native turn dies before it starts.
- 응답은 legacy Web UI header의 compact git status 전용이다: branch/hash, tracked modified count, untracked count.
- project root가 없거나, home 밖 경로거나, git repository가 아니거나, git 호출이 실패하면 mutation 없이 `{ available:false, reason }` 형태로 조용히 숨길 수 있는 payload를 반환한다.
- status count는 `git status --porcelain=v1 -z --untracked-files=all` 기반이며 ignored entry는 표시하지 않는다.

### `/api/pi/*`

- `POST /api/pi/profiles/register` — body의 provider/endpoint/model/key/mode를 `normalizePiProfile()`로 정규화하고, isolated `PI_CODING_AGENT_DIR` 아래 `models.json` + `settings.json`을 만든 뒤 `pi --offline --list-models <profile>`로 등록 모델이 실제 Pi model list에 나타나는지 검증한다. 성공 시 `applySettings()`를 통해 `settings.pi`와 `perCli.pi.provider/model`을 함께 저장한다.
- `GET /api/pi/models?profile=<id>` — 저장된 Pi profile 설정으로 모델 목록을 재발견하고, `settings.pi.discoveredModels[profile]` 및 Settings UI dropdown 갱신에 사용할 배열을 반환한다.
- Pi 응답은 API key를 직접 반환하지 않고 `apiKeySet`, `apiKeyLast4`, `apiKeySource`만 노출한다.

### `/api/runtime-context`

- `GET` — 모든 entry를 반환하며 각 entry에 `expired` boolean을 추가한다.
- `POST` — body `{ text, label?, expiresAt? }`. `text`는 필수(max 2000자). 201 + 생성된 entry 반환.
- `DELETE /:id` — 단일 entry 삭제. 없으면 404.
- `DELETE /` — 전체 삭제. `{ cleared: <count> }` 반환.

### `/api/security-audit/*`

- `GET /entries` — audit log entries (limit param, max 500).
- `GET /verify` — integrity verification of audit chain.

---

## WebSocket Events

이 heading은 `structure/check-doc-drift.sh`의 anchor로 유지한다. X-01 이후 current server는 public browser events를 WebSocket으로 broadcast하지 않는다. 아래 catalog는 `broadcast()`가 발행하는 event type 전체다. 기본 audience인 `public` 항목은 `src/core/bus.ts` → `src/core/event-bus.ts` → `GET /api/events`로 전달되는 SSE surface이고, `broadcast(..., 'internal')`로 발행되는 항목은 audience gate에서 SSE로 나가지 않고 in-process listener만 받으므로 해당 행에 **internal audience**로 명시한다. WebSocket은 `public/js/ws.ts`와 `bin/commands/tui/channel.ts`가 `/api/events`를 한 번도 열 수 없는 pre-X-01 server에 붙을 때만 fallback path로 사용한다. Current Web UI는 reconnect 시 REST snapshot hydration으로 `agent_status`, `queue_update`, 비-IDLE `orc_state` 상태를 보강한다.

| Type | 설명 |
| --- | --- |
| `agent_status` | running/done/error/evaluating + agentId/phase |
| `agent_tool` | tool/thinking/search 진행 step |
| `agent_output` | 라이브 text chunk preview |
| `agent_done` | 최종 응답 + toolLog + origin |
| `agent_retry` / `agent_fallback` | retry/fallback 안내 |
| `alert_escalation` | repeated failure / capacity fallback escalation alert |
| `agent_smoke` | smoke auto-continue 안내 |
| `queue_update` | 대기열 길이 갱신 |
| `queued_run_started` | 큐에 있던 턴이 **실행을 시작**했다는 신호 — `{ requestId, origin, scope }`. 큐 drain(`src/agent/spawn/queue.ts`)만 발행하며, 그 지점이 어느 요청이 시작되는지 아는 유일한 곳이다. 배달 claim의 턴 앵커를 latch하는 데 쓰인다(`src/messaging/turn-delivery.ts`): 앞 턴이 아직 돌고 있는 enqueue 시점에 앵커를 잡으면 그 턴이 나중에 남긴 claim이 더 새것으로 정렬돼 큐 턴의 답변을 삼킨다. 핸들러는 자기 `requestId`에만 반응한다 |
| `clear` / `session_reset` | UI clear / session reset broadcast |
| `new_message` | Telegram/Discord/Slack inbound message |
| `orc_state` | PABCD 상태 변경 + `taskAnchor`/`resolvedSelection`/`interview` 컨텍스트 |
| `orchestrate_done` / `orchestrate_warning` | orchestration 완료/실패 + 비차단 경고 |
| `request_settled` | 요청 하나의 최종 결말 (`completed｜steered｜merged｜failed｜cancelled｜dropped｜skipped`). `src/orchestrator/request-registry.ts`의 `settleOnce()`가 멱등이라 요청당 정확히 한 번 발생한다. `orchestrate_done`을 대체하지 않고 보완한다 — steer 성공처럼 완료 이벤트가 없는 경로를 덮기 위한 것. 전체 payload 스키마는 `structure/stream-events.md` 참고 (#276) |
| `steer_started` | `/steer` 또는 pending queue steer가 새 프롬프트를 accepted 상태로 전환 |
| `steer_rejected` | in-band steer 가 거부됨 — `reason: 'turn-not-steerable'` (review/compact 중 등). payload `{ prompt, origin, scope, sessionId, reason, requestId? }` (`src/agent/spawn.ts`, #533) |
| `steer_context_lost` | kill-steer 에서 중단된 턴의 부분 출력을 salvage 하지 못함. payload `{ origin, scope, sessionId, requestId? }`. Web UI(`public/js/ws.ts`)가 경고 배너로 표시 (#533) |
| `agent_added` / `agent_updated` / `agent_deleted` | employee CRUD 반영 |
| `settings_change` | project/workspace settings 변경 신호 |
| `memory_status` | memory sidebar / runtime 상태 갱신 신호 |
| `system_notice` | compact refresh 같은 시스템 공지 |
| `heartbeat_pending` | pending heartbeat job 수 |
| `heartbeat_run` | 승인된 heartbeat 틱 1건의 결과 record (execution/delivery + 연속 실패·skip 카운터) |
| `worker_stalled` / `worker_disconnected` / `worker_timeout` | distributed worker 상태 변화; 같은 상태가 `/api/orchestrate/worker-progress`의 safe `attention` metadata에도 반영됨 |
| `goal_done` / `goal_done_rejected` / `goal_cancel_requested` / `goal_continuation` / `goal_continuation_failed` / `goal_continuation_limit` | durable goal / bounded continuation lifecycle. `goal_cancel_requested` replaced `goal_cancel`: an AI-authored marker now clears timers and asks, rather than archiving the goal outright (#441) |
| `goal_pause_detected` / `goal_pause_gate_pending` | goal pause 2-tap gate 감지 및 pending gate continuation suppression |
| `session_switched` / `session_created` / `session_list` | multi-session state update |
| `schedule_wakeup` / `schedule_wakeup_failed` | ScheduleWakeup continuation scheduling lifecycle |
| `bgtask_update` | background task lifecycle/status update for manager/runtime monitors; running and changed entries include native `status` plus shared `statusCategory` |
| `widget_updated` | file-backed diagram widget changed on disk; payload `{chatId, widgetId}` for targeted iframe refetch |
| `policy_verdict` | **internal audience 전용** — runtime policy hook 판정 broadcast (`src/core/policy-hooks.ts` `emitVerdict`). `broadcast(..., 'internal')`이므로 `src/core/bus.ts`의 audience gate에서 SSE로 발행되지 않고 in-process listener만 받는다. payload는 verdict + optional `channel` |

---

## Manager Dashboard Server Surface

`jaw dashboard serve`가 띄우는 별도 manager 서버(`src/manager/server.ts`, 992L)는 core `server.ts` route count에 포함하지 않는다. Manager instance state는 `src/manager/instance-registry.ts`(120L)가 cached scan + diff event source로 제공한다. Manager React UI는 `/api/manager/events`, `/api/dashboard/instances`, `/i/:port/api/messages/latest` 계열 HTTP polling으로 상태를 읽고, manager server는 `src/manager/worker-events.ts` + `src/manager/worker-sse-client.ts`를 통해 각 worker instance의 `GET /api/events`를 server-side로 구독해 latest-message cache를 갱신한다. #233부터 worker의 `settings:settings_change`(cli/model/projectDirs 변경)는 `worker_settings_change`로 재발행되어 `GET /api/manager/events/stream`(SSE)으로 manager UI에 live 전달되고, UI(`useManagerEventStream`)는 해당 instance row를 즉시 재조회한다. Code mode의 goal/PABCD/background/worker monitors는 child Jaw instance가 아니라 manager-local `src/manager/routes/runtime-monitor.ts`를 통해 `/api/manager/runtime-status`, `/api/bgtask`, `/api/orchestrate/worker-progress` JSON API를 직접 읽는다. #260 이후 per-instance Jaw sidebar에는 worker progress monitor가 렌더링되지 않고, Code/CEO runtime observability lane에서만 표시된다. `/api/bgtask`의 `preset: "web-ai"` path는 native web-ai watcher가 진행하는 session id를 `session-status` probe로 관찰하고 `session-answer` extractor로 완료 결과를 전달한다. 이 bridge는 BrowserPanel tab state나 Code session transcript ownership으로 승격하지 않는다. `background_tasks.notified_at` 변경도 `bgtask_update`를 발행하므로 Manager monitor는 completion transition 뒤 별도 reload 없이 notification handoff 상태를 재조회할 수 있다.

| Surface | Endpoints |
| --- | --- |
| Manager health/scan | `GET /api/dashboard/health` `GET /api/dashboard/instances` `GET /api/dashboard/instances/:port` `POST /api/dashboard/instances/:port/message` `POST /api/dashboard/instances/:port/project/pick` |
| Manager events/logs | `GET /api/manager/events` `GET /api/manager/events/stream` (SSE) `GET /api/manager/health-history/:port` `GET /api/manager/instance-logs/:port` |
| Runtime monitors | `GET /api/manager/runtime-status` `GET/POST /api/bgtask` `GET/DELETE /api/bgtask/:id` `GET /api/orchestrate/worker-progress` `GET /api/orchestrate/worker-progress/:agentId` |
| Registry | `GET /api/dashboard/registry` `PATCH /api/dashboard/registry` |

`PATCH /api/dashboard/registry` `ui` is whitelisted by `normalizeUi` (`src/manager/registry.ts`). `ui.instanceSettingsOpen` (boolean, default `false`) is retained for one version so older clients are not rejected, but nothing writes it: the Workbench instance-settings page was removed and the rail owns settings. A stored `true`, and the legacy `ui.selectedTab: 'settings'`, both hydrate as `selectedTab: 'overview'` plus `sidebarMode: 'settings'`, so an older registry opens the rail workspace rather than a page that no longer exists.
| Lifecycle | `POST /api/dashboard/lifecycle/:action` (start/stop/restart/perm/unperm) |
| Process control | `GET /api/dashboard/process-control` `POST /api/dashboard/process-control/adopt` `POST /api/dashboard/process-control/stop-managed` `POST /api/dashboard/process-control/force-release` |
| Desktop/Electron | `GET /api/dashboard/desktop-status` `GET/POST /api/dashboard/electron-metrics` |
| Design workspace | `GET /api/dashboard/design/version` `GET/POST /api/dashboard/design/pages` `POST /api/dashboard/design/pages/rescan` `GET/PATCH /api/dashboard/design/pages/:pageId` `GET/PUT /api/dashboard/design/pages/:pageId/files/{*filePath}` `GET /api/dashboard/design/pages/:pageId/local-paths` `POST /api/dashboard/design/pages/:pageId/rescan` `POST /api/dashboard/design/pages/:pageId/export` `GET/POST /api/dashboard/design/pages/:pageId/snapshots` `POST /api/dashboard/design/pages/:pageId/snapshots/:snapshotId/restore` `GET /api/dashboard/design/catalog` `GET /api/dashboard/design/pages/:pageId/preview` |
| Embedded browser | `POST/GET /api/manager/embedded-browser/targets` `POST /api/dashboard/instances/:port/embedded-browser/targets` `POST /api/manager/embedded-browser/:targetId/screenshot` `POST /api/manager/embedded-browser/:targetId/snapshot` `POST /api/manager/embedded-browser/:targetId/act` `GET /api/manager/embedded-browser/commands` `POST /api/manager/embedded-browser/commands/:id/result` |
| Notes | `GET /api/dashboard/notes/auth/status` `POST /api/dashboard/notes/ws-token` `GET /api/dashboard/notes/history/status` `POST /api/dashboard/notes/history/init` `GET /api/dashboard/notes/history` `GET /api/dashboard/notes/history/show` `GET /api/dashboard/notes/history/diff` `POST /api/dashboard/notes/history/flush` `GET /api/dashboard/notes/plugins` `GET /api/dashboard/notes/plugins/:id/asset/*` `GET /api/dashboard/notes/version` `POST /api/dashboard/notes/asset` `POST /api/dashboard/notes/asset/remote` `GET /api/dashboard/notes/asset` `GET /api/dashboard/notes/info` `GET /api/dashboard/notes/tree` `GET /api/dashboard/notes/templates` `GET /api/dashboard/notes/template` `GET /api/dashboard/notes/snippets` `GET /api/dashboard/notes/snippets/file` `PUT /api/dashboard/notes/snippets/toggle` `PUT /api/dashboard/notes/theme` `PUT /api/dashboard/notes/plugins/:id/toggle` `GET /api/dashboard/notes/search` `GET /api/dashboard/notes/index` `GET /api/dashboard/notes/capabilities` `GET/POST/PUT /api/dashboard/notes/file` `POST /api/dashboard/notes/folder` `POST /api/dashboard/notes/rename` `POST /api/dashboard/notes/trash` |
| Board | `GET/POST/PATCH/DELETE /api/dashboard/board/tasks` `POST /api/dashboard/board/tasks/from-message` |
| Schedule | `GET/POST/PATCH/DELETE /api/dashboard/schedule/work` `POST /api/dashboard/schedule/work/:id/dispatch` |
| Reminders | `GET /api/dashboard/reminders` `POST /api/dashboard/reminders` `POST /api/dashboard/reminders/from-message` `PATCH /api/dashboard/reminders/:id` |
| Telegram Hub | `GET/PUT /api/dashboard/telegram-hub` `POST /api/dashboard/telegram-hub/routes` `DELETE /api/dashboard/telegram-hub/routes/:chatId/:threadId` `POST /api/dashboard/telegram-hub/outbound` (loopback-only) |
| Connector | `POST /api/dashboard/connector/board` `PATCH /api/dashboard/connector/board/:id` `POST /api/dashboard/connector/reminders` `PATCH /api/dashboard/connector/reminders/:id` `POST /api/dashboard/connector/notes` `GET /api/dashboard/connector/audit` |
| Git diff/status/worktrees | `POST /api/dashboard/git/repo-candidates` `POST /api/dashboard/git/diff-summary` `POST /api/dashboard/git/file-diff` `POST /api/dashboard/git/status-map` `POST /api/dashboard/git/scm-snapshot` `POST /api/dashboard/git/scm-operation` `POST /api/dashboard/git/worktrees` `POST /api/dashboard/git/worktree-operation-preview` `POST /api/dashboard/git/worktree-operation` |
| Memory federation | `GET /api/dashboard/memory/instances` `GET /api/dashboard/memory/search` `GET /api/dashboard/memory/read` `GET /api/dashboard/memory/chat/search` (`?format=envelope`로 세션 provenance 포함 envelope opt-in — 033) |
| Memory embedding | `GET /api/dashboard/memory/embed-config` `POST /api/dashboard/memory/embed-config` `POST /api/dashboard/memory/reindex` `GET /api/dashboard/memory/embed-state` `GET /api/dashboard/memory/embed-estimate` `GET /api/dashboard/memory/reindex-stream` (SSE) |
| Wiki (읽기 전용 프록시) | `GET /api/dashboard/wiki/status` `GET /api/dashboard/wiki/entities` (`?port=` 필수). Notes와 같은 preflight+auth pair를 지나고, 포트 범위는 `isDashboardProxyPortAllowed`를 호출해 판정하며, 미등록·오프라인·upstream 실패는 전부 `503 wiki_core_unavailable` 하나로 답한다 (041-C). **`/i` 프록시로 대체하지 말 것** — 그 경로는 loopback으로 접속해 인스턴스의 `requireAuth`가 토큰 검사 전에 통과시키므로 인증 경계가 사라진다 |
| Jaw CEO (manager) | `/api/jaw-ceo/*` (same sub-router as core server) |

Text responses from the hub outbound relay may include `bodyDelivered`, a server-generated receipt. Native hub-member completions require both `ok === true` and `bodyDelivered === true`; missing/false receipts are unconfirmed and are not automatically resent. Request payloads cannot set the receipt or native guard options. Existing untagged callers retain the prior `ok` contract.

### Linux file-open dispatch

`POST /api/file/open` keeps the existing auth middleware and `{path}` input. Missing/invalid paths return `400 path_required`; nonexistent targets return `404 file_not_found`. Document paths (including supported line/column suffixes) open directly; other files open their parent directory, and directories open themselves. An existing literal filename takes precedence over suffix stripping.

On Linux, `xdg-open` launches asynchronously with detached lifecycle and ignored stdio. The handler returns `200 {ok:true,data:{opened,resolvedTarget,strategy}}` after the process spawns, without waiting for the desktop application's lifetime. Launch failures such as missing executable or execute permission return `500 {ok:false,error:"open_failed"}`. A later opener failure/nonzero exit does not change the completed HTTP response; success confirms dispatch, not a visible desktop window. macOS and Windows behavior is unchanged.

## Native Code API

The `/api/code` routes use the existing instance authentication
policy on both the worker and Manager. Responses use `{ok:true,...}` or
`{ok:false,error}`; private native cursor data is never returned.

| Method and suffix | Contract |
|---|---|
| GET `/models` | Four CLI catalogs, availability and honest per-provider capabilities |
| GET `/sessions` | Durable index; canonical cwd, archive, limit and offset filters; current pending permission counts |
| GET `/sessions/:id` | Full-item snapshot, session watermark and current pending permissions |
| GET `/sessions/:id/items` | Byte-bounded older materialized items before `beforeSequence`; never advances the live replay cursor |
| GET `/sessions/:id/events` | Contiguous replay after `afterSequence`; byte/row-bounded page with `nextSequence`, `throughSequence`, `hasMore` |
| POST `/sessions` | Explicit provider, existing absolute cwd, model, effort and permissionMode;201 metadata creation |
| PATCH `/sessions/:id` | `expectedRevision` plus title/model/effort/permissionMode/archive;409 on conflict or busy policy/archive change |
| POST `/sessions/:id/prompt` | `text` and `clientTurnKey`;202 new admission,200 existing receipt,409 mismatched key/busy |
| POST `/sessions/:id/cancel` | Captured `turnId` and `epoch`; never cancels a successor |
| POST `/sessions/:id/attach` | Explicit native resume; selecting or reading a session does not attach |
| POST `/permissions/:id` | Captured session/turn/epoch and opaque optionId; stale or unknown decisions fail |

Prompt retries with the same `clientTurnKey` and exact text recover the original receipt even after archive or a metadata revision change. They emit no new events and open no provider. A reused key with different text remains409; a new key on an archived session remains409. Archive, revision and busy checks gate new admission after duplicate receipt lookup.

Snapshots contain complete items. Replay may contain `code_item_update` append
suffixes and status/phase changes; apply only once in contiguous sequence to the
existing item. Preserve `firstSequence` ordering. Worker and Manager use the same
Code JSON envelope cap of 6MiB + 4KiB; decoded prompt `text` is limited to 1MiB
of UTF-8 bytes. The larger envelope accepts JSON escape expansion without
increasing the decoded prompt allowance. Oversized envelopes return413 and
oversized decoded prompts return400 before lazy host initialization. JSON parser
errors receive a JSON Code error response. Parsing precedes authentication, so
malformed or oversized requests can return400/413 before an authentication error.
Other API requests retain their existing worker 1MiB / Manager 64KiB limits and
Manager streaming exemptions.

Retired compatibility endpoints return410 and are excluded from the active
Code Mode inventory: `GET /api/code/sessions/stored`,
`POST /api/code/sessions/load`, and all methods on `/api/code/model-default`,
`/api/code/model-assignments`, `/api/code/model-presets`,
`/api/code/model-assignments/:role`, `/api/code/sessions/:id/ext`,
`/api/code/sessions/:id/fork`, `/api/code/sessions/:id/config` and
`/api/code/sessions/:id/model`. Unsupported paths such as session DELETE or
permission-list GET are not functional native APIs.

## POST /api/browser/vision-click — failure codes and observation fields

A failed vision-click carries a `code`, and consumers must read what it MEANS
rather than whether it is present. Five returns used to carry only prose, which
the CLI printed as "not found" and the evaluation harness scored as deliberate
restraint — an infrastructure failure reading as good judgement.

Refusals (the pipeline declined, and declining was reasonable):
`COMPUTER_TARGET_AMBIGUOUS`, `COMPUTER_TARGET_COVERED`,
`COMPUTER_VERIFY_DISAGREED`, `COMPUTER_OBSERVATION_EXPIRED`,
`COMPUTER_OBSERVATION_STALE`, `COMPUTER_GEOMETRY_TRUNCATED`.

`EXPIRED` is a wall-clock budget on the observation; `STALE` is observed
navigation — the page identity no longer matches what the screenshot showed.
`GEOMETRY_TRUNCATED` refuses only the claim that exactly ONE element contains
the point, because a partial capture can dissolve an ambiguity it could never
have created. It deliberately does not refuse a coordinate fallback: "no ref box
here" is the correct answer for canvas, WebGL and cross-origin iframes.

Not found (the model looked and did not see it): `COMPUTER_TARGET_NOT_FOUND`.
Scored as an abstention when declining was the right answer and as a grounding
failure when the element was present and described.

Infrastructure (the call could not be completed, and this says nothing about
grounding): `COMPUTER_CAPTURE_UNMEASURABLE`, `COMPUTER_VIEWPORT_UNAVAILABLE`,
`COMPUTER_CAPTURE_NO_DPR`. `COMPUTER_CANDIDATE_OUT_OF_BOUNDS` is NOT one of
these — a model returning a point outside the frame it was shown is a grounding
defect, and grouping it here would take a real failure out of the denominator.

A successful response additionally reports what the pipeline knew about its own
evidence. `freshness` is `'verified'` when page identity was read and matched,
`'unknown'` when the identity probe itself failed — which is not the same as
changed, so the click proceeds and says so. `truncated` is true when element
geometry was captured only in part, whether because the node cap sliced it or
the measurement deadline expired.

The occlusion check applies to the ref path only. It decides whether a point
relates to a KNOWN target, which needs a resolved element to compare against,
so `--no-occlusion-check` has no meaning for a coordinate click. Running it
there would always return "unknown" and refuse nothing, which is worse than not
running it: a guard that cannot fire still looks like a guard.


### Typed Slack tools

Worker `permissions:"auto"` enables full-local authority through the shared HTTP
classifier after ordinary authentication. Both actual/effective peers must be
loopback, with a valid local Host, exact Origin when present, permitted fetch
metadata, and no forwarding/proxy marker. Safe/custom and proxy/remote requests
retain scoped/operator credentials. Full-first resolution ignores stale grant
headers for authority; valid context is retained only for protected RTS search.
`authorization.mode` identifies full-local/turn/operator/unavailable, independently
of implemented, granted, available and verified status. Full sends require explicit
destinations and use server-created file-root/target options, never JSON privilege
flags. See [full-local semantics](../docs/slack-tools.md#full-local-api-access).

`PUT /api/prompt` accepts the complete A2 `content` string and triggers B/working-directory AGENTS regeneration. Preserve existing A2 instructions and verify both output files separately. The builder's unchanged-content optimization requires both persisted outputs to match and commits its hash only after successful writes; AGENTS write errors retain the existing logging contract.

Authenticated `GET /api/prompt?withGenerated=1` adds a versioned `generated` proof computed from one current `getSystemPrompt({forDisk:true})` result: expected SHA-256/UTF-8 byte length, B/AGENTS match booleans and matched/mismatched/missing/unreadable states. It does not regenerate files or return their private bodies. Missing files are false, unreadable or generation failure is unknown; the default GET remains `{content}`. The proof is an observation, not a lock against subsequent edits. A2 raw text and generated output must be verified separately because disk rendering can transform its Working Directory line.

`POST /api/slack/tools` accepts registered source operations (`message`, `permalink`, `quote`, `search.info`, `search.quote`) and typed actions for reactions, own-message edits/deletion, schedules, pins, bookmarks, Canvas and Lists. See [operation inputs and limits](../docs/slack-tools.md). No arbitrary method proxy is accepted. `GET /api/slack/tools/capabilities` requires ordinary instance authentication and returns unavailable capabilities when no valid turn/operator principal is supplied and separates implemented, observed granted scopes, base availability, and real verified receipts. Action mutations persist bounded invocation receipts, capture credential/actor/destination ownership, pace per workspace/method, and preserve known IDs on uncertain completion. Request disconnects cancel further dispatch; accepted writes are never assumed undone.

Source operations use `{source:{channel,ts,threadTs?}}`. Quote publications require `invocationId`; `excerpt` must occur in the fresh source, while `summary` is explicitly labelled and proves references only. The server rereads source content/version and membership before publication, then verifies the posted quote and permalink. Source proof is at observation time, not an atomic snapshot of future Slack edits.

`search.quote` requires a real captured action token and an initialized privacy store. Input includes `query`, optional `channelTypes` (default public_channel), maxQuotes1..5, maxPages1..3, before/after timestamps and sort controls. It processes RTS results only within the server request, publishes permitted excerpts in Slack, and returns only new-output delivery receipts and partial/query-scope metadata. Raw RTS bodies, original pointers and cursors never enter CLI output or a result cache. `search.info` reports semantic availability without assuming a workspace plan.

RTS output IDs are recorded as our own publication provenance. A server-owned block marker and durable output-ID filter exclude those responses from ordinary history/message lookup and subsequent thread context. An uncertain publication retains an invocation-specific destination hold; held history returns restricted placeholders, not source text. The store contains output addresses/holds and safe operator quote receipts, never original RTS source bodies. No-ID delivery reports `sent:"unknown"`; verified known posts report true. Failure receipts remain non-retryable and preserve known new-message IDs.

The same-account operator isolation boundary remains unresolved (issue #646). Full-local is an instance-wide operator policy, not a per-run Safe sandbox. See the full/local versus scoped credential paths in [Slack tools](../docs/slack-tools.md#authorization-and-deployment-boundary).

### Slack file upload receipts

`jaw slack send C123 --file ./report.pdf --thread 1712345678.123456 --caption "Report" --json` sends one file to an explicit conversation. Omit `--thread` for a channel-root post. `--operator` is explicit; normal CLI calls use existing instance/turn headers and the full-local policy. The command never infers a destination, retries a POST, or substitutes text for a failed upload.

The `upload` receipt records `stage` (`validation`, `reservation`, `upload`, `completion`), `state` (`failed`, `unknown`, `completed`), requested `channelId`/optional `threadTs`, and a known `fileId`. `verification: not_checked` means no content or visual readback was performed. Only a successful HTTP and Slack completion acknowledgement yields `ok: true, sent: true`. A reservation or accepted bytes alone do not prove delivery. If the completion reply is lost or contradictory, `sent: unknown, retryable: false` preserves that uncertainty. A later cancellation cannot erase an acknowledged send.

Files must be regular, nonempty and at most 50 MiB. The three-stage request has a shared 120-second cancellation bound. An oversize file with a caption returns a failure and posts nothing. CLI success requires a matching completed receipt; legacy bare success or caption-only responses exit nonzero as unconfirmed.
