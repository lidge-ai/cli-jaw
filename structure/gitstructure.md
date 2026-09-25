---
created: 2026-03-27
tags: [cli-jaw, git, submodule]
aliases: [CLI-JAW Git Structure, cli-jaw 서브모듈 구조, Git Structure Guide]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · [str_func ↗](str_func.md) · **Git 구조 & 서브모듈**

# Git Structure Guide (CLI-JAW)

live working tree + `.gitmodules` 기준으로 정리한 Git 구조/운영 요약입니다. top-level prose docs와 다를 때는 실제 트리와 `.gitmodules`를 우선한다.

## 1) Repository Topology

```text
lidge-ai/cli-jaw              ← public parent repo
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public)
├── officecli/   (submodule)   ← lidge-jun/OfficeCLI (public)
└── .npmignore                 ← npm publish 시 submodule 제외
```

- `skills_ref/`: 스킬 레퍼런스 저장소
- `officecli/`: Office 문서 도구용 별도 submodule
- parent repo 기준 `git status`에는 두 공개 submodule이 독립 항목으로 보인다.

### Dashboard Diff Root Policy

Manager/Electron Diff panel에서 이 repo를 볼 때 source repo root와 runtime home을 혼동하면 안 된다.

- 실제 source repo root: `/Users/jun/Developer/new/700_projects/cli-jaw`
- runtime/JAW_HOME 예시: `/Users/jun/.cli-jaw-3459`
- `jaw dashboard serve`가 스캔한 instance metadata의 `projectDirs[]`와 `workingDir`가 diff root 후보의 source of truth다.
- Diff panel은 `projectDirs[]`를 우선 사용하고, 설정에 따라 `workingDir` 또는 port별 pinned root를 먼저 사용한다. `$HOME`은 마지막 fallback이다.
- parent repo와 `skills_ref/`, `officecli/` submodule은 각각 독립 git repo이므로 root selector에서 명시적으로 선택해야 한다.

## 2) Clone Strategy

```bash
# 코드만 (일반 사용자/CI)
git clone https://github.com/lidge-ai/cli-jaw.git

# 코드 + 공개 submodule 전체
git clone --recursive https://github.com/lidge-ai/cli-jaw.git

# 이미 clone 후 submodule 초기화
git submodule update --init --recursive
```

## 3) Submodule Commit Flow (중요)

서브모듈 내용을 바꿨다면 반드시 2단계로 커밋합니다.

```bash
# 1) submodule 내부에서 먼저 커밋/푸시
cd skills_ref   # 또는 cd officecli
git add -A
git commit -m "update"
git push
cd ..

# 2) parent repo에서 submodule ref 업데이트 커밋
git add skills_ref   # 또는 git add officecli
git commit -m "chore: update skills_ref ref"
git push
```

핵심: submodule commit과 parent repo ref commit은 별개입니다.

## 4) Private records boundary

비공개 계획·감사·증거·개발 이력은 별도 sibling clone인 [cli-jaw-internal](https://github.com/lidge-jun/cli-jaw-internal)에만 보관합니다. 접근 권한은 [이슈](https://github.com/lidge-ai/cli-jaw/issues)로 요청하세요.

이 체크아웃 안에는 어느 깊이에서도 private 기록을 만들지 않습니다. `devlog`, `_plan`, `_fin`, `.jwc` 별칭도 금지하며, 이 규칙은 일반 스킬의 기본 경로보다 우선합니다. `docs/`와 `structure/`는 공개 제품 문서용이고, 공개 문서·소스에 비공개 기록 경로를 넣지 않습니다.

## 5) PR & Quality Gate

공개 push 전에는 [기여 가이드의 로컬 hook 설정](../CONTRIBUTING.md#local-private-path-check)을 적용하고, index와 전송할 모든 커밋 트리를 각각 검사합니다. CI는 업로드 이후의 보완 검사이므로 최초 공개를 막아주지 못합니다.

```bash
npm run check:private-boundary
node scripts/check-private-boundary.mjs --range <remote-base> HEAD
```

PR 전 최소 검증:

```bash
npm run build
npm test
npm run typecheck
bash structure/check-doc-drift.sh
bash structure/verify-counts.sh
```

추가로 실제 `package.json`에는 아래 스크립트들이 있다.

- `npm run build:frontend`
- `npm run test:all`
- `npm run test:integration`
- `npm run test:smoke`
- `npm run prepublishOnly`

## 6) str_func 문서 동기화 규칙

`AGENTS.md` 규칙:

- `str_func.md` 파일 트리는 멤버십 지도다 (줄 수는 기록하지 않는다)
- 파일을 추가·삭제·이동한 뒤 항목이 실제 파일을 가리키는지 검증:

```bash
bash structure/verify-counts.sh
```

## 7) Structure Sync Scope

- `server.ts`가 route glue layer로 바뀌었으므로 API 변경은 `src/routes/*`와 `structure/server_api.md`를 함께 본다.
- CLI command transport 변경은 `src/cli/commands.ts`, `src/cli/handlers.ts`, `src/cli/handlers-runtime.ts`, `src/cli/handlers-completions.ts`, `src/cli/handlers-workflows.ts`, `src/cli/api-auth.ts`, `src/command-contract/*`와 `structure/commands.md`를 같이 동기화한다.
- prompt/spawn 구조 변경은 `src/prompt/*`, `src/agent/*`, `src/orchestrator/*`와 `structure/prompt_flow.md`, `prompt_basic_*.md`, `agent_spawn.md`를 같이 본다.
- memory/heartbeat runtime 변경은 `src/memory/*`, `src/routes/memory.ts`, `src/routes/jaw-memory.ts`, `src/routes/heartbeat.ts`와 `memory_architecture.md`, `telegram.md`, `infra.md`를 같이 본다.
- 큰 refactor 뒤에는 parent repo quality gate와 별개로 `structure/` drift 검사까지 같이 통과시킨다.
