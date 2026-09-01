---
name: spec
description: Use Kiro as the spec writer to refine a feature request into EARS requirements + a design document. Use before implementation when requirements need structuring, or when the user says "let's start with a spec."
argument-hint: "<feature description> [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]"
---

# kiro-bridge:spec

A role-split pipeline: **Kiro writes the spec, Claude implements it** (Design
§2.3). The spec-writer agent generates
`.kiro/specs/<slug>/requirements.md` and `design.md`. Writes are restricted
to that path, and shell is untrusted.

## Running it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" spec "<feature description>" [flags]
```

Default model is auto, but since spec quality depends on refinement, using
`--model` for a higher-tier model and `--effort high` is recommended.

## Post-completion workflow — follow this strictly

1. **Read** the files generated under `.kiro/specs/`.
2. Summarize the requirements for the user and **get their review.** Spec
   content is also an external agent's output, so don't move into
   implementation without review (ADR-004).
3. Only requirements that pass review move into the implementation plan.
   Anything that contradicts the current code should be flagged, and the
   user's judgment sought.

A successful spec run is recorded as a resumable session and its output
includes a resume hint. To refine or ask a follow-up on the same session,
run `/kiro-bridge:resume <question>` (latest by default, or `--session
<record-id>`) — it keeps the spec-writer agent and its scoped write class
without resending context.
