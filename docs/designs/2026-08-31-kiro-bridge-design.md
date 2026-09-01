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
├── commands/            # setup, review, task, spec, result, status, cancel
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
| `/kiro-bridge:review [ref]` | 1 | diff context → findings | reviewer (read-trusted) | sonnet family / medium |
| `/kiro-bridge:task <description> [--bg] [--write]` | 2 | Delegate a task | read-only by default / `--write`→scoped agent | auto |
| `/kiro-bridge:spec <feature>` | 2 | Native spec mode → `.kiro/specs/` | spec-writer | higher-tier model / high |
| `/kiro-bridge:result [id] [--follow-up <question>]` | 2 | Retrieve job result, continue session with follow-up | - | - |
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
`_kiro.dev/metadata` is used to warn against over-stuffing the payload.

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
has a pre-send stage:

- File exclusion list: `.env*`, `*.pem`, `*credentials*`, `*.key`, etc.
- Pattern masking: AWS access keys, high-entropy strings, private hostnames (configurable).
- `--dry-run`: lets a human review the payload right before it's sent.
- Transmitted payload logs (`~/.kiro-bridge/`) get 0600 permissions + a configurable retention period.

## 8. Failure modes and job lifecycle

### Failure modes (Phase 1 required)

| Failure | Detection | Shown to user | Retry |
|---|---|---|---|
| Timeout | Per-command default (review 180s, task 600s), `--timeout` | Partial output + timeout explicitly noted | No |
| Unauthenticated | `kiro-cli whoami` fails | Guidance to run `kiro-cli login` | No |
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
- Cancellation guards against PID reuse by matching job-id → PID + start time before killing (or `session/cancel` for ACP).
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
