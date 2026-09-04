# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/kiro-bridge:transfer` — hand a delegated session back to Kiro's own CLI.**
  Prints the `kiro-cli chat --resume-id <session-id>` command that continues a
  recorded conversation in Kiro's TUI, so a delegation started from Claude Code
  can be taken over directly. Verified that `kiro-cli acp`'s `session/new`
  persists into `~/.kiro/sessions/cli/<sessionId>.json` — the same store
  `chat --resume-id` reads. It spawns no process and sends no prompt, so it
  spends no credits. Kept as a separate command rather than a line appended to
  every result because routine output deliberately surfaces only the generated
  record id, never the raw ACP session id.

- **`/kiro-bridge:models` — the model ids this kiro-cli accepts for `--model`.**
  `--model` used to be an unvalidated pass-through, so a caller that guessed
  `sol` when the real id is `gpt-5.6-sol` only found out after a process had
  been spawned — and with `--bg`, after a job had been created and its id
  handed back. The list is not hardcoded, here or in the skill docs: it varies
  by kiro-cli version *and* by account (experimental previews come and go), so
  a baked-in list would be wrong within a release. kiro-cli already answers the
  question via `chat --list-models --format json`, so the bridge asks it and
  caches the answer under the kiro-cli version — the same key the ACP
  capability cache uses — with a 24h TTL for same-version account changes.
  Every command taking `--model` now validates against that list first and
  suggests the nearest real id on a miss.

  The check is deliberately **advisory, not authoritative**. An id this
  kiro-cli does not know is rejected, but if discovery itself fails (offline,
  kiro-cli error, unparseable output) the value passes through and kiro-cli
  remains the judge — otherwise the bridge would block a model released after
  the cache entry was written. For the same reason a miss against a *cached*
  list triggers one forced re-list before anything is rejected: the cache can
  be a full TTL behind, so "absent from the cache" is not evidence of "kiro-cli
  does not know it".

- **Project-level config — `.kiro/settings/kiro-bridge.json`.** Follows Kiro's
  own global/project settings convention (`~/.kiro/settings/` mirrored by
  `.kiro/settings/` in the repo) rather than inventing a bridge-specific
  location. The overlay is deliberately **tightening-only**: a repository may
  add `redaction.excludeFiles` and `redaction.privateHosts` patterns and
  nothing else. Because the file ships inside the repository it is
  attacker-controlled input for any repo you did not write, so removing a
  default exclude pattern, raising `entropyThreshold`/`minSecretLength`,
  widening `envPassthrough`, and writing the capability cache are all ignored.
  Capability-cache writes now read the user layer (`loadUserConfig`) so a
  project pattern can never be promoted into the user-global config.
- **`--json` output mode on every command.** Emits a machine-readable envelope
  instead of the human summary, so callers no longer regex the text output.
  Failures use the same envelope with `ok: false`. The trust boundary is not
  relaxed: envelopes carrying agent-produced content set `external: true`,
  repeat the notice, and keep the fenced `wrapped` string, which remains what
  belongs in a model's context (ADR-004).

### Fixed

- **Self-review of the additions above.** Four defects found by reviewing the
  new code with the same pass applied to 0.2.0:
  - The project overlay was resolved from `process.cwd()` while commands
    operate on an explicitly passed `cwd`. Any caller whose `cwd` differed
    silently got no project config at all. Every site now loads it from the
    same `cwd` the command was given.
  - `review` never reported the agent it used, so the `--json` envelope said
    `"agent": null` while the trust-fence header it carried said
    `kiro-bridge-reviewer`. The envelope now agrees with the fence.
  - `status --json` dumped every raw usage record (capped at 5,000) where the
    text path prints a summary. It now summarizes in both formats.
  - `--json` was read from parsed flags, so a caller whose arguments failed to
    parse got a text stack trace instead of a JSON error. It is now detected
    from the raw argv before parsing.
- **`review` no longer fails with a raw git error in a repository with no
  commits.** `git diff HEAD` cannot resolve HEAD before the first commit, so a
  fresh repo whose files are all untracked — the "only new files created" case
  reviews are meant to handle — escaped as an unclassified exit-128 error.
  `collectDiff` now detects a missing HEAD and falls through to the
  untracked-only path.
- **Large results are no longer silently truncated.** `bridge.mjs` wrote to
  stdout and then called `process.exit()`. Writes to a *pipe* — how Claude Code
  captures this process — are asynchronous and are not flushed by `exit()`, so
  output was cut at the pipe buffer: a 116 KB `review --dry-run` payload
  arrived as exactly 65,536 bytes. Truncation inside the trust fence also
  dropped the closing `KIRO_EXTERNAL_DATA>>>` delimiter, breaking the external
  data boundary. Every write is now tracked and awaited (bounded by
  `FLUSH_TIMEOUT_MS`) before exiting.
- **Session reuse can no longer silently degrade to a contextless turn.** The
  one-shot subprocess transport ignores `sessionId`, so if ACP capability
  detection flipped to `subprocess` (e.g. after a kiro-cli upgrade), `resume`
  and `result --follow-up` would answer from an empty conversation while
  reporting success. `transport.run` now rejects a `sessionId` on the
  subprocess path, mirroring `acp.run`'s existing `loadSession` guard.
- **`task --bg` now sends the same constraints as foreground `task`.** The
  background worker omitted `TASK_CONSTRAINTS`, so adding `--bg` silently
  dropped the "do not claim anything you could not confirm by reading it"
  instruction.
- **Subprocess metadata is bounded like the ACP path.** A stream-json line
  carrying `_meta` was persisted as an arbitrary object; it is now reduced to a
  valid `contextUsagePercentage` or degraded to a non-persisted `RAW` event.
- **`setup` no longer exits non-zero on a healthy install.** A deliberate
  non-overwrite of a user-modified agent file (`skipped`) was counted as a step
  failure; it is now reported as a warning (`!`).
- **JSON-RPC responses that echo the request id as a string now resolve.**
  Pending requests are keyed by the id's string form instead of hanging until
  the stream closes.
- **Direct-invocation detection compares resolved real paths** instead of
  basenames, so a same-named script elsewhere cannot be mistaken for the entry
  point.

### Changed

- `renderAgent` now asserts that no tool in an agent's `deny` list appears in
  its `trust` list. `deny` was previously never read by any code path; it is
  now an enforced invariant rather than documentation (ADR-002).
- `usage.jsonl` is bounded. New `pruneUsage()` applies the retention window and
  a 5,000-record cap, swept opportunistically from `status` alongside
  `gcJobs` — the log previously grew without limit and was read in full on
  every `status`.
- Removed the `toolNaming` config key. It was written by `setup` (last agent
  wins) and never read; the resolved convention is already stamped per-agent in
  each installed file's `_kiroBridge.toolSet`.
- `commands/{result,resume,cancel}.md` now instruct shell-quoting of argument
  values, matching the `spec`/`task` skills.

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
