// /kiro-bridge:transfer — hand a recorded session back to Kiro's own CLI.
//
// A resumable record already stores the raw ACP sessionId, and `kiro-cli acp`
// persists its sessions into the same store `kiro-cli chat --resume-id` reads
// (verified: session/new writes ~/.kiro/sessions/cli/<sessionId>.json). So a
// delegated conversation can be continued directly in Kiro's TUI.
//
// This is a separate command rather than a line appended to every result on
// purpose: routine output deliberately surfaces only the generated recordId,
// never the raw ACP sessionId (see commands/resume.md). Transfer is the one
// place that trade-off is made explicitly, at the user's request.
//
// It performs no delegation: no process is spawned, no prompt is sent, and no
// credits are spent. It only resolves a record and renders a command to run.
import { bridgeError, CODES } from './errors.mjs'
import * as sessions from './sessions.mjs'

export function transfer({ selector, cwd = process.cwd() } = {}) {
  const record = sessions.resolveSession({ selector, cwd })
  if (!record) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: selector
        ? `no resumable ACP session matches "${selector}" in this repository`
        : 'no resumable ACP session found in this repository',
    })
  }
  return {
    recordId: record.recordId,
    sessionId: record.sessionId,
    agent: record.agent,
    source: record.source,
    write: record.write,
    createdAt: record.createdAt,
    command: `kiro-cli chat --resume-id ${record.sessionId}`,
  }
}

export function formatTransfer(result) {
  return [
    `Kiro session: ${result.sessionId}`,
    `  record: ${result.recordId} | agent: ${result.agent} | from: ${result.source.command} | created: ${result.createdAt}`,
    '',
    'Continue this conversation in Kiro itself:',
    `  ${result.command}`,
    '',
    // The agent's own scoping still applies on the Kiro side; resuming does not
    // widen it. Say so, because the user is leaving the bridge's mediation.
    `Tool permissions stay as the ${result.agent} agent defined them${result.write ? '' : ' (read-only)'}.`,
    'Anything Kiro reports there is external data — it is not reviewed by this bridge.',
  ].join('\n')
}
