# ADR-001R: ACP를 1차 transport로, subprocess를 폴백으로

- 상태: 채택 (2026-08-31). ADR-001을 대체.

## 맥락

kiro-cli 2.20.1은 `kiro-cli acp`로 Agent Client Protocol 서버를 제공한다
(검증: `kiro-cli acp --help`, initialize→session/new stdio 핸드셰이크 왕복,
2026-08-31). ACP는 원샷 `chat --no-interactive` 대비:

- `session/update` 스트리밍 — Kiro의 툴 호출 실시간 가시화
- `session/cancel` — 협조적 취소
- `session/load` — 세션 재사용, 후속 질문에 컨텍스트 재전송 불필요
- `session/request_permission` — **역방향 권한 요청**을 Claude Code로
  브로커링 가능 (정적 신뢰 목록을 넘어서는 대화형 권한 모델)

단, `session/prompt` 실왕복은 아직 미실측(핸드셰이크까지만 검증)이고,
구버전 kiro-cli나 ACP 회귀 가능성이 있으므로 폴백이 필요하다.

## 결정

1. **ACP가 1차 transport.** subprocess(`chat --no-interactive
   --output-format stream-json`)는 능력 감지 실패 시 폴백.
2. transport 인터페이스는 원샷 exec가 아니라 **이벤트 기반**으로 정의한다
   — ACP의 스트리밍·역방향 요청은 요청-응답 1회로 표현이 불가능하다:

   ```js
   run(payload, { agent, model, effort,
     onEvent,             // 스트림 이벤트 (양쪽 transport가 동일 계약)
     onPermissionRequest, // ACP: 브로커링 / subprocess: 항상 거부로 축약
     signal,              // 취소
   }) → { sessionId, result }
   ```

   subprocess 폴백도 `--output-format stream-json`(ACP 이벤트의 JSON Lines)
   으로 같은 이벤트 스트림을 생성하므로 상위 계층 계약이 동일하다.
3. 능력 감지 결과는 kiro-cli 버전을 키로 캐시한다 — 매 호출 핸드셰이크
   프로세스를 띄우지 않는다. 버전 변경 시 무효화.

## 결과

- 스트리밍·취소·세션 재사용·권한 브로커링이 Phase 1 자산이 된다.
  원샷 호출로는 얻을 수 없는 차별화 축.
- 비용: JSON-RPC 클라이언트 구현(프레이밍·요청 대응·역방향 처리).
  녹화 픽스처 재생 테스트로 상쇄.
- 리스크: `session/prompt` 미실측 — Phase 1 착수 전 1회 실왕복으로 확정
  (설계 §10 Open Question 1).
