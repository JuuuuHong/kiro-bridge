---
description: Kiro CLI 설치·인증 확인 후 kiro-bridge 에이전트를 설치한다
---

`${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs setup` 을 실행하고 결과를 그대로 보고하라.

- 실패한 단계가 있으면 출력의 안내(`kiro-cli login` 등)를 사용자에게 전달한다.
- 에이전트가 `user-modified` 로 skip 되면 덮어쓰지 말고 사용자에게 알린다.
- 재설치가 필요하면 `--force` 를 붙인다.
