# ADR-001: Transport 추상화 — subprocess 지금, ACP 대기

- 상태: **Superseded by ADR-001R** (2026-08-31, 당일 폐기)
- 폐기 사유: 전제 사실이 반증됨. 이 ADR은 "Kiro CLI v1.29는 외부 클라이언트
  ACP `session/prompt` 미지원"이라는 2차 정보를 검증 없이
  승계했다. 로컬 설치본 실측 결과 kiro-cli **2.20.1**이었고, `kiro-cli acp`가
  일급 서브커맨드로 존재하며 initialize→session/new 핸드셰이크가 성공했다
  (검증: `kiro-cli --version`, `kiro-cli acp --help`, stdio 왕복, 2026-08-31).
  텔레메트리 enum에 `external_acp`가 공식 실행 경로로 등재되어 있다.
  "ACP가 열리는 미래를 대비한다"는 결정 자체가 이미 지나간 미래를
  가리키므로 폐기하고, ACP를 1차 transport로 삼는 ADR-001R로 대체한다.
- 교훈: 외부 사실 주장에는 버전·검증 명령·날짜를 반드시 병기한다.

## 맥락

Kiro CLI v1.29 기준, 외부 클라이언트에 대한 ACP `session/prompt`가 아직
열려 있지 않다 (`initialize` + `session/new` 핸드셰이크까지만 동작).
따라서 지금
동작하는 유일한 경로는 `kiro-cli chat --no-interactive` 원샷 호출이다.

그러나 ACP가 열리면 스트리밍·멀티턴 세션·툴 호출 가시화가 가능해지고,
이것이 이 플러그인의 가장 큰 차별화 기회다.

## 결정

호출부는 transport 인터페이스(`exec(payload, opts)` / `spawn(payload, opts)`)
에만 의존한다. `transport/index.mjs`가 런타임에 능력 감지(핸드셰이크 시도)
후 acp → subprocess 순으로 선택한다. 상위 계층(커맨드, context, findings)은
transport 교체를 인지하지 못한다.

acp.mjs는 핸드셰이크까지만 구현해두고, `session/prompt` 미지원 감지 시
즉시 subprocess로 폴백한다.

## 결과

- Kiro 릴리스가 ACP를 여는 날, acp.mjs 완성만으로 전환된다. 커맨드 코드 무변경.
- 비용: 인터페이스 한 겹의 간접화. 모듈 2개 수준이라 수용.
