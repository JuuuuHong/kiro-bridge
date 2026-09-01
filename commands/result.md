---
description: 백그라운드 잡의 결과를 회수한다. --follow-up 으로 세션을 이어 후속 질문 가능
argument-hint: "[job-id] [--follow-up <질문>]"
---

`node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" result $ARGUMENTS` 를 실행하라.

- job-id 를 생략하면 이 저장소의 최신 잡을 본다.
- 아직 `running` 이면 그대로 보고하고 기다린다. 반복 폴링하지 마라.
- `--follow-up` 은 ACP 세션이 남아 있는 잡에서만 동작한다. 세션이 없다는
  오류가 나오면 새 `/kiro-bridge:task` 로 안내한다.
