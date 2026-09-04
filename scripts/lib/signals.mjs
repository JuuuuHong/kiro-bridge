// Builds the payload's `signals` block (design §5 payload spec).
//
// A reviewer that cannot run anything can only reason statically: it is forced
// to say "I could not execute the tests" exactly where a real defect would show
// up. The fix is *not* to trust the shell tool — ADR-002 denies it in every
// agent under every flag, and kiro-cli offers only a trust list, never an OS
// sandbox, so a trusted shell would be unrestricted execution on the user's
// machine driven by a model that just read an untrusted diff.
//
// Instead the execution happens on this side of the boundary and only its
// captured *output* crosses. Two sources, and the reviewer gains nothing from
// either:
//
//   1. `signals.testCommand` in the user config — the bridge runs it itself,
//      as an argv array through execFile. There is no shell string to inject
//      into (the git.mjs rule), and the child inherits the same allowlisted
//      environment as any kiro-cli spawn, so a test process cannot read
//      credentials the delegated call could not.
//   2. `--signals <path>` — a JSON file written by whoever already ran the
//      tests. The bridge executes nothing at all.
//
// Both paths end in `buildPayload`, which scrubs and caps every signal string
// on the standard outbound route, so a secret printed by a failing test is
// masked like any other outbound text.
//
// Source 1 is deliberately user-config-only. `applyProjectConfig` merges
// nothing but redaction patterns, so a `.kiro/settings/kiro-bridge.json` that
// ships inside a repository can never hand the bridge a command to execute —
// which would otherwise turn "review this repo" into arbitrary code execution.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { LIMITS } from './context.mjs'
import { childEnvFromConfig } from './env.mjs'

// The whitelist buildPayload also enforces. Kept in sync deliberately: this
// module rejects unknown keys early so a typo surfaces here rather than being
// silently dropped at the payload boundary.
export const SIGNAL_KEYS = ['failing_tests', 'lint', 'notes']

export const DEFAULT_TEST_TIMEOUT_MS = 120_000

// Generous relative to LIMITS.signal: a test runner can emit megabytes, and we
// want the *tail* of that, not a truncation of the first 20KB of setup noise.
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

// Keep only whitelisted, non-empty string entries. Anything else is dropped
// rather than coerced, so a malformed signals file cannot inject structure.
export function normalizeSignals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of SIGNAL_KEYS) {
    const value = raw[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    out[key] = trimmed
  }
  return Object.keys(out).length > 0 ? out : null
}

// Truncation keeps the tail. A failing test run puts the failures and the
// summary at the end; cutting from the front would throw away the answer.
export function tailTruncate(text, max = LIMITS.signal) {
  if (typeof text !== 'string' || text.length <= max) return text
  const kept = text.slice(text.length - max)
  return `… [truncated ${text.length - max} leading chars]\n${kept}`
}

// argv array only. A string is rejected with a message that names the fix,
// because the obvious thing to write is "npm test" and silently splitting that
// on whitespace would break the first command containing a quoted argument.
export function validateTestCommand(command) {
  if (command == null) return null
  if (!Array.isArray(command)) {
    throw new Error(
      'signals.testCommand must be an argv array, not a string '
      + '(e.g. ["npm", "test"]) — the bridge never runs a shell',
    )
  }
  const argv = command.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
  if (argv.length !== command.length) {
    throw new Error('signals.testCommand contains a non-string or empty entry')
  }
  return argv.length > 0 ? argv : null
}

// Run the configured command and capture combined output.
//
// A non-zero exit is the *expected* interesting case, not an error: failing
// tests are the signal. Only a failure to spawn at all is reported as one.
export function runTestCommand(argv, options = {}) {
  const {
    cwd = process.cwd(),
    config = {},
    timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
    execFileFn = execFile,
  } = options
  const [bin, ...args] = argv
  return new Promise((resolve) => {
    execFileFn(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_CAPTURE_BYTES,
        env: childEnvFromConfig(config),
      },
      (err, stdout, stderr) => {
        const combined = `${String(stdout || '')}${String(stderr || '')}`.trim()
        // Spawn failures (ENOENT, EACCES) produce no output and mean the
        // command is misconfigured — say so instead of sending an empty signal
        // that reads as "tests passed".
        if (err && combined === '' && !err.killed) {
          resolve({
            ok: false,
            reason: `signals.testCommand failed to run: ${err.code || err.message}`,
          })
          return
        }
        const timedOut = Boolean(err?.killed)
        const header = timedOut
          ? `$ ${argv.join(' ')}\n[timed out after ${timeoutMs}ms — output truncated]`
          : `$ ${argv.join(' ')}\n[exit ${err?.code ?? 0}]`
        resolve({ ok: true, text: tailTruncate(`${header}\n${combined}`) })
      },
    )
  })
}

// Read a caller-supplied signals JSON file.
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

// Resolve the signals block for one invocation.
//
// Precedence: an explicit flag on *this* call beats standing configuration.
//   --no-signals  -> nothing
//   --signals P   -> the file at P, and the bridge runs nothing
//   testCommand   -> the bridge runs it
//   otherwise     -> nothing
//
// Returns { signals, note } where note (if any) is a human-facing line about
// what could not be collected. A collection failure never fails the review:
// losing the signal is strictly better than losing the review.
export async function collectSignals(options = {}) {
  const {
    cwd = process.cwd(),
    config = {},
    signalsPath = null,
    disabled = false,
    runTestCommandFn = runTestCommand,
    readSignalsFileFn = readSignalsFile,
  } = options

  if (disabled) return { signals: null, note: null }

  if (signalsPath) {
    return { signals: readSignalsFileFn(signalsPath), note: null }
  }

  const argv = validateTestCommand(config.signals?.testCommand)
  if (!argv) return { signals: null, note: null }

  const result = await runTestCommandFn(argv, {
    cwd,
    config,
    timeoutMs: config.signals?.timeoutMs || DEFAULT_TEST_TIMEOUT_MS,
  })
  if (!result.ok) return { signals: null, note: result.reason }
  return { signals: { failing_tests: result.text }, note: null }
}
