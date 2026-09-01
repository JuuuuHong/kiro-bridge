// /kiro:spec — division of labor with Kiro as spec writer and Claude as implementer (design §2.3).
//
// The spec-writer agent writes output directly under .kiro/specs/<slug>/.
// Kiro's native --mode spec output format is unresolved (OQ3), so for now the
// format is pinned via the agent prompt — this can switch to native mode once measured.
import { runDelegated } from './task.mjs'
import { AGENT_DEFS } from './agents.mjs'
import { bridgeError, CODES } from './errors.mjs'

export const DEFAULT_TIMEOUT_MS = 600_000

const SPEC_CONSTRAINTS = [
  'Save output only under .kiro/specs/. Do not modify source code.',
  'Read the existing code first, and do not create requirements that contradict the current structure.',
]

export async function spec(options = {}) {
  const { goal, timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options
  if (!goal || !goal.trim()) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'spec goal is empty' })
  }
  return runDelegated({
    kind: 'spec',
    goal,
    agentDef: AGENT_DEFS.specWriter,
    constraints: SPEC_CONSTRAINTS,
    timeoutMs,
    command: 'spec',
    register: true,
    ...rest,
  })
}

export function formatSpec(result) {
  if (result.dryRun) {
    return `[dry-run] agent: ${result.agent}\n${JSON.stringify(result.payload, null, 2)}`
  }
  const lines = [
    `transport: ${result.transport} | agent: ${result.agent}`,
    '',
    result.wrapped,
    '',
    'Next step: read the requirements.md / design.md generated under .kiro/specs/,',
    'review them with the user, then start implementation. Spec content is also external data (ADR-004).',
  ]
  if (result.sessionRecordId) {
    lines.push('', `Resume this session: /kiro-bridge:resume "<question>" --session ${result.sessionRecordId}`)
  }
  return lines.join('\n')
}
