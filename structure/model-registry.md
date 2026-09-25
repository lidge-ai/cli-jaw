---
created: 2026-09-09
tags: [cli-jaw, architecture, model-registry]
aliases: [model registry, 모델 레지스트리, live model discovery]
---

# Model registry and live discovery

> 어느 런타임의 모델 목록이 관측에서 오고 어느 것이 손으로 유지되는지, 그리고
> 모델별 effort 사다리가 어디서 좁혀지는지를 기술한다. 런타임 선택과 transport는
> [runtime integration](runtime-integration.md)이, 설정 표면은
> [server API](server_api.md)가 소유한다.

## 두 개의 층

모델 목록에는 정적 층과 라이브 층이 있다.

정적 층은 `src/cli/registry.ts`의 `CLI_REGISTRY`다. 모든 런타임의 기본 모델,
기본 effort, 그리고 프로브가 실패했을 때 쓰는 폴백 목록을 담는다. 이 층은 CLI를
실행하지 않고 네트워크도 쓰지 않으므로 항상 답한다.

라이브 층은 `src/cli/registry-live.ts`의 `buildLiveCliRegistry()`다. 런타임 소스를
읽어 정적 층 위에 덮어쓴다. 소스가 없거나 실패하면 정적 층이 그대로 남는다.

이 순서가 계약이다. **라이브 실패가 모델 선택 불가로 이어지면 안 된다.** 빈 목록을
덮어쓰면 `CodeSessionManager.validate`가 모든 모델을 거부하므로, 라이브 결과가
비어 있으면 병합하지 않는다.

## 런타임별 소스

| 런타임 | 라이브 소스 | 구현 |
|---|---|---|
| `codex` / `codex-app` | opencodex `GET /v1/models` | `src/cli/opencodex-models.ts` |
| `kiro-code` | `kiro-cli chat --list-models --format json` | `src/agent/kiro-models.ts` |
| `claude` | 설치된 Claude Code 번들 | `src/cli/claude-model-discovery.ts` |
| `cursor` | `cursor-agent --list-models` | `src/agent/cursor-model-inventory.ts` |
| `grok` | `grok models` | `src/agent/grok-models.ts` |
| `agy` | `agy models` (두 번째 열, 티어가 붙은 라벨) | `src/agent/agy-models.ts` |
| `opencode` | `opencode models` (설정된 모든 provider, `opencode-go` 우선) | `src/agent/opencode-models.ts` |
| `copilot` | `copilot --headless --stdio`의 `models.list` JSON-RPC | `src/agent/copilot-models.ts` |
| `pi` | 프로필별 discovery (Settings) | `src/agent/pi-runtime.ts` `discoverPiProfileModels` |

Pi는 registry 수준 목록 대신 프로필마다 opencodex `/models` 또는
`pi --offline --list-models`로 모델을 찾는다.

Copilot CLI에는 목록 서브커맨드가 없고 `--acp` 세션도 모델을 알려주지 않는다.
공식 Copilot SDK가 쓰는 headless 서버에 `Content-Length` 프레임으로
`models.list`를 한 번 보내고 프로세스를 끝낸다. 이 목록은 로그인한 플랜이 쓸 수
있는 모델만 담으므로, `policy.state`가 `enabled`가 아닌 모델은 빼고 정적 기본
모델이 플랜에 없으면 첫 모델로 바꾼다. effort는 모델마다
`supportedReasoningEfforts`로 좁히며 `none`은 뺀다.

OpenCode는 사용자가 설정한 provider가 서비스하는 모델 전체를 보여주고,
기본 모델이 속한 `opencode-go`를 앞에 둔다.

AGY는 `agy models`의 두 번째 열만 선택지로 쓴다. 첫 열의 슬러그는 `--effort`를
요구하는데 cli-jaw는 AGY에 effort를 보내지 않는다. Google은 다음 Flash 세대가
나오면 이전 세대를 곧 내리므로, 정적 기본 모델이 라이브 목록에 없으면 첫 라이브
모델로 바꿔 picker가 고를 수 없는 기본값을 들고 있지 않게 한다.

## Cursor: 하나의 관측에서 두 목록을 파생한다

Cursor CLI에는 `--effort`가 없다. effort가 모델 id 안에 들어 있어
(`claude-opus-5-xhigh-fast`), `cursor-runtime.ts`가 두 목록을 갖는다: 계정이 받는
wire id 전체와 picker가 보여주는 base 모델. **두 목록의 일치가 곧 정확성이다.**
#394가 그 일치가 깨진 사고였다 — 계정은 Grok을 `cursor-` 접두사로 부르는데 picker
어휘는 접두사가 없어서, `grok-4.6` + `high`가 계정에 없는 id를 만들고 resolver가
조용히 base로 물러났다.

2026-09-23 관측한 `grok-4.7` wire id는 반대로 `cursor-` 접두사가 없다.
`low/medium/high/xhigh`와 각 fast 변형만 있으며 `max`는 없다. `claude-opus-5-5`는
같은 Cursor 목록에서 `low`부터 `max`까지와 각 fast 변형이 확인되었다.

`--list-models`가 출력하는 것이 정확히 첫 번째 목록이다. 그래서 그것을 관측으로
받고 base와 effort 사다리는 거기서 역산한다. 접미사 어휘는
`CURSOR_EFFORT_SUFFIX`의 역이며, 항등이 아닌 항목은 Cursor가 xhigh를
`extra-high`로 적는 것 하나뿐이다. 역산할 때 `cursor-` 접두사를 벗기는 것이
중요하다 — 남겨두면 resolver가 접두사를 다시 붙여 #394가 반대 방향으로 재현된다.

한계가 하나 있다. `resolveCursorModelVariant()`는 여전히 정적 wire id 집합으로
해석한다. 이 함수는 spawn 경로의 동기 함수라, 라이브 목록을 주입하면 프로세스를
띄우는 일이 CLI 프로브에 의존하게 된다. 라이브가 된 것은 레지스트리 표면이다.

## effort는 모델별로 좁힌다

opencodex는 모델마다 **다른** effort 집합을 광고한다. `gpt-5.6-sol`은 `ultra`까지
가고 `gpt-5.6-luna`는 `max`에서 멈춘다. 2026-09-23에는 `gpt-6-sol`이
`low..ultra`, `gpt-6-luna`가 `low..max`를 광고했다. 선택된 값은 그대로 wire에 실리므로
(`-c model_reasoning_effort=`, `src/agent/args.ts`), 소비자는 union이 아니라
모델별 집합으로 좁혀야 한다.

`registry-live.ts`가 이를 `effortsByModel`과 `defaultEffortByModel`로 노출한다.
`efforts`는 legacy 소비자를 위한 union으로 남지만, 그것을 그대로 쓰면 실제 사고가
난다: `gpt-5.6-sol`은 codex와 kiro 양쪽에 존재하는데 Kiro는
`low/medium/high/xhigh`만 받는다. 은퇴한 `ai-e`만 provider별로 `effortsByModelByProvider`를 썼다. 남은 런타임은 평평한 맵이다.

빈 union으로 넓히지 않는 규칙도 여기에 속한다. 모든 모델이 라우팅된 카탈로그에서는
union이 비는데, 그것을 그대로 반영하면 effort 컨트롤이 통째로 사라진다.

### 정적 폴백은 union이다

`CODEX_EFFORT_CHOICES`는 `low..ultra` 전체를 담는다. 모델별 표가 아니다.
폴백의 목적은 정확한 카탈로그가 아니라 **picker가 비지 않게 하는 것**이고, 손으로
유지하는 모델별 표는 라이브 디스커버리가 없앤 수동 동기화 부채를 되살린다.

어떤 모델에 맞지 않는 rung이 섞일 수 있지만 실제로 wire에 도달하기 어렵다. 이
목록이 쓰이는 상황은 opencodex가 없는 상황이고, Codex는 그 프록시를 통해 실행되기
때문이다. 프록시가 살아나면 `effortsByModel`이 즉시 모델별로 좁힌다.

`minimal`은 제외한다. 일부 라우팅 모델이 광고해서 라이브 union에는 나타나지만,
`CODEX_MODEL_CHOICES`의 GPT id 중 이를 받는 것은 관측되지 않았다.
## Claude ultracode

`ultracode`는 Anthropic API의 effort 값이 아니라 Claude Code의 세션 설정이다.
Claude Code는 `/effort ultracode`를 받으면 effort를 `xhigh`로 정규화하고
`settings.ultracode = true`를 따로 전달한다. 그래서 cli-jaw도 같은 모양을 지켜야
한다: 사용자에게는 하나의 티어로 보이되, wire에는 xhigh와 플래그가 각각 나간다.

Claude Code 자신이 세 가지 조건을 요구한다. dynamic workflows가 켜져 있어야 하고,
모델이 xhigh를 지원해야 하며, 조직 정책이 xhigh를 막지 않아야 한다. 따라서
ultracode는 xhigh 가능한 모델에만 노출한다.

`claude --effort`의 도움말이 받는 값을 그대로 적어둔다: `low, medium, high,
xhigh, max`. ultracode는 없다. 번들 스키마도 이 티어를 boolean 설정으로 정의하며
"typically provided via `--settings` or the `apply_flag_settings` control
request"라고 스스로 밝힌다.

구현은 `src/agent/args.ts`가 소유한다. `normalizeClaudeEffort()`가 플래그에 실을
값을 정하고, `claudeSettingsArgs()`가 스위치를 settings 객체에 넣는다. 이 둘은
같은 `--settings`를 fastMode와 공유하므로 **하나의 객체로 병합한다** — 플래그를
두 번 넘기면 뒤가 앞을 덮어 한쪽이 조용히 사라진다.

노출 범위는 `src/cli/claude-models.ts`의 `buildClaudeEffortsByModel()`이 정한다.
Haiku와 구세대 계열은 xhigh를 지원하지 않으므로 다섯 rung만 받는다. 나머지 두
조건(dynamic workflows, 조직 정책)은 cli-jaw가 알 수 없고 Claude Code가 런타임에
직접 거절 메시지를 낸다.

## 새 모델이 도착할 때

opencodex는 새 모델 도착을 명시적으로 다룬다
(`src/providers/new-model-policy.ts`). 기준선과 비교해 새 id를 찾고, 사라진 id는
연속 세 번 관측되지 않아야 제거한다. 한 번의 실패한 조회가 모델을 지우지 않게 하는
유예 장치다.

cli-jaw는 그보다 단순한 규칙을 쓴다. 성공한 프로브의 결과를 그대로 채택하고,
실패하면 이전 스냅샷을 유지한다. degraded 프로브가 정적 목록을 돌려주면 기존 라이브
스냅샷을 덮어쓰지 않는다 (`src/code-mode/providers/live-models.ts`).

## 기본값은 라이브로 바뀌지 않는다

`defaultModel`과 `defaultEffort`는 정적으로 남는다. `buildDefaultPerCli()`가
이 값으로 사용자 설정을 시드하므로, 라우팅 순서 변화가 사용자의 기본 런타임을 조용히
바꾸면 안 된다. 예외는 하나다: 라이브 카탈로그가 더 이상 제공하지 않는 기본값은 첫
세션에서 `validate()`에 걸리므로, 그때는 라이브 목록의 첫 모델로 물러선다.

## Code 카탈로그

`/api/code`의 카탈로그는 같은 라이브 결과를 쓰지만 경로가 다르다.
`CodeProvider.describe()`가 **동기**이고 카탈로그 읽기마다 호출되므로 프로브를
await할 수 없다. 그래서 메모리 스냅샷을 읽는다:
`src/code-mode/providers/live-models.ts`(Codex)와
`provider-live-models.ts`(claude/cursor/grok).

스냅샷을 채우는 비용이 프로바이더마다 다르고, 그 차이가 규칙을 만든다.

| 프로바이더 | 채우는 비용 | 읽기가 갱신을 예약하는가 |
|---|---|---|
| codex-app | HTTP | 예 |
| claude | 번들 파일 읽기 | 예 |
| cursor | `cursor-agent` 실행 | **아니오** |
| grok | `grok` 실행 | **아니오** |

`catalog.ts`가 규칙을 명시한다: "catalogs must never execute a CLI or a login
probe." 카탈로그 렌더 한 번이 프로세스를 띄우면 로그인 프롬프트나 느린 바이너리가
읽기 경로에 들어온다. 그래서 cursor/grok 스냅샷은 **명시적 프라임만** 채운다.
`createCodeHost()`가 서비스 초기화 때 한 번 호출하고, 실패는 조용히 무시한다 —
정적 목록이 그대로 남는다.
## Claude 기본 모델과 설치 CLI 확인

기본값은 `claude-opus-5-5`다. 이 id는 Claude Code 2.1.280 미만에서 API 400으로 거절되므로, 설치된 CLI 번들 카탈로그(`claude-model-discovery.ts`)가 판단 근거다. `claude-default-model-boot.ts`가 카탈로그로 지원 여부를 판정한다.

- 부트 후 `server.ts`가 카탈로그를 한 번 읽고 `applyClaudeDefaultModelMigration()`을 돈다. `perCli.claude.model`이 정확히 예전 기본값 `claude-opus-4-8`인 홈만 옮기고, 다른 값·`activeOverrides`·직원 모델은 건드리지 않는다. 카탈로그를 못 읽거나 CLI가 5.5를 모르면 stamp를 남기지 않아서, CLI를 업데이트한 뒤 다음 부트에서 다시 시도한다.
- `spawnAgent`(print·native)와 Code의 Claude `open()`은 캐시된 카탈로그가 모델을 거절할 때만 "Claude Code를 업데이트하라"는 문구로 바로 실패한다. 캐시가 비어 있으면 막지 않는다.

## 관련 문서

- [runtime integration](runtime-integration.md) — transport 선택과 native adapter
- [server API](server_api.md) — `/api/cli-registry`, `/api/cli-status`
- [commands](commands.md) — 슬래시 커맨드에서의 모델 선택
