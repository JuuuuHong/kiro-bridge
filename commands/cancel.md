---
description: 실행 중인 백그라운드 Kiro 잡을 취소한다
argument-hint: "<job-id>"
---

`node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" cancel $ARGUMENTS` 를 실행하라.

- job-id 는 `/kiro-bridge:status` 에서 확인한다.
- 이미 종결된 잡은 취소되지 않는다 — 그 사실을 그대로 보고한다.
