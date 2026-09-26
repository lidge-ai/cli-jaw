---
created: 2026-03-28
tags: [cli-jaw, frontend, vite, pwa]
aliases: [CLI-JAW Frontend, public architecture, frontend.md]
---

> 📚 [INDEX](INDEX.md) · [커맨드](commands.md) · [서버 API](server_api.md) · **프론트엔드 아키텍처**

# Frontend — `public/`

> Web UI 본체는 Vanilla HTML + CSS + TypeScript ES Modules로 구성된다. Manager 대시보드는 `public/manager/`의 React 19 + TSX 앱이다.
> 빌드는 Vite 8 기준이며, `vite.config.ts`는 `public/index.html`과 `public/manager/index.html`을 multi-entry로 빌드한다.
> 메인 UI는 `index.html`에서 Google Fonts `Chakra Petch` + `Outfit`을 불러오고, 로컬 `public/assets/fonts/GeistVF.woff2`와 `JetBrainsMono-Variable.woff2`는 자산으로 보관 중이다.
> PWA는 `manifest.json` + `sw.js` + `icons/`로 구성된다. 오프라인 메시지 캐시, virtual scroll, markdown/KaTeX/Mermaid 렌더링, sandboxed diagram widget, avatar emoji/image 커스터마이즈, voice recording, SSE-first event-channel, PABCD roadmap, subagent-aware ProcessBlock 렌더링, slash command 복구 액션, 반응형 사이드바, theme toggle, chat search, workflow cockpit이 현재 런타임의 핵심이다.

Legacy TUI output in `bin/commands/tui/ws-handler.ts` separates turn-clock startup from answer-sink startup. Activity-native output uses the scoped owners below; piped raw remains unchanged.

### Classic permission selector

The sidebar permission badge opens a native Auto (YOLO) / Safe dropdown. YOLO is the display label for the stored `auto` policy, not an additional choice. `settings-core.ts` keeps the configured-policy readout separate from the pending selection and saves only the selected literal through the existing settings API. Identical selections do not write. Custom arrays, missing values and unrecognized settings remain explicit readouts until the user chooses a supported policy. A failed save restores the confirmed selection and shows an inline error; reads begun before or during a save cannot overwrite its result. Server startup preserves the saved policy without coercing `safe` to `auto`. This control does not change runtime policy support or active-run invalidation.

### Interactive TUI Activity

`src/cli/tui/activity.ts` groups live work, defaults collapsed and preserves explicit
disclosure through later updates. Whole-instance compatibility frames are fenced
before transcript/lifecycle mutation. Snapshot identity owns live admission; selected
history keeps original scope for the same authorized chat without changing writes.
The reducer is a bounded preview, not an answer source. Journal terminal text is
redacted. `activity-answer.ts` coalesces compatibility delivery and exact saved MESSAGE
(saved wins), with null/empty/whitespace distinct and explicit correction after
irreversible printing. Missing journal uses an identified assistant receipt, never
a fabricated canonical event. Absent-native error text remains a bounded diagnostic.

`bin/commands/tui/activity-http.ts` is GET-only, rejects redirects, combines caller
abort/deadline and counts streamed bytes before JSON:270000/page,16MiB snapshot/MESSAGE.
`activity-answer-read.ts` retains one active and16 queued identity/ref-only jobs;
retirement/captured-base checks prevent old replies from updating a new view.
Late line output redraws the existing draft/cursor without repeating turn cleanup.
F6 is a read-only inspector: Enter shows journal records; A shows exact saved answer.
Missing, loading, absent and unavailable are distinct. The selected answer renderer
retains only a viewport, not a full wrapped row array. Terminal sanitation and shared
grapheme cell policy preserve raw stored bytes while preventing provider VT controls.
Native scrollback releases payload only after actual flush; see `tui-scrollback.md`.

Saved viewport rendering has same-output fast paths: ordinary text/LF bypasses
per-character sanitizer staging; sanitized printable ASCII/LF uses logical-line
row arithmetic and slices only the requested viewport. Unicode/control fallback
still uses the shared parser/grapheme policy. This is not a whole-process memory
or constant-time Unicode guarantee. Compact F6 labels retain read-only, absent,
empty and failed-read meanings at20columns. An absent error/stopped terminal with
no diagnostic still has a generic status notice; it never becomes a final answer.

---

## 파일 구조

### Display preference plumbing

`presentation.mode` is Activity by default for fresh/upgraded settings without a choice, or explicitly Legacy. Manager Display places this before TUI appearance using the existing SelectField/SettingsSection skin. It has current-instance singleflight, disabled/guarded editing, failed-save draft retention and captured dirty-entry acknowledgement; A→B→A cannot accept an old completion. SettingsShell remains keyed by port across the shared navigation.

Classic `presentation-preference.ts` shares initial-load/event generations, coalesces queued changes and reads settings with the existing4MiB/15s bounded helper. It accepts direct settings or successful ok/data, retains last mode on latest failure, and never invokes loadSettings/runtime migration from settings_change. The native request bridge still owns snapshot identity, outage/manual freshness and original execution-ID responses.

### Live Activity

Classic consumes parsed canonical events through the existing SSE dispatcher. Activity is the default presentation: one closed native disclosure groups tools, commentary, reasoning and explicitly unknown-phase output; the existing message body owns the full final answer. Legacy remains reversible during a turn because CSS hides, rather than deletes, its existing bounded preview. Requests stay outside disclosure in either mode.

Legacy exposes the existing canonical Stopped/Failed status and bounded error summary even while Activity details remain hidden. It does not manufacture an answer for an interrupted empty turn. Initial virtual-history bootstrap keeps the exact current live message element outside the history copy, including when server events precede the user echo; completed text/empty rows still enter history, and the live row is promoted only on normal settlement.

Native request feedback follows the full selected form identity (including view, excluding expiry). A newly selected request does not inherit a previous request's success/expiry text. Empty-list polite outcome announcements and the same form's unconfirmed feedback/draft remain; this changes no freshness, focus, response payload or automatic retry policy.

`src/shared/activity-state.ts` owns the pure preview reducer (128 entries,4096 chars each,65536 combined chars,16 request notices,32768-char final preview). `activity-replay.ts` coordinates bounded state; it does not fetch history. `features/activity-view.ts` renders40 rows/page and retains128 explicit item choices. `activity-live.ts` retains16 turn models/64 choice groups and receives existing renderer actions through a host port; it must not import the legacy ui/state/VS/Trace dependency cycle.

`ws.ts` admits events only against the snapshot bridge's accepted session/scope and current stream readiness. Pre-admission events and gap notices share256 entries/1MiB; foreign identities are ignored, overflow and missing starts are visibly incomplete. Capacity fallback preserves the compatibility answer. Native-input/cancel-reprompt receipts are not terminals. A new run resets only the previous legacy presentation singleton, not the runtime.

Canonical terminal previews and public answers can arrive in either order. A later run-bound native-present or print answer corrects only its own earlier canonical row, without another completion/unread notification. Native-absent diagnostics are notices, not Activity answers. Virtual scroll uses stable message IDs and additive live remount/recycle hooks; cache correction updates only existing assistant rows in the captured browser cache scope and run. The full answer is never read back from the bounded reducer.

Virtualized rows are reconciled into geometric order in the DOM before lazy rendering and post-render hooks. Backward scrolling inserts older rows before retained newer rows, so reading and Tab order agree without replacing message or Activity hosts. Retained focus survives reordering without scrolling; evicted rows and focus outside the transcript are not restored.

### Retained Activity and saved answers

`activity-history.ts` admits only owned transcript hosts. It queues at most16 reads behind one active job, retains64 host records, cancels recycled/navigation jobs and bounds each read job to30s. Targeted replay buffers only that run while unrelated live turns continue. Historical stored execution scope is preserved; it need not equal the currently selected live scope. Focused terminal previews cannot be evicted, and recycled offscreen previews are preferred for eviction. Remounts reject nested copied message keys.

`activity-read.ts` validates fixed-through pages and one run/turn identity, with4096 events/4MiB across seed and catch-up. The recorded-run discovery disclosure (`activity-discovery.ts`) was removed in 260908 wp1; `readActivityRuns` remains for the TUI reader and Trace keeps raw run lookup. Missing or partial Activity has an explicit retry/retention notice; read success does not establish healthy SSE.

`activity-view.ts` renders one `details.activity-disclosure` whose `summary` is the only header row: `activity-chevron` (14px lucide `chevronRight`, rotates 90° when open) · `activity-status-label` (Working/Finished/Complete/Stopped/Failed) · `activity-summary-text` (latest action or `N steps`, single-line ellipsis) · `activity-steer-pill` (`↳ steered`, only when a scoped steer receipt named this run) · `activity-accessory` (count, tabular). `p.activity-status` stays an `sr-only` live region except legacy stopped/error. Notices, paging and the `Open in Trace` footer live inside the disclosure body. Tokens: `--activity-*` and `--motion-fast/base` in `variables.css`.

Expanded body (260908 wp2): `src/shared/activity-kind.ts` classifies tool names (`mcp` → `command` → `file` → `search` → `other`, first match on word boundaries after camelCase splitting) and `groupActivityEntries` folds two or more adjacent same-kind tools into a group (`Ran N commands` / `Read|Edited|Worked on N files` / `Searched N times` / `Called N tools`; any running/error/stopped member shows `N files · failed` instead). `activity-rows.ts` builds `details.activity-row` (icon · verb + first input line · status · 12px chevron; command labels in mono) and `div.activity-group > button.activity-group-summary + div.activity-group-body` (indented, 1px left border, `--activity-group-max` scroll). Running tools auto-open; a manual close on a running item is remembered as `false` in `choices.items`; finished items default closed. The row body is a sequence of `section.activity-block` (small muted label + optional `activity-block-copy`), one per part of the call in input/params/description/output/detail order: the input block is the decoded argument (`Command` for a command envelope, `Input` for a pretty-printed object), extra command fields become `Parameters`, and the detail block is labelled `Error` once the call failed. Each block `pre` is capped at `--activity-output-max` and scrolls, so only an overflowing block enters the tab order; a `Waiting for output…` line stands in until a running call produces output. A trailing `activity-block-toggle` (`Show all` / `Show less`, `aria-expanded`) lifts the cap through `data-expanded="true"` on the body, and the reader's choice outranks the next measurement so an expanded row stays expanded; reasoning rows use the UI font and 140px.



The exact final answer comes from MESSAGE, never the redacted journal preview. The opt-in resolved-session MESSAGE envelope supplies chat identity; browser/VS IDs remain distinct from server MESSAGE IDs. Saved-answer reads use the explicit chat/run endpoint with16MiB limit. Ambiguous links do not transfer a view. Fork-owned copied answers may display without gaining source Trace access. Metadata-free offline cache is a labeled text-only disclosure, not an identified conversation. MESSAGE loading is singleflight per view, cancellation-bounded and namespace-captured before asynchronous work.

The raw Trace drawer displays at most80 event rows with earlier/later controls; sparse sequence and row offset remain separate. Raw actions stay disabled until ownership has been checked. TUI has a separate read-only history and exact-answer consumer; integrated Electron QA is separately verified.

```text
public/
├── index.html            ← 메인 UI 엔트리
├── manifest.json         ← PWA 매니페스트
├── sw.js                 ← Service Worker 캐시 전략
├── theme-test.html       ← 테마 점검 페이지
├── assets/
│   ├── fonts/            ← 2 fonts (GeistVF, JetBrainsMono variable)
│   └── providers/        ← 19 SVG provider assets
├── css/                  ← 15 CSS files
├── icons/                ← 5 PWA icons (favicon-32, mascot, 192/512/maskable)
├── img/                  ← mascot runner sprite (scripts/brand/generate-brand-assets.py)
├── js/                   ← 90 TypeScript modules
│   ├── diagram/          ← 3 diagram pipeline modules
│   ├── features/         ← 51 feature modules
│   └── render/           ← 18 markdown/diagram rendering modules
├── locales/              ← ko/en/ja/zh JSON bundles
├── manager/              ← React manager dashboard (300 source files under src)
│   ├── index.html        ← Manager HTML entry
│   └── src/              ← React components/hooks/styles
└── dist/                 ← Vite build output (generated)
```

### 파일 수 요약

| 영역 | 파일 수 | 비고 |
| --- | ---: | --- |
| `public/` source/assets (generated 제외) | 434 | `public/dist/*`, `public/public/dist/*` 모두 제외 |
| `public/js/` root | 19 | TypeScript ES modules |
| `public/js/diagram/` | 3 | SVG/iframe diagram pipeline |
| `public/js/render/` | 20 | markdown/KaTeX/Mermaid/SVG/file-link/post-render/structured card renderer 책임 분리 |
| `public/js/features/` | 55 | settings 분해 + help/attention/orchestrate scope + process-step-match + preview shortcut/invalidate bridge + MCP registry + chat-search + workflow-event-adapter + media-lightbox + elicitation-state + Pi settings + project git header status 포함 |
| `public/manager/src/` | 304 | React 19 manager dashboard |
| `public/css/` | 12 | theme/layout/chat/markdown/tool UI/diagram/trace drawer/workflow cockpit/chat-search |
| `public/locales/` | 4 | `ko.json`, `en.json`, `ja.json`, `zh.json` |
| `public/assets/providers/` | 19 | provider SVG 세트 |
| `public/assets/fonts/` | 2 | 로컬 폰트 자산 |
| `public/icons/` | 5 | PWA icons (`favicon-32.png`, `mascot.png` 포함) |

---

## 핵심 모듈

### Bootstrap / Runtime

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `js/main.ts` | 612L | 앱 부트스트랩. 아이콘/프로바이더 아이콘 hydrate, i18n 초기화, CLI registry 로드, SSE event-channel + WS fallback 연결, 드래그앤드롭, auto-resize, commands/settings/employees/heartbeat/memory/app name/avatar/sidebar/theme/gesture 바인딩, production에서 SW 등록 |
| `js/state.ts` | 105L | 공유 상태 저장소. WS fallback, agent busy, attached files, heartbeat jobs/errors, CLI status cache, recording, `currentAgentDiv`, `currentProcessBlock` |
| `js/constants.ts` | 279L | CLI registry 동적 로딩, provider/model 매핑, CLI 메타 데이터 |
| `js/event-channel.ts` | 144L | `GET /api/events` SSE primary channel, Last-Event-ID replay, `replay_gap`, reconnect/backoff, legacy WS fallback handoff |
| `js/api.ts` | — | `api`, `apiJson`, `apiFire` fetch 래퍼 |
| `js/locale.ts` | — | localStorage 기반 locale 동기화 |
| `js/icons.ts` | 278L | Lucide 기반 중앙 아이콘 레지스트리 + emoji compatibility. `ICONS.robot`/`ICONS.tool` 등 ProcessBlock summary와 row icon에 재사용 |
| `js/provider-icons.ts` | 117L | provider SVG raw import + hydrate helper + label lookup. `codex-app` alias는 OpenAI icon을 녹색 color variant로 표시. kiro-code는 `kiro.svg`/`kiro-color.svg` 사용 |
| `js/uuid.ts` | — | virtual scroll와 live append가 공유하는 DOM-safe id 생성기 |
| `js/preview-parent-origin.ts` | — | `postPreviewInvalidate(topics, reason)` + `postPreviewOpenDoc(path)` bridge |

### Rendering / UI

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `js/render.ts` | 18L | render public API façade |
| `js/render/markdown.ts` | — | marked pipeline, CJK punctuation fix, math/SVG shielding, sanitize/unshield, post-render scheduling. `renderer.image`는 `/uploads/` 경로를 `/media/:filename`으로, 그 외 `/` 시작 절대경로를 인증된 `/api/image?path=`로 재작성하고 HTTP(S)/data/relative URL은 그대로 둔다. |
| `js/render/sanitize.ts` | — | DOMPurify 기반 HTML/SVG sanitizer |
| `js/render/mermaid.ts` | — | lazy Mermaid load, queued render, observer, rerender, prewarm, unmount release |
| `js/render/mermaid-preprocess.ts` | — | Mermaid code fence preprocessing |
| `js/render/svg-actions.ts` | — | inline SVG block render, diagram copy/save/zoom actions |
| `js/render/highlight.ts` | — | highlight.js language registration, code block highlight |
| `js/render/file-links.ts` | — | local absolute path linkification, `.md` → `postPreviewOpenDoc()` 분기, external web-link `_blank` targeting |
| `js/render/post-render.ts` | — | Mermaid render, rehighlight, zoom binding, elicitation/search-results/link-preview hydration, file-path linkify를 100ms debounce로 coalesce |
| `js/render/code-copy.ts` | — | code block copy button |
| `js/render/html.ts` | — | HTML rendering helpers |
| `js/render/math.ts` | — | KaTeX math rendering |
| `js/render/notes-vault-path.ts` | — | notes vault path resolution |
| `js/render/delegations.ts` | — | one-time render delegation registry + document capture-phase `.chat-inline-img` error replacement. non-bubbling `error`와 late/virtual-scroll 노드를 한 listener가 처리한다. |
| `js/render/search-results.ts` | — | `search-results` fenced JSON placeholder hydration. Final-render only; malformed specs fail closed, unsafe URLs are dropped, and results render as compact native cards. |
| `js/render/link-preview.ts` | — | External URL link preview lazy hydration. Skips internal/private/media links, fetches `/api/link-preview`, renders proxied images through `/api/link-preview/image`, caps concurrent preview fetches, and renders compact cards with favicon/site/URL metadata on the first line plus clamped title/description text. |
| `js/render/compose-block.ts` | — | `compose-block` fenced JSON placeholder hydration. Renders editable draft cards with variants, copy/open actions, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/render/diff-viewer.ts` | — | Unified diff native renderer. Supports explicit `diff` fences and no-language unified diff auto-detect, escapes all content, caps large diffs, and keeps streaming code blocks inert. |
| `js/render/dataframe.ts` | — | `dataframe` fenced JSON placeholder hydration. Renders searchable/sortable/paginated read-only tables with cell copy, row/column caps, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/render/chart-json.ts` | — | `chart-json` fenced JSON placeholder hydration. Renders dependency-free SVG bar/line/pie cards with legend swatches, data caps, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/features/elicitation.ts` | — | `elicitation` / `choice-buttons` structured question placeholder hydration. Supports sequential wizard answers, skip/direct input, auto-injection, persistent compact completed-state rendering, and 21 Advanced `visibleWhen` prior-answer branching. Final-render oriented; malformed final specs fail closed with user-safe error + console diagnostic, and incomplete fences stay inert. |
| `src/shared/structured-fence.ts` | — | shared syntax-light scanner for `elicitation` / `choice-buttons` / `search-results` / `compose-block` / `dataframe` / `chart-json` fenced block completeness; used by frontend render guards and server lifecycle diagnostics. |
| `js/ui.ts` | 441L | 메시지 렌더링, skeleton/empty state, virtual scroll 연동, ProcessBlock 오케스트레이션, copy button, avatar markup 주입, message finalization, `scrollIntent` 기반 bottom-follow/restore policy |
| `js/ws.ts` | 877L | SSE/WS 공용 메시지 dispatcher + legacy WebSocket fallback. agent status, queue update, `agent_tool`→typed ProcessStep, agent output/done, orchestration state, interview panel, Telegram/Discord new message, reconnect snapshot, 10초 reload dedup, 8초 disconnect-toast grace, reconnect 후 bottom anchor reconciliation |
| `js/streaming-render.ts` | — | 스트리밍 텍스트 렌더러 |
| `js/virtual-scroll-bootstrap.ts` | — | virtual scroll 초기 hydrate/measure/bootstrap 오케스트레이터 |
| `js/virtual-scroll.ts` | 596L | TanStack virtualizer 기반 DOM 풀링, mounted node 재사용, post-render hook 실행, Mermaid observer release, scroll anchor preservation, 폭 변경 드래그 중 드래그 시작 시점 기준 재고정(bottom-follow 또는 첫 visible row) |
| `js/sanitizer.ts` | — | DOMPurify singleton + SVG/HTML attribute hook boundary |
| `js/cjk-fix.ts` | — | CJK 줄바꿈/구두점 보정 |
| `js/mermaid-loader.ts` | — | lazy Mermaid dynamic import |

### Diagram Pipeline

| 파일 | 역할 |
| --- | --- |
| `js/diagram/types.ts` | SVG block 추출, code-fence shielding/unshielding |
| `js/diagram/iframe-renderer.ts` | sandboxed iframe widget renderer, CSP/importmap/bridge script, copy/save 버튼, theme sync |
| `js/diagram/widget-validator.ts` | diagram-html 검증. 위험 패턴 차단 + CDN allowlist 검사 |

### Feature Modules

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `features/avatar.ts` | — | agent/user avatar emoji 저장 + image upload/reset |
| `features/appname.ts` | — | sidebar agent name localStorage 저장 |
| `features/attention-badge.ts` | — | window focus/visibility 기반 unread/attention badge |
| `features/chat.ts` | 587L | send, slash command dispatch, unknown-command recovery, multi-file attachment, stop-mode, clear chat, auto-resize, voice send |
| `features/chat-messages.ts` | — | message DOM append/finalization helpers |
| `features/chat-scroll.ts` | — | bottom-follow/scroll intent helpers and initial settle |
| `features/chat-search.ts` | 226L | in-chat message search UI |
| `features/media-lightbox.ts` | — | 살아 있는 `.chat-inline-img`와 업로드 preview 이미지만 여는 라이트박스. `.chat-inline-img-error` 대체 노드는 대상에서 제외된다. |
| `features/copy-text.ts` | 39L | clipboard copy utility |
| `features/employees.ts` | — | employee CRUD + CLI/model/role 조정 |
| `features/gesture.ts` | — | 모바일 edge swipe sidebar toggle |
| `features/heartbeat.ts` | — | heartbeat job editor, cron/every + timezone validation |
| `features/help-content.ts` | — | help dialog topic content registry |
| `features/help-dialog.ts` | — | help trigger binding + modal rendering |
| `features/i18n.ts` | — | 프론트엔드 번역 bootstrap + `t()` |
| `features/idb-cache.ts` | — | IndexedDB conversation cache — scope-based, incremental upsert |
| `features/elicitation-state.ts` | — | `elicitation` / `choice-buttons` 완료 상태 keying, localStorage persistence, structured-response history backfill, shared spec normalization/hash |
| `features/memory.ts` | — | basic memory + advanced memory modal/indexing UI |
| `features/message-actions.ts` | — | message action button delegation |
| `features/message-history.ts` | — | history loading and reconnect restore flow |
| `features/message-item-html.ts` | — | message item HTML serialization helper |
| `features/orchestrate-scope.ts` | — | PABCD/orchestration scope display helper |
| `features/pending-queue.ts` | — | queued prompt overlay / pending queue 렌더 |
| `features/preview-shortcut-bridge.ts` | 44L | preview iframe shortcut message bridge |
| `features/process-block.ts` | 641L | collapsible ProcessBlock UI: `tool`/`thinking`/`search`/`subagent` steps, type별 summary, trusted SVG icon policy, lazy per-step detail (`data-detail-lazy`), long-turn head/tail window + `[data-expand-steps]` full expand, in-memory `processDetailStore`/`processStepMetaStore`, `dataset.processStepIds` persistence, `reconstructStepsFromBlock()` WeakMap fallback for hydrated/virtual-scroll-recycled blocks, `releaseProcessBlockDetails()` on unmount, `data-had-detail` released-detail placeholder |
| `features/process-block-dom.ts` | 175L | ProcessBlock DOM ownership, normalization, row replacement helpers |
| `features/process-log-adapter.ts` | — | persisted tool log to ProcessStep adapter |
| `features/process-step-match.ts` | — | ProcessStep matching helper |
| `features/project-git-status.ts` | 73L | legacy Web UI header의 project git summary badge. `/api/project/git-summary`를 읽어 `/ ⑂ branch *tracked ?untracked` compact label로 표시하고 narrow viewport에서는 숨김 |
| `features/settings.ts` | — | barrel re-export |
| `features/settings-channel.ts` | — | active channel + fallback order |
| `features/settings-cli-status.ts` | 482L | CLI availability/quota/status, kiro-code quota, generic auth/status badge |
| `features/settings-cli-status-render.ts` | 161L | CLI status row rendering helpers |
| `features/settings-core.ts` | 588L | Classic Agents settings load/save, per-CLI model/effort/permissions, flush-agent controls, locale/header sync and `postPreviewInvalidate`; shared Settings pages retain their own save owners |
| `features/settings-discord.ts` | — | Discord settings save/load/toggles |
| `features/settings-slack.ts` | — | Slack settings save/load/toggles (bot+app token, mentionOnly/replyInThread default ON) |
| `features/settings-mcp.ts` | 561L | MCP server list/sync/install + registry browse/install (`/api/mcp/registry`) |
| `features/settings-stt.ts` | — | STT engine/provider fields |
| `features/settings-telegram.ts` | — | Telegram settings save/load/toggles |
| `features/settings-templates.ts` | — | prompt/template tree + editor + dev mode |
| `features/settings-types.ts` | — | shared settings interfaces |
| `features/sidebar.ts` | — | responsive collapse/expand, narrow overlay behavior |
| `features/skills.ts` | — | skill load/filter/toggle |
| `features/slash-commands.ts` | — | web slash command dropdown + workflow metadata chips (commands only; skills are not listed) |
| `features/skill-mentions.ts` | — | web `$` inline skill popup — lists active skills from `/api/skills` and inserts the server-computed `mention` word |
| `features/theme.ts` | — | dark/light theme toggle, hljs theme swap, Mermaid/iframe refresh |
| `features/tool-ui.ts` | — | legacy finalized tool group + live activity helper |
| `features/trace-drawer.ts` | — | trace drawer open/close/render controls |
| `features/transport-status-row.ts` | 94L | transport status row rendering |
| `features/ui-status.ts` | — | compact UI status helper |
| `features/voice-recorder.ts` | — | MediaRecorder wrapper, MIME detection, pending/error UI, preview STT lifecycle |
| `features/workflow-event-adapter.ts` | 77L | workflow event → UI adapter |

### Settings Split

```text
settings.ts (barrel)
├─ settings-core.ts
├─ settings-telegram.ts
├─ settings-discord.ts
├─ settings-slack.ts
├─ settings-channel.ts
├─ settings-mcp.ts
├─ settings-cli-status.ts
├─ settings-cli-status-render.ts
├─ settings-stt.ts
├─ settings-templates.ts
└─ settings-types.ts
```

---

## CSS 시스템

| 파일 | 역할 |
| --- | --- |
| `css/variables.css` | 컬러/타이포/spacing/easing token, light/dark variables, reveal animations |
| `css/layout.css` | 전체 grid layout, sidebar width, base UI scaffolding |
| `css/chat.css` | chat area, message layout, input bar, attachments, voice button, virtual scroll container, slash command workflow chips, unknown-command recovery block, `.file-path-link` open states, `.chat-inline-img` 최소 높이/`object-fit: contain`, `.chat-inline-img-error` fallback |
| `css/chat-search.css` | in-chat search overlay styling |
| `css/orc-state.css` | PABCD roadmap, mascot runner, orc glow, state badge, interview panel (known/unknown 트래커, dimension bars, budget panel) |
| `css/sidebar.css` | left/right sidebar, collapse behavior, status / CLI / app name sections |
| `css/modals.css` | prompt/template/heartbeat/memory modal shells + form controls |
| `css/markdown.css` | markdown rendering, code block, copy button, tables, mermaid/KaTeX styles |
| `css/tool-ui.css` | tool call group, live activity, ProcessBlock summary/row/detail, subagent badge, row icon column |
| `css/diagram.css` | diagram container, widget iframe, overlay, zoom/copy/save buttons, semantic inline SVG label/connector color ramps |
| `css/trace-drawer.css` | trace drawer panel and event list styling |
| `css/workflow-cockpit.css` | workflow cockpit panel styling |

---

## Manager Dashboard — `public/manager/`

`public/manager/`는 메인 채팅 UI와 별개의 React 19 앱이다. `vite.config.ts`의 `manager` entry가 `public/manager/index.html`을 빌드한다.

### Manager design tokens (260902 t3 shell polish, wp1)

`public/manager/src/manager-tokens.css`는 primitive → semantic 2계층으로, t3code(pingdotgg/t3code `apps/web/src/index.css`) zinc/neutral oklch 스케일을 값으로 쓴다. 다크 기본은 캔버스 `#0a0a0a` / 사이드바·레일 `#000`, 라이트는 zinc-25(`oklch(99.2% 0 0)`) 캔버스에 흰 카드. `--accent`는 표면 틴트가 아니라 CTA primary(`oklch(0.571 0.21 264)` 다크 / `oklch(0.488 0.217 264)` 라이트)이고 `--ring`도 같은 값이다. 다크 보더는 `color-mix(in srgb, white 8%, transparent)`부터 시작한다(contrast 슬라이더가 없으므로 t3의 6%보다 한 단계 진하게). Tailwind 전용 `--alpha()`는 쓰지 않는다.

레거시 변수 이름 88개(`--bg-base`, `--text-primary`, `--accent`, `--surface-*`, `--ink-*` 등)는 전부 보존되며 값만 바뀌었다. 추가된 semantic 토큰: `--radius-sm/md/lg/xl`(0.375/0.5/0.625/0.875rem), `--control-radius`(0.5rem), `--font-sans`(시스템 스택 + CJK 폴백), `--font-mono`(Geist Mono 우선), `--focus-ring`, `--motion-fast`(120ms) / `--motion-base`(180ms), `--workspace-topbar-height`(44px), `--sidebar-row-hover/active/selected`, `--sidebar-row-working/attention/error/ready`(행 상태 색, wp3 소비), `--sidebar-border`, `--sidebar-control-surface`, `--text-danger`, `--scrollbar-*`. 라이트 블록은 `:root[data-theme="light"]`와 `@media (prefers-color-scheme: light) :root[data-theme="auto"]`에 동일하게 복제되어야 한다.

### Manager sidebar shell (260902 t3 shell polish, wp2)

좌측 사이드바 픽셀 폭은 `public/manager/src/hooks/useSidebarWidth.ts`가 단독 소유한다. localStorage 키 `jaw.sidebarWidth`, 기본 300, 최소 220, 최대 `viewport - 640 - (우측 패널 열림 ? 그 폭 : 0)`, 접힘 시 44px 레일. 서버 registry `ui.*`에는 넣지 않는다(`sidebarCollapsed`만 기존대로 서버 영속). `WorkspaceLayout`이 inline style로 `--sidebar-width`를 항상 쓰고, layout/polish/p0-1-1 CSS가 데스크톱 폭을 덮어쓰던 340/360/300/56/44 cascade는 제거됐다(`@property --sidebar-width` 초기값/fallback 300px, 1023px 이하 드로어 폭 `min(88vw, 340px)`/`min(85vw, 300px)`, 모바일 1열의 `0px`은 남는다). `components/SidebarResizeHandle.tsx`(`PanelResizer` 재사용, `role="separator"`, `aria-label="Resize sidebar"`, `aria-valuenow`)는 `.manager-workspace` 직속 자식으로 `left: calc(var(--sidebar-width) - 12px)`에 놓인다 — aside 안에 두면 `overflow: hidden`이 24px 히트 영역 절반을 잘라 드래그가 안 된다. 더블클릭 또는 단축키 `resetSidebarWidth`(기본 `Alt+Shift+B`, `runManagerShortcut`이 `jaw:shortcut-action` CustomEvent를 dispatch하고 `SidebarRailRouter`가 구독)가 300으로 되돌리고 키를 지운다. 접힘 전환은 grid column `var(--motion-base, 180ms)`, `prefers-reduced-motion`이면 `transition: none !important`.

`AppChrome`이 capture-phase window keydown(`createManagerCaptureKeydownHandler`)으로 `toggleLeftSidebar` / `toggleRightPanel` / `resetSidebarWidth`를 포커스된 에디터보다 먼저 처리한다. `[data-keybinding-capture]` 조상이 있으면 건너뛴다. keymap 기본값(`Meta+B` 우측, `Meta+Shift+B` 좌측)은 바뀌지 않았다. 레일 버튼은 32px, 아이콘 18px stroke 1.5, active는 `--sidebar-row-active` + 왼쪽 2px `--accent`.

Keymap `Meta`(`Cmd`/`Command`/`Mod`)는 주 수정자다. 클라이언트 플랫폼(`public/manager/src/client-platform.ts`, `userAgentData.platform` → `navigator.platform` → `userAgent`)이 macOS면 ⌘, Windows/Linux면 Ctrl로 해석하며 Electron 메뉴의 `CommandOrControl`과 같다. 서버 `process.platform`은 쓰지 않는다(원격 접속 시 화면 쪽 OS와 다를 수 있음). 물리 Windows/Super 키는 `Win`/`Super` 토큰이다. 저장된 `Meta+…` 문자열은 바꾸지 않고 해석만 바뀌며, `formatShortcut`은 macOS에서 `⌘⇧B`, 그 외에서 `Ctrl + Shift + B`로 표기한다. 메뉴 소유 chord 판정도 같은 해석을 써서 Windows 데스크톱의 Ctrl+W가 두 번 실행되지 않는다. 명령 팔레트(`useCommandPalette`)와 폴더 패널도 같은 helper를 쓴다.

Sidebar width keeps the user's preferred value separate from the displayed, viewport-clamped value. Opening a right panel or narrowing the window does not overwrite the preference; space returning restores it. Pointer completion and handled resize arrows persist the latest width. Unavailable browser storage leaves resizing usable in memory.

### Manager sidebar rows (260902 t3 shell polish, wp3)

데스크톱(`:root[data-cli-jaw-desktop="true"]`) 상단 command-bar는 52px이며 macOS 신호등은 `electron/src/main/lib/window/chrome-options.ts`의 `TRAFFIC_LIGHT_POSITION {x:16,y:20}`로 같은 26px 중심선에 놓인다. 좌측 reserve는 `--electron-titlebar-left-reserve: 108px`(fullscreen 12px), `.command-search`는 >=1024px에서 `clamp(220px, 28vw, 420px)`로 제한되고 남는 트랙은 `-webkit-app-region: drag`로 남는다.

`components/instance-row-status.ts`가 행 상태를 정한다: `transitioning`(라이프사이클 진행) > `working`(`busyPorts`) > `attention`(timeout/error/unknown) > `offline` > `online`. `InstanceRow`는 제목 위에 `.instance-row-status-line[data-status]`(pill + working일 때만 행 국소 1s `WorkingDuration`, `Ns`/`Nm`/`Xh Ym`)를 두고, compact/rail density에서는 숨긴다. 툴팁은 `composeInstanceRowTitle`의 native `title`. 퀵 액션(`.instance-row-quick .quick-btn`)은 hover/focus-within/선택 행에서 `:not(:disabled):not(.is-disabled)`만 드러난다. Coarse pointer에서도 같은 제외 조건을 적용하여 사용 가능한 퀵 액션만 hover 없이 표시한다. `InstanceGroups` 헤더는 `button.instance-group-header.instance-group-toggle[aria-expanded]`로 접히며(`Selected`, 내부 ID `active` 그룹은 예외), 접힘 맵은 `hooks/useSidebarGroupCollapse.ts`가 localStorage `jaw.sidebarGroupCollapsed`(`Record<groupId, boolean>`)에 저장한다. 접힌 그룹에서도 선택 인스턴스는 한 줄로 남는다. 그룹 내 정렬은 favorite 우선 후 포트 오름차순(`comparePinnedThenPort`)이다. 표시 label은 정렬 키가 아니다 — 커스텀 이름을 붙이면 문자열 정렬이 그 행을 목록 밖으로 밀어내므로, 서버 order key가 없는 상태에서 포트가 유일하게 안정적이고 예측 가능한 키다. DnD는 없다. 제네릭 `.instance-row.is-selected {` 선택자는 contract 테스트가 금지한다.

The selected-instance summary is labeled `Selected` while retaining internal group ID `active` and the instance's original lifecycle group. Each section of an `InstanceGroups` mount uses a React `useId` namespace for both group-body and session-wrapper DOM IDs, so a persistent sidebar and an open drawer have distinct local disclosure targets. `InstanceRow.sessionListId` links Sessions to its owning wrapper; that wrapper remains mounted while closed and its ID updates with the selected port. User group labels never enter DOM IDs or `aria-controls` tokens. Internal group state keys and `data-instance-port` remain unchanged; DOM IDs are not persistent identities. Row selection and Sessions/Stop/Open are sibling interactive targets; list Arrow/Home/End/Enter handling applies only when the selection button itself owns focus. Action buttons and label inputs retain their own keyboard behavior. The navigator heading is `Instances`; hidden-count metadata appears only when nonzero, and the shared search query remains unchanged.

Rows use an inline-size container: below 240px of row content width, quick actions move below selection and wrap as whole controls if needed. Wider rows retain two columns. Title/status grids constrain text to the available width; title ellipsis does not clip buttons or focus rings. Hosted sidebar resize coverage records synthetic DOM geometry and screenshots at requested sidebar widths 164/220/300px, including long Korean Selected/Running labels with and without Sessions. These fixtures prove layout only, not session API behavior.

### Manager sidebar search, keyboard, settled shelf (260902 t3 shell polish, wp4)

`InstanceNavigator` 헤더의 `#manager-sidebar-search`는 CommandBar와 같은 `App.query`를 소비한다(두 번째 필터 없음). Escape는 쿼리를 비우고 IME 조합 중에는 무시한다. `components/sidebar-keyboard.ts`가 순수 헬퍼를 가진다: `resolveAdjacentPort`(wrap 없음), `handleInstanceListKeyDown`(Arrow/Home/End는 `[data-instance-port]` 버튼 포커스만 이동, Enter가 선택), `createJumpHintVisibilityController`(Alt 200ms 유지 시 렌더된 행 1..9 오른쪽 상단 `.instance-jump-hint` 오버레이), `readRenderedInstancePorts(#manager-sidebar-list)`, `registerInstanceJumpSelector`(SidebarRailRouter가 등록). 단축키 `jumpInstance1..9`(기본 `Alt+1..9`)는 `resolveEventKey`의 Digit 코드 폴백으로 macOS Alt+숫자 특수문자에도 매칭되고, 같은 폴백이 Alt+문자에도 적용된다 — `altKey`가 눌린 `Key*` 코드는 `event.key`가 `∆`나 `˜` 같은 단일 문자이거나 `Dead`여도 물리 문자를 이긴다(그래서 `Alt+Shift+N`(newCodeSession)과 `Alt+I/J/K/P`가 macOS에서 발화한다). 서버 keymap whitelist에는 넣지 않는다(switchTab과 동일하게 기본값 복원). offline/unknown/timeout은 `Settled` 그룹(id `settled`, 접힘은 wp3 `useSidebarGroupCollapse`)으로 내려가고 `pageSettledPorts`로 10개 → "Show N more" 25개씩 페이징되며 선택 인스턴스는 항상 렌더된다. Attention은 error만.


### Manager command bar (260902 t3 shell polish, wp5)

탑바는 한 줄 `[brand][search][actions]` 그리드다. 높이는 `--workspace-topbar-height`(브라우저 44px, `:root[data-cli-jaw-desktop="true"]`에서 52px). Electron에서는 `--electron-titlebar-left-reserve`가 108px(t3 초기값 90px에서 상향; 위 command-bar 문단 참조)이고 `html[data-window-fullscreen="true"]`이면 12px로 접힌다; 바 자체는 `-webkit-app-region: drag`, 모든 인터랙티브 자식은 `no-drag`(p0-1-1.css 상단 블록이 권위). 브랜드 13px/600/0.02em(`--manager-brand-cyan` 유지), 검색은 28px ghost(`--sidebar-control-surface`), 액션은 28px `.command-icon-button`. 드로어 트리거는 SVG이며 1024px 이상에서는 숨고 그 아래에서는 `drawer` 열을 따로 가진다. `hooks/useWindowFullscreen.ts`가 `getDesktop()?.window?.getFullscreenState?.()`를 읽어 `data-window-fullscreen` 속성을 생산한다(fullscreen이 아니면 속성 제거); IPC 생산자는 wp7. Mod+B 기본값(`Meta+B` 우측 패널, `Meta+Shift+B` 좌측)은 바꾸지 않았다.


### Manager browser panel chrome (260902 t3 shell polish, wp6)

`browser-panel/browser-address-state.ts`가 주소창 상태기계다: blur 상태에서는 live URL, focus 시 draft(전체 선택), Enter는 `submit` → `openUrlInTab` → blur, Escape는 live로 되돌리고 blur, 포커스 중 도착한 `sync-live`는 draft를 덮지 않는다. 탭이 바뀌면 상태를 재생성한다. `BrowserAddressBar`(placeholder "Search or enter URL")가 옛 `inputUrl`/`editingTabIdRef`/draft ref를 대체하며 Go 버튼과 `data-tooltip="Reload"`는 유지된다. 로딩은 툴바 아래 2px `.browser-loading-bar`(`scaleX .04→.9` 5.3s, reduced-motion이면 정적 .9)만 보이고 status 줄은 blocked/error에만 남는다. 탭 스트립은 16px favicon(`browser-favicon.ts`, 없으면 이니셜 원)을 달고, Electron `ipc.ts`가 guest `page-favicon-updated`를 contents-id 가드로 한 번만 구독해 `favicons`/`zoomFactor`를 `browser:webview-state` payload에 싣는다. 최근 방문은 `browser-history-store.ts`(localStorage `jaw.browserHistory`, 최대 20)로 empty/new tab 위에 표시되며, 게이트는 `shouldShowRecentVisits`(주소창이 포커스 중이고 draft가 비었거나 live URL 그대로)라서 포커스가 없으면 페이지를 덮지 않는다. more 메뉴의 zoom in/out/reset은 `control-webview` kind `zoomIn|zoomOut|zoomReset`(0.5-3, 0.1 단계)이고 여기에 자동 `fit` 모드가 붙는다: 리사이즈와 탭 활성화가 `fitToWidth` kind로 측정을 요청하고, 탭은 `zoomMode: 'auto' | 'manual'`을 들고 있으며 auto는 0.5–1.0으로 클램프해 넓은 페이지를 줄인다. 수동 줌은 Reset이 탭을 auto로 되돌릴 때까지 이긴다. mini player·device viewport·cookie/cache 삭제는 범위 밖.


### Electron window chrome (260902 t3 shell polish, wp7)

`electron/src/main/lib/window/chrome-options.ts`의 `resolveWindowChromeOptions(platform, shouldUseDarkColors)`가 창 크롬을 정한다: darwin은 `hiddenInset` + traffic light `{x:16,y:20}`(t3 초기값 y:18에서 상향), win32/linux는 `hidden` + 40px `titleBarOverlay`(색 `#01000000`, symbolColor는 nativeTheme에 따라 `#f8fafc`/`#1f2937`, 테마 변경 시 `setTitleBarOverlay`). fullscreen 상태는 `window:get-fullscreen`(invoke, origin guard)과 `window:fullscreen-changed`(event)로 흐르고, preload가 캐시해 `cliJawDesktop.window.{getFullscreenState, onFullscreenStateChange}`를 노출한다(`sendSync` 금지). View 메뉴는 Toggle Right Sidebar 다음에 Toggle Left Sidebar, Reset Sidebar Width(`resetSidebarWidth`)를 두고, Zoom In/Out/Reset은 guest webview가 아니라 Manager `webContents.setZoomFactor`(0.5-3)만 움직인다. 패키지 검증은 `npm run electron:dist:mac` 후 `electron/dist/mac-arm64/cli-jaw.app`을 기동해 번들 Manager 서버 응답, 서빙 CSS의 108px reserve/52px topbar/새 셸 클래스, 실제 창을 확인한다.


### Manager a11y and smoke (260902 t3 shell polish, wp8)

포커스 링은 전부 `--focus-ring` 토큰(`2px solid color-mix(ring 50%)`)이다: 레일 버튼·커맨드 아이콘 버튼·검색 입력은 styles.css의 전역 `button/input:focus-visible`, 인스턴스 행·그룹 헤더는 components.css, 리사이즈 핸들은 panels.css `.panel-resizer:focus-visible`(토큰을 그대로 outline에 넣는다 — `2px solid var(--focus-ring)`처럼 감싸면 무효), 브라우저 주소창은 browser-panel.css `:focus-visible`. 선택 행 article은 `aria-current="true"`, 리사이즈 핸들은 `aria-valuenow` + `aria-valuetext`(px). `PanelResizer`는 pointerdown 뒤 2px 이내 움직임을 무시해 더블클릭이 폭을 흔들지 않는다. wp2-wp6가 추가한 transition/animation은 모두 `prefers-reduced-motion: reduce`로 꺼진다(layout/components/browser-panel 각 파일 하단). `tests/browser/manager-layout-smoke.test.ts`의 4번째 케이스가 사이드바 셸(기본 300 → 드래그 420 persist → 새로고침 복원 → 더블클릭 300 + 키 삭제 → Meta+Shift+B 44px)을 CDP Chrome에서 측정하며, CDP가 없으면 나머지처럼 skip한다. 로컬 실행: 헤드리스 Chrome을 `--remote-debugging-port=9243`로 띄우고 `MANAGER_BROWSER_CDP_URL=http://127.0.0.1:9243 MANAGER_DASHBOARD_URL=<manager url> npx tsx --test tests/browser/manager-layout-smoke.test.ts`. 시각 검증은 light/dark × 1280x720/1440x900 × default/search/settled-collapsed/collapsed 매트릭스와 포커스 링을 포함한다.


### Manager preview memory note

2026-06-14 점검 기준, Chrome에서 manager Web UI를 열었을 때 1GB 근처까지 올라갔다가 약 10분 뒤 300MB대 근처로 안정화되는 패턴은 `jaw dashboard serve` manager 서버 누수보다 preview iframe의 cold-load peak로 해석한다. 실제 관찰에서는 manager 서버 `dist/src/manager/server.js` RSS가 약 170~220MB 수준이었고, 큰 RSS는 Chrome renderer와 각 `jaw serve` worker(`dist/server.js`) 쪽에 있었다.

원인 경로:

- `manager/src/InstancePreview.tsx`는 선택된 instance의 일반 Web UI를 iframe으로 mount한다.
- Active 행 재클릭이 Settings로 가던 단축은 제거됐다(모든 online 행 클릭은 `/0` 프리뷰). 세션 행 클릭은 서버 활성 세션만 바꾸고 프리뷰를 `/<seq>`로 이동시키지 않는다(후속 과제).
- `manager/src/preview.ts`는 dedicated preview origin 또는 legacy `/i/{port}/` proxy URL을 만들고, 두 transport 모두 기본 세션 경로 `/0`을 붙인다(theme query/hash 유지). 네비게이터에서 online 인스턴스 행을 클릭하면 `InstanceListContent`가 `onPreview`로 라우팅해 Preview 탭이 켜지고 `/0`이 로드된다(offline 행은 선택만). Active 행의 세션 disclosure(`hooks/useActiveSessionDisclosure.ts`)는 선택 포트마다 기본 open이며 세션 1개부터 chevron을 보이고, `.instance-session-list`는 30px 행 3개(`max-height: 108px`) 안에서 내부 스크롤한다. 인스턴스 웹 UI 쪽은 `js/features/session-hub.ts`의 `initialized` 플래그로 navigation-off 서버의 `/:seq`에서도 초기화 후 전송을 허용한다(초기화 전 fail-closed 가드는 그대로).
- iframe 안의 일반 Web UI는 `js/features/message-history.ts`의 `BOOT_MESSAGE_WINDOW = 3000`에 따라 `/api/messages?limit=3000` 최근 메시지 창을 boot fetch한다.
- 2026-06-14 실측에서 선택 instance `:3457`의 `/api/messages?limit=3000` payload는 3000 messages / 약 23.4MB JSON, full `/api/messages`는 5781 messages / 약 45.8MB JSON이었다.
- 이 payload는 normalize 결과, virtual scroll items, raw markdown, rendered HTML, structured renderer hydration, widget iframe, IndexedDB cache 등으로 브라우저 힙에서 여러 배로 증폭될 수 있다.

한 달 전 baseline(`7262770d4ea0e65b7fdb2e9eff54c64995e4f798`)은 `/api/messages` full history를 직접 로드했으므로 현재 코드가 더 큰 payload를 요청하게 바뀐 것은 아니다. 현재 코드는 이미 3000-message boot window로 제한되어 있다. 다만 그 사이 실제 chat DB가 커졌고, `search-results` / `link-preview` / `compose-block` / `dataframe` / `chart-json` 같은 structured renderer와 manager preview bridge 기능이 늘어 cold-load 피크가 더 잘 보일 수 있다.

패치가 필요하면 일반 Web UI의 3000-window를 무조건 줄이기보다 manager preview 전용 저메모리 모드를 우선 고려한다: preview URL에 `jawPreview=1` 같은 플래그를 붙이고, preview iframe 안에서는 boot window를 800~1000 수준으로 낮추거나 IndexedDB history cache / structured hydration을 더 lazy하게 만든다. 안정화 후 RSS가 내려가는 경우는 지속 누수로 분류하지 않는다.

| 파일/폴더 | 역할 |
| --- | --- |
| `manager/src/main.tsx` | `react-dom/client` `createRoot()`로 `App` 렌더 |
| `manager/src/App.tsx` | 475L — InstanceRegistry-backed scan/filter/select/lifecycle + dashboard section 상태 orchestration |
| `manager/src/AppChrome.tsx` | App chrome shell (sidebar rail + workspace layout) |
| `manager/src/SidebarRailRouter.tsx` | 323L — sidebar rail routing to workspace panels + Electron drop routing to FolderPanel/DocPanel |
| `manager/src/InstancePreview.tsx` | 303L — preview iframe mount/theme sync + STT shortcut bridge + sandbox popup escape + `jaw-preview-open-doc` + preview dropped-file metadata 수신 |
| `manager/src/panels/` | desktop panel infra: `PanelResizer`, `PanelLayoutProvider`, `RightSidebar`, `BottomPanel`, `BottomPanelTabBar`, `desktop-bridge`, `panel-capabilities`, `panel-shortcut-bus` |
| `manager/src/hooks/useElectronDroppedPaths.ts` | 89L — Electron-only OS file/folder drop resolver; Manager drops route to right panel, preview drops preserve iframe chip passthrough |
| `manager/src/doc-panel/` | `DocPanel.tsx` — dropped file / `.md` 절대경로를 우측 사이드바에 markdown preview로 렌더(Electron only) |
| `manager/src/folder-panel/` | Electron desktop Workspace Explorer; starts empty until explicit Open Folder/picked/dropped/worktree root, keeps that root independent from projectDirs/terminal/preview state, supports native file/folder move/copy/reveal plus minimal new/rename mutations, coalesces manual/watch/move/mutation/git-operation visible-tree refresh with large-tree branch budgeting/status, decorates rows with read-only Git status, exposes a compact existing-worktree selector, and gates worktree add/remove/prune behind preview + explicit confirmation with bounded result history and retry-with-confirmation |
| `manager/src/terminal/` | Electron desktop terminal sessions, accessible tab navigation, theme projection and creation recovery |
| `manager/src/browser-panel/` | Electron desktop Browser panel (Google default, URL/search normalization) |
| `manager/src/diff-panel/` | Electron desktop Git Diff panel (server-backed via selected-instance `/api/dashboard/git/*` diff routes) |
| `manager/src/settings/` | settings pages/components/field renderers, `pages/Mcp.tsx` (MCP server cards + registry), Model defaults Pi profile popup |
| `manager/src/api.ts` | Dashboard API wrapper + manager event/diff surfaces |
| `manager/src/components/` | `ManagerShell`, `WorkspaceLayout`, `Instance*`, `Command*`, `ActivityDock`, `MobileNav`, `DesktopPanelControls` 등 |
| `manager/src/dashboard-board/` | Kanban board UI (backlog/ready/active/review/done lanes) |
| `manager/src/dashboard-schedule/` | schedule/heartbeat dashboard UI |
| `manager/src/dashboard-reminders/` | reminders matrix/sidebar/workspace UI, drag/drop, detail popover |
| `manager/src/dashboard-settings/` | Developer tools settings (diff defaults, embedding) |

### Manager Settings — Runtime transport and embedded Classic

Workbench has Overview/Preview/Logs modes. The Settings tab and the command-bar gear are both removed: the sidebar rail is the only settings entry point, it renders manager scope only, and Meta+, opens it through the same dirty guard. The Workbench keeps Overview/Preview/Logs with its Preview iframe mounted across tab changes. `ui.instanceSettingsOpen` is accepted by the registry for one version but no longer written; page saves still target the selected instance API.

`permissions` has three stored shapes, not two: `auto`, `safe`, and an explicit token
allowlist. `parsePermissionsValue` returns `safe` as a first-class mode rather than `unknown`,
and both the Agent quick section and the Permissions page render and write it. Reporting it as
unknown is what previously let the editors collapse a Safe instance to Auto, widening
permissions without the user seeing the policy they were changing; the root AGENTS.md rule
against the safe-to-auto coercion applies to the frontend editors too, not only to startup.

Runtime employees are diffed against the server at save time, not against the snapshot the page
loaded, because the Classic sidebar writes employees immediately and independently. The baseline
is the server list restricted to rows the page already knew about or the draft still names, so a
row added from the sidebar while the page was open is not read as a removal and deleted. A failed
re-read falls back to the page snapshot rather than discarding the user's edit.

The manager never renders instance settings. It asks the instance to open its own page, and the
request travels three hops: `InstancePreview` posts `jaw-preview-settings-open` to the Classic
document, whose relay in `js/features/settings.ts` calls `toggleSettingsPage(true)`, which owns the
settings iframe. That iframe accepts messages only from its immediate parent under strict
same-origin, and its parent is Classic, not the manager, so a direct post cannot reach it.

The two guards in `settings.ts` differ on purpose and must not be collapsed. The iframe guard is
strict same-origin because that frame is same-origin by construction. The manager guard uses
`isLocalPreviewRelayOrigin`, because under the default origin-port preview transport the manager
runs on a different loopback port and a strict equality check drops every request silently. The
trigger is a workbench mode-bar button scoped to the selected instance; failures surface in the
existing `.lifecycle-state` notice. Opening settings fills the instance viewport: `#settingsPage`
spans the whole grid and hides both sidebars plus the chat area, and the mobile drawer scrim is
suppressed because it is a pseudo-element of `body` rather than of the sidebar.

`settings/settings-registry.ts` supplies Instance/Manager scopes to `SettingsShell` and its button-based sidebar (`aria-current="page"`). Each page retains its save owner. `public/settings/index.html` and `settings-standalone.tsx` build to `public/dist/settings/index.html`; Classic's header gear opens `#settingsPage`, spanning the center and right sidebar, with this entry in a titled iframe and Instance scope only. The same header moves into the page while chat is hidden/inert; the right sidebar retains only Agents and Skills. Back/Escape request the iframe's dirty guard before `settings:back` returns to chat and restores composer focus. Theme messages are source/origin checked and the relative iframe URL preserves legacy proxy prefixes.

`SettingsPage` wraps the existing Shell save owner for both Workbench and Dashboard settings mode. Navigation uses Back, group eyebrows and 16px registry icons; the 264px nav collapses to 40px icon buttons below 1024px viewport width. The rounded content area caps its inner width at 896px with 32px horizontal padding, a 24px title (30px in wide settings hosts), 12px section cards and divided 16px/12px rows. Controls use 192px (280px for wide hosts), with the existing below-720px host rule stacking fields. Instance selection and Manager registry saves retain their distinct clients and dirty owners.

Classic's t3 shell uses system UI/mono fonts, alpha surface/border tokens, a 44px header and segmented sidebar tabs, with explicit dark/light values. Classic focus uses the box-shadow token `--focus-ring-shadow` plus a forced-colors outline; Manager and standalone Settings use `--focus-ring` as an outline. `activity.css`, `layout.css`, `manager-layout.css` and `settings-controls.css` disable scoped transitions/animations (including pseudo-elements) at reduced motion without changing expanded visibility or chevron rotation. Activity's polite status stays outside details; Legacy Stopped/Failed remains visible and Requests/final answers retain their owners.

Model defaults uses `ModelProvider.tsx` → `PerCliRow.tsx` →
`runtime-transport-field.tsx` for explicit Cursor/Grok/Claude native opt-in or
print compatibility. Absence migrates to native once on load; the field still renders a stored print honestly and reads only its own pending
dirty entry or server original, not a model-draft shadow. ModelProvider owns
save/reset singleflight, guarded inputs, captured-entry acknowledgement and
instance/read generations. See [runtime preference and save ownership](runtime-integration.md#manager-runtime-preference-and-save-ownership)
for the existing settings PUT chain, native constraints and admitted Pi completion.

Runtime native/print is separate from Activity-default/Legacy presentation and
from `preview.ts`'s `origin-port`/`legacy-path`/`none` HTTP routing. Manager embeds
the existing Classic Activity/history/native-request surface; it does not own a
second transcript or request panel. Workbench tab changes hide the same iframe;
port changes remount it, with saved-history/snapshot restoration owned by Classic.
Unsent input is not promised across A→B→A. Presentation is not part of iframe
src/key; theme still affects src. These source contracts do not certify embedded
browser, dev Electron or packaged-sidecar QA.

### Manager Settings — Pi Runtime

| 파일 | 역할 |
| --- | --- |
| `manager/src/settings/pages/ModelProvider.tsx` | Pi를 Model defaults에서 다른 CLI보다 앞에 렌더하고 `settings.pi` draft를 `PerCliRow`로 전달 |
| `manager/src/settings/pages/components/PerCliRow.tsx` | `cli === "pi"` branch: Provider dropdown, discovered-model SelectField, Effort, Settings button |
| `manager/src/settings/pages/components/PiProfileDialog.tsx` | mode(`basic`/`openai`/`anthropic`/`vertex`) + endpoint/model/API key 등록 popup; `/api/pi/profiles/register` 호출 |
| `manager/src/settings/pages/components/pi-profile.ts` | Pi profile/model option pure helper |

- Pi model field는 발견된 모델이 있으면 `SelectField`를 사용하고, 목록이 비어 있을 때만 free-text `TextField`로 fallback한다.
- Pi 전용 grid는 provider/model/effort를 bounded 1:2:1 트랙에 두고 긴 설명을 줄바꿈한다. 720px 이하의 기존 한 열 배치는 유지하며 다른 CLI grid나 설정 값/콜백은 바꾸지 않는다.
- 이미 수락된 등록이 완료되면 현재 instance의 `onPiRegistered`가 `perCli.pi.provider/model` intent를 반영한다. 페이지 저장 중에도 이 완료 처리는 허용하지만, 일반 입력은 차단하고 retired instance의 완료는 무시한다. Optional `settings.pi` metadata는 응답에 있을 때만 반영하며, 기존 dialog의 `ok/data` envelope 처리에 따른 metadata refresh 한계는 별개다. 새 provider/model 선택 반영을 전체 profile/discovery metadata 갱신 보장으로 해석하지 않는다.
| `manager/src/jaw-ceo/` | Jaw CEO console panels, orchestration-control actions, voice, virtual timeline |
| `manager/src/goal-status/` `manager/src/background-tasks/` `manager/src/workers/` | Manager runtime-observability monitors for goal/PABCD, background tasks, web-ai bgtask bridges, worker progress, durable worker runs, shared status-category display contracts, safe event timelines, and explicit bounded raw-output drill-down |
| `manager/src/notes/` | markdown notes, search sidebar, WYSIWYG editing, wikilinks, graph view |
| `manager/src/hooks/` | dashboard registry/view persistence/instance message events hooks |
| `manager/src/sync/` | dashboard sync helpers (invalidation bus, iframe/visibility bridge) |
| `manager/src/help/` | help drawer + topic content |
| `manager/src/clipboard/` | copy-text utility |
| `manager/src/lib/` | shared utilities (preview-prefs, use-hidden-unload) |

### Manager terminal interaction and ownership

Terminal tabs use stable renderer-lifetime ordinals with shell names and full working-directory tooltips. The session strip scrolls independently from New and Hide controls. Arrow/Home/End keys move tab focus; Enter/Space activates the focused tab and its terminal. Closing the selected tab chooses a neighboring session; closing another tab preserves selection.

Hide retains running sessions and returns focus to the terminal reveal control. Explicit session close requests termination of only that session. Automatic empty-panel close waits for that request to settle; rejection keeps the recovery UI available. A bridge acknowledgement is not observed process-exit proof. Natural process exit keeps the existing removal and last-session panel-close policy. Renderer unmount disposes presentation resources without killing backend PTYs. The Electron bridge owns terminal processes independently from native Code API sessions and selected chat/workspace state.

All New controls and shortcuts use hydration-first, bounded creation admission. Creation is serialized; failures preserve existing tabs and expose explicit recovery. A failed inventory read must be retried successfully before creating from an unknown inventory. Delayed create/list/exit callbacks reconcile ownership before updating inventory, closing an empty panel or moving focus. Queued requests retain their admission-time focus intent, so a later completion cannot override a newer selection. Focus changes to other controls and window blur revoke pending focus; programmatic focus is exempt only for the current terminal surface. Fit/resize errors are presentation state and do not block the natural-exit close policy. Overflow is reported without silently replaying requests. The renderer's pending-request bound is separate from the backend's existing live-session limit.

Light/dark/auto changes update the existing xterm palette and matching terminal canvas without recreating sessions. Terminal chrome uses Manager theme tokens; it has no separate stored theme preference. Full working directories remain display metadata and do not silently reassign a live shell.

Manager 서버는 `jaw dashboard serve`가 실행하는 `src/manager/server.ts`이며 기본 port는 `24576`. React manager app은 `/api/manager/events`, `/api/dashboard/instances`, `/i/:port/api/messages/latest` 계열 polling으로 상태를 읽는다. Worker live bridge는 browser가 직접 EventSource를 여는 구조가 아니라 manager server의 `src/manager/worker-events.ts` + `src/manager/worker-sse-client.ts`가 각 worker instance `GET /api/events`를 server-side 구독하고 latest-message cache를 갱신하는 구조다. Jaw CEO right panel은 completion/watch/voice/orchestration control을 소유하고, Code mode monitor panels는 `/api/manager/runtime-status`, `/api/bgtask`, `/api/orchestrate/worker-progress` 기반 runtime observability를 소유한다. web-ai long task는 BrowserPanel이나 Code transcript가 아니라 `preset: "web-ai"` background task로 등록되며, monitor retry도 native web-ai session id를 보존한 preset 재등록을 사용한다. Background task monitor는 terminal completion, cancellation/orphaning, and notification handoff 모두를 `bgtask_update` + `GET /api/bgtask` hydration으로 반영한다. Worker Runs and Background Tasks remain separate panels and stores, but their client contracts preserve shared `statusCategory` so UI comparisons do not duplicate native status mapping.

---

## ProcessBlock / Subagent Rendering

tool history의 canonical UI는 `features/process-block.ts`다. `ui.ts`는 live channel event(SSE primary / legacy WS fallback), persisted `tool_log`, IndexedDB fallback, virtual-scroll history 모두를 `ToolLogEntry[]` → `ProcessStep[]` → ProcessBlock HTML 흐름으로 맞춘다.

| 관심사 | 현재 구현 |
| --- | --- |
| 타입 보존 | `ws.ts`는 `msg.toolType === 'subagent'`를 `ProcessStep.type = 'subagent'`로 넘기고, unknown type만 `tool`로 떨어진다 |
| Summary split | type별로 `Thinking`, `Search`, `Subagent`, `Tool`을 따로 count |
| row layout | `.process-step-toggle`은 `auto 16px auto minmax(0, 1fr) auto` grid |
| rawIcon / SVG policy | `renderTrustedIcon()`은 `<svg...`로 시작하는 값만 SVG로 삽입, 나머지는 escape |
| running → done merge | `stepRef` 기반 매칭 우선, 없으면 같은 label의 running row 매칭 |
| done-only fallback blocking | `stepRef`가 있는 done/error 이벤트는 legacy fallback을 타지 않음 |
| repeated done-only dedup | 같은 `stepRef`의 done/error row가 이미 있으면 `replaceStep()` |
| single-owner invariant | `.agent-body > .process-block` 하나만 허용, `normalizeAgentToolBlocks()`가 정리 |
| layout mutation anchor | `window.__jawProcessBlockLayoutMutation(anchor, mutate)` bridge로 virtual-scroll remeasure + row-top anchor 보존 |
| lazy history render | virtual-scroll history item은 mounted lazy render 시점에 ProcessBlock detail HTML 생성 |
| mermaid cleanup | unmount/deactivate 전 `releaseMermaidNodes()` 호출 |
| long-turn step window | `steps.length > 80`이면 head 24 + tail 24 + running/error만 DOM에 렌더; 가운데는 `[data-expand-steps]` 버튼으로 opt-in 전체 펼침 |
| live state ownership | `blockStatesByElement` WeakMap은 `createProcessBlock()` 라이브 블록만 등록; hydrate/virtual-scroll remount 블록은 WeakMap 미스 가능 |
| hydrated expand fallback | `[data-expand-steps]` 클릭 시 WeakMap 미스면 `reconstructStepsFromBlock(block)`이 `dataset.processStepIds` + `processStepMetaStore`에서 **전체** step list 복원(elided middle 포함) |
| DOM-only restore limit | `currentProcessBlockFromDom()`는 보이는 `.process-step` row만 스캔 — long-block middle 복원은 `reconstructStepsFromBlock` 경로 필수 |
| detail release + placeholder | virtual-scroll unmount 시 `releaseProcessBlockDetails()`; `detailLength>0` step은 `data-had-detail` 표식; release 후 빈 펼침은 reload hint 표시 |

### ProcessBlock key exports (`features/process-block.ts`)

| Export | Role |
| --- | --- |
| `buildProcessBlockHtml(steps, collapsed?)` | history hydrate HTML; sets `dataset.processStepIds`, populates meta store |
| `createProcessBlock` / `addStep` / `replaceStep` / `collapseBlock` | live SSE path; registers `blockStatesByElement` |
| `reconstructStepsFromBlock(block)` | hydrated/recycled block용 전체 step 복원 — elided middle 포함 |
| `releaseProcessBlockDetails(root)` | virtual-scroll unmount, agent switch 시 in-memory detail/meta 해제 |

---

## PWA / Assets

| 자산 | 현재 구현 |
| --- | --- |
| `manifest.json` | `standalone`, `background_color: #0b1220`, `theme_color: #22d3ee`, 192/512/maskable icons |
| `sw.js` | navigation network-first, `/dist/assets/*` cache-first, 그 외 stale-while-revalidate |
| `icons/` | `favicon-32.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `mascot.png` |
| `assets/providers/` | `antigravity(-color)`, `claude(-color)`, `copilot(-color)`, `cursor(-color)`, `gemini(-color)`, `grok(-color)`, `kiro(-color)`, `openai`, `opencode`, `discord`, `telegram`, `slack` |
| `assets/fonts/` | `GeistVF.woff2`, `JetBrainsMono-Variable.woff2` |
| `locales/` | `ko.json`, `en.json`, `ja.json`, `zh.json` |

브랜드 PNG/ICNS/tray template은 모두 `scripts/brand/mascot-master.png` 마스터에서 `scripts/brand/generate-brand-assets.py`로 재생성한다.

---

## 현재 런타임 흐름

| 단계 | 구현 사실 |
| --- | --- |
| 초기화 | `hydrateIcons()` → `hydrateProviderIcons()` → `initI18n()` → `loadCliRegistry()` → `connect()` → `initAvatar()` + pending/help/attention 초기화 |
| 입력 | slash command dropdown, file attachment, drag/drop, auto-resize, voice record/cancel, STT mic pending state |
| 전송 | 일반 메시지는 `/api/message`, slash command는 `/api/command`, stop 버튼은 `/api/stop` |
| 렌더링 | `render.ts` façade → `renderMarkdown()`의 marked parse → sanitize/unshield → render delegation 흐름. 인라인 `/uploads/`는 `/media`, 그 외 로컬 절대경로는 인증된 `/api/image`로 보내며, history lazy hydrate/virtual-scroll 재사용도 `renderMarkdown()` 경로를 공유한다. 나머지 `public/js/render/*` 모듈이 KaTeX/Mermaid/code copy/diagram widget/file-path click-to-open/external web-link new-tab targeting/post-render를 담당한다. |
| 오프라인 | `idb-cache.ts`가 메시지 히스토리를 IndexedDB에 보관 — scope별 캐시, 실시간 upsert |
| Event channel | `GET /api/events` SSE primary channel handles `agent_tool`→typed ProcessBlock step, `agent_output`→streaming renderer, `agent_done`→finalization; `ws.ts` is the shared dispatcher and legacy WebSocket fallback for pre-X-01 servers. Transient SSE drops are quiet for 8 seconds before the UI posts a disconnected message. |
| 상태 | `agent_status`, `queue_update`, `orc_state`, `session_reset`, `clear`, Telegram/Discord `new_message` |
| 반응형 | sidebar collapse/expand, mobile edge swipe, theme switch, PABCD roadmap, voice shortcut(`Ctrl/Cmd+Shift+Space`, `Alt/Option+M`) |
| Manager | 별도 React 앱이 dashboard API polling으로 Jaw 인스턴스 scan/preview/lifecycle, notes, board, reminders, schedule, CEO console, **Telegram Hub** settings을 관리하고, manager server가 worker SSE bridge/cache를 담당 |

---

## Runtime Hardening Invariants

| 영역 | invariant |
| --- | --- |
| Web UI runtime tests | `tests/unit/web-ui-test-dom.ts`가 jsdom globals를 먼저 설치 |
| ProcessBlock DOM recovery | `.process-step` row는 `data-step-id`, `data-type`, `data-status`, `data-step-ref`, `data-start-time` 보존 |
| ProcessBlock recycle | unmount 시 `releaseProcessBlockDetails()`; expand 복원은 `dataset.processStepIds` + meta store. DOM row만으로 long-block middle 복원 금지 |
| Released detail UX | `data-had-detail="true"` when `detailLength>0`; empty expand after release shows reload hint |
| Restore bottom-follow intent | `scrollIntent = unknown/following/pinnedAway` 기준 guarded reconciliation |
| Inline image failure delegation | `renderMarkdown()`이 설치하는 document-level `error` capture listener는 한 번만 등록된다. `error`가 bubble하지 않아도 현재/late/lazy `.chat-inline-img`를 `.chat-inline-img-error[role="status"]`로 교체한다. |
| Build output guard | `npm run check:frontend-build-output`가 eager Mermaid reference 차단 |
| Tool-log memory cap | Server-side `sanitizeToolLog*()` caps before ProcessBlock/Manager hydration |

---

## UI 모달/팝업 규약

### 메인 Web UI

모달/팝업은 **`document.body`에 동적 생성**. `help-dialog.ts` 참조:
1. overlay → `className = 'modal-overlay'` → `document.body.append(overlay)`
2. box → `role="dialog"` + `aria-modal="true"`
3. 열기: `.open` 클래스 추가
4. 닫기: `.open` 제거 + Esc 키
5. CSS: `public/css/modals.css`

### Imperative DOM islands (sanitize 경계)

메인 Web UI는 vanilla 구조라 `innerHTML` 직접 조립 지점이 많다(2026-07-06 기준 약 169곳;
최다 소유자는 `features/settings-mcp.ts`, `features/process-block.ts`, `features/settings-core.ts`,
`features/settings-cli-status.ts`, `features/memory.ts`). 규약:

- HTML escape의 단일 소유자는 `public/js/render/html.ts`의 `escapeHtml()`이다. 새 로컬
  `escapeHtml` 복제를 만들지 말고 import한다.
- interpolation(`${...}`)이 들어가는 `innerHTML` 템플릿은 반드시 `escapeHtml()` 또는
  `render/sanitize.ts` 경로를 거친다. 서버/유저 설정 문자열을 렌더링하는 settings-* 계열이
  최우선 검토 대상이다.

### Manager Dashboard

React 컴포넌트에서는 `role="dialog"` + `aria-modal` 패턴.

### 두 UI 간 기능 동기화

백엔드 API는 동일, 프론트엔드만 다름 (Vanilla JS vs React). 기능 추가 시 양쪽 모두 구현 필요.

### Classic asynchronous intent ownership

`features/chat.ts` and `features/settings-core.ts` share a settings-save barrier,
but completion of that barrier is not ownership of the current editor value.
A send owns its captured prompt; clearing the composer must not erase an edit
made while that send was waiting. Likewise a settings read belongs to the CLI,
provider and local model/effort selection that initiated it. A later selection
or local edit invalidates that read's right to repaint the shared controls.
Each send tracks input events for the lifetime of that submission and checks the
original textarea plus raw value before clearing any ordinary, slash-command or
attachment draft. Editing A to B and back to A still preserves the draft; the
listener is removed when the send settles. CLI reads capture a generation, edit
revision and control identities. Model/effort saves and custom-model typing
invalidate pending reads; provider mismatches cannot restore a stale effort.
Regressions delay the save/read, change local intent, and verify both the
submitted value and preserved controls, including ABA and replaced DOM owners.

## Native Code workbench

Manager Code uses `/api/code` with isolated Codex, Claude, Cursor and Grok
sessions. Runtime and workspace are fixed at creation; idle session model, effort,
Claude thinking and approval policy changes use optimistic revision checks. New-session and
per-session prompt drafts survive selection changes and page reloads in the same
browser tab. A bounded, versioned sessionStorage record keeps text, choices and
request uncertainty; it stores no transcript, native cursor or permission answer.
Uncertain creation/send recovery requires explicit action and never auto-submits. Auto (YOLO) is an explicit
provider capability, and opening the catalog never launches a process.

The composer dock groups its controls by how often each is touched:
`[runtime glyph] [permission] ····· [model] [effort] [thinking (Claude only)]` on one row, with dictation
and send trailing the input. Runtime is icon-only and carries its name on the
button (`aria-label="Runtime: Codex"` plus a title) while the brand SVG stays
`aria-hidden`; the marks come from `public/assets/providers`, inlined in
`ProviderGlyph.tsx` because the Manager bundle has no `?raw` convention.
Model is a filterable dropdown rather than free text — a newly chosen model
outside the catalog is rejected, so typing could only produce a 400 — and a live Codex
catalog carries 28+ routed ids. Effort offers the intersection of the selected
model's advertised set and, for an open session, the capabilities it stored at
creation; the server checks both. Dictation records through `MediaRecorder` and
posts to `/api/voice` with `x-stt-only`, appending the transcript to the draft
instead of sending it, and stays disabled with a stated reason when the browser
has no `mediaDevices`.

A submitted prompt is visible before the server echoes it. The pending item is
derived from the draft at read time, not inserted into the session reducer,
which applies strictly sequence-ordered server events; `clientTurnKey` joins the
two so the real item replaces the local one. Tool calls collapse to one action
line (`Read src/app.ts`, `Bash npm test`) and open only on failure, `Done` is
not printed, and user messages use a right-aligned bubble while the assistant
keeps the full column as plain prose.

Turn boundaries are bookkeeping and never become transcript rows: `turn_started`
and `turn_completed` stay in the store and on the wire, where history replay and
the failed-input recovery lookup still read them, but the transcript filters them
out. `turn_failed` and `turn_cancelled` remain visible because a reader can act
on them. A call that has not settled reads in the present tense (`Reading`,
`Running`, `Searching`) with a streaming marker on the summary line, and settling
changes only the tense, so no badge repeats what the verb already says; the
settled vocabulary and an unrecognised tool's own name are unchanged. Tool and
reasoning detail is built only while its disclosure is open, and the transcript
owns that open state, scoped per session and bounded, because the virtualizer
unmounts rows. A reader's choice outlives the failure default, so a failed call
that has been read can be closed. The disclosure is part of the virtualizer's
item key: a measured size always wins over an estimate, so a row measured while
collapsed would keep that height once expanded, and re-keying hands it back to
the estimate until its real height is observed. Overflow inside an open body is
measured on every capped pane, the call's own detail paragraph included, and an
expansion the body no longer justifies is retracted rather than left holding
`Show less` and an uncapped pane over content that fits. A running call reads as
waiting only while it has neither output nor a detail of its own to show.

Notices sit over the transcript, directly above it rather than absolutely
positioned from the pane, which would place them inside the workspace header and
swallow clicks meant for its picker. They are keyed per source, so repeating one
replaces it and restarts its timer instead of stacking; the stack is capped at
three, and re-raising a notice moves it newest so the cap cannot evict what was
just triggered. A notice with no finite duration waits for an explicit dismiss,
and the timer is held while the pointer is over the card or focus is inside it,
because unmounting a card that owns focus drops it to the document body.

The permission warning is derived from the current policy rather than from a
transition, and it does not expire: it is re-raised on every mount, so it
survives a draft becoming a real session, and it is retired when the policy
leaves Auto rather than outliving what it describes. One polite live region,
mounted before there is anything to say, since a region that arrives together
with its first message is not announced. Anything the reader must act on stays
inline instead, including footer errors, transport status, the recovery strips
for unconfirmed creation and unconfirmed send, archived sessions and the
approval queue; each carries a recovery path a self-dismissing notice would take
with it.

`useCodeController` owns requests and selection fencing. A single Code SSE
subscription reconciles a full snapshot at watermark H and contiguous events
after H. Opening transport does not mean synchronization has completed. Compact
updates append once to stable item IDs. Older materialized history adds missing
rows without overwriting current content or advancing the live cursor.

The composer stays editable while a turn runs. Stop targets the captured turn
and epoch. While a synchronized Claude session streams, `Send follow-up` sits beside Stop
and posts `/steer` with that turn's captured `turnId`, `epoch` and a fresh key; an idle
session still sends `/prompt`, and any other busy runtime offers Stop only. The attempt
lives in the draft's in-memory `steer` field, never in `operation`, `retry`, `awaitingTurn`
or sessionStorage, so its completion cannot overwrite a Stop in progress. Both Send buttons
close while it is in flight (`Sending follow-up…`), and Send follow-up closes while Stop is
pending or unconfirmed and once the synchronized transcript holds the current turn's
follow-up (`<turnId>:steer:`). The input clears only on a matching receipt or the follow-up's own
`user_message` (from an event or a later snapshot), and only if it was not edited since; a 4xx
keeps the text with its reason. Anything else reads `Follow-up delivery not confirmed` and is
never resent: a lost response adds that it appears in the conversation if Claude received it,
while a 503 `steer_outcome_unknown` says Claude may have received it but it will not appear. A
follow-up the turn never consumed reads `You · Delivery not confirmed`. An uncertain prompt acknowledgement offers explicit retry of the
original key and text; reconnect never resends automatically. Each approval has
its own pending/error state and forwards the native opaque choice. Session rows
support rename, archive/restore, current-workspace filtering and paging.

The session list has two views, modeled on the Codex desktop sidebar. **Projects**
(the default) groups sessions under their workspace folder, newest session first
inside a group, and places a group by its newest session; the group heading shows
the folder name (full path in its title) and a `+` that starts a draft there. The
server returns sessions by last activity, which would move a session to the top of
the list while the reader is looking at it merely because it answered a prompt;
Projects never does that, and which session is running is carried by the row's own
status instead. The **bell** in the header switches to **Recent activity**, the view
the reader chose to see movement in: a **Priority** section with unread sessions
(newest completion first), then Today, Yesterday and Earlier by last activity at
local midnight, each row showing its workspace name. A session is unread when
`lastTurnCompletedAt > lastVisitedAt`; never-opened, archived and the currently open
session are never unread. Unread rows and the bell (when anything is unread) carry
a blue dot. The chosen view persists in `localStorage` (`jaw.code.sidebarView`). There is no All / This cwd toggle (Projects already
scopes by workspace); a search icon left of the bell opens the search field together
with an Archived switch, and closing it clears the query so nothing stays filtered
by a hidden box.
From Send until that send's own turn ends, the session reads as working: the row
shows a spinner (and "Starting" while the server still reports idle) and the
transcript ends with a "Working…" line unless a running row already animates. The
client marker is tied to the send's `clientTurnKey` and clears only when the server
reports the turn busy, the turn's own terminal item arrives, or the send is rejected;
a newer idle snapshot alone (such as a read-receipt echo) does not clear it, and it is
never persisted. Sending to a suspended or recoverably failed session attaches it
first and then sends, as t3code continues a thread on the next message; the Resume
action remains for attaching without sending. The Claude permission menu lists the live catalog's six modes (Ask first, Accept
edits, Plan, Auto review, Don't ask, Auto (YOLO)) rather than the session snapshot; the
standing warning stays on Auto (YOLO). Claude approval cards may offer "Allow for this
session". Claude sessions and drafts add a Thinking menu (Thinking on / Thinking off) after
Effort; it is hidden for other runtimes, and a draft that leaves Claude drops the switch.
A Claude session whose server reports `rollback.available` shows "Roll back
conversation to here" under each settled `${turnId}:user` row at or after
`rollback.sinceSequence` that has a later turn, while the session is idle or failed,
synchronized, not archived and no other operation or follow-up POST is in flight; the
unsent row and follow-up rows never get it, and an older server without the field reads
as unavailable. It
asks first ("Later turns are removed from this conversation. Workspace files are not
changed. No prompt is sent."), posts only the opaque row id with the revision and
epoch it saw, shows "Rolling back conversation…" and then takes a fresh snapshot; a
refusal keeps the transcript and names the reason (a revision conflict reads "The
conversation changed since you chose this point", a missing boundary names a turn that
never reached Claude or a compaction). A `code_session` event with a higher
`historyGeneration` makes the reducer take a new snapshot. A rollback, including one seen
from elsewhere, retires an awaited send whose own row it removed and makes Retry use a
new key; its recovery strip, kept across reload, reads "This message's turn was removed
by a rollback. Files it changed were not reverted. Retry sends it as a new message.". A
same-key retry the server answers `cancelled` for a turn absent from the post-rollback
transcript reads the same, which is all a reloaded page can go by. An unconfirmed follow-up
whose turn is absent after a rollback stops being reported as unconfirmed, also when the
page had dropped that session's transcript.
Archived sessions, when shown, form a trailing section ordered by when each was put
away. A section with nothing in it is not rendered. Idle status and "no pending approvals" stay in the
accessibility tree but are visually hidden, because a label on every row costs
the one row that is actually waiting its visibility; an unhydrated approval
count remains unknown rather than being shown as zero.

Context usage is reported by the runtime and shown in the composer footer as a
ring beside the model. Occupancy is read from the runtime's last turn, which is
what is resident in the context; the conversation-wide total is a spend
accumulator that adds every turn including the prompt resent each time, so it
passes the window many times over in ordinary use and is carried separately as
processed tokens rather than driving the gauge. Usage is derived at read time
and never persisted, like the pending approval count, because it describes a
live native process. There are three states and they are distinct: nothing
reported renders nothing, a count without a window shows the count alone since
a proportion of an unknown total is not a proportion, and a count with a window
shows a percentage. A count past the window caps the ring, which cannot draw
past full, but says so rather than reading as a genuinely full context. Every
part of the breakdown is nullable and an unreported field shows as absent,
never as zero. Thresholds change the ring colour at 75 and 90 percent, and the
accessible name carries the numbers the ring cannot.
Usage is bound to the runtime that reported it and is dropped whenever that
runtime is retired or exits, including disposal, an idle reap and a model
change, rather than leaving a measurement of a process that is gone or a
proportion of a window that no longer applies.

Because it is attached at read time, usage travels on snapshots and listings
and not on stored session events, which are built from the persisted record.
A session event therefore carries no usage, and the client keeps the figure it
already has rather than blanking the meter on every unrelated status change.
The number is refreshed by a snapshot, a session switch or an explicit refresh,
so between those it can lag the runtime; it is old rather than invented, and
the alternative would be a session frame per token notification against the
turn's byte budget.

The transcript renders sanitized Markdown, math and linear tables with stable
virtual rows. Tool output stays escaped; local files open only after an explicit
click. Endpoint/session changes reset measured heights and scroll ownership.

Retired runtime settings preserve a saved JWC selection as an explicit retired
value. It is absent from runtime choices, including stale registry responses,
employee creation and fallback menus. Existing employee and flush selections stay
visible, and their model controls are disabled until a supported runtime is
chosen. Classic native selects keep a disabled selected tombstone so rendering
cannot silently choose the first available runtime. No settings write occurs
merely from displaying the retired value.

Settings navigation tracks the Instance and Dashboard drafts separately. Leaving
Dashboard, closing Instance settings or changing instance confirms only drafts
that the transition discards. Retained pages preserve their drafts. Both keyboard
and desktop shortcut subscriptions observe Dashboard dirty-state changes even
when a retained Instance draft already keeps the aggregate dirty flag true.

Employee forms keep each label above its control within the roster column, and
collapse to one column in narrow settings containers. Expanding a select menu
returns focus to its combobox so Escape dismisses the menu before page navigation.
