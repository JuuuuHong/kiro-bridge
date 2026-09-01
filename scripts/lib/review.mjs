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

export const DEFAULT_TIMEOUT_MS = 180_000 // design §8 failure mode table

const DEFAULT_CONSTRAINTS = [
  'Do not modify files — review only.',
  'Do not claim anything you could not confirm by reading it.',
]

export async function review(options = {}) {
  const {
    cwd = process.cwd(),
    ref = null,
    goal = 'Review this diff and report defects as findings JSON.',
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    onPermissionRequest,
    signal,
    runFn = transport.run,
    collectDiffFn = collectDiff,
    config = loadConfig(),
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
      excludedFiles: collectedExcluded,
      message: `No reviewable changes relative to ${usedRef}${suffix}.`,
    }
  }

  const {
    payload,
    redactions,
    excludedFiles: payloadExcluded,
  } = buildPayload(
    { kind: 'review', goal, diff, files, constraints: DEFAULT_CONSTRAINTS },
    { redaction: config.redaction },
  )
  const excludedFiles = [...new Set([...collectedExcluded, ...payloadExcluded])]

  // All changed paths may have been intentionally excluded. Do not spend
  // credits on a payload with no review target.
  if (!payload.diff?.trim() && !payload.files?.length) {
    return {
      empty: true,
      ref: usedRef,
      excludedFiles,
      message: `No reviewable changes relative to ${usedRef} (${excludedFiles.length} excluded file(s)).`,
    }
  }

  // Path for a human to inspect the payload right before it's sent (design §7).
  if (dryRun) {
    return { dryRun: true, payload, redactions, excludedFiles, untracked, ref: usedRef }
  }

  const agent = `${AGENT_PREFIX}reviewer`
  const startedAt = Date.now()
  let res
  try {
    res = await runFn(payload, {
      cwd,
      agent,
      timeoutMs,
      onEvent,
      onPermissionRequest,
      signal,
    })
  } catch (err) {
    // Failure metering mirrors runDelegated: a failed non-dry-run call is still
    // a credit-spending attempt and must be recorded.
    recordUsage({
      command: 'review', agent, cwd, ok: false,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }

  // Success metering mirrors runDelegated, including structured ACP usage/cost
  // and contextUsagePercentage when the transport surfaced them.
  recordUsage({
    command: 'review',
    agent,
    transport: res.transport,
    cwd,
    durationMs: Date.now() - startedAt,
    contextUsagePercentage: res.metadata?.contextUsagePercentage,
    acpUsed: res.metadata?.usage?.used,
    acpSize: res.metadata?.usage?.size,
    acpCost: res.metadata?.usage?.cost,
  })

  const parsed = parseResponse(res.result)

  return {
    ref: usedRef,
    untracked,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    // Final string for insertion into Claude's context. Always wrapped in the trust boundary (ADR-004).
    wrapped: wrapForClaude(parsed, { agent }),
    redactions,
    excludedFiles,
    metadata: res.metadata,
  }
}

// Human-readable summary. No auto-apply path is provided (ADR-004 decision 1).
export function formatSummary(result) {
  if (result.empty) return result.message
  if (result.dryRun) {
    const lines = [
      `[dry-run] payload relative to ${result.ref} (not sent)`,
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

  const head = [`transport: ${result.transport}`, `ref: ${result.ref}`]
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
  return `${head.join(' | ')}\n\n${result.wrapped}`
}
