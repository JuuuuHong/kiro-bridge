# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-01

### Added

- **Universal resume — `/kiro-bridge:resume <question>`.** Continues any
  recorded resumable ACP session with a follow-up question, reusing its
  conversation via `session/load`.
  `resume [--session <record-or-session-id>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]`
  defaults to this repo's most recent resumable session. It restores the
  original session's agent and read/write classification (a resumed review
  stays a read-only reviewer; a `--write` worker keeps its scoped write
  permissions), redacts the outbound question on the same path as any handoff
  payload, wraps the reply in the fixed trust boundary (ADR-004), meters usage,
  and records the next turn back into the registry.
- **Generic resumable-session registry.** Every successful, resumable ACP turn
  (foreground `task`/`spec`/`review`, a successful background completion, and a
  `result --follow-up`) is persisted as one immutable, atomic `0600` record
  under `~/.kiro-bridge/sessions/<cwd-hash>/`. Records are independent files
  scoped by cwd hash so different repositories never mix, are garbage-collected
  by retention age and a hard maximum count, and carry only a bounded, safe
  field set (record id, session id, agent, source kind/command, write flag,
  transport, optional model, `createdAt`). Successful ACP outputs surface a
  resume hint pointing at the generated record id.
- **Review enhancement flags.** `/kiro-bridge:review` gains `--focus <text>`
  (steer the review toward a concern; appended to the goal and redacted on the
  same path as the diff), `--adversarial` (a skeptical, findings-only stance
  that pressure-tests assumptions, trust boundaries, concurrency,
  rollback/data-loss, and alternative designs — still strictly read-only), and
  `--bg` (run the review as a background job returning the same formatted
  findings body, with reviewer follow-up on the job's session).

### Security

- **Explicit child-environment allowlist.** Every kiro-cli spawn/exec now
  receives an explicit environment instead of inheriting `process.env`. The
  default allowlist forwards only what a normal CLI needs (`PATH`, `HOME`,
  locale, temp dir, XDG/`LC_*` prefixes, proxy, CA bundle, `KIRO_AGENTS_DIR`)
  and hard-denies cloud/provider credential variables (AWS credential/token
  vars, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`),
  `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `FORCE_COLOR`, and npm config injection
  (`npm_*`, `NPM_CONFIG_*`). It never forwards `KIRO_BRIDGE_HOME` or an
  inherited `PWD`, and forces `NO_COLOR=1`. Config `envPassthrough` is an
  exact-name, no-wildcard opt-in that can forward additional non-secret
  variables (e.g. `AWS_PROFILE`, `AWS_REGION`); the hard-deny floor always
  wins, so a passthrough entry can never re-introduce a credential variable.
- **Full terminal-control sanitization.** All Kiro output is stripped of
  terminal control sequences — ANSI CSI and OSC (including OSC 52 clipboard),
  DCS/PM/APC/SOS strings, bare `ESC`, and C0/C1 control bytes — at the final
  stdout/stderr boundary and at every structured/raw output boundary. Job event
  labels reuse the same sanitizer, so a malicious diff or model reply cannot
  emit escape sequences into the terminal.

### Changed

- **Unknown background commands fail closed.** An unrecognized background
  command is rejected rather than silently falling back to the task executor.
- **Result and skill guidance now surface resume.** `/kiro-bridge:result` and
  the `task`/`spec`/`review` skills point at the generic resume flow for
  arbitrary recorded sessions while preserving the existing job follow-up path.

## [0.1.2] - 2026-09-01

### Added

- **Kiro model selection across delegated calls.** `review` and
  `result --follow-up` now accept `--model <id>` and `--effort <lv>`, matching
  the existing `task` and `spec` overrides. The selected model is forwarded to
  both transports and recorded in usage metering; result-only retrieval rejects
  these flags unless `--follow-up` is present.

## [0.1.1] - 2026-09-01

### Fixed

- **Plugin command deduplication.** Removed the four legacy flat command files
  that duplicated the richer `setup`, `review`, `task`, and `spec` skills in
  Claude Code's component inventory. The unique `result`, `status`, and
  `cancel` commands remain, yielding exactly seven plugin slash commands.
- **Output classification uses diagnostics only.** Auth/throttle classification
  on both the ACP and subprocess transports now reads process diagnostics
  (`stderr`) exclusively, never collector/model text. A clean, successful agent
  message that merely mentions phrases like `unauthorized`, `not logged in`,
  `rate limit`, or `insufficient credits` no longer fails. Structural tool-denial
  events remain authoritative.
- **Review usage metering.** Non-dry-run `review` calls now record usage on both
  success and failure, mirroring `runDelegated` (transport, duration, structured
  ACP `used`/`size`/`cost`, and `contextUsagePercentage`). Dry-run and empty
  (no-change) reviews record nothing.
- **Bounded Kiro context metadata.** `contextUsagePercentage` is normalized from
  all reasonable real ACP shapes — the custom `_kiro.dev/metadata` update,
  `params._meta` (direct or nested `_kiro.dev/metadata`), and the `update._meta`
  equivalents — accepting only a finite percentage in `0..100` and emitting a
  `METADATA` event that carries **only** `contextUsagePercentage`. The ACP
  notification handler preserves the normal update event and additionally emits
  one bounded metadata event, with no duplicate for the custom metadata update.
- **Metadata/state concurrency.** A synchronous, cross-process per-job lock
  (atomic lock directory + unique owner token, bounded wait, stale-lock
  recovery, always released in `finally`, no busy-spin) now serializes
  read/decide/merge/write. `updateMeta` re-reads and merges under the lock and
  accepts a static patch or an updater callback; `transition`, `reapOrphans`,
  and `cancelJob` make their decision and state write under the same lock via
  internal unlocked helpers so a worker transition cannot race a stale decision
  (fail-closed cancellation preserved). `recordJobEvent` computes its
  recent-events ring inside the locked updater, so concurrent field/event
  writers no longer lose each other's changes.
- **Queued false-reap.** After a successful spawn the parent persists the child
  `pid`, best-effort process identity, and `spawnedAt` while the job is still
  queued, using a lock-guarded updater that never clobbers a fast-starting
  worker's own fields. `reapOrphans` uses the persisted queued PID: a live PID
  past grace is left alone (worker starting), a live PID with a mismatched
  identity is marked failed without signalling, and only queued+expired+no-live-PID
  (including legacy null-PID records) becomes failed.
- **Temp-file uniqueness.** Atomic temp files in `jobs.mjs`, `config.mjs`, and
  `agents.mjs` now use a `PID + randomUUID` suffix so concurrent writers cannot
  collide; failure cleanup is unchanged.
- **Usage size alias.** Removed the unverified `usage_update.total` → `size`
  alias. Only the official `used`/`size` fields and explicitly-supported
  compatibility aliases (`usedTokens`/`contextUsed`, `contextSize`) populate
  usage; an unrelated `total` no longer fills `size`.

- **ACP protocol conformance.** `initialize` responses are now validated
  against the expected protocol version in both probe (→ `available:false` on
  mismatch/malformed) and run (→ `PROTOCOL` error with a specific reason).
  Session reuse calls `session/load` only when the agent advertises
  `agentCapabilities.loadSession`; otherwise it fails clearly instead of
  silently creating a contextless new session.
- **Prompt stopReason validation.** `end_turn` succeeds; `max_tokens` /
  `max_turn_requests` now raise a new `INCOMPLETE` error, `refusal` a new
  `REFUSED` error, `cancelled` maps to `CANCELLED`, and missing/unknown
  reasons raise `PROTOCOL` — each carrying partial output rather than being
  mistaken for a finished result.
- **Atomic worker lifecycle.** Worker PID metadata and `queued → running` now
  commit under one per-job lock, and startup exceptions are caught and recorded
  through a bounded best-effort failure path. Successful result body, session
  metadata, and `running → done` also commit under one lock, so cancellation
  winning first leaves no late `result.txt` or completion metadata behind.
- **PID identity safety.** Workers store a best-effort process start identity
  (Linux `/proc/<pid>/stat`, macOS/BSD `ps lstart`) alongside the PID.
  Cancellation fails closed when a live PID's identity is absent,
  unverifiable, or mismatched (no signal, no transition), and orphan reaping
  treats a live-but-mismatched PID as orphaned without killing it.
- **Node 20 test discovery.** The `npm test` glob is now expanded by the
  POSIX shell instead of being passed as a quoted literal path to Node 20.
- **Documentation contract.** Removed the false restricted-permission
  payload-log claim from the READMEs, CHANGELOG, and design §7; clarified that
  redaction covers only bridge-built payloads, that transmitted payloads are
  not persisted, and that bridge permissions are not an OS-level sandbox.

### Added

- **ACP structured events.** `usage_update` and `plan` session updates are
  normalized (`EVENT_TYPES.USAGE` / `PLAN`) and surfaced through collector
  metadata (plan uses full-replacement semantics).
- **Background observability.** Workers persist a bounded (≤20), sanitized
  recent-event tail (type, timestamp, char counts, bounded tool
  title/id/status, numeric usage, plan counts — no raw prose or ANSI/control
  chars), track `lastProgressAt`, and record latest usage/plan metadata.
  `status`/`formatStatus` classify running-job health
  (`active`/`quiet`/`possibly_stalled`) and show a prose-free event tail.
  `usage.jsonl` records gain optional ACP `used`/`size`/`cost` fields
  (backward compatible).

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
  masking, and a `--dry-run` payload preview. Redaction covers only the
  bridge-built diff/excerpts; transmitted payloads are not persisted (no
  payload audit log).
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
  transitions (`queued → running → done | failed | cancelled`), PID-guarded
  cancellation, 30-day GC.
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

[Unreleased]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JuuuuHong/kiro-bridge/releases/tag/v0.1.0
