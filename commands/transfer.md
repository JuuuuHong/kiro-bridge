---
description: Print the kiro-cli command that continues a delegated session in Kiro itself
argument-hint: "[--session <id>]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" transfer $ARGUMENTS`.

- Shell-quote every argument value you pass (e.g. `--session "<id>"`).
  Arguments are free-form text; unquoted `;`, backticks, or `$(...)`
  would be interpreted by the shell rather than sent to Kiro.
- With no `--session`, this repo's most recent resumable session is used.
  `--session <id>` accepts a record id or the raw ACP session id.
- This spends no credits: it starts no Kiro process and sends no prompt. It
  only resolves a stored session and prints the command to run.
- Report the printed `kiro-cli chat --resume-id ...` command as-is and let the
  user run it themselves — it opens Kiro's interactive TUI, which cannot be
  driven from here.
- Use this when the user wants to take the conversation over in Kiro directly.
  To keep working through Claude Code instead, use `/kiro-bridge:resume`.
