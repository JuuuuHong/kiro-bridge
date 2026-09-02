---
description: Cancel a running background Kiro job
argument-hint: "<job-id>"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" cancel $ARGUMENTS`.

- Shell-quote every argument value you pass (e.g. `<job-id>`).
  Arguments are free-form text; unquoted `;`, backticks, or `$(...)`
  would be interpreted by the shell rather than sent to Kiro.
- Find the job-id via `/kiro-bridge:status`.
- A job that has already finished cannot be cancelled — report that fact as-is.
