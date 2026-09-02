// /kiro:review flow. git diff -> payload -> transport -> findings -> wrapping.
//
// This file only assembles. redaction is context.mjs's job, the trust
// boundary is findings.mjs's job, and failure classification is errors.mjs's job.
import { collectDiff } from './git.mjs'
import { buildPayload } from './context.mjs'
import { parseResponse, wrapForClaude } from './findings.mjs'
import { loadConfig } from './config.mjs'
import * as transport from './transport/index.mjs'
import { AGENT_PREFIX } from './agents.mjs'
import { recordUsage } from './usage.mjs'
import * as sessions from './sessions.mjs'

export const DEFAULT_TIMEOUT_MS = 180_000 // design §8 failure mode table

const DEFAULT_CONSTRAINTS = [
  'Do not modify files — review only.',
  'Do not claim anything you could not confirm by reading it.',
]

// Adversarial mode does not relax the read-only, findings-only contract — it
// only sharpens what to look for. These constraints pressure-test the change
// rather than granting any new capability, so they are additive to the
// read-only default constraints above.
const ADVERSARIAL_CONSTRAINTS = [
  'Adopt a skeptical, adversarial stance: assume the change is wrong until the diff proves otherwise.',
  'Challenge every stated or implied assumption; call out any that the diff does not actually establish.',
  'Probe trust boundaries: untrusted input, authz/authn, injection, and unsafe deserialization at each boundary the diff touches.',
  'Probe concurrency: races, ordering, atomicity, and lock scope on any shared or persisted state.',
  'Probe rollback and data-loss: partial failure, non-atomic writes, and irreversible or destructive operations.',
  'Consider at least one alternative design and state where it would be safer or simpler than the diff.',
  'Remain strictly read-only and findings-only: do not modify files and report only as the findings JSON schema.',
]

// Default review goal. Kept as a constant so foreground and background share
// the exact same base wording (background must return an identical body).
const DEFAULT_GOAL = 'Review this diff and report defects as findings JSON.'

// Compose the outbound review goal. The caller's focus text is appended to the
// base goal here, before buildPayload runs, so the focus is redacted on the
// same path as every other outbound string (design §7). Empty/whitespace focus
// is ignored rather than emitting a dangling "Focus:" line.
export function buildReviewGoal({ goal = DEFAULT_GOAL, focus } = {}) {
  const base = goal || DEFAULT_GOAL
  const trimmed = typeof focus === 'string' ? focus.trim() : ''
  if (!trimmed) return base
  return `${base}\nFocus especially on: ${trimmed}`
}

// Select the constraint set for a review. Adversarial mode adds the skeptical
// pressure-testing constraints on top of the read-only defaults.
export function reviewConstraints({ adversarial = false } = {}) {
  return adversarial
    ? [...DEFAULT_CONSTRAINTS, ...ADVERSARIAL_CONSTRAINTS]
    : [...DEFAULT_CONSTRAINTS]
}

export async function review(options = {}) {
  const {
    cwd = process.cwd(),
    ref = null,
    goal = DEFAULT_GOAL,
    focus,
    adversarial = false,
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    model,
    effort,
    onEvent,
    onPermissionRequest,
    signal,
    runFn = transport.run,
    collectDiffFn = collectDiff,
    config = loadConfig(cwd),
    // Foreground review registers its successful resumable ACP turn. The
    // background worker leaves this false and registers only after its atomic
    // completeJob returns 'done' (see task.mjs runWorker), so a cancel-first
    // background review never leaves a resumable record.
    register = false,
  } = options

  const {
    diff,
    files,
    excludedFiles: collectedExcluded = [],
    untracked = [],
    ref: usedRef,
  } = await collectDiffFn({
    cwd,
    ref,
    excludeFiles: config.redaction.excludeFiles,
  })

  // Untracked-only cases still count as review targets — ending empty-handed
  // just because diff is empty would silently review nothing when "only new files were created".
  if (!diff.trim() && files.length === 0) {
    const suffix = collectedExcluded.length > 0
      ? ` (${collectedExcluded.length} excluded file(s))`
      : ''
    return {
      empty: true,
      ref: usedRef,
      adversarial,
      excludedFiles: collectedExcluded,
      message: `No reviewable changes relative to ${usedRef}${suffix}.`,
    }
  }

  // Focus is folded into the goal (and constraints for adversarial) before
  // buildPayload, so both are redacted on the standard outbound path (design §7).
  const outboundGoal = buildReviewGoal({ goal, focus })
  const constraints = reviewConstraints({ adversarial })

  const {
    payload,
    redactions,
    excludedFiles: payloadExcluded,
  } = buildPayload(
    { kind: 'review', goal: outboundGoal, diff, files, constraints },
    { redaction: config.redaction },
  )
  const excludedFiles = [...new Set([...collectedExcluded, ...payloadExcluded])]

  // All changed paths may have been intentionally excluded. Do not spend
  // credits on a payload with no review target.
  if (!payload.diff?.trim() && !payload.files?.length) {
    return {
      empty: true,
      ref: usedRef,
      adversarial,
      excludedFiles,
      message: `No reviewable changes relative to ${usedRef} (${excludedFiles.length} excluded file(s)).`,
    }
  }

  // Path for a human to inspect the payload right before it's sent (design §7).
  if (dryRun) {
    return { dryRun: true, adversarial, payload, redactions, excludedFiles, untracked, ref: usedRef }
  }

  const agent = `${AGENT_PREFIX}reviewer`
  const startedAt = Date.now()
  let res
  try {
    res = await runFn(payload, {
      cwd,
      agent,
      timeoutMs,
      model,
      effort,
      onEvent,
      onPermissionRequest,
      signal,
    })
  } catch (err) {
    // Failure metering mirrors runDelegated: a failed non-dry-run call is still
    // a credit-spending attempt and must be recorded.
    recordUsage({
      command: 'review', agent, model, cwd, ok: false,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }

  // Success metering mirrors runDelegated, including structured ACP usage/cost
  // and contextUsagePercentage when the transport surfaced them.
  recordUsage({
    command: 'review',
    agent,
    model,
    transport: res.transport,
    cwd,
    durationMs: Date.now() - startedAt,
    contextUsagePercentage: res.metadata?.contextUsagePercentage,
    acpUsed: res.metadata?.usage?.used,
    acpSize: res.metadata?.usage?.size,
    acpCost: res.metadata?.usage?.cost,
  })

  const parsed = parseResponse(res.result)

  // Foreground review registers the successful resumable ACP turn. Only an ACP
  // turn with a sessionId yields a record; subprocess/null-session turns do not.
  const sessionRecordId = register && res.sessionId
    ? (sessions.registerSession(
      {
        sessionId: res.sessionId,
        agent,
        source: { kind: 'review', command: 'review' },
        write: false,
        transport: res.transport,
        model: res.metadata?.model || res.model,
      },
      { cwd, retentionDays: config.logRetentionDays },
    )?.recordId ?? null)
    : null

  return {
    ref: usedRef,
    adversarial,
    untracked,
    // Reported so callers (and the --json envelope) agree with the agent name
    // already stamped into the trust-fence header by wrapForClaude.
    agent,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    // Final string for insertion into Claude's context. Always wrapped in the trust boundary (ADR-004).
    wrapped: wrapForClaude(parsed, { agent }),
    redactions,
    excludedFiles,
    metadata: res.metadata,
    sessionRecordId,
  }
}

// Human-readable summary. No auto-apply path is provided (ADR-004 decision 1).
export function formatSummary(result) {
  if (result.empty) return result.message
  const mode = result.adversarial ? 'adversarial' : 'standard'
  if (result.dryRun) {
    const lines = [
      `[dry-run] payload relative to ${result.ref} (mode: ${mode}, not sent)`,
      JSON.stringify(result.payload, null, 2),
    ]
    if (result.redactions.length > 0) {
      lines.push('', `Redacted: ${result.redactions.map((r) => `${r.where}:${r.kind}x${r.count}`).join(', ')}`)
    }
    if (result.excludedFiles.length > 0) {
      lines.push(`Excluded files: ${result.excludedFiles.join(', ')}`)
    }
    if (result.untracked?.length > 0) {
      lines.push(`untracked (path only): ${result.untracked.join(', ')}`)
    }
    return lines.join('\n')
  }

  const head = [`transport: ${result.transport}`, `mode: ${mode}`, `ref: ${result.ref}`]
  if (result.redactions.length > 0) {
    head.push(`redaction: ${result.redactions.length}`)
  }
  if (result.excludedFiles.length > 0) {
    head.push(`excluded files: ${result.excludedFiles.length}`)
  }
  if (result.untracked?.length > 0) {
    head.push(`untracked ${result.untracked.length}`)
  }
  if (!result.parsed.ok) {
    head.push('structuring failed — raw text attached')
  } else {
    const bySeverity = { high: 0, medium: 0, low: 0 }
    for (const f of result.parsed.findings) bySeverity[f.severity] += 1
    head.push(`findings: high ${bySeverity.high} / medium ${bySeverity.medium} / low ${bySeverity.low}`)
  }
  const out = [`${head.join(' | ')}`, '', result.wrapped]
  if (result.sessionRecordId) {
    out.push('', `Resume this session: /kiro-bridge:resume "<question>" --session ${result.sessionRecordId}`)
  }
  return out.join('\n')
}
