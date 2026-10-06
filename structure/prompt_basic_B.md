---
created: 2026-03-28
tags: [cli-jaw, prompt, cache, system-prompt]
aliases: [B prompt cache, CLI-JAW B prompt, regenerated prompt]
---

> 📚 [INDEX](INDEX.md) · [프롬프트 흐름 ↗](prompt_flow.md) · [A1](prompt_basic_A1.md) · [A2](prompt_basic_A2.md) · **B 조립 결과**

# prompt_basic_B — 조립 결과 + 스킬/MCP/하트비트 기본값

> B.md = `getSystemPrompt({ forDisk: true })` 결과 캐시
> 경로: `~/.cli-jaw/prompts/B.md` + `{workDir}/AGENTS.md`
> 구현: `src/prompt/builder.ts` → `getSystemPrompt()` + `regenerateB()`
> 관련 템플릿: `a1-system.md`, `a2-default.md`, `orchestration.md`, `heartbeat-jobs.md`, `heartbeat-default.md`, `skills.md`, `employee.md`, `worker-context.md`, `vision-click.md`

---

## 현재 생성 경로

`regenerateB()`는 캐시를 지우고 `getSystemPrompt({ forDisk: true })`를 다시 조립한 뒤 두 곳에 저장한다.

| 출력 대상 | 역할 |
|---|---|
| `~/.cli-jaw/prompts/B.md` | 디스크 캐시 |
| `{workDir}/AGENTS.md` | 현재 워크스페이스용 지침 파일 |

`AGENTS.md`는 Codex, Copilot, OpenCode가 직접 읽는 런타임 지침이라서, B.md와 같은 본문을 공유한다. `forDisk: true`이므로 persisted A-1의 `desktop-control` anchor를 항상 유지하고, 조건부 제외는 turn별 `forDisk: false` 조립에만 적용한다.

---

## 조립 순서

현재 `getSystemPrompt({ forDisk: true })`의 실제 순서는 다음과 같다.

1. `A-1.md` 파일 우선, 없으면 `a1-system.md` 렌더 결과
2. `A-2.md` 파일 우선, 없으면 빈 문자열
3. legacy 세션 메모리 보강 (`appendLegacyMemoryContext()`)
4. `MEMORY.md` 코어 메모리
5. forDisk 전용 `## Core Memory` 보강 — `loadProfileSummary(600)` + `buildTaskSnapshot('current session context', 1500)` 결과를 추가 (advanced memory가 준비된 경우에만)
6. 직원이 있을 때 orchestration prompt + PABCD guide
7. `Dev Work Classification (contract)` — C0-C5 분류와 C4 promotion/verification floor
8. 활성 heartbeat job이 있을 때 heartbeat 섹션 (`heartbeat.json` 기준)
9. active skills + reference skills 섹션
10. Codex 활성 CLI일 때 vision-click legacy fallback hint
11. forDisk가 아닐 때 runtime context + pre-prompt context hooks
12. `Bounded Local Search Contract`
13. delegation rules

이전 버전에 있던 timestamp stamp는 현재 `getSystemPrompt()`에서 제거됐다.

---

## 현재 핵심 동작

### Memory

- `appendLegacyMemoryContext()`는 `flushEvery`의 절반 간격으로 최근 세션 메모리를 주입한다
- `forDisk: true` 경로는 advanced memory injection 블록(`## Memory Runtime`)은 쓰지 않지만, 끝부분에 `loadProfileSummary(600)` + `buildTaskSnapshot('current session context', 1500)` 결과를 `## Core Memory` 아래에 덧붙인다
- `MEMORY.md`는 50자 이상일 때만 읽고, 1500자를 넘으면 잘라서 넣는다

### Orchestration

- 직원이 1명 이상이면 `orchestration.md`가 렌더된다
- 그 뒤에 `dev-pabcd/SKILL.md`가 있으면 `PABCD Orchestration Guide`가 추가된다
- `Completion Protocol`은 orchestration 템플릿 내부에 포함된 현재 규칙이다
- PABCD A/B dispatch 예시는 task body 첫 줄에 `Project root: <absolute path>`를 넣도록 안내한다. 직원은 repo-relative path를 이 root 기준으로 해석하고, `~/.cli-jaw*`/JAW_HOME/employee temp cwd를 repo root로 추론하면 안 된다.
- orchestration prompt는 직원 stdout 밖의 조회 경로도 짧게 안내한다. Boss는 `cli-jaw worker status [agent] --port <port>` 또는 `cli-jaw worker watch [agent] --port <port>`로 current/previous safe-summary progress를 확인할 수 있고, `snapshot.workers`는 running-only다.

### Heartbeat

- 잡이 1개 이상이면 `heartbeat-jobs.md`가 붙는다
- 각 잡은 enabled 상태와 스케줄 설명, 앞부분 prompt 미리보기를 포함한다
- `HEARTBEAT.md`는 별도 편집 파일로 유지되지만, 현재 B 조립에는 직접 포함되지 않는다

### Skills

- active skills는 `{{JAW_HOME}}/skills/`
- reference skills는 `{{JAW_HOME}}/skills_ref/registry.json`
- 둘 중 하나만 있어도 `Skills System` 섹션이 생성된다
- `skills_ref`는 public/reference skill surface다. private local runtime skills such as `k-writing` (Korean promotional/content writing; retired label: `k-thread-gen`) and `lecture-stt` can be deployed under active `{{JAW_HOME}}/skills/` without being registered in `skills_ref/registry.json`. Korean promotional/content writing routes through active `k-writing`, not free-form prose or the retired label.
- The active `jaw-search` skill is the default search backend. Korean/source-sensitive search guidance rewrites the request into focused queries, treats search results as URL candidates, verifies original pages with fetch/open, and uses `agbrowse research plan` only as optional query-planning help.
- dev skill은 TS-first strict-compatible 기본값과 기존 source-of-truth 탐색 규칙을 포함한다.
- broad change 전에 기존 아키텍처 문서와 저장소별 기록 위치 규칙을 먼저 읽는다.
- dev-scaffolding의 일반 계획 위치보다 저장소별 private 기록 경계가 우선한다. cli-jaw의 `docs/`와 `structure/`에는 공개 제품 문서만 두며, private 계획·감사·증거는 별도 sibling 저장소에서 관리한다.

### Vision Click

- active CLI가 `codex`일 때만 `vision-click.md`가 추가된다
- 이는 `snapshot`에 ref가 없을 때만 쓰는 fallback 힌트를 제공한다
- 현재 의미는 범용 브라우저 제어가 아니라 Codex provider(`codex exec -i`) 기반 legacy fallback이다. 일반 DOM/Web UI 작업은 빠른 `cli-jaw browser` 경로를 우선하고, desktop/non-DOM 작업은 노출된 `jaw-computer-use` MCP 또는 Codex 기본 Computer Use 플러그인으로 직접 수행한다. 명시적 `$computer-use` 요청에 CDP를 대체 경로로 쓰지 않는다.

### Delegation Rules

- Boss는 `cli-jaw dispatch`로 jaw employees를 보낸다
- CLI sub-agents는 내부 병렬 작업용이다
- 둘은 서로 다른 시스템이며, 서로를 대체하지 않는다
- 이 규칙 블록은 orchestration 템플릿이 없어도 항상 B 프롬프트 끝에 붙는다

---

## Employee Prompt

`getEmployeePromptV2()`는 boss prompt와 별개로 직원용 추가 레이어를 쌓는다.

- 등록된 static employee용 system patch와 declared skill inline injection (이전 전용 데스크톱 직원의 `control-system.md`는 제거됨)
- 공통 `dev/SKILL.md`
- `jaw-dev-scaffolding`
- role별 skill (`jaw-dev-frontend`, `jaw-dev-backend`, `jaw-dev-data`, `documentation`)
- phase 2일 때 `jaw-dev-code-reviewer`
- phase 4일 때 `jaw-dev-testing`
- `worker-context.md`에서 phase별 worker context 추출 (Phase 1~4)
- 실행 규칙 + delegation 규칙: `cli-jaw dispatch`와 subtask JSON은 금지지만, CLI 자체 sub-agent(Task/Agent tool)는 내부 병렬 작업용으로 명시적으로 허용
- PABCD A/B/C 중 Approved Plan이 주입될 때 `Project root`와 path guard가 함께 들어가므로, 직원은 `Workspace Context`와 Approved Plan의 root를 기준으로 파일을 읽고 검증한다.

이 구조 때문에 B.md는 단순한 "완성본"이 아니라, 현재 시스템 프롬프트가 어떻게 합성되는지 보여주는 캐시 스냅샷이다. forDisk 경로는 advanced `## Memory Runtime` 블록 대신 legacy fallback에 bounded `shared/soul.md`, 축약 profile/snapshot, 실제 `JAW_HOME`·working directory를 보강한다는 점을 같이 봐야 한다.
