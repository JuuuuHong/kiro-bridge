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
cancellation (`session/cancel`), and session reuse (`session/load` — no context
resend on follow-ups). None of these are structurally possible over a single
request-response round trip.

Permission brokering (`session/request_permission` mediated by Claude Code's
own judgment rather than a static trust list) is the fourth thing ACP makes
possible, and the transport implements the reverse-request path for it — but no
command wires a decision handler yet, so today every such request is
auto-denied. Agents pre-trust the read tools they need (ADR-002), so the
shipped flows do not depend on it. Interactive brokering is Phase 3.

**Structured context handoff with trust-boundary wrapping.** Instead of a
prompt string, kiro-bridge hands over a structured payload — diff, relevant
file excerpts, constraints, and optionally execution evidence such as test
output (see [Execution evidence](#execution-evidence)) — and gets back findings
JSON with severity attached. The payload is deterministic, so failures are
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
- macOS or Linux

Windows is not supported. Two mechanisms are POSIX-specific and fail closed
rather than misbehaving: process identity is read from `/proc` or `ps`, and
`cancel` refuses to signal a pid whose identity it cannot verify — so on Windows
cancel declines instead of killing the wrong process, and background jobs cannot
be stopped from the plugin. Foreground commands may still work; they are not
tested there.

## Install

```
/plugin marketplace add JuuuuHong/kiro-bridge
/plugin install kiro-bridge@kiro-bridge
```

## Commands

| Command | Phase | Description |
|---|---|---|
| `/kiro-bridge:setup` | 1 | Verify install/auth and install the bundled Kiro agents |
| `/kiro-bridge:review [ref|A..B] [--staged] [--focus <text>] [--adversarial] [--bg] [--signals <path>] [--no-signals] [--model <id>] [--effort <lv>]` | 1 | Have Kiro review the current diff and return structured findings |
| `/kiro-bridge:task <goal> [--bg] [--write] [--model <id>] [--effort <lv>]` | 2 | Delegate investigation or debugging to Kiro, foreground or background |
| `/kiro-bridge:spec <feature> [--model <id>] [--effort <lv>]` | 2 | Use Kiro's native spec mode to generate requirements/design under `.kiro/specs/` |
| `/kiro-bridge:result [job-id] [--follow-up] [--model <id>] [--effort <lv>]` | 2 | Retrieve a background job's result, optionally continuing the session |
| `/kiro-bridge:resume <question> [--session <id>] [--model <id>] [--effort <lv>]` | 3 | Continue any recorded resumable Kiro session with a follow-up question |
| `/kiro-bridge:transfer [--session <id>]` | 3 | Print the `kiro-cli chat --resume-id` command to continue a session in Kiro itself |
| `/kiro-bridge:models [--force]` | 2 | List the model ids this kiro-cli accepts for `--model` |
| `/kiro-bridge:status` | 2 | List jobs for this repo and show accumulated usage |
| `/kiro-bridge:cancel <job-id>` | 2 | Cancel a running background job |

Every command above also accepts `--json`, which emits a machine-readable
envelope instead of the human summary. Agent-produced fields stay marked
`"external": true` and keep the fenced `wrapped` string — that string, not
`findings`, is what belongs in a model's context (ADR-004).

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

### Choosing what gets reviewed

The `ref` argument accepts anything `git diff` does, and the default is
unchanged: `HEAD` against the working tree, untracked files included.

| Form | What it compares |
|---|---|
| *(none)* | `HEAD` vs the working tree — staged, unstaged, and untracked |
| `<commit-ish>` | that point vs *tracked* working-tree state (`HEAD~3`, `origin/main`, a tag). Untracked files are not included |
| `A..B` | the two endpoints, working tree untouched |
| `A...B` | `B` against the merge base of `A` and `B` |
| `--staged` | the index only — what `git add` has picked up |

A range or `--staged` deliberately excludes untracked files, because neither
comparison involves the working tree. That is the point of them: reviewing
`origin/main..HEAD` before pushing sends your commits and nothing else, with
no stashing to isolate unrelated work in progress.

Every endpoint is verified before anything reaches `git diff`, so a typo comes
back naming the side that failed rather than as a diff error. `--staged`
cannot be combined with a range — `--cached` compares the index to a single
commit, so there is no second endpoint for it to use.

### Execution evidence

The reviewer agent has no shell (ADR-002), so it cannot run your tests and says
so rather than guess. `signals` lets whoever *did* run them hand the output
over as data:

```
/kiro-bridge:review --signals /tmp/signals.json
```

The file holds any of `failing_tests`, `lint`, `notes`. `--no-signals` opts out
for one call.

**The bridge runs nothing to produce this.** That is deliberate. The command a
repository answers to — `npm test`, `make test` — is defined by that
repository, so running it means executing the code under review. The decision
to do that already belongs one layer up, in the permission prompt your agent
host shows you; a second, quieter copy of it inside the bridge could only
subtract safety.

Signal text is redacted and capped on the same outbound path as the diff, but
treat that as best-effort rather than a guarantee: you choose the file's
contents, and the redaction patterns match secrets in their ordinary shapes,
not ones you have reformatted. Do not put anything in there you would not send.

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
- **Project-level config is tightening-only.** A repository may add outbound
  protection via `.kiro/settings/kiro-bridge.json` (Kiro's own global/project
  settings convention), but only by *adding* `redaction.excludeFiles` and
  `redaction.privateHosts` patterns. Because that file ships inside the
  repository, it is attacker-controlled input for any repo you did not write:
  it can never remove a default exclude pattern, raise the entropy/length
  thresholds, widen `envPassthrough`, or write the capability cache. Those keys
  are ignored, and project patterns are never promoted into the user-global
  `~/.kiro-bridge/config.json`.
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

macOS, on kiro-cli 2.20.2 (2026-09-01) and 2.21.0 (2026-09-04). 2.21.0 changed
the subprocess fallback's engine default and stream-json envelope shape; both
are handled, so either version works.

## License

[MIT](LICENSE)
