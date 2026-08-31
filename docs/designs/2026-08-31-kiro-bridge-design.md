# kiro-bridge 설계

> 2026-08-31 v2 (설계 리뷰 반영). Claude Code 안에서 Kiro CLI를 활용하는 플러그인.
> 목적: (1) 일상 실사용 (2) 검증되면 포트폴리오 공개.
>
> **검증 환경**: kiro-cli 2.20.1 / macOS 15 / 2026-08-31.
> 외부 사실 주장에는 검증 명령을 병기한다. v1 초안은 kiro-cli v1.29 시점
> 정보에 기반해 ACP를 미래 과제로 놓았으나, 2.20.1 실측으로 반증되어
> 전면 재구성했다 (ADR-001 → Superseded, ADR-001R).

## 1. 포지셔닝 — 무엇을 기여하는가

Claude Code에서 Kiro CLI를 부르는 가장 단순한 경로는 프롬프트 문자열을
`kiro-cli chat --no-interactive`에 넘기는 원샷 호출이다. kiro-bridge는 그
경로로는 성립하지 않는 두 축을 기여한다.

**축 1 — ACP 네이티브 통합.** kiro-cli 2.20.1은 `kiro-cli acp` 서브커맨드로
Agent Client Protocol을 정식 제공한다 (검증: `kiro-cli acp --help`,
initialize→session/new 핸드셰이크 왕복 확인). 이를 1차 transport로 써서:
- 스트리밍 진행 상황 (`session/update`) — Kiro의 툴 호출이 실시간으로 보임
- 취소 (`session/cancel`), 세션 재사용 (`session/load`, 후속 질문에 컨텍스트 재전송 불필요)
- **권한 브로커링**: Kiro의 `session/request_permission`을 Claude Code 쪽
  판단으로 중재. 정적 신뢰 목록보다 강한, 대화형 권한 모델.

원샷 서브프로세스 호출은 요청-응답 한 번으로 끝나므로 위 네 가지가
구조적으로 성립하지 않는다.

**축 2 — 구조화 컨텍스트 핸드오프.** 프롬프트 문자열 대신 diff·관련 파일
발췌·테스트 실패 출력을 구조화 페이로드로 넘기고, 응답을 severity 붙은
findings JSON으로 받는다 (ADR-003). 페이로드가 결정적이라 실패를 재현하고
회귀 테스트할 수 있다. **이 축은 실사용 가설이며, 평가 하네스로 검증한다** (§9).

**왜 Kiro 내장 기능으로 안 되는가**: Kiro는 `--trust-tools` 툴 단위 신뢰,
커스텀 에이전트, spec/planner 모드를 이미 내장한다. kiro-bridge의 기여는
그 기능들의 재발명이 아니라 **Claude Code 세션과의 접속면**이다 — Claude가
가진 컨텍스트(diff, 실패 테스트)를 구조화해 넘기고, Kiro의 스트림·권한
요청·findings를 Claude 세션 안으로 되가져오는 부분은 Kiro 단독으로 성립하지
않는다. spec 파이프라인은 차별화가 아니라 Kiro 네이티브 `--mode spec`을
호출하는 통합 시나리오로만 다룬다 (§2.3).

## 2. 사용 시나리오 (실사용 우선순위 순)

1. **리뷰 세컨드 오피니언**: Claude가 작업을 마친 diff를 Kiro가 리뷰.
   `/kiro-bridge:review` → findings JSON → Claude가 반영 여부 판단 (자동 적용 없음, ADR-004).
2. **작업 위임**: 조사·디버깅을 Kiro에 위임. `/kiro-bridge:task [--bg]` → `/kiro-bridge:result`.
3. **spec 파이프라인**: Kiro 네이티브 spec/planner 모드로 requirements/design
   정제 → Claude Code가 구현. (Kiro `--mode spec` 출력 형식 실측 후 설계 확정 — §10)
4. **AWS 자문**: 인프라 코드(CDK/IAM)에 대해 `use_aws`를 읽기 전용·서비스
   제한으로 좁힌 advisor 에이전트로 질의.

## 3. 아키텍처

```
plugins/kiro-bridge/
├── .claude-plugin/plugin.json
├── commands/            # setup, review, task, spec, result, status, cancel
├── kiro-agents/         # Kiro 커스텀 에이전트 정의(JSON) — 권한 명세의 SSOT
│   ├── kiro-bridge-reviewer.json   # 읽기 툴 명시 신뢰, 쓰기 미신뢰 (Phase 1)
│   ├── kiro-bridge-spec-writer.json# 쓰기는 .kiro/specs/ 하위만 (Phase 2)
│   ├── kiro-bridge-researcher.json # 읽기 + web_search/web_fetch (Phase 2)
│   └── kiro-bridge-aws-advisor.json# use_aws 읽기 전용·서비스 제한 (Phase 2)
├── scripts/
│   ├── bridge.mjs       # 엔트리포인트 (커맨드 라우팅)
│   └── lib/
│       ├── transport/
│       │   ├── index.mjs      # 능력 감지(버전 키로 캐시) → acp | subprocess
│       │   ├── acp.mjs        # 1차: kiro-cli acp (stdio JSON-RPC)
│       │   └── subprocess.mjs # 폴백: chat --no-interactive --output-format stream-json
│       ├── context.mjs  # 핸드오프 페이로드 빌더 + 아웃바운드 redaction (§7)
│       ├── findings.mjs # 응답 파싱 → 구조화 findings + 신뢰 경계 래핑 (ADR-004)
│       ├── jobs.mjs     # 백그라운드 잡 상태 (§8)
│       └── config.mjs   # ~/.kiro-bridge/config.json
└── skills/              # 커맨드별 상세 사용법 SKILL.md
```

원칙:
- 외부 프로세스는 `execFile`/`spawn` 직접 호출만. 셸 문자열 조립 금지.
- 네트워크 코드 0줄 — 모든 통신은 kiro-cli 바이너리를 통해서만.
- 상태·설정은 `~/.kiro-bridge/` 하위. 예외: 커스텀 에이전트는 Kiro 규약상
  `~/.kiro/agents/kiro-bridge-*.json` (접두사로 네임스페이스 격리, §6).
- Stop 훅 없음. 훅은 SessionStart/End 라이프사이클 정리용만.
- 프롬프트 페이로드는 **항상 stdin 파이프**로 전달 (인자 크기 분기 자체를 제거).

### Transport 인터페이스 (ADR-001R)

원샷 `exec()`로는 ACP의 스트리밍·역방향 권한 요청을 표현할 수 없으므로
이벤트 기반으로 정의한다:

```js
transport.run(payload, {
  agent, model, effort,
  onEvent,             // session/update 스트림 (subprocess는 stream-json으로 동일 계약)
  onPermissionRequest, // ACP: Claude Code로 브로커링 / subprocess: 항상 거부로 축약
  signal,              // AbortSignal → session/cancel 또는 프로세스 kill
}) → { sessionId, result }
```

능력 감지 결과는 kiro-cli 버전을 키로 `~/.kiro-bridge/config.json`에 캐시.

## 4. 커맨드 설계

| 커맨드 | Phase | 동작 | 기본 에이전트/권한 | 기본 model/effort |
|---|---|---|---|---|
| `/kiro-bridge:setup` | 1 | 설치·로그인 확인, 에이전트 설치 + `agent validate` | - | - |
| `/kiro-bridge:review [ref]` | 1 | diff 컨텍스트 → findings | reviewer (읽기 신뢰) | sonnet 계열 / medium |
| `/kiro-bridge:task <설명> [--bg] [--write]` | 2 | 작업 위임 | 기본 읽기 / `--write`→scoped 에이전트 | auto |
| `/kiro-bridge:spec <기능>` | 2 | 네이티브 spec 모드 → `.kiro/specs/` | spec-writer | 상위 모델 / high |
| `/kiro-bridge:result [id] [--follow-up <질문>]` | 2 | 잡 결과 회수, 세션 이어서 후속 질문 | - | - |
| `/kiro-bridge:status` / `/kiro-bridge:cancel` | 2 | 잡 목록·누적 크레딧 / 취소 | - | - |

- 커맨드 네임스페이스는 **플러그인 이름**이다 (`plugin.json` 의 `name`).
  초안의 `/kiro:*` 는 플러그인 이름이 `kiro` 여야 나오므로 도달 불가였고,
  실제 이름 `kiro-bridge` 에 맞춰 `/kiro-bridge:*` 로 정정했다
  (확인: 설치된 플러그인 `oh-my-claudecode` + `commands/hud.md` → `/oh-my-claudecode:hud`).
- `--trust-all-tools`가 기본값이 되는 코드 경로는 만들지 않는다 (ADR-002).
  전권은 `--yolo` 명시 + 실행 전 확인으로만.
- model/effort는 커맨드별 기본값 + `--model`/`--effort` 오버라이드.
  호출별 크레딧 소모를 `~/.kiro-bridge/usage.jsonl`에 적재하고
  `/kiro-bridge:status`에 누적 표시.

## 5. 컨텍스트 핸드오프 (ADR-003)

요청 페이로드 (Claude → Kiro, stdin):

```json
{
  "kind": "review | task | spec",
  "goal": "한 문장 목표",
  "diff": "git diff 출력 (리뷰 시)",
  "files": [{ "path": "...", "reason": "why included", "excerpt": "..." }],
  "signals": { "failing_tests": "...", "lint": "...", "notes": "..." },
  "constraints": ["수정 금지 영역", "스타일 규칙 등"]
}
```

Kiro는 `read`/`grep` 툴로 스스로 파일을 읽을 수 있으므로, `files.excerpt`는
전체 삽입이 아니라 **진입점 안내** 수준으로 최소화한다 (컨텍스트 밀어내기
방지). ACP `_kiro.dev/metadata`의 `contextUsagePercentage`를 받아 페이로드
과대 삽입을 경고한다.

응답 계약 (Kiro → Claude, 에이전트 프롬프트로 요구, best-effort):

```json
{
  "findings": [{
    "severity": "low | medium | high",
    "file": "path", "line": 0,
    "claim": "한 문장 결함 서술",
    "evidence": "근거", "suggestion": "수정 방향"
  }],
  "summary": "전체 판단"
}
```

- severity별 기본 동작: high=반드시 검토, medium=제안으로 표시, low=기록만.
- 파싱 실패는 오류가 아니다 — 원문 그대로 반환하되, **신뢰 경계 래핑은
  파싱 성공/실패와 무관하게 항상 적용** (ADR-004).

## 6. 커스텀 에이전트 관리

- 모든 번들 에이전트는 `kiro-bridge-` 접두사 — 사용자 소유 공간
  (`~/.kiro/agents/`)에서의 이름 충돌 방지.
- 에이전트 JSON에 버전 스탬프를 넣고, `/kiro-bridge:setup`이 해시 비교 →
  사용자가 수정한 파일은 덮어쓰지 않고 경고.
- 설치 시 `kiro-cli agent validate --path <file>` 필수 통과
  (검증: `kiro-cli agent --help`에 validate 존재).
- **tool 이름 주의**: `--trust-tools` 도움말 예시는 `fs_read,fs_write`인데
  session/new 응답의 built-in 목록은 `read, write, shell, grep, glob,
  use_aws, web_search, ...`로 상이하다. 에이전트 초안 작성 시 실측으로
  확정하고 validate로 검증한다 (§10 Open Question).

## 7. 아웃바운드 방어 (redaction)

diff·발췌·테스트 출력이 AWS로 전송되므로 `context.mjs`에 전송 전 단계를 둔다:

- 파일 제외 목록: `.env*`, `*.pem`, `*credentials*`, `*.key` 등.
- 패턴 마스킹: AWS 액세스 키, 고엔트로피 문자열, private 호스트명(설정 가능).
- `--dry-run`: 전송 직전 페이로드를 사람이 확인.
- 전송 페이로드 로그(`~/.kiro-bridge/`)는 0600 권한 + 보존기간 설정.

## 8. 실패 모드와 잡 수명주기

### 실패 모드 (Phase 1 필수)

| 실패 | 감지 | 사용자 표시 | 재시도 |
|---|---|---|---|
| 타임아웃 | 커맨드별 기본(review 180s, task 600s), `--timeout` | 부분 출력 + 타임아웃 명시 | 안 함 |
| 미인증 | `kiro-cli whoami` 실패 | `kiro-cli login` 안내 | 안 함 |
| 크레딧/스로틀 | 오류 패턴 매칭 | 소진 안내 + usage 표시 | 안 함 |
| **툴 거부** | 출력/이벤트의 `[denied]` 감지 | findings 신뢰 취소, "권한 부족" 오류로 승격 | 안 함 |
| 파싱 실패 | JSON 추출 실패 | 원문 반환 + 구조화 실패 표시 | 안 함 |

툴 거부가 특히 중요하다: non-interactive 모드는 미신뢰 툴 호출을 묻지 않고
자동 거부하며 대화는 계속되므로(검증: 바이너리 오류 문자열), 감지하지
않으면 "파일을 못 읽고 만든 그럴듯한 findings"를 성공으로 오인한다.
→ reviewer 에이전트는 읽기 툴을 **명시적으로 pre-trust**하고, transport에
denial detector를 둔다.

### 잡 수명주기 (Phase 2)

- 레이아웃: `~/.kiro-bridge/jobs/<cwd-hash>/<job-id>/{meta.json,stdout.log,status}`
  — cwd 스코프로 리포 간 잡 혼선 방지.
- 상태 전이: `queued → running → done | failed | cancelled`. 상태 쓰기는
  임시파일+rename으로 원자적.
- 백그라운드는 `detached + unref`, stdio는 파일 리다이렉트.
- 취소는 PID 재사용 대비 job-id→PID+시작시각 대조 후 kill (ACP면 session/cancel).
- 완료 후 30일 GC. SessionEnd 훅은 고아 프로세스 정리만 하고 잡 결과는 보존.
- 잡 메타에 `sessionId` 저장 → `/kiro-bridge:result --follow-up`이 `session/load`로
  컨텍스트 재전송 없이 후속 질문.

## 9. 평가 하네스 (포트폴리오 핵심)

축 2는 가설이므로 검증한다: 실제 diff 15~20개에 대해
(A) 프롬프트 문자열만 vs (B) 구조화 핸드오프를 돌리고, gold findings 대비
precision/recall + 크레딧 + 지연을 `docs/evaluation/`에 재현 스크립트와 함께
기록한다. **결과가 "차이 없음"이어도 그대로 공개한다** — 반증 가능한 설계
자체가 산출물이다.

## 10. 로드맵 / Open Questions

- **Phase 1 — 리뷰 단일 축**: ACP transport(+subprocess 폴백) + 컨텍스트
  빌더/redaction + reviewer 에이전트 + `/kiro-bridge:setup` `/kiro-bridge:review` +
  실패 모드 표 구현. 유닛 테스트 동반.
  → **코드 완료 (2026-09-01), 실기기 검증 대기.** 목업 바이너리 기준 테스트
  91건 통과. 실제 `kiro-cli` 로 1회 왕복해야 Phase 1 을 닫을 수 있다
  (OQ 1·2·3·5·6·7). OQ4 는 설치 시점 탐침으로 코드가 스스로 해소한다.
- **Phase 2**: `/kiro-bridge:task`(fg/bg), 잡 수명주기, spec 파이프라인,
  나머지 에이전트 3종, `--follow-up`, usage 계측.
- **Phase 3**: 권한 브로커링 고도화(세밀한 정책), 평가 하네스 완성, 공개 준비
  (README 영/한, marketplace.json, 스트리밍 데모 캡처, private 기간 산출물
  전수 점검 후 public).

Open Questions (각 1회 실측으로 해소):
1. ACP `session/prompt` 실왕복 (핸드셰이크까지만 검증됨, 크레딧 소모 이슈로 보류).
2. 기본 신뢰 툴 집합 — `read`가 기본 신뢰인지 (`autoAllowReadonly` 기본값).
3. `--mode spec` 출력이 `.kiro/specs/` 파일인지 대화 텍스트인지.
4. tool 정식 명칭 (`fs_read` vs `read`) — §6 참조.
5. ACP 프레이밍이 ndjson인지 (LSP식 `Content-Length` 헤더가 아닌지).
   `jsonrpc.mjs` 한 곳에 격리되어 있어 반증되면 그 파일만 바뀐다.
6. `session/update` 판별자 이름 (`agent_message_chunk` 등) 및
   `--output-format stream-json` 줄 형식이 ACP 이벤트와 동일한지.
   `events.mjs` 의 정규화가 양쪽을 흡수하도록 되어 있다.
7. `chat`/`acp` 서브커맨드의 `--agent`/`--model`/`--effort` 플래그 실재 여부.

**착수 순서 변경 (2026-09-01)**: 원래 1~4를 Phase 1 착수 전 조건으로 뒀으나,
실측 환경이 없는 동안 §11의 목업 기반 계층(컨텍스트·findings·transport)을
먼저 구현했다. 실측이 가능해지면 목업 응답을 녹화 픽스처로 교체하고 위
항목들을 확정한다 — transport 코드 자체는 바뀌지 않는 것이 설계 의도다.

## 11. 테스트 전략

- transport·context·findings·jobs는 가짜 kiro-cli 바이너리(mock 스크립트)로
  유닛 테스트. Node 내장 `node:test`, 의존성 0.
- ACP transport는 녹화된 JSON-RPC 왕복 픽스처로 재생 테스트.
- 통합 테스트는 실제 kiro-cli 존재 시에만 도는 opt-in 계층.
- redaction은 시크릿 샘플 픽스처로 양성/음성 모두 검증.
