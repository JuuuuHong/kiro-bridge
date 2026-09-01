---
description: Cancel a running background Kiro job
argument-hint: "<job-id>"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" cancel $ARGUMENTS`.

- Find the job-id via `/kiro-bridge:status`.
- A job that has already finished cannot be cancelled — report that fact as-is.
