# Contributing to CLI-JAW

## Quick Start

```bash
# Clone with public submodules
git clone --recursive https://github.com/lidge-jun/cli-jaw.git
cd cli-jaw
npm install
npm test
```

## Repository Structure

```
lidge-jun/cli-jaw              ← this repo (public)
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public)
└── officecli/   (submodule)   ← lidge-jun/OfficeCLI (public)
```

### Submodules

| Submodule | Repo | Visibility | 용도 |
|-----------|------|:---:|------|
| `skills_ref/` | [cli-jaw-skills](https://github.com/lidge-jun/cli-jaw-skills) | public | 100+ bundled skills |
| `officecli/` | [OfficeCLI](https://github.com/lidge-jun/OfficeCLI) | public | Office document tools |

Private plans, audits, evidence, and history belong only in a separate sibling clone of [cli-jaw-internal](https://github.com/lidge-jun/cli-jaw-internal). Request collaborator access through an [issue](https://github.com/lidge-jun/cli-jaw/issues). Public builds and tests do not require it.

Never create private records inside this checkout, including `devlog`, `_plan`, `_fin`, or `.jwc` aliases at any depth, even when a generic skill suggests them. Keep `docs/` and `structure/` for public product documentation and omit private record paths from public docs and source.

### Clone Options

```bash
# 1. 코드만 (일반 유저 / CI)
git clone https://github.com/lidge-jun/cli-jaw.git

# 2. 코드 + 공개 서브모듈 (개발자)
git clone --recursive https://github.com/lidge-jun/cli-jaw.git

# 3. 이미 clone 한 후 submodule 추가
git submodule update --init --recursive
```

## Development

```bash
npm install          # dependencies
npm run dev          # dev server (tsx watch)
npm run build        # production build
npm test             # root + unit tests (integration is separate)
npm run typecheck    # tsc --noEmit
```

## Local Private-Path Check

Enable the repository's pre-push hook for this checkout. First inspect any existing hook configuration; if you already have hooks, integrate this check into them instead of replacing them.

```bash
git config --show-origin --get-all core.hooksPath  # no output means no configured override
git config --local extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks
```

Before pushing, check both the candidate index and every outgoing commit tree:

```bash
npm run check:private-boundary
git fetch origin dev
node scripts/check-private-boundary.mjs --range origin/dev HEAD
```

Use the destination branch's current remote tip as the range base. The default check scans indexed paths; `--range` checks every outgoing commit, including private files added and later deleted. `.githooks/pre-push` passes Git's ref updates to `--pre-push` on stdin, and in that mode commits any ref of the same destination already advertises are not re-scanned: a fast-forward of `preview`/`main` onto commits `dev` has already published introduces no new disclosure. Do not bypass this check with `--no-verify`.

These checks reject private path names, not private content hidden under otherwise public names. Review the diff for private record links and content too. CI is a backstop after upload; it cannot prevent or retract disclosure from a push. Package exclusions also do not protect Git pushes: npm's `files` allowlist can override root `.npmignore`, so private paths need explicit exclusions there as well.

## Submodule Workflow

서브모듈 내용을 수정한 경우:

```bash
# 1. 서브모듈 안에서 커밋 + 푸시
cd skills_ref   # 또는 cd officecli
git add -A && git commit -m "update" && git push
cd ..

# 2. 메인 레포에서 참조 업데이트
git add skills_ref   # 또는 git add officecli
git commit -m "chore: update skills_ref ref"
git push
```

## Pull Request

1. Fork this repo
2. Create a feature branch
3. `npm run build && npm test` — 빌드 + 테스트 통과 확인
4. Submit PR

### UI changes need screenshot evidence

A PR that changes rendered UI files must embed a screenshot in its
description — the `screenshot-gate` check fails the PR otherwise. The gate
counts `public/` (the manager dashboard / web frontend) and the Electron
rendered surface (`electron/src/preload/`, markup/style/component files under
`electron/`); pure test files are excluded — see
`.github/scripts/pr-screenshot.cjs` for the exact rules.

Only rendered images count as evidence: `![alt](url)` or `<img src="...">` in
the description body. Dragging an image into the GitHub editor works.

**Never commit screenshot files to the PR branch.** A directory named
`pr-assets` anywhere in the tree (e.g. `docs/pr-assets/`) is rejected by
`npm run check:private-boundary`. CLI/agent uploads with push access go to
the orphan `pr-assets` branch instead, linked by commit SHA so the link never
drifts:

```text
https://raw.githubusercontent.com/lidge-jun/cli-jaw/<sha>/<pr-or-date-slug>/<name>.png
```

A maintainer can waive the requirement with the `ui-screenshot-waived` label
(only valid when the label actor has write access or above) or with a comment
stating the change does not touch the UI — e.g. "no UI changes" — posted after
the latest push by someone with write access or above.

> 📋 Found a bug or have a feature idea? [Open an issue](https://github.com/lidge-jun/cli-jaw/issues)
