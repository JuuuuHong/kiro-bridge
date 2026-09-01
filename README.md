# kiro-bridge

[English](README.md) | [한국어](README.ko.md)

![license](https://img.shields.io/badge/license-MIT-blue.svg)

Delegate reviews, research, and spec-writing from Claude Code to Kiro CLI over ACP.

## Why

The simplest way to call Kiro CLI from Claude Code is a one-shot subprocess
call — hand it a prompt string, get a prompt string back. kiro-bridge exists
because that path doesn't hold up on two axes:

**ACP-native integration.** kiro-cli ships the Agent Client Protocol as a
first-class subcommand (`kiro-cli acp`). Using it as the primary transport,
instead of a one-shot call, unlocks streaming progress
(`session/update` — Kiro's tool calls become visible in real time),
cancellation (`session/cancel`), session reuse (`session/load` — no context
resend on follow-ups), and permission brokering (`session/request_permission`
mediated by Claude Code's own judgment, an interactive model beyond a static
trust list). None of these are structurally possible over a single
request-response round trip.

**Structured context handoff with trust-boundary wrapping.** Instead of a
prompt string, kiro-bridge hands over a structured payload — diff, relevant
file excerpts, failing-test output, constraints — and gets back findings JSON
with severity attached. The payload is deterministic, so failures are
reproducible and regression-testable. And because Kiro's output re-enters
Claude Code's context, it's wrapped as data, not command: no auto-apply,
fixed trust-boundary wrapping, and schema-enforced sanitization on every
response, parsed or not.

kiro-bridge doesn't reinvent Kiro's own tool-trust model, custom agents, or
spec/planner mode — it's the interface surface between a Claude Code session
and Kiro's capabilities.

## Requirements

- Claude Code
- kiro-cli 2.20+
- Node 20+
- An authenticated `kiro-cli login` session

## Install

```
/plugin marketplace add JuuuuHong/kiro-bridge
/plugin install kiro-bridge@kiro-bridge
```

## Commands

| Command | Phase | Description |
|---|---|---|
| `/kiro-bridge:setup` | 1 | Verify install/auth and install the bundled Kiro agents |
| `/kiro-bridge:review [ref]` | 1 | Have Kiro review the current diff and return structured findings |
| `/kiro-bridge:task <goal> [--bg] [--write]` | 2 | Delegate investigation or debugging to Kiro, foreground or background |
| `/kiro-bridge:spec <feature>` | 2 | Use Kiro's native spec mode to generate requirements/design under `.kiro/specs/` |
| `/kiro-bridge:result [job-id] [--follow-up]` | 2 | Retrieve a background job's result, optionally continuing the session |
| `/kiro-bridge:status` | 2 | List jobs for this repo and show accumulated usage |
| `/kiro-bridge:cancel <job-id>` | 2 | Cancel a running background job |

## Security model

- **Read-only by default.** Delegated execution explicitly pre-trusts
  read-family tools and leaves write/execute-family tools untrusted; the
  custom agent JSON is the single source of truth for the permission spec
  (ADR-002).
- **Explicit pre-trust + a denial detector.** Non-interactive mode
  auto-denies untrusted tool calls without asking and keeps going — silent
  functional failure, not safety. A denial detector escalates any detected
  denial to an explicit "insufficient permission" error instead of letting
  it pass as a plausible-looking result (ADR-002).
- **Shell is never trusted**, in any agent, under any flag.
- **No default path to full trust.** `--trust-all-tools` never becomes a
  default; full trust opens only via an explicit `--yolo` flag plus a
  pre-execution confirmation (ADR-002).
- **Outbound redaction.** Diffs and file excerpts are filtered before
  leaving the machine — file exclusion list, secret-pattern masking,
  `--dry-run` payload preview, restricted-permission payload logs (design §7).
- **Kiro output is treated as data, never as a command.** Findings are
  always wrapped in a fixed trust boundary, sanitized against a schema, and
  require explicit user approval with a diff preview before anything is
  applied — no auto-apply flow exists (ADR-004).

## Design docs

Architecture, decision records, and the evaluation plan live under
[`docs/`](docs/) — start with
[`docs/designs/2026-08-31-kiro-bridge-design.md`](docs/designs/2026-08-31-kiro-bridge-design.md)
and the ADRs under [`docs/decisions/`](docs/decisions/).

## Verified environment

kiro-cli 2.20.1, macOS, 2026-09-01.

## License

[MIT](LICENSE)
