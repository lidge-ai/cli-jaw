---
created: 2026-03-28
tags: [cli-jaw, prompt, system-prompt, template]
aliases: [A1 system prompt, CLI-JAW A1, system prompt template]
---

> 📚 [INDEX](INDEX.md) · [프롬프트 흐름 ↗](prompt_flow.md) · **A1 시스템 규칙** · [A2](prompt_basic_A2.md) · [B](prompt_basic_B.md)

# prompt_basic_A1 — 시스템 프롬프트 기본값

> 경로: `~/.cli-jaw/prompts/A-1.md`
> 소스: `src/prompt/templates/a1-system.md`
> 구현: `src/prompt/builder.ts` → `getA1Content()` / `initPromptFiles()` / `getSystemPrompt()`
> 파일 우선: `A-1.md`가 있으면 사용자 편집본 사용, 없으면 템플릿 렌더 결과 사용
> `A1_CONTENT` 상수는 더 이상 없음

---

## 현재 로딩 방식

| 단계 | 동작 | 코드 |
|---|---|---|
| 1 | `A-1.md` 존재 시 이를 persisted 원본으로 사용 | `getSystemPrompt()` |
| 2 | `A-1.md`가 없으면 `a1-system.md`를 렌더링한 원본 사용 | `getA1Content()` |
| 3 | 런타임은 desktop/browser 의도일 때만 원본의 `desktop-control` anchor를 포함; `forDisk`는 항상 원본 유지 | `shouldIncludeDesktopControlSection()` / `getSystemPrompt()` |
| 4 | 첫 설치 시 `initPromptFiles()`가 `A-1.md`와 `.hash`를 생성 | `initPromptFiles()` |
| 5 | 해시가 달라졌을 때 사용자 편집본이면 보존, stock 파일이면 새 템플릿으로 이관 | `resolveLegacyA1Migration()` |

> 핵심은 "파일 우선, 템플릿 폴백"이다. 예전처럼 코드 상수 하나로 고정된 구조가 아니다.
> Computer Use 전환에서는 이전 배포본의 정상 `desktop-control` anchor 해시를 새 MCP 안내로 이관한다. Anchor 밖의 이전 item 5 문구는 완전한 줄로 정확히 한 번 있을 때만 바꾸고, 사용자 수정본이나 중복 문구는 보존한다.

---

## 템플릿 구조

`a1-system.md`는 시스템 프롬프트의 정적 골격을 담당한다. 현재 템플릿은 다음 축으로 구성된다.

- `Rules`: 응답 언어, 결과 보고, git 안전장치, 짧고 구조적인 Markdown
- `Project root`: `{{JAW_HOME}}`과 실제 repo를 분리하고, 주입된 Project root는 명시적 변경/해제 전까지 유지한다. 사용자가 다른 repo/project를 명확히 지정하면 stale root를 계속 쓰지 말고 한 번 확인하거나 `cli-jaw project set` / `cli-jaw project clear`로 전환한다.
- `Structured Elicitation UI`: 선택지가 명확한 clarification은 짧은 설명 + standalone `elicitation` fence로 출력할 수 있다. JSON은 작고 완전해야 하며, 단순 prior-answer branching은 `visibleWhen: { "<priorQuestionId>": ["<optionValue>"] }`만 쓴다. question/label/description에는 raw HTML/XML-like internal tag text를 넣지 않는다. 프로젝트별 판단이 헷갈리면 repo `AGENTS.md`와 `structure/`를 다시 확인한다.
- `Structured Renderer Output`: Web UI에서는 답변 목적에 맞는 가장 작은 전용 fence를 쓴다. `search-results`는 검색/출처 목록, plain external link는 link preview, `compose-block`은 이메일/메시지/문서 초안, `chart-json`은 단순 bar/line/pie, `dataframe`은 필터/정렬/페이지가 필요한 표, `diff`/unified diff는 패치 표시가 소유한다. 이 fence들을 출력하기 전에는 `{{JAW_HOME}}/skills/jaw-structured-renderers/SKILL.md`를 읽고, `compose-block`은 `compose-block-v1` + `variants[]` 스키마를 사용하며 `type/title/body` shorthand를 쓰지 않는다. 고급 인터랙션/지도/비표준 차트/외부 JS가 필요하면 기본적으로 `diagram-file`로 올리고, 현재 chatId를 알 수 없거나 아주 작은 throwaway widget일 때만 `diagram-html`을 fallback으로 쓴다. Web UI widget을 못 쓰는 채널은 plain text로 fallback한다.
- `Fail fast`: 실패를 숨기지 말고 즉시 보고
- `Search routing`: 버전/오류/API/현재 정보 질문은 native cli-jaw search 경로를 우선하고, 한국어/source-sensitive 검색은 1-3개 focused query로 재작성한 뒤 URL 후보의 원문 fetch/open 검증을 거친다.
- `jaw Employees vs CLI Sub-agents` + `When to Use Which`: Boss dispatch와 CLI 내부 sub-agent를 구분
- `How jaw Works (Architecture)`: Boss/employee 흐름과 `$computer-use` 토큰, `cli-jaw dispatch` 타임아웃, `cli-jaw worker status/watch` 직원 progress 조회 힌트. `snapshot.workers`는 running-only이고 완료된 worker progress는 `worker-progress.previous`에 있다.
- `Desktop / Browser Control (MANDATORY)`: `$computer-use` 트리거, `jaw-computer-use` MCP의 `js` 도구(Claude에서는 `mcp__jaw-computer-use__js`) 또는 Codex 기본 Computer Use 플러그인으로 직접 수행하는 경로, 빠른 `cli-jaw browser` CDP/Web UI 경로, 별도의 Codex 전용 legacy vision-click fallback, transcript format, 금지 항목. Computer Use 첫 호출에서 반환된 `cua` API 문서를 읽고 거기에 나온 동작만 사용한다. 도구가 없으면 `precondition failed: no Computer Use surface`, 첫 앱 호출이 막히면 `precondition failed: computer-use app access blocked`로 구분한다.
- `Channel File Delivery` (+ Discord/Slack notes): canonical local API, transport와 conversation ID 구분, target 생략 시 현재 Slack thread 보존, explicit `targetId` + parent `threadId` JSON 예시
- `Long-term Memory (MANDATORY)`: `{{JAW_HOME}}/memory/structured/` 경로, L1 `cli-jaw memory ...` current-instance read/write, L2 `cli-jaw dashboard memory ...` cross-instance read-only 경계, 저장 가이드
  - **Compact Handoff Interpretation**: `/compact` 핸드오프 후 trust table(section별 High/Medium/Low) + decision tree(goal 검증 → memory search → file open 순서)
- `Search routing — file vs web`: 로컬 코드/로그/심볼은 file search, 외부·현재 정보는 active `jaw-search` skill 또는 web/official-docs 경로를 사용한다. `agbrowse research plan`은 query-planning 보조일 뿐 provider 실행 경로가 아니며, `k-writing`/`lecture-stt` 같은 private runtime skills는 public `skills_ref` surface로 문서화하지 않는다. 한국어 홍보/콘텐츠 작성 작업은 구 `k-thread-gen` 라벨이 아니라 active `k-writing` skill로 라우팅한다.
- `Goal System`: goal CLI 명령어 + `[goal-continuation]` 포인터 스텁. goal-mode 행동 규칙(autonomous advance, pause audit, evidence bundle)은 continuation 프롬프트(`src/goal/heartbeat.ts`)가 단일 소유 (260610 2차 슬림)
- `Heartbeat System`: `heartbeat.json` 자동 재로드
- `Development Rules` + `Dev Skills`: ES Module, 500줄 제한, try/catch, 작업 전 `dev/SKILL.md` 읽기
- `Diagrams (MANDATORY)`: 다이어그램·SVG·Mermaid를 위한 skill 우선 규칙과 인라인 전달 규칙
- `Session-poll (anchor)`: turn 종료 금지 규칙 — 작업 중 exit 방지, stuck detection 15분 타이머

---

## 리셋/수정 기준

| 상황 | 결과 | 자동 복구? |
|---|---|---|
| `A-1.md` 삭제 | `a1-system.md` 렌더본으로 재생성 | ✅ |
| `A-1.md` 내용 수정 | 수정본 그대로 사용 | ✅ |
| stock 템플릿 변경 | `.hash` 기준으로 stock 여부를 다시 판정 | ✅ |
| 사용자 커스텀 파일 | 해시가 달라도 보존 | ✅ |

> `A-1.md`는 설정 파일이 아니라 사용자 편집 가능한 시스템 프롬프트 캐시다. `getSystemPrompt()`는 이 파일을 최상단에 그대로 붙이고, 동적 섹션(memory injection, orchestration, heartbeat, skills, vision-click, delegation rules)을 그 뒤에서 추가한다. 이전에 A1 다음에 붙던 timestamp stamp(`YYMMDD-HH:MMAM/PM.`)는 현재 코드에서 제거됐다.
