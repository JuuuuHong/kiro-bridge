# ADR-002: Read-only by default = explicit trust on read tools + no trust on write tools

- Status: Adopted (2026-08-31, v2 — revised to incorporate review)

## Context

Candidate default permission policies for delegated execution:

- `--trust-all-tools` **on by default**: if a prompt injection slips into the
  delegated prompt, it executes as-is — rejected.
- Read-only by default + full trust when `--write` is passed: too coarse a
  switching unit. A task that only needs one line written would be granted
  full trust — rejected.

Note that kiro-cli itself already provides tool-level trust via
`--trust-tools=<list>` and path-scoping/`allowedTools` on custom agents
(verified: `kiro-cli chat --help`, 2.20.1), so this ADR's contribution isn't
inventing a permission mechanism — it's the **default policy and operational
convention**.

**Key constraint**: in non-interactive mode, an untrusted tool call is not
asked about — it is **automatically denied and the conversation continues**
(verified via the binary's error string:
`[denied] tool permission approval is not supported in non-interactive mode`).
In other words, "trust nothing" is not safety — it's **silent functional
failure**: a reviewer can produce plausible-sounding findings without ever
having read the file.

## Decision

1. Define "read-only by default" as: **explicitly pre-trusting read-family
   tools while leaving write/execute-family tools untrusted**. The custom
   agent JSON is the single source of truth for the permission spec.
2. The transport gets a **denial detector**: when a tool denial is detected
   in output/events, the result is not trusted and is escalated to an
   "insufficient permission" error.
3. Commands that need writes use only scope-restricted agents: spec-writer
   may write only under `.kiro/specs/`; aws-advisor is restricted to
   read-only `use_aws` operations against an allow-listed set of services.
4. `--write` doesn't mean "full trust" — it means "use a scoped agent that
   permits writes." No code path enabling `--trust-all-tools` or full trust
   is created; shell remains untrusted in every bundled agent.
5. On the ACP path, `session/request_permission` is brokered to Claude Code,
   mediating requests outside the static list interactively (ADR-001R).

## Consequences

- The blast radius of injection or malfunction is capped by the agent
  definition, and the "silent denial" failure mode is structurally detected.
- Cost: an agent-installation step (`/kiro-bridge:setup`, must pass `agent
  validate`) and empirical confirmation of canonical tool names (help-text
  example `fs_read/fs_write` vs. `read/write` in the session/new response —
  Design §10 Open Question 4).
