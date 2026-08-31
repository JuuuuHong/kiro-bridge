---
name: setup
description: kiro-bridge 설치 상태를 점검하고 Kiro 커스텀 에이전트를 설치한다. 첫 사용 전, kiro-cli 업데이트 후, 또는 리뷰가 TOOL_DENIED 로 실패했을 때 실행한다.
argument-hint: "[--force]"
---

# kiro-bridge:setup

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" setup [--force]
```

단계별로 `✓`/`✗` 를 출력한다. 실패한 단계에서 멈추고 다음으로 넘어가지 않는다.

| 단계 | 확인하는 것 | 실패 시 |
|---|---|---|
| `version` | `kiro-cli --version` | 설치 안내 후 중단 |
| `auth` | `kiro-cli whoami` | `kiro-cli login` 안내 후 중단 |
| `transport` | ACP 핸드셰이크 → acp / subprocess 결정 | 폴백으로 계속 |
| `agent:reviewer` | 에이전트 렌더 → `agent validate` → 설치 | 시도 내역과 함께 실패 보고 |

미인증 상태에서는 **에이전트를 설치하지 않는다.** 절반만 된 설치 상태를
남기지 않기 위해서다.

## tool 명명 규약 탐침

Kiro 의 tool 정식 명칭이 문서상 불일치한다 — `--trust-tools` 도움말 예시는
`fs_read,fs_write` 인데 `session/new` 응답의 built-in 목록은 `read, write,
grep...` 이다.

setup 은 이걸 찍지 않고 **두 규약을 순서대로 `agent validate` 에 걸어**
통과하는 쪽을 채택한다. 결과는 `~/.kiro-bridge/config.json` 의 `toolNaming`
에 기록되어 다음 실행에서 재탐침하지 않는다.

둘 다 실패하면 설치를 중단하고 시도 내역을 보고한다. 이때는 Kiro 버전이
바뀌어 tool 이름 체계가 또 달라진 것이므로 `agents.mjs` 의
`TOOL_NAME_SETS` 에 새 규약을 추가해야 한다.

## 설치되는 에이전트

`~/.kiro/agents/kiro-bridge-reviewer.json` — `kiro-bridge-` 접두사로
사용자 소유 공간에서 이름 충돌을 피한다.

권한 (ADR-002):

- 신뢰: `read`, `grep`, `glob` — **명시적으로** pre-trust 한다
- 미신뢰: `write`, `shell`

읽기를 명시 신뢰하는 이유가 중요하다. non-interactive 모드에서 미신뢰 툴
호출은 사용자에게 묻지 않고 **자동 거부되며 대화는 계속된다.** 즉
"아무것도 신뢰하지 않음"은 안전이 아니라 조용한 기능 고장이다 — 리뷰어가
파일을 못 읽은 채 그럴듯한 findings 를 만든다.

## 사용자가 수정한 에이전트

에이전트 JSON 에는 버전과 본문 해시가 스탬프로 들어간다. 사용자가 파일을
손대면 해시가 어긋나고, setup 은 **덮어쓰지 않고 skip 하며 경고한다.**

```
✓ agent:reviewer: skipped (tool 규약: short) → ... — user-modified — 덮어쓰지 않음
```

이 메시지가 보이면 사용자에게 알리고, 덮어쓸지 물어라. 임의로 `--force` 를
붙이지 마라 — 사용자가 의도적으로 프롬프트나 권한을 조정했을 수 있다.

## 언제 다시 실행하나

- 첫 사용 전
- `kiro-cli` 업데이트 후 (능력 캐시는 버전 키라 자동 무효화되지만,
  에이전트 스키마가 바뀌었을 수 있다)
- 리뷰가 `[TOOL_DENIED]` 로 실패했을 때 — 권한 설정이 깨진 신호다
