# ADR-001: Transport abstraction — subprocess now, wait for ACP

- Status: **Superseded by ADR-001R** (2026-08-31, superseded the same day)
- Reason for supersession: the underlying factual premise was disproved. This
  ADR inherited, without verification, secondhand information stating that
  "Kiro CLI v1.29 does not support external-client ACP `session/prompt`."
  Measurement against the actual local install showed kiro-cli was
  **2.20.1**, that `kiro-cli acp` exists as a first-class subcommand, and that
  the initialize→session/new handshake succeeded (verified:
  `kiro-cli --version`, `kiro-cli acp --help`, stdio round trip, 2026-08-31).
  The telemetry enum lists `external_acp` as an officially supported
  execution path. The decision itself — "prepare for a future where ACP opens
  up" — was already pointing at a future that had passed, so it is superseded
  and replaced by ADR-001R, which adopts ACP as the primary transport.
- Lesson: every external factual claim must be paired with a version, a
  verification command, and a date.

## Context

As of Kiro CLI v1.29, ACP `session/prompt` is not yet open to external
clients (only the `initialize` + `session/new` handshake works). So the only
path that works today is a one-shot call to `kiro-cli chat --no-interactive`.

However, once ACP opens up, streaming, multi-turn sessions, and visible tool
calls become possible, and that is this plugin's biggest differentiation
opportunity.

## Decision

Call sites depend only on a transport interface (`exec(payload, opts)` /
`spawn(payload, opts)`). `transport/index.mjs` performs runtime capability
detection (attempts a handshake) and selects acp → subprocess in that order.
Upper layers (commands, context, findings) remain unaware of which transport
is in use.

acp.mjs implements only the handshake for now, and falls back to subprocess
immediately upon detecting that `session/prompt` is unsupported.

## Consequences

- The day Kiro's release opens up ACP, completing acp.mjs alone flips the
  switch. No command-code changes needed.
- Cost: one layer of interface indirection. Acceptable at roughly 2 modules.
