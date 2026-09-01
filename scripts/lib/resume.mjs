// /kiro-bridge:resume — continue a previously-recorded ACP session (design §8).
//
// Resume reuses a stored resumable session (see sessions.mjs) to ask a new
// question against the *same* Kiro conversation. It rebuilds the original agent
// from the record's stored agent name, sends the new question through the same
// redacted task-payload path every other command uses (design §7), and reasserts
// the trust boundary on the reply (ADR-004). It never resurrects prompts, diffs,
// or file paths from the past turn — only the sessionId is reused; the question
// is fresh, redacted, and bounded like any other outbound goal.
import { buildPayload } from './context.mjs'
import { parseResponse, wrapForClaude } from './findings.mjs'
import { loadConfig } from './config.mjs'
import * as transport from './transport/index.mjs'
import { agentDefByName } from './agents.mjs'
import { bridgeError, CODES } from './errors.mjs'
import { recordUsage } from './usage.mjs'
import * as sessions from './sessions.mjs'

export const DEFAULT_TIMEOUT_MS = 600_000 // mirror task's failure-mode budget

const RESUME_CONSTRAINTS = [
  'Do not claim anything you could not confirm by reading it.',
]

// Build the outbound payload for the resumed question on the standard redacted
// path — identical treatment to task/spec goals, so the question is truncated,
// control-stripped, and secret-redacted before it leaves the process.
function buildResumePayload({ question, config }) {
  return buildPayload(
    { kind: 'task', goal: question, constraints: RESUME_CONSTRAINTS },
    { redaction: config.redaction },
  )
}

export async function resume(options = {}) {
  const {
    question,
    session, // optional selector: recordId or sessionId; latest when omitted
    cwd = process.cwd(),
    model,
    effort,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    onPermissionRequest,
    signal,
    runFn = transport.run,
    config = loadConfig(),
  } = options

  if (!question || !String(question).trim()) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'resume question is empty' })
  }

  // Resolve latest by default, or an exact recordId/sessionId when requested.
  const record = sessions.resolveSession({ selector: session, cwd })
  if (!record) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: session
        ? `no resumable ACP session matches "${session}" in this repository`
        : 'no resumable ACP session found in this repository',
    })
  }

  // Reconstruct the original agent from the record's stored name. A record only
  // ever stores a name from the fixed catalog, and agentDefByName rejects any
  // unknown/untrusted name — so reviewer stays reviewer, and a
  // researcher/worker/spec-writer keeps its own agent (and webDerived wrapping).
  const agentDef = agentDefByName(record.agent)
  if (!agentDef) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: `resume record references an unknown agent: ${record.agent}`,
    })
  }

  const { payload, redactions, excludedFiles } = buildResumePayload({ question, config })

  const startedAt = Date.now()
  let res
  try {
    res = await runFn(payload, {
      cwd,
      agent: agentDef.name,
      sessionId: record.sessionId,
      model,
      effort,
      timeoutMs,
      onEvent,
      onPermissionRequest,
      signal,
    })
  } catch (err) {
    // Failure metering mirrors every other credit-spending call.
    recordUsage({
      command: 'resume', agent: agentDef.name, model, cwd, ok: false,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }

  recordUsage({
    command: 'resume',
    agent: agentDef.name,
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
  const wrapped = wrapForClaude(parsed, {
    agent: agentDef.name,
    webDerived: Boolean(agentDef.webDerived),
  })

  // Register the resumed turn as its own resumable record, so chained resumes
  // can continue from the latest turn. Preserve the source kind/command and the
  // original write flag; only an ACP turn with a session yields a record.
  const newRecord = sessions.registerSession(
    {
      sessionId: res.sessionId,
      agent: agentDef.name,
      source: { kind: record.source.kind, command: 'resume' },
      write: Boolean(record.write),
      transport: res.transport,
      model: res.metadata?.model || model,
    },
    { cwd, retentionDays: config.logRetentionDays },
  )

  return {
    agent: agentDef.name,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    wrapped,
    redactions,
    excludedFiles,
    metadata: res.metadata,
    // The record we resumed from, and the fresh record this turn created.
    sourceRecordId: record.recordId,
    sessionRecordId: newRecord ? newRecord.recordId : null,
  }
}

export function formatResume(result) {
  const lines = [
    `transport: ${result.transport} | agent: ${result.agent} | resumed: ${result.sourceRecordId}`,
    '',
    result.wrapped,
  ]
  if (result.sessionRecordId) {
    lines.push('', `Resume again: /kiro-bridge:resume "<question>" --session ${result.sessionRecordId}`)
  }
  return lines.join('\n')
}
