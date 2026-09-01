# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-01

### Added

**Phase 1 — ACP-first transport, review, redaction, trust boundary**

- ACP transport (`kiro-cli acp`, stdio JSON-RPC) as the primary path, with a
  subprocess fallback (`chat --no-interactive --output-format stream-json`)
  when capability detection fails.
- `/kiro-bridge:setup` — verifies kiro-cli version and auth, detects
  transport capability, and installs bundled Kiro custom agents with
  `agent validate` and hash-based user-modification protection.
- `/kiro-bridge:review` — structured diff/context handoff to a read-trusted
  reviewer agent, returning severity-tagged findings JSON.
- Outbound redaction (`context.mjs`): file exclusion list, secret-pattern
  masking, `--dry-run` payload preview, restricted-permission payload logs.
- Trust-boundary wrapping and schema sanitization for all Kiro output
  (`findings.mjs`), applied regardless of parse success or failure.
- Tool-denial detection so a silently-denied tool call escalates to an
  explicit permission error instead of being mistaken for success.
- Unit tests against a mock kiro-cli binary and recorded ACP fixtures.

**Phase 2 — task fg/bg, job lifecycle, spec pipeline, usage metering**

- `/kiro-bridge:task` — delegate investigation/debugging in the foreground
  or as a background job (`--bg`), with a read-only researcher agent by
  default and a scoped write-permitted worker agent via `--write`.
- Background job lifecycle: cwd-scoped job directories, atomic state
  transitions (`queued → running → done | failed | cancelled`), PID+start-time
  guarded cancellation, 30-day GC.
- `/kiro-bridge:result` — retrieve job output, with `--follow-up` continuing
  an existing ACP session via `session/load`.
- `/kiro-bridge:status` / `/kiro-bridge:cancel` — job listing with
  accumulated usage, and job cancellation.
- `/kiro-bridge:spec` — native Kiro spec/planner mode generating EARS
  requirements and design docs under `.kiro/specs/`.
- Per-call credit usage metering (`~/.kiro-bridge/usage.jsonl`).
- Five bundled Kiro custom agents (`kiro-bridge-reviewer`,
  `kiro-bridge-spec-writer`, `kiro-bridge-researcher`,
  `kiro-bridge-aws-advisor`, `kiro-bridge-worker`), each with a scoped
  permission spec.
- Test suite grown to 119 tests.

[0.1.0]: https://github.com/JuuuuHong/kiro-bridge/releases/tag/v0.1.0
