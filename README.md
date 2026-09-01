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
| `/kiro-bridge:review [ref] [--focus <text>] [--adversarial] [--bg] [--model <id>] [--effort <lv>]` | 1 | Have Kiro review the current diff and return structured findings |
| `/kiro-bridge:task <goal> [--bg] [--write] [--model <id>] [--effort <lv>]` | 2 | Delegate investigation or debugging to Kiro, foreground or background |
| `/kiro-bridge:spec <feature> [--model <id>] [--effort <lv>]` | 2 | Use Kiro's native spec mode to generate requirements/design under `.kiro/specs/` |
| `/kiro-bridge:result [job-id] [--follow-up] [--model <id>] [--effort <lv>]` | 2 | Retrieve a background job's result, optionally continuing the session |
| `/kiro-bridge:resume <question> [--session <id>] [--model <id>] [--effort <lv>]` | 3 | Continue any recorded resumable Kiro session with a follow-up question |
| `/kiro-bridge:status` | 2 | List jobs for this repo and show accumulated usage |
| `/kiro-bridge:cancel <job-id>` | 2 | Cancel a running background job |

### Review modes

`review` defaults to a read-only defect review. `--focus "<concern>"` steers it
toward a specific area; `--adversarial` makes the reviewer assume the change is
wrong until proven otherwise and probe assumptions, trust boundaries,
concurrency, and alternative designs — still strictly read-only and
findings-only. `--bg` runs the review as a background job that returns the same
formatted findings; retrieve it with `/kiro-bridge:result`.

### Resumable sessions

Every successful Kiro turn over ACP — foreground `task`/`spec`/`review`, a
completed background job, or a `result --follow-up` — is recorded in a bounded,
per-repository session registry, and successful output prints a resume hint.
`/kiro-bridge:resume <question>` continues the most recent recorded session by
default (or a specific one via `--session`), reusing its ACP conversation
through `session/load` without resending context. Resume restores the original
session's agent and read/write classification — a resumed review stays a
read-only reviewer, a `--write` worker keeps its scoped write permissions — and
the reply is wrapped as external data (ADR-004), never auto-applied.

The registry is deliberately minimal: each record is an immutable atomic
`0600` file scoped by a cwd hash so repositories never mix, holding only safe
fields (record id, session id, agent, source kind/command, write flag,
transport, optional model, timestamp). Prompts, diffs, file paths, and model
output are **never** stored. Records are garbage-collected by age and a hard
maximum count. `--session` accepts either the generated record id (from a
resume hint) or the raw ACP session id, but the record id is preferred because
it avoids surfacing the raw ACP id.

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
- **No path to full trust.** `--trust-all-tools` is never enabled by this
  plugin. Even the explicit `task --write` mode keeps shell untrusted and
  grants only the worker agent's scoped write tools (ADR-002).
- **Outbound redaction (bridge-built payloads only).** Diffs and file
  excerpts that the bridge itself assembles are filtered before leaving the
  machine — file exclusion list, secret-pattern masking, and a `--dry-run`
  payload preview (design §7). This redaction covers **only** the
  diff/excerpts the bridge builds; files Kiro reads directly through its own
  tools do not pass through bridge redaction. Bridge permissions are a
  Kiro-level tool-trust configuration, **not** an independent OS-level sandbox.
- **Kiro output is treated as data, never as a command.** Review findings are
  always wrapped in a fixed trust boundary and schema-sanitized, and are never
  auto-applied. `task --write` is a separate, explicit execution mode that can
  modify scoped files; review its resulting git diff before accepting changes
  (ADR-004).
- **Isolated child environment.** Every kiro-cli spawn/exec receives an
  explicit allowlisted environment instead of inheriting the parent process
  environment. The default allowlist forwards only what a normal CLI needs
  (`PATH`, `HOME`, locale/`LC_*`, temp dir, XDG, proxy, CA bundle,
  `KIRO_AGENTS_DIR`) and **hard-denies** cloud/provider credentials
  (AWS credential and token vars, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GITHUB_TOKEN`, `NPM_TOKEN`), `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `FORCE_COLOR`,
  and npm config injection (`npm_*`, `NPM_CONFIG_*`). `KIRO_BRIDGE_HOME` and an
  inherited `PWD` are never forwarded, and `NO_COLOR=1` is forced. To forward an
  extra variable, list its **exact name** in `envPassthrough` in
  `~/.kiro-bridge/config.json` (no wildcards). This is a safe opt-in for
  non-secret selectors such as `AWS_PROFILE` or `AWS_REGION`; the hard-deny
  floor always wins, so a passthrough entry can never re-introduce a credential
  variable.
- **Output sanitization.** All Kiro output is stripped of terminal control
  sequences — ANSI CSI and OSC (including OSC 52 clipboard), DCS/PM/APC/SOS
  strings, bare `ESC`, and C0/C1 control bytes — at the final stdout/stderr
  boundary and at every structured/raw output boundary, and job event labels
  reuse the same sanitizer. A malicious diff or model reply cannot emit escape
  sequences into your terminal.

## Design docs

Architecture, decision records, and the evaluation plan live under
[`docs/`](docs/) — start with
[`docs/designs/2026-08-31-kiro-bridge-design.md`](docs/designs/2026-08-31-kiro-bridge-design.md)
and the ADRs under [`docs/decisions/`](docs/decisions/).

## Verified environment

kiro-cli 2.20.2, macOS, 2026-09-01.

## License

[MIT](LICENSE)
