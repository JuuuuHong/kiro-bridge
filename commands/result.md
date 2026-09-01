---
description: Retrieve the result of a background job. --follow-up continues the session for a follow-up question
argument-hint: "[job-id] [--follow-up <question>]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" result $ARGUMENTS`.

- If job-id is omitted, this repo's most recent job is used.
- If it's still `running`, report that as-is and wait. Do not poll repeatedly.
- `--follow-up` only works on jobs with a surviving ACP session. If it errors
  saying no session exists, guide the user toward a new `/kiro-bridge:task`.
