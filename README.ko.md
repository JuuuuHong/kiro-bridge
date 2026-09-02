# kiro-bridge

[English](README.md) | [한국어](README.ko.md)

![license](https://img.shields.io/badge/license-MIT-blue.svg)

Claude Code에서 리뷰·조사·spec 작성을 ACP를 통해 Kiro CLI에 위임한다.

## 왜 필요한가

Claude Code에서 Kiro CLI를 부르는 가장 단순한 경로는 원샷 서브프로세스
호출이다 — 프롬프트 문자열을 넘기고 문자열을 돌려받는다. kiro-bridge는
그 경로가 성립하지 않는 두 축을 채우기 위해 존재한다.

**ACP 네이티브 통합.** kiro-cli는 `kiro-cli acp` 서브커맨드로 Agent Client
Protocol을 정식 제공한다. 원샷 호출 대신 이를 1차 transport로 쓰면
스트리밍 진행 상황(`session/update` — Kiro의 툴 호출이 실시간으로 보임),
취소(`session/cancel`), 세션 재사용(`session/load` — 후속 질문에 컨텍스트
재전송 불필요), 권한 브로커링(`session/request_permission`을 Claude Code
쪽 판단으로 중재하는, 정적 신뢰 목록을 넘어서는 대화형 모델)이 열린다.
이 넷은 요청-응답 한 번으로는 구조적으로 성립하지 않는다.

**신뢰 경계 래핑을 갖춘 구조화 컨텍스트 핸드오프.** 프롬프트 문자열
대신, kiro-bridge는 diff·관련 파일 발췌·실패한 테스트 출력·제약 조건을
구조화 페이로드로 넘기고, severity가 붙은 findings JSON을 돌려받는다.
페이로드가 결정적이므로 실패를 재현하고 회귀 테스트할 수 있다. 그리고
Kiro의 출력이 Claude Code 컨텍스트로 되돌아오므로, 명령이 아니라
데이터로 래핑한다 — 자동 반영 없음, 고정 신뢰 경계 래핑, 파싱 성공
여부와 무관하게 모든 응답에 적용되는 스키마 소독.

kiro-bridge는 Kiro 자체의 툴 신뢰 모델, 커스텀 에이전트, spec/planner
모드를 재발명하지 않는다 — Claude Code 세션과 Kiro의 기능 사이의
접속면이다.

## 요구사항

- Claude Code
- kiro-cli 2.20+
- Node 20+
- `kiro-cli login`으로 인증된 세션

## 설치

```
/plugin marketplace add JuuuuHong/kiro-bridge
/plugin install kiro-bridge@kiro-bridge
```

## 커맨드

| 커맨드 | Phase | 설명 |
|---|---|---|
| `/kiro-bridge:setup` | 1 | 설치·인증 확인 후 번들 Kiro 에이전트 설치 |
| `/kiro-bridge:review [ref] [--focus <text>] [--adversarial] [--bg] [--model <id>] [--effort <lv>]` | 1 | 현재 diff를 Kiro가 리뷰하고 구조화 findings 반환 |
| `/kiro-bridge:task <목표> [--bg] [--write] [--model <id>] [--effort <lv>]` | 2 | 조사·디버깅을 Kiro에 위임 (foreground 또는 background) |
| `/kiro-bridge:spec <기능> [--model <id>] [--effort <lv>]` | 2 | Kiro 네이티브 spec 모드로 `.kiro/specs/`에 requirements/design 생성 |
| `/kiro-bridge:result [job-id] [--follow-up] [--model <id>] [--effort <lv>]` | 2 | 백그라운드 잡 결과 회수, 세션 이어서 후속 질문 가능 |
| `/kiro-bridge:resume <질문> [--session <id>] [--model <id>] [--effort <lv>]` | 3 | 기록된 재개 가능한 Kiro 세션을 후속 질문으로 이어감 |
| `/kiro-bridge:transfer [--session <id>]` | 3 | 세션을 Kiro 자체에서 이어가는 `kiro-cli chat --resume-id` 명령을 출력 |
| `/kiro-bridge:status` | 2 | 이 저장소의 잡 목록과 누적 사용량 표시 |
| `/kiro-bridge:cancel <job-id>` | 2 | 실행 중인 백그라운드 잡 취소 |

위 모든 명령은 `--json`도 받는다. 사람이 읽는 요약 대신 기계가 읽는 봉투를
출력하며, 에이전트가 생성한 필드는 `"external": true`로 표시되고 펜스가 적용된
`wrapped` 문자열을 그대로 유지한다. 모델 컨텍스트에 넣어야 하는 건 `findings`가
아니라 이 `wrapped` 문자열이다(ADR-004).

### 리뷰 모드

`review`는 기본적으로 읽기 전용 결함 리뷰다. `--focus "<관심사>"`로 특정
영역에 집중시킬 수 있고, `--adversarial`은 변경이 틀렸다고 가정하고 가정·
신뢰 경계·동시성·대안 설계를 적극적으로 파고든다 — 여전히 엄격히 읽기 전용,
findings 전용이다. `--bg`는 리뷰를 백그라운드 잡으로 돌리며 동일한 형식의
findings를 반환한다. 결과는 `/kiro-bridge:result`로 회수한다.

### 재개 가능한 세션

ACP를 통한 모든 성공한 Kiro 턴 — foreground `task`/`spec`/`review`, 완료된
백그라운드 잡, `result --follow-up` — 은 저장소별 제한된 세션 레지스트리에
기록되고, 성공 출력에는 resume 힌트가 표시된다. `/kiro-bridge:resume <질문>`은
기본적으로 가장 최근에 기록된 세션(또는 `--session`으로 특정 세션)을
`session/load`로 이어받아 컨텍스트 재전송 없이 대화를 계속한다. resume은
원래 세션의 에이전트와 읽기/쓰기 분류를 복원한다 — 재개된 리뷰는 읽기 전용
리뷰어로 남고, `--write` worker는 제한된 쓰기 권한을 유지한다 — 응답은 외부
데이터로 래핑되며(ADR-004) 자동 반영되지 않는다.

레지스트리는 의도적으로 최소한이다: 각 레코드는 cwd 해시로 스코프된 불변
atomic `0600` 파일이라 저장소가 섞이지 않으며, 안전한 필드(레코드 id, 세션
id, 에이전트, source kind/command, write 플래그, transport, 선택적 model,
타임스탬프)만 담는다. 프롬프트·diff·파일 경로·모델 출력은 **절대** 저장되지
않는다. 레코드는 보존 기간과 최대 개수 상한으로 GC된다. `--session`은 생성된
레코드 id(resume 힌트에서 제공)와 원본 ACP 세션 id를 모두 받지만, 원본 ACP
id 노출을 피하므로 레코드 id가 권장된다.

## 보안 모델

- **기본 읽기 전용.** 위임 실행은 읽기 계열 툴을 명시적으로 pre-trust하고
  쓰기·실행 계열 툴은 미신뢰로 둔다. 커스텀 에이전트 JSON이 권한 명세의
  단일 진실 공급원이다 (ADR-002).
- **명시 pre-trust + denial detector.** non-interactive 모드는 미신뢰 툴
  호출을 묻지 않고 자동 거부한 채 대화를 계속한다 — 안전이 아니라 조용한
  기능 고장이다. denial detector가 감지된 거부를 그럴듯한 결과로 흘려
  보내지 않고 "권한 부족" 오류로 승격한다 (ADR-002).
- **셸은 어떤 에이전트·어떤 플래그에서도 절대 신뢰하지 않는다.**
- **전권으로 가는 경로는 없다.** 이 플러그인은 `--trust-all-tools`를
  활성화하지 않는다. 명시적인 `task --write` 모드도 셸은 미신뢰로 유지하고
  worker 에이전트의 제한된 쓰기 툴만 허용한다 (ADR-002).
- **아웃바운드 redaction (브리지가 구성한 페이로드에 한함).** 브리지가 직접
  조립하는 diff·파일 발췌는 기기를 떠나기 전에 걸러진다 — 파일 제외 목록,
  시크릿 패턴 마스킹, `--dry-run` 페이로드 미리보기 (설계 §7). 이 redaction은
  브리지가 만든 diff/발췌에**만** 적용된다. Kiro가 자체 툴로 직접 읽는 파일은
  브리지 redaction을 거치지 않는다. 브리지 권한은 Kiro 수준의 툴 신뢰 설정이며
  독립적인 OS 수준 샌드박스가 **아니다**.
- **Kiro 출력은 데이터로 취급하며 명령으로 취급하지 않는다.** 리뷰 findings는
  항상 고정 신뢰 경계로 래핑되고 스키마로 소독되며 자동 반영되지 않는다.
  `task --write`는 제한된 파일을 수정할 수 있는 별도의 명시적 실행 모드이므로,
  결과를 수락하기 전에 생성된 git diff를 검토해야 한다 (ADR-004).
- **격리된 자식 환경.** 모든 kiro-cli spawn/exec는 부모 프로세스 환경을
  상속하지 않고 명시적 허용 목록 환경을 받는다. 기본 허용 목록은 일반 CLI에
  필요한 것(`PATH`, `HOME`, 로케일/`LC_*`, 임시 디렉터리, XDG, 프록시, CA
  번들, `KIRO_AGENTS_DIR`)만 전달하고, 클라우드·프로바이더 자격증명(AWS
  자격증명·토큰 변수, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`,
  `NPM_TOKEN`), `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `FORCE_COLOR`, npm config
  주입(`npm_*`, `NPM_CONFIG_*`)은 **하드 차단**한다. `KIRO_BRIDGE_HOME`과
  상속된 `PWD`는 전달하지 않으며 `NO_COLOR=1`을 강제한다. 추가 변수를
  전달하려면 `~/.kiro-bridge/config.json`의 `envPassthrough`에 **정확한
  이름**을 나열한다(와일드카드 없음). `AWS_PROFILE`, `AWS_REGION` 같은 비밀이
  아닌 선택자에 대한 안전한 opt-in이며, 하드 차단이 항상 우선하므로
  passthrough 항목이 자격증명 변수를 다시 들일 수는 없다.
- **프로젝트 단위 설정은 강화 전용.** 저장소는 `.kiro/settings/kiro-bridge.json`
  (Kiro 자체의 전역/프로젝트 설정 관례)으로 아웃바운드 보호를 추가할 수 있지만,
  `redaction.excludeFiles`와 `redaction.privateHosts` 패턴 *추가*만 가능하다. 이
  파일은 저장소 안에 함께 배포되므로 내가 작성하지 않은 레포에서는 공격자가
  제어하는 입력이다. 따라서 기본 제외 패턴 제거, 엔트로피·길이 임계값 완화,
  `envPassthrough` 확장, capability 캐시 쓰기는 전부 무시된다. 프로젝트 패턴이
  사용자 전역 `~/.kiro-bridge/config.json`으로 승격되는 일도 없다.
- **출력 소독.** 모든 Kiro 출력은 터미널 제어 시퀀스 — ANSI CSI 및 OSC(OSC 52
  클립보드 포함), DCS/PM/APC/SOS 문자열, 단독 `ESC`, C0/C1 제어 바이트 — 가
  최종 stdout/stderr 경계와 모든 구조화/원시 출력 경계에서 제거되며, 잡 이벤트
  라벨도 동일한 소독기를 재사용한다. 악의적인 diff나 모델 응답이 터미널로
  이스케이프 시퀀스를 방출할 수 없다.

## 설계 문서

아키텍처, 결정 기록, 평가 계획은 [`docs/`](docs/) 하위에 있다 —
[`docs/designs/2026-08-31-kiro-bridge-design.md`](docs/designs/2026-08-31-kiro-bridge-design.md)와
[`docs/decisions/`](docs/decisions/) 하위 ADR부터 보면 된다.

## 검증 환경

kiro-cli 2.20.2, macOS, 2026-09-01.

## 라이선스

[MIT](LICENSE)
