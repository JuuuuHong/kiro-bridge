# ADR-003: Structured context handoff + best-effort response contract

- Status: Adopted (2026-08-31)

## Context

The simplest form of delegation is handing over a single natural-language
prompt string. The result of that:

- No way to reproduce what Kiro actually saw and judged from (the whole diff? part of it?).
- The response is prose, so Claude has to re-parse and interpret findings,
  and the decision of whether to apply them is non-deterministic.

The hypothesis under real-world use is that delegation quality is governed
more by **the quality of the context handed over** than by model performance.

## Decision

1. Request: `context.mjs` assembles a JSON block per kind (review/task/spec)
   — diff, relevant file excerpts, failing-test output, constraints — and
   inserts it at the top of the prompt. What's included is determined by
   code and left in the logs.
2. Response: the custom agent prompt requires a findings JSON schema
   (severity/file/line/claim/evidence/suggestion).
3. **Best-effort principle**: a response parse failure is not an error. The
   raw text is returned as-is and only a structuring-failure flag is set. No
   validation gate is built to force a schema onto LLM output (a gate leads
   to retry loops and wasted credits).
4. The payload is **always delivered via stdin pipe**, regardless of size —
   eliminating an argument-size threshold branch, which cuts the test
   surface roughly in half (piped stdin is an officially supported kiro-cli path).
5. Since Kiro can read files itself via the `read`/`grep` tools,
   `files.excerpt` is kept to entry-point-level guidance rather than full
   inclusion. The `contextUsagePercentage` from ACP's `_kiro.dev/metadata`
   is used to warn against over-stuffing the payload.

## Consequences

- Review results become machine-readable → the foundation for a
  findings-application flow (user approval always required, ADR-004).
- Reproducibility: same input → same **payload** (the response is still
  non-deterministic). This means failures can be reproduced and
  regression-tested, not that the whole delegation becomes deterministic.
- "Context quality governs delegation quality" is a hypothesis, so it is
  validated with an evaluation harness (Design §9). If disproved, this ADR
  will be revised.
- Cost: ongoing maintenance of the context builder. This is the core
  differentiation point, so the investment is worthwhile.
