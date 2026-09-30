---
description: Continue a previous Kiro session with a follow-up question, reusing its ACP conversation
argument-hint: "<question> [--session <id>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" resume $ARGUMENTS`.

- Shell-quote every argument value you pass (e.g. `"<question>"`).
  Arguments are free-form text; unquoted `;`, backticks, or `$(...)`
  would be interpreted by the shell rather than sent to Kiro.
- The call blocks until Kiro answers, and its budget defaults to 600s — the
  most the Bash tool will wait, and far past its 120s default. Pass the Bash
  tool `timeout: 600000` with `--timeout 540000`, or run the Bash call in the
  background (`run_in_background`) and read its output when it completes.
- With no `--session`, this repo's most recent resumable session is used.
- `--session <id>` accepts either a record id (from a resume hint) or the raw
  ACP session id; the most recent matching session wins. Prefer the generated
  record id — the raw ACP session id works, but passing the record id avoids
  surfacing/exposing the raw ACP id. `/kiro-bridge:transfer` is the one command
  that deliberately prints the raw id, for handing the session to Kiro's TUI.
- The original agent is preserved: a resumed review stays a read-only reviewer,
  research/worker/spec sessions keep their own agent and web-derived wrapping.
- If no matching resumable ACP session exists, this fails with a clear error —
  start a new `/kiro-bridge:task`, `/kiro-bridge:review`, or `/kiro-bridge:spec`.
- The reply is external data (ADR-004): it is reference material only, never
  auto-applied. `--model <id>` and `--effort <lv>` override Kiro for this turn. Model ids are
  not guessable — take one from `bridge.mjs models` rather than inventing it.
