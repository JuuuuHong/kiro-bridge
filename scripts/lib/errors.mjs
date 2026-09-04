// Failure modes (design §8). Each row of the table maps to one code here.
//
// No retries on any path — these calls spend credits, so a silent retry
// doubles the cost. Failures are classified and shown to the user as-is.

export const CODES = {
  TIMEOUT: 'TIMEOUT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  THROTTLED: 'THROTTLED',
  TOOL_DENIED: 'TOOL_DENIED',
  TRANSPORT_UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
  CANCELLED: 'CANCELLED',
  PROTOCOL: 'PROTOCOL',
  SPAWN_FAILED: 'SPAWN_FAILED',
  // The turn ended before completing the goal (max_tokens / max_turn_requests).
  // Any partial output cannot be trusted as a finished result.
  INCOMPLETE: 'INCOMPLETE',
  // The agent explicitly refused the request (stopReason: refusal).
  REFUSED: 'REFUSED',
}

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

// Untrusted tool calls are auto-denied without prompting in non-interactive
// mode, and the conversation continues (design §8, ADR-002). Missing this
// string means mistaking "findings fabricated without reading the file" for success.
const DENIAL_PATTERNS = [
  /\[denied\]/i,
  /tool permission approval is not supported in non-interactive mode/i,
  /permission denied for tool/i,
]

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run .*login/i,
  /authentication (?:required|failed|expired)/i,
  /unauthorized/i,
  /ExpiredToken/i,
]

const THROTTLE_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota exceeded/i,
  /insufficient credits?/i,
  /monthly limit/i,
]

export function detectDenial(text) {
  if (typeof text !== 'string' || text === '') return false
  return DENIAL_PATTERNS.some((re) => re.test(text))
}

// Output text -> error code. null if none applies (normal path).
// Priority: auth > throttle > tool denial. Auth failure can trigger the rest, so check it first.
export function classifyOutput(text) {
  if (typeof text !== 'string' || text === '') return null
  if (AUTH_PATTERNS.some((re) => re.test(text))) return CODES.UNAUTHENTICATED
  if (THROTTLE_PATTERNS.some((re) => re.test(text))) return CODES.THROTTLED
  if (detectDenial(text)) return CODES.TOOL_DENIED
  return null
}

// Maps a turn's stopReason to a terminal disposition. Shared by both transports
// so a truncated or refused turn is classified identically on either path.
// { ok: true } means the turn finished cleanly. Otherwise { code } carries the
// BridgeError code to throw, with partial output attached by the caller.
export function classifyStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
      return { ok: true }
    case 'max_tokens':
    case 'max_turn_requests':
      return { ok: false, code: CODES.INCOMPLETE, stopReason }
    case 'refusal':
      return { ok: false, code: CODES.REFUSED, stopReason }
    case 'cancelled':
      return { ok: false, code: CODES.CANCELLED, stopReason }
    default:
      return {
        ok: false,
        code: CODES.PROTOCOL,
        stopReason,
        reason:
          stopReason == null
            ? 'the turn reported no stopReason'
            : `unknown stopReason: ${JSON.stringify(stopReason)}`,
      }
  }
}

export const MESSAGES = {  [CODES.TIMEOUT]: 'Timed out. Returning partial output only (not retried).',
  [CODES.UNAUTHENTICATED]: 'Kiro authentication required. Run `kiro-cli login`.',
  [CODES.THROTTLED]: 'Credits exhausted or throttled. Check usage with `/kiro-bridge:status`.',
  [CODES.TOOL_DENIED]:
    'Kiro could not read a needed file due to insufficient tool permissions. Findings cannot be trusted, so this is promoted to an error.',
  [CODES.TRANSPORT_UNAVAILABLE]: 'kiro-cli could not be found or executed.',
  [CODES.CANCELLED]: 'Cancelled.',
  [CODES.PROTOCOL]: 'Protocol exchange with kiro-cli did not match expectations.',
  [CODES.SPAWN_FAILED]: 'Failed to start the kiro-cli process.',
  [CODES.INCOMPLETE]:
    'Kiro stopped before finishing (token or turn limit). Partial output only; not a trustworthy result.',
  [CODES.REFUSED]: 'Kiro refused the request. Partial output only.',
}

export function bridgeError(code, details = {}) {
  return new BridgeError(code, MESSAGES[code] || code, details)
}
