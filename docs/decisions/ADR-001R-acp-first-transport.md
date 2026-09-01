# ADR-001R: ACP as the primary transport, subprocess as fallback

- Status: Adopted (2026-08-31). Supersedes ADR-001.

## Context

kiro-cli 2.20.1 provides an Agent Client Protocol server via `kiro-cli acp`
(verified: `kiro-cli acp --help`, a real stdio round trip of the
initialize→session/new handshake, 2026-08-31). Compared to a one-shot
`chat --no-interactive`, ACP gives us:

- `session/update` streaming — real-time visibility into Kiro's tool calls
- `session/cancel` — cooperative cancellation
- `session/load` — session reuse, no need to resend context on follow-up questions
- `session/request_permission` — enables **reverse permission requests** to
  be brokered to Claude Code (an interactive permission model beyond a
  static trust list)

However, a real round trip of `session/prompt` has not yet been measured (only
the handshake has been verified), and older kiro-cli versions or ACP
regressions are possible, so a fallback is needed.

## Decision

1. **ACP is the primary transport.** subprocess
   (`chat --no-interactive --output-format stream-json`) is the fallback used
   when capability detection fails.
2. The transport interface is defined **event-driven**, not as a one-shot
   exec — ACP's streaming and reverse requests cannot be expressed by a
   single request-response round trip:

   ```js
   run(payload, { agent, model, effort,
     onEvent,             // stream events (same contract on both transports)
     onPermissionRequest, // ACP: brokered / subprocess: always collapsed to denial
     signal,              // cancellation
   }) → { sessionId, result }
   ```

   The subprocess fallback also produces `--output-format stream-json` (JSON
   Lines of ACP events), so the contract seen by upper layers is identical.
3. Capability detection results are cached keyed by kiro-cli version — no
   handshake process is spawned on every call. Invalidated on version change.

## Consequences

- Streaming, cancellation, session reuse, and permission brokering become
  Phase 1 assets. A differentiation axis unattainable via one-shot calls.
- Cost: implementing a JSON-RPC client (framing, request correlation,
  reverse-direction handling). Offset by replay tests against recorded
  fixtures.
- Risk: `session/prompt` unmeasured — confirmed via one real round trip
  before Phase 1 begins (Design §10 Open Question 1).
