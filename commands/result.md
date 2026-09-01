---
description: Retrieve the result of a background job. --follow-up continues the session for a follow-up question
argument-hint: "[job-id] [--follow-up <question>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" result $ARGUMENTS`.

- If job-id is omitted, this repo's most recent job is used.
- If it's still `running`, report that as-is and wait. Do not poll repeatedly.
- `--follow-up` only works on jobs with a surviving ACP session. If it errors
  saying no session exists, guide the user toward a new `/kiro-bridge:task`.
- `--model <id>` and `--effort <lv>` override Kiro for the follow-up call.
  These flags, `--timeout`, and `--quiet` require `--follow-up`; plain result
  retrieval is immediate and accepts none of these execution-only options.
- A successful job (and any `--follow-up` on it) is recorded as a resumable
  session and its output includes a resume hint. `--follow-up` remains the
  direct way to continue this specific job's session; for continuing an
  arbitrary previously-recorded session, `/kiro-bridge:resume <question>
  [--session <record-id>]` is preferred, since it resolves any recorded session
  (latest by default) and takes the generated record id rather than the raw
  ACP id.
