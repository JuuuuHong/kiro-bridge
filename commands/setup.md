---
description: Verify Kiro CLI is installed and authenticated, then install the kiro-bridge agents
argument-hint: "[--force]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" setup $ARGUMENTS` and
report the result as-is. See the `setup` skill for detailed instructions.

- Relay guidance for any failed step (e.g. `kiro-cli login`) to the user.
- If an agent is skipped as `user-modified`, do not overwrite it — tell the
  user. Do not append `--force` on your own.
