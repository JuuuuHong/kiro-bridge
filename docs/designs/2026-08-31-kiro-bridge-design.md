# kiro-bridge Design

> 2026-08-31 v2 (incorporates design review). A plugin for using Kiro CLI from
> inside Claude Code.
> Purpose: (1) daily real-world use (2) publish as a portfolio piece once validated.
>
> **Verified environment**: kiro-cli 2.20.1 / macOS 15 / 2026-08-31.
> Every external factual claim is paired with a verification command. The v1
> draft was based on information from kiro-cli v1.29 and treated ACP as future
> work, but that premise was disproved by measurement against 2.20.1, so the
> design was rebuilt from the ground up (ADR-001 → Superseded, ADR-001R).

## 1. Positioning — what this contributes

The simplest way to call Kiro CLI from inside Claude Code is a one-shot call
that hands a prompt string to `kiro-cli chat --no-interactive`. kiro-bridge
contributes two axes that don't hold up on that path.

**Axis 1 — ACP-native integration.** kiro-cli 2.20.1 ships the Agent Client
Protocol as a first-class citizen via the `kiro-cli acp` subcommand (verified:
`kiro-cli acp --help`, confirmed round trip of the initialize→session/new
handshake). Using it as the primary transport gives us:
- Streaming progress (`session/update`) — Kiro's tool calls become visible in real time
- Cancellation (`session/cancel`), session reuse (`session/load`, no need to resend context on follow-up questions)
- **Permission brokering**: `session/request_permission` from Kiro is mediated
  by Claude Code's own judgment. A more capable, interactive permission model
  than a static trust list.

A one-shot subprocess call ends after a single request-response round trip, so
none of the above four are structurally possible.

**Axis 2 — structured context handoff.** Instead of a prompt string, we hand
over a structured payload of diff, relevant file excerpts, and test-failure
output, and receive back findings JSON with severity attached (ADR-003).
Because the payload is deterministic, failures can be reproduced and
regression-tested. **This axis is a real-world-use hypothesis, and it is
validated with an evaluation harness** (§9).

**Why this can't just be Kiro's built-in features**: Kiro already has
tool-level trust via `--trust-tools`, custom agents, and a spec/planner mode
built in. kiro-bridge's contribution isn't reinventing those features — it's
**the interface surface with the Claude Code session**. Structuring the
context Claude already holds (diff, failing tests) and handing it over, then
bringing Kiro's streams, permission requests, and findings back into the
Claude session — none of that is achievable by Kiro alone. The spec pipeline
isn't a differentiator; it's handled purely as an integration scenario that
invokes Kiro's native `--mode spec` (§2.3).

## 2. Usage scenarios (in order of real-world priority)

1. **Review second opinion**: Kiro reviews a diff Claude just produced.
   `/kiro-bridge:review` → findings JSON → Claude decides whether to apply
   them (no auto-apply, ADR-004).
2. **Task delegation**: delegate investigation/debugging to Kiro.
   `/kiro-bridge:task [--bg]` → `/kiro-bridge:result`.
3. **Spec pipeline**: refine requirements/design using Kiro's native
   spec/planner mode → Claude Code implements. (Design finalized after
   measuring Kiro's `--mode spec` output format — §10)
4. **AWS advisory**: query an advisor agent scoped to read-only,
   service-restricted `use_aws` for infrastructure code (CDK/IAM).

## 3. Architecture

```
plugins/kiro-bridge/
├── .claude-plugin/plugin.json
├── commands/            # result, status, cancel (legacy flat command format)
├── skills/              # setup, review, task, spec (rich SKILL.md workflows)
├── kiro-agents/         # Kiro custom agent definitions (JSON) — SSOT for permission specs
│   ├── kiro-bridge-reviewer.json   # explicit trust on read tools, no write trust (Phase 1)
│   ├── kiro-bridge-spec-writer.json# writes limited to under .kiro/specs/ (Phase 2)
│   ├── kiro-bridge-researcher.json # read + web_search/web_fetch (Phase 2)
│   └── kiro-bridge-aws-advisor.json# use_aws, read-only, service-restricted (Phase 2)
├── scripts/
│   ├── bridge.mjs       # entry point (command routing)
│   └── lib/
│       ├── transport/
│       │   ├── index.mjs      # capability detection (cached by version key) → acp | subprocess
│       │   ├── acp.mjs        # primary: kiro-cli acp (stdio JSON-RPC)
│       │   └── subprocess.mjs # fallback: chat --no-interactive --output-format stream-json
│       ├── context.mjs  # handoff payload builder + outbound redaction (§7)
│       ├── findings.mjs # response parsing → structured findings + trust-boundary wrapping (ADR-004)
│       ├── jobs.mjs     # background job state (§8)
│       └── config.mjs   # ~/.kiro-bridge/config.json
└── skills/              # per-command detailed usage SKILL.md
```

Principles:
- External processes are invoked only via direct `execFile`/`spawn` calls. No shell string assembly.
- Zero lines of network code — all communication goes through the kiro-cli binary only.
- State/config lives under `~/.kiro-bridge/`. Exception: custom agents must
  follow Kiro's convention of `~/.kiro/agents/kiro-bridge-*.json`
  (namespace-isolated via prefix, §6).
- No Stop hook. Hooks are only for SessionStart/End lifecycle cleanup.
- Prompt payloads are **always delivered via stdin pipe** (eliminating the
  argument-size branching decision entirely).

### Transport interface (ADR-001R)

A one-shot `exec()` cannot express ACP's streaming and reverse permission
requests, so it's defined event-driven instead:

```js
transport.run(payload, {
  agent, model, effort,
  onEvent,             // session/update stream (subprocess uses the same contract via stream-json)
  onPermissionRequest, // ACP: brokered to Claude Code / subprocess: always collapsed to denial
  signal,              // AbortSignal → session/cancel or process kill
}) → { sessionId, result }
```

Capability detection results are cached in `~/.kiro-bridge/config.json`, keyed by kiro-cli version.

## 4. Command design

| Command | Phase | Behavior | Default agent/permission | Default model/effort |
|---|---|---|---|---|
| `/kiro-bridge:setup` | 1 | Verify install/login, install agents + `agent validate` | - | - |
| `/kiro-bridge:review [ref]` | 1 | diff context → findings | reviewer (read-trusted) | auto; `--model` / `--effort` override |
| `/kiro-bridge:task <description> [--bg] [--write]` | 2 | Delegate a task | read-only by default / `--write`→scoped agent | auto |
| `/kiro-bridge:spec <feature>` | 2 | Native spec mode → `.kiro/specs/` | spec-writer | higher-tier model / high |
| `/kiro-bridge:result [id] [--follow-up <question>]` | 2 | Retrieve job result, continue session with follow-up | original task agent | follow-up accepts `--model` / `--effort` override |
| `/kiro-bridge:resume <question> [--session <id>]` | 3 | Continue any recorded resumable ACP session (§12) | original session's agent + write class | latest by default; `--model` / `--effort` override |
| `/kiro-bridge:status` / `/kiro-bridge:cancel` | 2 | Job list & accumulated credits / cancel | - | - |

- Command namespace is the **plugin name** (`plugin.json`'s `name`). The
  draft's `/kiro:*` would only be reachable if the plugin name were `kiro`, so
  it was unreachable; it's corrected to `/kiro-bridge:*` to match the actual
  name `kiro-bridge` (confirmed against the installed plugin
  `oh-my-claudecode` + `commands/hud.md` → `/oh-my-claudecode:hud`).
- No code path enabling `--trust-all-tools` or full trust is created
  (ADR-002). `--write` selects only the scoped worker agent and shell remains
  untrusted.
- model/effort have per-command defaults with `--model`/`--effort`
  overrides. Per-call credit consumption is logged to
  `~/.kiro-bridge/usage.jsonl` and shown cumulatively in `/kiro-bridge:status`.

## 5. Context handoff (ADR-003)

Request payload (Claude → Kiro, stdin):

```json
{
  "kind": "review | task | spec",
  "goal": "one-sentence goal",
  "diff": "git diff output (for reviews)",
  "files": [{ "path": "...", "reason": "why included", "excerpt": "..." }],
  "signals": { "failing_tests": "...", "lint": "...", "notes": "..." },
  "constraints": ["areas not to modify", "style rules, etc."]
}
```

Since Kiro can read files itself via the `read`/`grep` tools, `files.excerpt`
is kept to entry-point-level guidance rather than full inclusion (to avoid
context displacement). The `contextUsagePercentage` from ACP's
`_kiro.dev/metadata` is used to warn against over-stuffing the payload. It is
collected via bounded normalization from all reasonable notification shapes
(the custom `_kiro.dev/metadata` update, `params._meta`, and `update._meta`,
direct or nested) and only a finite percentage in `0..100` is accepted — no
other `_meta` fields are ever persisted.

Response contract (Kiro → Claude, required via agent prompt, best-effort):

```json
{
  "findings": [{
    "severity": "low | medium | high",
    "file": "path", "line": 0,
    "claim": "one-sentence description of the defect",
    "evidence": "supporting evidence", "suggestion": "suggested fix direction"
  }],
  "summary": "overall assessment"
}
```

- Default handling by severity: high=must review, medium=shown as a suggestion, low=logged only.
- A parsing failure is not an error — the raw text is returned as-is, but
  **trust-boundary wrapping always applies regardless of parse success or
  failure** (ADR-004).

## 6. Custom agent management

- Every bundled agent uses the `kiro-bridge-` prefix — prevents name
  collisions in the user's own space (`~/.kiro/agents/`).
- A version stamp is embedded in each agent JSON, and `/kiro-bridge:setup`
  compares hashes → files modified by the user are not overwritten, only warned about.
- Installation requires passing `kiro-cli agent validate --path <file>`
  (verified: `validate` exists in `kiro-cli agent --help`).
- **A note on tool names**: the `--trust-tools` help example uses
  `fs_read,fs_write`, but the built-in list in the `session/new` response is
  `read, write, shell, grep, glob, use_aws, web_search, ...` — different. This
  is nailed down empirically when drafting agents and confirmed via validate
  (§10 Open Question).

## 7. Outbound defense (redaction)

Since diffs, excerpts, and test output are transmitted to AWS, `context.mjs`
has a pre-send stage. This redaction applies **only to the diff/excerpts the
bridge itself builds** — files Kiro reads directly via its own `read`/`grep`
tools never pass through this stage. Bridge permissions are a Kiro-level
tool-trust configuration, not an independent OS-level sandbox.

- File exclusion list: `.env*`, `*.pem`, `*credentials*`, `*.key`, etc.
- Pattern masking: AWS access keys, high-entropy strings, private hostnames (configurable).
- `--dry-run`: previews the payload right before it's sent; nothing is transmitted.
- **Transmitted payloads are not persisted.** There is no payload audit log.
  Job, usage, and config state under `~/.kiro-bridge/` is written `0600`
  (dirs `0700`); the retention period (30-day GC) applies to **jobs**, not to
  any payload audit log.

## 8. Failure modes and job lifecycle

### Failure modes (Phase 1 required)

| Failure | Detection | Shown to user | Retry |
|---|---|---|---|
| Timeout | Per-command default (review 180s, task 600s), `--timeout` | Partial output + timeout explicitly noted | No |
| Unauthenticated | stderr/output pattern classification (`classifyOutput`) | Guidance to run `kiro-cli login` | No |
| Credit/throttling | Error pattern matching | Exhaustion notice + usage display | No |
| **Tool denial** | Detect `[denied]` in output/events | Findings trust revoked, escalated to "insufficient permission" error | No |
| Parse failure | JSON extraction fails | Raw text returned + structuring-failure indicator shown | No |

Tool denial matters especially: non-interactive mode auto-denies untrusted
tool calls without asking, and the conversation continues (verified via the
binary's error string), so without detection, "plausible-sounding findings
built without reading the file" gets mistaken for success. → The reviewer
agent **explicitly pre-trusts** read tools, and a denial detector is placed
in the transport layer.

### Job lifecycle (Phase 2)

- Layout: `~/.kiro-bridge/jobs/<cwd-hash>/<job-id>/{meta.json,stdout.log,status}`
  — scoped by cwd to prevent job mixups across repos.
- State transitions: `queued → running → done | failed | cancelled`. State
  writes are atomic via temp-file + rename.
- Background runs are `detached + unref`, with stdio redirected to files.
- Cancellation guards against PID reuse by storing a **best-effort process
  start identity** in job metadata when the worker starts (Linux
  `/proc/<pid>/stat` start ticks; macOS/BSD `ps -o lstart`) alongside the PID.
  `cancelJob` sends SIGTERM only when a live PID's stored identity is present
  and still matches; if the identity is absent, unverifiable on the platform,
  or mismatched, it **fails closed** (no signal, no state transition) rather
  than risk killing an unrelated reused-PID process. A dead process may
  transition to `cancelled` without any signal. `reapOrphans` treats a live
  PID whose stored identity no longer matches as orphaned (marked `failed`)
  without signalling it. (For ACP, in-session cancellation uses
  `session/cancel`.)
- **Queued PID ownership.** On a successful spawn the parent persists the child
  PID, best-effort process identity, and `spawnedAt` while the job is still
  queued, and the worker reasserts its own PID/identity before flipping
  `queued → running`. `reapOrphans` uses the persisted queued PID so a worker
  that spawned but has not yet reached `running` is not falsely reaped: a live
  queued PID past the startup grace is left alone, a live PID with a mismatched
  identity is marked `failed` without signalling, and only a
  queued-and-expired-and-no-live-PID record (including legacy records with a
  null PID) becomes `failed`.
- **Per-job locking.** All read/decide/merge/write sequences over a job's
  `meta.json`/`status` run under a synchronous, cross-process per-job lock
  (atomic lock directory + unique owner token, bounded wait, stale-lock
  recovery). This serializes worker transitions, parent queued writes,
  event recording, reaping, and cancellation so no metadata field or state
  decision is lost or raced. Worker PID metadata + `queued → running` and
  result/session metadata + `running → done` are each one locked lifecycle
  operation; if cancellation reaches a terminal state first, the worker does
  not persist a late result body or completion metadata. Startup exceptions
  use the same atomic failure path, with orphan reaping as the fallback when a
  contended lock cannot be reacquired immediately.
- 30-day GC after completion. The SessionEnd hook only cleans up orphan
  processes and preserves job results.
- `sessionId` is stored in job metadata → `/kiro-bridge:result --follow-up`
  uses `session/load` for follow-up questions without resending context.

## 9. Evaluation harness (portfolio centerpiece)

Axis 2 is a hypothesis, so it's validated: across 15–20 real diffs, run (A)
prompt-string-only vs (B) structured handoff, and record
precision/recall-against-gold-findings + credits + latency in
`docs/evaluation/`, along with a reproduction script. **Even if the result is
"no difference," it's published as-is** — a falsifiable design is itself the
deliverable.

## 10. Roadmap / Open Questions

- **Phase 1 — review axis only**: ACP transport (+subprocess fallback) +
  context builder/redaction + reviewer agent +
  `/kiro-bridge:setup` `/kiro-bridge:review` + failure-mode table
  implementation. Accompanied by unit tests.
  → **Complete + passed real-device verification (2026-09-01).** All setup
  stages green (transport: acp, all 5 agents pass validate); bugs planted in
  a synthetic repo (off-by-one, hardcoded key) were both caught as high
  severity in a real 21-second review round trip.
- **Phase 2**: `/kiro-bridge:task` (fg/bg), job lifecycle, spec pipeline,
  remaining agents, `--follow-up`, usage metering.
  → **Code complete (2026-09-01, 119 tests).** Real round trips for
  spec/follow-up not yet measured.
- **Phase 3**: mature permission brokering (fine-grained policy), complete
  the evaluation harness, prepare for release (README EN/KR,
  marketplace.json, streaming demo capture, full audit of private-period
  deliverables before going public).

Open Questions — 2026-09-01 measurement results (kiro-cli 2.20.1):
1. ~~ACP `session/prompt` real round trip~~ **Resolved**: succeeded via the
   reviewer agent. Streaming tool_call events received, findings JSON (3
   items) parsed and wrapped end to end.
2. ~~Default trust tool set~~ **Partially resolved**: confirmed explicitly
   pre-trusted `read`-family tools work without denial. The default for
   agents without pre-trust remains unconfirmed — but our path always uses
   explicit trust, so this has no practical impact.
3. `--mode spec` output format — **Unresolved**. spec.mjs currently pins the
   format via the agent prompt. To be confirmed on `/kiro-bridge:spec`'s
   first real-world use.
4. ~~Canonical tool names~~ **Resolved**: the `short` convention
   (`read`/`write`/`shell`) passes validate. Auto-confirmed by the setup probe
   (`toolNaming: short` cached).
5. ~~ACP framing~~ **Resolved**: real round trip succeeded via ndjson
   (`jsonrpc.mjs` unmodified).
6. ~~`session/update` discriminator~~ **Resolved**: `events.mjs`
   normalization absorbs real events as-is (confirmed tool_call title
   streaming).
7. ~~`--agent` flag actually exists~~ **Resolved**: `acp --agent
   kiro-bridge-reviewer` works. `--model`/`--effort` confirmed only from
   help text, real-call use not yet measured.

Remaining measurements: OQ3 (spec format), the `session/load` real round trip
for follow-up, the subprocess fallback path (`--output-format stream-json`) —
since ACP always wins, verifying the fallback requires explicitly forcing
`transport: 'subprocess'`.

## 11. Testing strategy

- transport, context, findings, and jobs are unit-tested against a fake
  kiro-cli binary (mock script). Uses Node's built-in `node:test`, zero
  dependencies.
- ACP transport is replay-tested against recorded JSON-RPC round-trip fixtures.
- Integration tests only run as an opt-in layer, and only when a real kiro-cli is present.
- Redaction is validated against secret-sample fixtures, both positive and negative cases.

## 12. Hardening & resume additions (0.2.0)

These are focused additions on top of the architecture above; §1–§11 stand.

### 12.1 Child-environment trust boundary (`env.mjs`, extends §7)

Outbound redaction (§7) covers payload *contents*, but the child process also
inherits an *environment*, which is a second exfiltration and injection surface.
Every kiro-cli spawn/exec now builds an **explicit allowlisted environment**
instead of passing `process.env`.

- **Default allow** (exact names + prefixes): `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `TERM`, temp dir (`TMPDIR`/`TMP`/`TEMP`), locale
  (`LANG`/`LANGUAGE` + the `LC_*` prefix), proxy vars (upper/lower case), CA
  bundle / TLS trust vars, `KIRO_AGENTS_DIR`, and the `XDG_` prefix.
- **Hard deny** (always wins, even over a passthrough entry): AWS credential
  and token variables and the container/IMDS credential endpoints,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`,
  `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `FORCE_COLOR`, and npm config injection
  (`npm_` prefix, `NPM_CONFIG_` prefix). Deny entries ending in `_` match as
  prefixes.
- **Never forwarded**: `KIRO_BRIDGE_HOME` (an internal override) and an
  inherited `PWD` are not on the allowlist, so they cannot leak or be used to
  redirect state. `NO_COLOR=1` is always set on the child (defense in depth for
  §12.2, not a substitute for it).
- **`config.envPassthrough`** is an exact-name, no-wildcard opt-in. It merges
  into the allow set so a user can forward a non-secret selector such as
  `AWS_PROFILE` or `AWS_REGION`, but the hard-deny floor is applied last, so a
  passthrough entry can never re-introduce a credential variable. Precedence:
  **deny > (exact-allow | prefix-allow | passthrough)**, and the value must be a
  string present in the source environment.

### 12.2 Output sanitization (`sanitize.mjs`, extends ADR-004)

ADR-004 treats Kiro output as data; a diff or model reply can nonetheless carry
raw terminal control sequences. All output is stripped of ANSI CSI and OSC
(including OSC 52 clipboard writes), DCS/PM/APC/SOS string sequences, bare
`ESC`, and C0/C1 control bytes. Sanitization is applied at the **final
stdout/stderr boundary** and at **every structured/raw output boundary**, and
job event labels (§8) reuse the same sanitizer, so a background job's persisted
event tail cannot smuggle escape sequences either.

### 12.3 Generic resumable-session registry (`sessions.mjs`, extends §8)

§8 stored `sessionId` in *job* metadata for `result --follow-up`. 0.2.0
generalizes this into a standalone registry so any successful ACP turn — not
just a background job — is resumable.

- **Layout**: `~/.kiro-bridge/sessions/<cwd-hash>/<recordId>.json`, scoped by a
  cwd hash so records from different repositories never mix.
- **Independent immutable records**: each turn writes its own `0600` file
  atomically (temp + rename, PID+UUID temp suffix), so concurrent processes
  never clobber one another. The `recordId` is generated locally, time-prefixed
  (so a directory listing sorts chronologically), and is the **only** value a
  filesystem path is ever derived from — an untrusted `sessionId` never becomes
  a path component (path-traversal guard).
- **Bounded safe fields only**: `recordId`, `sessionId`, `agent`,
  `source { kind, command }`, `write`, `transport` (must be `acp`), optional
  `model`, `createdAt`. Prompts, focus text, diffs, file paths, model output,
  and raw diagnostics are **never** stored — they are external data (ADR-004)
  or outbound-redacted context (§7) and have no place in a resume index. Every
  field is validated/sanitized on write and again on read; a malformed or
  hand-edited record is ignored, not trusted.
- **Who registers**: foreground `task`/`spec`/`review`, a **successful**
  background completion, and a `result --follow-up`. **Cancel-first and the
  subprocess transport do not register** — a cancelled turn or a one-shot
  subprocess turn has no reusable ACP session (`RESUMABLE_TRANSPORT === 'acp'`).
- **GC**: opportunistic on every successful register — prune by retention age
  (`logRetentionDays`, default 30) and enforce a hard `maxRecords` cap (default
  200) by dropping the oldest survivors.

### 12.4 Resume lifecycle (`resume.mjs`)

`/kiro-bridge:resume <question> [--session <record-or-session-id>] [--model]
[--effort] [--timeout] [--quiet]`:

1. **Resolve**: with no `--session`, the latest record for this cwd wins. A
   selector matches a `recordId` first (exact, path-guarded), then falls back to
   the most recent record whose `sessionId` equals the selector. The raw ACP id
   is accepted but the generated record id is preferred because it avoids
   surfacing the raw id.
2. **Restore classification**: the record's `agent` and `write` flag are
   restored, so a resumed review stays a read-only reviewer and a `--write`
   worker keeps its scoped write tools — resume never escalates permissions.
3. **Redact** the outbound question on the same path as any handoff payload
   (§7), continue the conversation via `session/load`, **wrap** the reply in the
   fixed trust boundary (ADR-004), **meter** usage, and **register the next
   turn** back into the registry so the chain remains resumable.

### 12.5 Background review semantics (extends §2.1, §8)

`review --bg` runs the review through the same background job lifecycle as
`task --bg` (§8): a job id is returned immediately, and `/kiro-bridge:result`
returns the **same formatted findings body** as a foreground review. The
background review path stores **no diff or file contents** in job metadata (only
the bounded, sanitized event tail of §8 applies), preserves the fail-closed
cancellation invariants, and a follow-up on a completed review job continues
under the reviewer agent. An **unknown background command fails closed** rather
than being silently accepted.
