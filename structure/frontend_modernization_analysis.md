---
created: 2026-03-28
tags: [cli-jaw, frontend, modernization, audit]
aliases: [Frontend Modernization Audit, cli-jaw frontend analysis, modernization analysis]
---

> 📚 [INDEX](INDEX.md) · [프론트엔드 ↗](frontend.md) · **현대화 제안 분석**

# 프론트엔드 현대화 제안 분석

> 점검 기준: 실제 `public/`, `vite.config.ts`, `tsconfig.frontend.json`, `package.json`.
> 현재 프론트엔드는 “Vanilla 메인 UI + React Manager 대시보드”의 이중 구조다.
> 과거의 “React/Vite 도입 여부” 논점은 최신 코드 기준으로 분리해야 한다. 메인 채팅 UI는 Vanilla를 유지하고, Manager 화면에는 React 19가 이미 도입됐다.

---

## 현재 구현 기준

| # | 항목 | 현재 상태 | 판정 | 근거 |
|---|------|------|------|------|
| 1 | 메인 UI 프레임워크 rewrite (React/Vue/Svelte) | 미도입 | ❌ 비추천 유지 | 메인 채팅 UI는 Vanilla + 모듈 분리가 이미 진행됐고, 전면 rewrite 비용이 큼 |
| 2 | Manager React 앱 | 구현됨 | ✅ 완료 | `public/manager/src/main.tsx`, `App.tsx`, `components/`, `hooks/` 존재 |
| 3 | Vite 번들러 전환 | 구현됨 | ✅ 완료 | `vite.config.ts`가 `public/index.html`, `public/manager/index.html` multi-entry 빌드 |
| 4 | 전역 상태 관리 (Zustand/Pinia) | 미도입 | ❌ 비추천 | 메인 `state.ts`는 87L plain object 중심이고, Manager도 React local/hooks 상태 중심 |
| 5 | TypeScript strict frontend check | 구현됨 | ✅ 완료 | `tsconfig.frontend.json`이 `public/js/**/*.ts`와 manager TSX를 strict/noEmit으로 검사 |
| 6 | 가상 스크롤 | 구현됨 | ✅ 완료 | `js/virtual-scroll.ts`와 `ui.ts`가 대화 DOM 풀링과 bottom-follow 복귀 reconciliation을 담당한다 |
| 7 | 스트리밍 UI 플리커링 방지 | 구현됨 | ✅ 완료 | `streaming-render.ts` + `render.ts`가 부분 렌더링과 최종 마감 처리를 분리한다 |
| 8 | 오프라인 영속성 (IndexedDB) | 구현됨 | ✅ 완료 | `features/idb-cache.ts`가 대화 히스토리 캐시를 담당한다 |
| 9 | 반응형 제스처 UI | 구현됨 | ✅ 완료 | `features/gesture.ts`, `sidebar.ts`, mobile nav가 모바일 흐름을 처리한다 |
| 10 | PWA (서비스 워커) | 구현됨 | ✅ 완료 | `manifest.json` + `sw.js` + `icons/`가 설치/캐시 흐름을 제공한다 |
| 11 | Avatar personalization | 구현됨 | ✅ 완료 | `features/avatar.ts` + `/api/avatar*`가 emoji/image avatar를 지원한다 |
| 12 | Help / attention UX | 구현됨 | ✅ 완료 | `help-dialog.ts`, `help-content.ts`, `attention-badge.ts` 존재 |
| 13 | WS reconnect dedup / snapshot 복원 | 구현됨 | ✅ 완료 | `ws.ts`가 reconnect snapshot, reload dedup, reconnect 후 bottom anchor reconciliation을 처리한다 |

---

## 현재 런타임에서 확인된 사실

### 규모와 모듈화

- 생성 산출물을 모두 빼면 `public/`의 실소스/자산은 109개다.
- 기존 문서 관례대로 `public/dist/*`만 제외하면 `public/public/dist/*`가 남아서 총 236개로 잡힌다.
- `public/js/`는 root가 15개, `js/diagram/`이 3개, `js/features/`가 31개다.
- `public/manager/`는 28개 파일의 React Manager 대시보드 source다.
- `public/css/`는 9개, `public/locales/`는 2개, `public/assets/providers/`는 14개, `public/assets/fonts/`는 2개, `public/icons/`는 5개다.
- 핵심 runtime 크기(2026-07-06 재측정): `main.ts 628L`, `ui.ts 561L`, `render.ts 18L`(façade로 축소, 실제 렌더링은 `render/` 모듈로 분해됨), `ws.ts 1144L`, `virtual-scroll.ts 646L`, `state.ts 105L`, `features/process-block.ts 740L`, `features/settings-core.ts 648L`, `manager/src/App.tsx 499L`.

### 이미 현대화된 영역

- `main.ts`는 부트스트랩과 이벤트 바인딩을 맡고, 실제 기능은 `features/*`와 `ui.ts`, `ws.ts`, `render.ts`로 분리돼 있다.
- `main.ts`는 `initAvatar()`까지 bootstrap에 포함해 emoji/image avatar 상태를 초기에 동기화한다.
- `main.ts`는 현재 `initAttentionBadge()`와 `initHelpDialog()`도 bootstrap에 포함한다.
- `public/manager/`는 React 19 + `react-dom/client` 기반 별도 dashboard 앱이며, `App.tsx`, `components/`, `hooks/`로 구성된다.
- `render.ts`와 `ui.ts`는 markdown 렌더링 뒤의 file-path linkification과 local file open interception까지 맡아서, plain text 경로와 markdown 링크를 같은 OS open flow로 보낸다.
- `render.ts`는 최근 100ms batched post-render scheduler를 도입해 rapid rerender 시 Mermaid/linkify/rehighlight 작업을 한 번으로 합친다.
- `virtual-scroll.ts`는 TanStack virtualizer를 즉시 활성화하고, viewport child 재사용 + `onLazyRender`/`onPostRender` hook으로 lazy content와 widget activation을 나눠 처리한다. `pageshow`/`visibilitychange`/`focus` 복귀 시 사용자가 bottom을 따라가던 상태면 layout 재측정 후 bottom anchor를 복원한다.
- `ws.ts`는 reconnect 시 `/api/orchestrate/snapshot`으로 상태를 복원하고, 마지막 `loadMessages()` 이후 10초 이내면 중복 reload를 건너뛴다. reconnect 직전 bottom intent를 캡처해 hydration 뒤 bottom reconciliation도 수행한다.
- `settings.ts`는 모놀리스가 아니라 barrel이며, 실제 로직은 `settings-core`, `settings-telegram`, `settings-discord`, `settings-channel`, `settings-mcp`, `settings-cli-status`, `settings-stt`, `settings-templates`, `settings-types`로 쪼개져 있다.
- `provider-icons.ts`, `icons.ts`, `locale.ts`, `constants.ts`, `uuid.ts` 같은 공통 모듈도 이미 분리돼 있다.

### 남아 있는 생성 산출물

- 생성 산출물 루트는 `public/dist/` 262개와 `public/public/dist/` 127개가 남아 있다.
- `public/dist/` 262개에는 `public/dist/dist/` 127개가 이미 재귀 포함된다.
- 즉 중복 build tree는 root duplicate 하나(`public/public/dist/`)와 nested duplicate 하나(`public/dist/dist/`)로 보는 편이 실제 트리와 맞다.

---

## 문서에서 구식인 부분

### 1. “React 미도입”은 더 이상 전체 프론트엔드 설명으로 맞지 않다

메인 채팅 UI는 Vanilla가 맞지만, Manager 대시보드는 `react`, `react-dom`, `@vitejs/plugin-react`를 실제로 사용한다. 따라서 “프레임워크 미도입”은 “메인 UI rewrite 미도입”으로 좁혀 써야 한다.

### 2. “Vite 번들러 전환”은 더 이상 제안이 아니다

이 문서의 이전 버전은 Vite 전환을 `가치있음 (P1)`으로 두었지만, 현재 트리는 이미 Vite 기준이다. 이제는 “도입 제안”이 아니라 “이미 적용된 전환”으로 써야 한다.

### 3. 가상 스크롤, IndexedDB, PWA, 제스처는 이미 구현됐다

이 항목들을 여전히 미래의 로드맵으로 적어두면 실제 상태를 왜곡한다. 지금은 “계획”이 아니라 “구현 완료”로 남겨야 한다.

### 4. 예전 코드 크기 숫자는 낡았다

이전 문서의 코드 크기 가정은 현재 트리와 맞지 않는다. 2026-07-06 기준 `render.ts`는 18L façade로 이미 분해 완료됐고, 현재의 대형 파일은 `ws.ts 1144L`, `features/process-block.ts 740L`, `features/settings-core.ts 648L`, `virtual-scroll.ts 646L`, `main.ts 628L`이다.

### 5. 프레임워크/상태 라이브러리 도입 논리는 메인 UI 기준 여전히 비추천이다

메인 UI에 React/Vue/Svelte나 Zustand/Pinia를 넣어야 할 구조는 아니다. 이미 모듈 경계와 UI 분리가 되어 있고, 남은 일은 rewrite가 아니라 세부 UX/성능/정리다. 단, Manager dashboard는 이미 React 앱으로 분리되어 있으므로 이 판단의 대상에서 제외한다.

### 6. 하지만 추가 분해 후보는 분명하다

프레임워크 rewrite가 필요 없다는 말과, 모든 파일 크기가 건강하다는 말은 다르다. `render.ts` 분해는 완료됐고(18L façade), 현재 500L 가이드를 넘는 파일은 `ws.ts 1144L`, `features/process-block.ts 740L`, `features/settings-core.ts 648L`, `virtual-scroll.ts 646L`, `main.ts 628L`, `ui.ts 561L`, `tool-ui.css 550L`다. 다음 현대화는 메인 UI React 도입이 아니라 이 목록의 책임 단위 분해다.

### 7. Avatar/WS/VS/help/attention은 이제 “실험”이 아니라 기본 런타임이다

avatar image upload, VS DOM reuse, reconnect dedup, help dialog, attention badge는 보조 기능이 아니라 기본 동작이다. 관련 항목을 “추후 검토”나 “실험적”으로 남겨두면 현재 운영 상태를 오도한다.

---

## 결론

| 판정 | 건수 | 설명 |
|------|------|------|
| ❌ 여전히 비추천 | 2건 | 메인 UI framework rewrite, 전역 상태 라이브러리 |
| ✅ 이미 구현됨 | 11건 | Vite, React Manager, strict frontend typecheck, virtual scroll, 플리커링 완화, IndexedDB, 제스처/mobile, PWA, avatar, help/attention, WS snapshot |
| 🔄 문서 갱신 완료 | 4건 | 파일 수, generated output 수, line count, React 적용 범위 |
| 🛠 다음 현대화 후보 | 5건 | `ws.ts`, `features/process-block.ts`, `features/settings-core.ts`, `virtual-scroll.ts`, `main.ts` 책임 분리 (`render.ts`는 분해 완료) |

> 핵심 인사이트: 현재 `public/`은 “작은 vanilla 프로젝트”가 아니라, Vanilla 메인 UI와 React Manager가 공존하는 Vite 기반 UI다. 따라서 남은 과제는 메인 UI 프레임워크 교체가 아니라, `ws.ts`/`process-block.ts`/`settings-core.ts`/`virtual-scroll.ts`/`main.ts` 책임 분해다.
