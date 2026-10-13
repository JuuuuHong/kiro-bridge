# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The spec writer tags each requirement with how it is verified.**
  Requirements are numbered and marked `verify: deterministic`, `rubric` or
  `human`, each with its check, criterion or the thing a person looks at.
  `design.md` now ends with a verification matrix and an out-of-scope list. A
  spec previously stopped at acceptance criteria and left it to the reader to
  decide which ones a test could settle.
- **`task --write` reports end with Human check and Deferred sections.** The
  worker cannot run tests or the program, so its report now says what is left
  for a person to try and what part of the goal it skipped, next to the
  per-file changes. Re-run `/kiro-bridge:setup` to install the updated agents.

## [0.3.1] - 2026-09-30

### Security

- **The ACP transport now pins the v2 agent engine.** `kiro-cli acp` follows
  the CLI's default engine — v2 today — and v3 refuses a v2-shaped custom agent
  and runs the turn under the default, full-permission agent instead, so a
  default flip would drop the reviewer's read-only sandbox without an error.
  The subprocess path already pinned v2 for this reason. Checked on kiro-cli
  2.26.0: the handshake and a `session/load` both succeed with the flag. A
  session created under v3 (`chat.agentEngine` set to v3) may no longer load;
  those ran under the full-permission default agent anyway.

- **Partial output on a failed turn is fenced.** A timeout or refusal printed
  what Kiro had written so far bare to stderr, and the `--json` error envelope
  carried it raw under `external: false` — agent output outside the trust
  boundary every other response gets (ADR-004). Both now wrap it like a
  response, with the web notice, and the envelope is marked external.

### Fixed

- **A truncated diff was passed off as complete.** The payload cap cuts the
  diff at 200,000 characters, but only the file-list cap was reported, so a
  review of a large change read as if it covered files it never saw. The
  header, `--dry-run`, and the `--json` envelope (`diffTruncatedChars`) now
  say how much was cut. A `--bg` review now stores the same summary a
  foreground one prints, header included; it kept only the fenced findings, so
  truncation, the file cap, exclusions and the verdict never reached
  `result`.

- **`setup` installed agents where kiro-cli never looks when
  `KIRO_AGENTS_DIR` was set.** kiro-cli does not read the variable (measured
  on 2.26.0), so it now warns and says to unset it.

- **A test wrote a fake review into the user's real usage log.** It called
  `review()` without isolating `KIRO_BRIDGE_HOME`, so every test run appended
  one — 62 of 67 recorded reviews on one machine — and inflated the totals
  `status` reports.

## [0.3.0] - 2026-09-30

### Added

- **Review verdict, per-finding confidence, and a `critical` severity.** The
  reviewer returned a flat list with three severities and nothing to separate
  a confirmed defect from a hunch. It now reports a top-level `verdict`
  (`approve` / `needs-attention`, shown in the result header), a `confidence`
  of 0-1 on each finding, and `critical` for data loss, security holes, and
  crashes on a common path. All three are whitelisted or range-checked like
  every other field: an unknown verdict or an out-of-range confidence becomes
  `null` rather than being coerced. A response in the old schema still parses.
  The new instructions live in the reviewer agent's prompt, so they take
  effect after `/kiro-bridge:setup` reinstalls it.

- **Review scope: commit ranges and `--staged`.** `ref` was verified with
  `rev-parse --verify <ref>^{commit}`, which accepts a single commit-ish and
  nothing else, so `origin/main..HEAD` came back as "unknown git ref". The only
  expressible comparison was a point against the working tree — meaning a
  review of "the commits I am about to push" dragged in every unrelated
  edit sitting in the tree, and isolating them meant stashing first.

  `ref` now takes anything `git diff` does. `..` cannot appear inside a valid
  ref name, so its presence marks a range unambiguously; both endpoints are
  verified individually (an omitted side means HEAD, as git reads it) and only
  then does the spec pass through verbatim — still one element of an argv
  array, still behind `--`. A bad endpoint is named in the error instead of
  surfacing as a diff failure. `--staged` adds the index-only comparison.

  Ranges and `--staged` exclude untracked files, because neither comparison
  involves the working tree. `--staged` is rejected with a range rather than
  handed to git, since `--cached` compares the index to a single commit and
  leaves no second endpoint. `--staged` also never probes for HEAD, so it works
  before the first commit. The default — `HEAD` vs the working tree, untracked
  included — is unchanged.

### Added

- **Execution evidence in review payloads — `signals`.** The reviewer agent has
  no shell and never will (ADR-002 denies it in every agent under every flag,
  because kiro-cli offers a trust list and not an OS sandbox). The consequence
  was a reviewer that could only reason statically and had to say "I could not
  run the tests" exactly where a real defect would surface.

  `--signals <path>` closes that: a JSON file holding any of `failing_tests`,
  `lint`, `notes`, written by whoever already ran the suite. The bridge reads
  it and runs nothing. `--no-signals` opts out for one call. Signal text is
  redacted and capped on the same outbound path as the diff, tail-first so the
  failures and summary at the end of a run survive truncation.

### Changed

- **Error codes distinguish a bad request from a bad exchange.** `PROTOCOL` —
  "Protocol exchange with kiro-cli did not match expectations" — was raised for
  a dozen conditions in which kiro-cli was never contacted: an unresolvable git
  ref, an empty goal, a `--session` selector matching nothing, an unknown
  `--model`, a git diff exceeding the read buffer. The message sent the reader
  looking for a fault in a process that had not started. Those now raise
  `INVALID_INPUT` ("The request could not be carried out as given"), leaving
  `PROTOCOL` to what it names: a kiro-cli exchange that actually went wrong.
  The new message deliberately does not claim kiro-cli was never run — model
  validation and transport capability detection may spawn it before the
  request is judged unusable — only that the fix is in the request. The
  `--json` envelope reports the new code.

  One case went elsewhere: a resume routed to the one-shot subprocess transport
  now raises `TRANSPORT_UNAVAILABLE`, not `INVALID_INPUT`. Session reuse is a
  legitimate request; what is missing is a kiro-cli that speaks ACP, and no
  rewording of the request would help. That code's message is widened to cover
  a working binary that cannot serve the transport, alongside one that is not
  there at all.

- **A commit-ish now keeps untracked files.** `git diff <commit-ish>` already
  compares that point against the working tree, so a file that has not been
  `git add`ed is part of what changed since then — but it was dropped, and a
  change consisting mostly of new files came back nearly empty. Untracked files
  now travel wherever the working tree is in scope and only there: ranges and
  `--staged` still exclude them, because neither comparison looks at the working
  tree. The old rationale ("if ref was given, working-tree state is not mixed
  in") was simply wrong about what `git diff <ref>` does.

  Untracked paths are now listed *before* tracked ones in `payload.files`,
  because that list is capped by truncation. A tracked file's change still
  travels in the diff, so losing its entry costs some context; an untracked
  file's entry is its only trace in the whole payload, so losing it hides the
  file entirely. Appending them last meant a change touching more than 50
  tracked files dropped every new file — the same "mostly-new-files review
  comes back empty" failure, in a different shape. The result header also
  counted the collected untracked paths rather than the ones that fit, so it
  claimed files had gone out after the cap dropped them; it reports what
  travelled now.

### Security

- **A repository's exclude patterns could hang the reviewer's machine.**
  `globToRegExp` escaped every regex metacharacter except `?`, so a `?` in a
  pattern compiled to a quantifier instead of a wildcard. `a?a?a?…aaa…b` against
  `aaa…` then backtracked exponentially — 125ms at 20 characters, doubling every
  four. Patterns reach that function from `.kiro/settings/kiro-bridge.json`,
  which ships inside the repository being reviewed, and `isExcludedPath` runs
  once per path per pattern, so the cost multiplied by the diff's file count.
  The tightening-only overlay was a denial-of-service lever.

  `?` is now the single-character wildcard it was always meant to be (`[^/]`,
  which does not cross a separator), and the escape set covers the rest.
  Compiled patterns are cached, so the compile cost is paid once rather than
  files x patterns times. Project pattern lists are capped at 64 entries of 200
  characters; anything beyond is dropped rather than rejected, since a hostile
  file must not be able to fail the review either. The same input now resolves
  in under a millisecond at 120 characters.

- **The bridge no longer runs a configured test command.** A `signals.testCommand`
  the bridge executed itself was added and removed before any release; it is
  documented here because it briefly reached `main`.

  The reasoning behind it was wrong in a specific way. Moving execution out of
  the agent removed the *model's* ability to drive it and left the
  *repository's* ability untouched: the command a repo answers to — `npm test`,
  `make test`, `npx jest` — is defined by that repo's own files, so running it
  executes the code under review. `review --dry-run`, which the skill doc calls
  the safe first move on an unfamiliar repo, ran that repo's `package.json`
  because collection happened before the dry-run branch. The environment
  allowlist is no defence: `HOME` is forwarded, so the child could read
  `~/.aws/credentials` off disk. It also opened an outbound channel whose
  format an attacker controls, past redaction patterns that only match secrets
  in ordinary shapes.

  No flag would have fixed it. The flag would be typed by the model reading the
  skill doc — the thing ADR-002 says not to rely on — and standing config is
  worse, following the user into every clone. The decision to run a
  repository's code already exists one layer up, in the host's permission
  prompt, where a person sees it; a quieter second copy inside the bridge could
  only subtract safety. Configuration for it is gone rather than deprecated, so
  a stale `signals.testCommand` on disk is inert.

### Fixed

- **A review started in a subdirectory sent an empty diff.** `git diff
  --name-only` names files relative to the repository root, but the follow-up
  `git diff -- <paths>` resolves those paths against cwd, so from `pkg/` it
  matched nothing: credits spent on a payload listing changed files with no
  diff. Untracked files above cwd were dropped, and the job and session
  registries — keyed by a cwd hash — split one repository into one scope per
  directory, so `status` and `resume` came back empty. Every command now moves
  to `git rev-parse --show-toplevel` before running; a relative `--signals`
  path is resolved where it was typed first. Jobs and sessions recorded from a
  subdirectory before this change are no longer visible from any directory.

  The move applies to every command, so Kiro's working directory is now the
  repository root for `task`, `spec`, and `resume` as well: a `spec` started in
  `packages/api` writes to the root's `.kiro/specs/`, and the project config
  (`.kiro/settings/kiro-bridge.json`) and Kiro steering are read from the root,
  not from the subdirectory. A relative path in a task goal is read against the
  root.

- **A resumed turn carried the previous conversation in its result.**
  `session/load` replays the earlier conversation as `session/update`
  notifications before it answers — measured against kiro-cli 2.26.0 with a
  load and no prompt, and required by the ACP spec. The collector was already
  listening, so the previous answer was prepended to the new one, and because
  `parseResponse` takes the first findings block, a resumed review could
  return the old findings as its own; replayed tool calls were also reported
  as progress. Updates are now dropped until this turn's prompt is sent. The
  mock replays on load, as the real agent does.

- **`setup` never delivered an edited agent prompt.** An installed agent was
  reported `unchanged` whenever its version stamp and tool convention matched,
  whatever its body said, so a prompt changed without a version bump stayed on
  disk in its old form. The body is now compared too.

- **A failed background job could not be diagnosed.** The job kept only the
  error's category — "The request could not be carried out as given." — and
  dropped the reason and the agent's JSON-RPC message that said what went
  wrong. Both are now appended to the recorded error. A turn that timed out or
  was refused had its partial output thrown away although it had been paid
  for; it is kept as the job's body, wrapped as external data, so `result`
  shows it. `review <ref> --bg` also checks the ref and `--staged` scope in the
  foreground, so a typo fails immediately instead of after a job id is issued.

- **Caching a capability or model list froze the defaults into config.json.**
  Both caches saved the whole loaded config, which had been merged with the
  defaults, so the default redaction list was written to disk the first time
  anything was cached — and from then on the on-disk copy won, so an exclude
  pattern added in a later release never reached that user. A config.json that
  failed to parse was replaced by defaults on the next save, deleting
  `privateHosts` and `envPassthrough`. The caches now write only their own
  entry into the file as it is on disk, and leave a file that does not parse
  alone. A config.json that already carries a frozen `redaction.excludeFiles`
  keeps it; delete that key to pick up the defaults again.

- **Foreground runs outlived the Bash tool that launched them.** Claude Code's
  Bash tool stops a command after 120s by default, shorter than review's own
  180s budget, and task/spec/resume default to 600s — the tool's ceiling, with
  no headroom. A long run was cut off by the shell, credits spent and result
  lost. The skills and commands now tell Claude to size the Bash timeout to the
  bridge's, and to go background for anything longer. A `--bg` review also
  inherited the 180s foreground budget, though `--bg` is what a long review
  reaches for; it now gets the 600s background budget.

- **Signal truncation defeated itself.** `tailTruncate` kept the tail of a run
  but overshot `LIMITS.signal` by the length of its own notice, and
  `buildPayload`'s cap then truncated from the head — cutting off exactly the
  tail the function existed to preserve. It now fits the cap, and a test covers
  the composition rather than each half.

- **README described a payload field that never shipped.** The handoff was
  advertised as carrying "failing-test output", but `signals` was dead code:
  `buildPayload` accepted, whitelisted, and redacted the block, `LIMITS.signal`
  bounded it, a unit test covered it, and the design doc specified it — yet not
  one of the three `buildPayload` call sites ever passed it. The unit test is
  why it went unnoticed. Wiring it up (above) makes the sentence true; it is
  now stated conditionally, since evidence travels only when configured or
  supplied.

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

- **The subprocess fallback transport was fully broken on kiro-cli 2.21.0.**
  Three independent defects stacked on the path that runs whenever ACP is
  unavailable, and any one of them was enough to make a delegated call useless:

  - `buildArgs` left the engine to the CLI default. On 2.21.0
    `chat --no-interactive` resolves to the v1 engine, which rejects
    `--output-format stream-json` outright, exits nonzero, and surfaced to the
    caller as `[SPAWN_FAILED]`. The engine is now pinned to `v2` explicitly.
    `v3` is not an alternative: it refuses a v2-shaped custom agent
    (`needs upgrading for this agent engine, using "default"`) and would run the
    delegated call under the *default* full-permission agent, silently dropping
    the read-only sandbox the reviewer/researcher agents exist to enforce.
  - 2.21.0 wraps every stream-json line in a typed envelope
    (`{"type":"sessionUpdate","data":{"sessionId":…,"update":{…}}}`) instead of
    emitting the ACP update at the top level. `normalizeStreamJsonLine` matched
    neither shape, classified all 63 lines of a real turn as `raw`, and returned
    an **empty result with null metadata** — a review that silently found
    nothing. The envelope is now unwrapped for `sessionUpdate`, `metadata`,
    `runFinished`, and `runError`; the flat and `session/update` forms still
    normalize as before. `runFinished.finalText` is deliberately *not* collected
    as message text, since it repeats the already-streamed chunks.
  - `runFinished.stopReason` was never read, so a turn truncated by `max_tokens`
    or ended by a refusal returned exit 0 and looked like a finished answer —
    the ACP path has always rejected those. `classifyStopReason` moved from
    `transport/acp.mjs` to `errors.mjs` and both transports now apply it
    (re-exported from `acp.mjs`, so `acp.classifyStopReason` still resolves).
    It is enforced only when the stream actually carried a terminal event, so an
    older shape that has none is not mistaken for a missing stopReason.

- **`--model` was silently ignored on the subprocess fallback.** On 2.21.0 this
  path answers `failed to set model '<id>': Method not found` on stderr and then
  runs the turn on the default model with exit 0. The requested id was reported
  back as though it had been honoured, so a review attributed to `gpt-5.6-sol`
  could have been produced by an entirely different model. That misattribution
  is worse than a failure, so the call now raises `PROTOCOL` naming the model
  that could not be applied. The ACP transport is unaffected — it applies
  `--model` correctly, verified against the real binary.

- **A cold-start ACP probe cached the degraded transport.** The handshake budget
  was 5s. A warm `kiro-cli acp` answers `initialize` in well under a second, but
  the first launch after a CLI upgrade pays for agent-server startup and can
  exceed that — and the resulting "ACP unavailable" verdict then pushed every
  delegated call onto the subprocess fallback (broken, per above) for the
  negative-cache TTL. Raised to 15s: being impatient here costs far more than
  waiting.

- **A findings block after a shadowing preamble was lost to the raw fallback.**
  `extractJsonObject` matched only the first ```` ```json ```` fence and, within
  it, only the first balanced object. When Kiro ignored the prompt and printed
  a schema example ahead of the real answer, that example was returned, the
  `findings` array was missing, and the entire review degraded to unstructured
  raw text. Every fenced block is now a candidate and every top-level object
  within a candidate is tried in turn, with `parseResponse` asking for the
  block that actually carries a `findings` array — so the preamble no longer
  shadows the answer whether it is fenced, unfenced, or sharing a fence with
  it. Callers wanting "some JSON object" pass no predicate and are unaffected.

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

[Unreleased]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JuuuuHong/kiro-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JuuuuHong/kiro-bridge/releases/tag/v0.1.0
