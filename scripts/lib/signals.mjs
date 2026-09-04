// Builds the payload's `signals` block (design §5 payload spec).
//
// A reviewer that cannot run anything can only reason statically: it is forced
// to say "I could not execute the tests" exactly where a real defect would show
// up. The fix is not to trust the shell tool — ADR-002 denies it in every agent
// under every flag, and kiro-cli offers only a trust list, never an OS sandbox.
// Instead, whoever already ran the tests hands the output over and the reviewer
// reads it as data.
//
// The bridge executes NOTHING here, deliberately.
//
// An earlier version let the user configure a `signals.testCommand` that the
// bridge would run itself. That was the wrong layer. The command a repository
// answers to — `npm test`, `make test`, `npx jest` — is defined *by that
// repository*, so running it means executing the reviewed code. Moving the
// execution out of the agent and into the bridge removed the model's ability to
// drive it and left the repository's ability untouched; `review --dry-run` on
// an unfamiliar repo, the step the docs call the safe first move, ran that
// repo's package.json. No flag fixes this: the flag would be typed by the model
// reading the skill doc, which is precisely what ADR-002 says not to rely on,
// and standing config is worse because it follows the user into every clone.
//
// The decision of whether to run a repository's code already exists one layer
// up, in the host's permission prompt, where a person sees it and answers. A
// second, quieter copy of that decision inside the bridge could only subtract
// safety. So the caller runs the tests under those existing controls and passes
// the result here with --signals.
import { readFileSync } from 'node:fs'
import { LIMITS } from './context.mjs'

// The whitelist buildPayload also enforces. Kept in sync deliberately: this
// module rejects unknown keys early so a typo surfaces here rather than being
// silently dropped at the payload boundary.
export const SIGNAL_KEYS = ['failing_tests', 'lint', 'notes']

// Truncation keeps the tail: a test run puts its failures and summary at the
// end, so cutting from the front would throw away the answer.
//
// The result must fit LIMITS.signal *exactly*. buildPayload caps every signal
// string with its own truncate(), which cuts from the head — so overshooting
// here by even the length of the notice hands the tail straight back to a
// head-truncation and defeats the whole point.
export function tailTruncate(text, max = LIMITS.signal) {
  if (typeof text !== 'string' || text.length <= max) return text
  const notice = (dropped) => `… [truncated ${dropped} leading chars]\n`
  // The notice's length depends on the number it prints, which depends on how
  // much room the notice leaves. Two passes settle it — the digit count can
  // only shrink, never grow, on the second.
  let keep = max - notice(text.length - max).length
  keep = max - notice(text.length - keep).length
  if (keep <= 0) return text.slice(-max)
  const out = `${notice(text.length - keep)}${text.slice(-keep)}`
  return out.length <= max ? out : out.slice(-max)
}

// Keep only whitelisted, non-empty string entries, each bounded to the payload
// cap. Anything else is dropped rather than coerced, so a malformed signals
// file cannot inject structure.
export function normalizeSignals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of SIGNAL_KEYS) {
    const value = raw[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    out[key] = tailTruncate(trimmed)
  }
  return Object.keys(out).length > 0 ? out : null
}

// Read a caller-supplied signals JSON file.
//
// This throws rather than degrading to "no signal". The path was named
// explicitly for this call, so a typo must not produce a review that silently
// went out with no evidence while the caller believed it carried some.
export function readSignalsFile(path, { readFileFn = readFileSync } = {}) {
  let parsed
  try {
    parsed = JSON.parse(readFileFn(path, 'utf8'))
  } catch (err) {
    throw new Error(`--signals could not read ${path}: ${err.message}`)
  }
  const normalized = normalizeSignals(parsed)
  if (!normalized) {
    throw new Error(
      `--signals file has no usable keys (expected any of: ${SIGNAL_KEYS.join(', ')})`,
    )
  }
  return normalized
}

// Resolve the signals block for one invocation. Reads a file at most; runs
// nothing. --no-signals wins over --signals so a caller can suppress evidence
// without editing the command that supplied it.
export function collectSignals(options = {}) {
  const {
    signalsPath = null,
    disabled = false,
    readSignalsFileFn = readSignalsFile,
  } = options
  if (disabled || !signalsPath) return { signals: null }
  return { signals: readSignalsFileFn(signalsPath) }
}
