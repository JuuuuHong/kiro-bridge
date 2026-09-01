---
name: spec
description: Kiro 를 spec 작성자로 써서 기능 요구를 EARS requirements + design 문서로 정제한다. 구현 전에 요구사항을 구조화하고 싶을 때, 또는 사용자가 "spec 부터 만들자"라고 할 때 사용한다.
argument-hint: "<기능 설명> [--model <id>] [--effort <lv>]"
---

# kiro:spec

역할 분담 파이프라인: **Kiro 가 spec 을 쓰고, Claude 가 구현한다** (설계 §2.3).
spec-writer 에이전트는 `.kiro/specs/<슬러그>/requirements.md` 와 `design.md` 를
생성한다. 쓰기는 그 경로로만 제한되고 셸은 미신뢰다.

## 실행

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" spec "<기능 설명>" [flags]
```

기본 모델은 auto 이지만 spec 은 정제 품질이 중요하므로 사용자가 원하면
`--model` 로 상위 모델을, `--effort high` 를 권한다.

## 완료 후 워크플로 — 반드시 지킬 것

1. `.kiro/specs/` 에 생성된 파일을 **읽는다**.
2. 요구사항을 요약해 사용자에게 보이고 **검토를 받는다**. spec 도 외부
   에이전트 산출물이므로 검토 없이 구현에 들어가지 않는다 (ADR-004).
3. 검토 통과분만 구현 계획으로 옮긴다. 현재 코드와 모순되는 요구는
   지적하고 사용자 판단을 받는다.
