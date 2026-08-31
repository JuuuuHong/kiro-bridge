# ADR-002: 기본 읽기 전용 = 읽기 툴 명시 신뢰 + 쓰기 툴 미신뢰

- 상태: 채택 (2026-08-31, v2 — 리뷰 반영 개정)

## 맥락

위임 실행의 권한 기본값 후보:

- `--trust-all-tools` **기본 on**: 위임 프롬프트에 인젝션이 섞이면 그대로
  실행되므로 기각.
- 기본 읽기 전용 + `--write` 시 전권: 전환 단위가 너무 거칠다. 쓰기 한
  줄이 필요한 작업에도 전권을 주게 되므로 기각.

한편 kiro-cli 자체가 `--trust-tools=<목록>` 툴 단위 신뢰와 커스텀 에이전트의
`allowedTools`/경로 스코핑을 이미 제공하므로(검증: `kiro-cli chat --help`,
2.20.1), 이 ADR의 기여는 권한 메커니즘의 발명이 아니라 **기본값 정책과
운영 규약**이다.

**핵심 제약**: non-interactive 모드에서 미신뢰 툴 호출은 사용자에게 묻지
않고 **자동 거부되고 대화는 계속된다** (검증: 바이너리 오류 문자열
`[denied] tool permission approval is not supported in non-interactive mode`).
즉 "아무것도 신뢰하지 않음"은 안전이 아니라 **조용한 기능 고장**이다 —
reviewer가 파일을 못 읽은 채 그럴듯한 findings를 만들 수 있다.

## 결정

1. "기본 읽기 전용"의 정의: **읽기 계열 툴을 명시적으로 pre-trust하고
   쓰기·실행 계열 툴을 미신뢰**로 두는 것. 커스텀 에이전트 JSON이 권한
   명세의 단일 진실 공급원이다.
2. transport에 **denial detector**를 둔다: 출력/이벤트에서 툴 거부를
   감지하면 결과를 신뢰하지 않고 "권한 부족" 오류로 승격한다.
3. 쓰기가 필요한 커맨드는 범위 제한 에이전트로만: spec-writer는
   `.kiro/specs/` 하위 쓰기만, aws-advisor는 `use_aws`를 읽기 전용
   오퍼레이션·허용 서비스 목록으로 제한.
4. `--write`는 "전권"이 아니라 "쓰기 허용 scoped 에이전트 사용".
   `--trust-all-tools`가 기본값이 되는 코드 경로는 만들지 않으며,
   전권은 별도 `--yolo` 플래그 + 실행 전 사용자 확인으로만 연다.
5. ACP 경로에서는 `session/request_permission`을 Claude Code로 브로커링해
   정적 목록 밖의 요청을 대화형으로 중재한다 (ADR-001R).

## 결과

- 인젝션·오동작의 피해 반경이 에이전트 정의로 상한이 잡히고,
  "조용한 거부" 실패 모드가 구조적으로 감지된다.
- 비용: 에이전트 설치 단계(`/kiro:setup`, `agent validate` 필수 통과)와
  tool 정식 명칭 실측(도움말 예시 `fs_read/fs_write` vs session/new 응답
  `read/write` 불일치 — 설계 §10 Open Question 4).
