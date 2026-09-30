---
description: Retrieve the result of a background job. --follow-up continues the session for a follow-up question
argument-hint: "[job-id] [--follow-up <question>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" result $ARGUMENTS`.

- Shell-quote every argument value you pass (e.g. `--follow-up "..."`).
  Arguments are free-form text; unquoted `;`, backticks, or `$(...)`
  would be interpreted by the shell rather than sent to Kiro.
- If job-id is omitted, this repo's most recent job is used.
- If it's still `running`, report that as-is and wait. Do not poll repeatedly.
- `--follow-up` only works on jobs with a surviving ACP session. If it errors
  saying no session exists, guide the user toward a new `/kiro-bridge:task`.
- A `--follow-up` call blocks until Kiro answers, and its budget defaults to 600s — the
  most the Bash tool will wait, and far past its 120s default. Pass the Bash
  tool `timeout: 600000` with `--timeout 540000`, or run the Bash call in the
  background (`run_in_background`) and read its output when it completes.
- `--model <id>` and `--effort <lv>` override Kiro for the follow-up call. Model
  ids are not guessable — take one from `bridge.mjs models` rather than inventing it.
  These flags, `--timeout`, and `--quiet` require `--follow-up`; plain result
  retrieval is immediate and accepts none of these execution-only options.
- A successful job (and any `--follow-up` on it) is recorded as a resumable
  session and its output includes a resume hint. `--follow-up` remains the
  direct way to continue this specific job's session; for continuing an
  arbitrary previously-recorded session, `/kiro-bridge:resume <question>
  [--session <record-id>]` is preferred, since it resolves any recorded session
  (latest by default) and takes the generated record id rather than the raw
  ACP id.
