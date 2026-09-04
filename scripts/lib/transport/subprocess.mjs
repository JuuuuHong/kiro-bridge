// Fallback transport: kiro-cli chat --no-interactive --output-format stream-json.
//
// Used only when ACP capability detection fails (ADR-001R decision 1). The
// upper-layer contract is the same, but this path has no reverse permission request — untrusted tools are
// auto-denied without prompting, so onPermissionRequest collapses to "always deny", caught by the denial detector.
import { spawn } from 'node:child_process'
import { createLineSplitter, normalizeStreamJsonLine, createCollector } from './events.mjs'
import { loadConfig } from '../config.mjs'
import { childEnvFromConfig } from '../env.mjs'
import { bridgeError, classifyOutput, classifyStopReason, CODES } from '../errors.mjs'

// The engine is pinned explicitly rather than left to the CLI default.
// kiro-cli 2.21.0 resolves `chat --no-interactive` to the v1 engine, and v1
// rejects `--output-format stream-json` outright ("not supported on the v1
// engine"), which exits nonzero and surfaces as SPAWN_FAILED. v3 is not an
// option either: it refuses a v2-shaped custom agent ("needs upgrading for
// this agent engine, using \"default\"") and would silently run the delegated
// call under the *default* full-permission agent, dropping the read-only
// sandbox the reviewer/researcher agents exist to enforce (ADR-002). v2 is the
// only engine that accepts both stream-json and our agent definitions.
export const AGENT_ENGINE = 'v2'

// kiro-cli reports an unapplied model as a warning on stderr and still exits 0.
const MODEL_UNAPPLIED_PATTERN = /failed to set model/i

export function buildArgs({ agent, model, effort } = {}) {
  const args = [
    'chat', '--no-interactive',
    '--output-format', 'stream-json',
    '--agent-engine', AGENT_ENGINE,
  ]
  if (agent) args.push('--agent', agent)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  return args
}

export async function run(payload, options = {}) {
  const {
    bin = 'kiro-cli',
    cwd = process.cwd(),
    onEvent,
    signal,
    timeoutMs = 180_000,
    terminationGraceMs = 500,
    spawnFn = spawn,
    config = loadConfig(),
  } = options

  let child
  try {
    child = spawnFn(bin, buildArgs(options), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvFromConfig(config) })
  } catch (err) {
    throw bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) })
  }

  const collector = createCollector()
  let stderr = ''
  let timedOut = false
  let processError = null
  let forceKillTimer = null
  let terminationStarted = false

  const splitter = createLineSplitter((line) => {
    const event = normalizeStreamJsonLine(line)
    if (!event) return
    collector.push(event)
    onEvent?.(event)
  })

  child.stdout.on('data', (c) => splitter.push(String(c)))
  child.stderr.on('data', (c) => { stderr += String(c) })

  // Register lifecycle listeners before writing. A process can exit between
  // spawn() and stdin.write(), and missing that close event would hang forever.
  const exited = new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
    child.once('error', (err) => {
      processError = err
      resolve(-1)
    })
  })

  const terminate = () => {
    if (terminationStarted || child.exitCode !== null || child.signalCode !== null) return
    terminationStarted = true
    try { child.kill('SIGTERM') } catch {}
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
    }, terminationGraceMs)
    forceKillTimer.unref?.()
  }

  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)

  const onAbort = () => terminate()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  // Await stream completion as well as process exit. Writable errors such as
  // EPIPE are asynchronous events and cannot be caught by a write try/catch.
  const inputFinished = new Promise((resolve) => {
    let settled = false
    const settle = (error = null) => {
      if (settled) return
      settled = true
      resolve(error)
    }
    child.stdin.once('error', settle)
    child.stdin.once('finish', () => settle())
    child.stdin.once('close', () => {
      if (!child.stdin.writableFinished) {
        settle(new Error('kiro-cli stdin closed before the payload was written'))
      }
    })
    try {
      child.stdin.end(JSON.stringify(payload))
    } catch (err) {
      settle(err)
    }
  })

  const [exitCode, inputError] = await Promise.all([exited, inputFinished])

  clearTimeout(timer)
  if (forceKillTimer) clearTimeout(forceKillTimer)
  signal?.removeEventListener('abort', onAbort)
  splitter.flush()

  if (timedOut) {
    throw bridgeError(CODES.TIMEOUT, { partial: collector.text })
  }
  if (signal?.aborted) {
    throw bridgeError(CODES.CANCELLED, { partial: collector.text })
  }
  if (processError || inputError) {
    const cause = processError || inputError
    throw bridgeError(CODES.SPAWN_FAILED, {
      cause: String(cause?.message || cause),
      code: cause?.code,
      exitCode,
      stderr,
    })
  }

  // Auth/throttle classification is driven strictly by process diagnostics
  // (stderr), never by collector/model text — a clean successful agent message
  // may legitimately contain phrases like "unauthorized" or "rate limit" and
  // must not be misclassified (F1). Structural denial events below remain
  // authoritative.
  const classified = classifyOutput(stderr)
  if (classified) throw bridgeError(classified, { stderr, exitCode })

  // A requested model that the CLI could not apply is a silent downgrade: on
  // kiro-cli 2.21.0 this path answers "failed to set model '<id>': Method not
  // found" on stderr, exits 0, and runs the turn on the *default* model while
  // the caller is told its choice was honoured. Reporting a gpt-5.6-sol review
  // that an entirely different model produced is worse than failing, so fail.
  if (options.model && MODEL_UNAPPLIED_PATTERN.test(stderr)) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: `kiro-cli did not apply --model ${options.model} on the subprocess fallback transport; the turn would have run on the default model`,
      model: options.model,
      stderr,
    })
  }

  if (collector.denied) {
    throw bridgeError(CODES.TOOL_DENIED, { denials: collector.denials })
  }

  if (exitCode !== 0) {
    throw bridgeError(CODES.SPAWN_FAILED, { exitCode, stderr })
  }

  // A non-success stop reason cannot be trusted as a finished result — the same
  // rule the ACP path applies. Only enforced when the stream actually reported a
  // terminal event, so an older stream shape that has none still succeeds.
  if (collector.stopSeen) {
    const stop = classifyStopReason(collector.stopReason)
    if (!stop.ok) {
      throw bridgeError(stop.code, {
        stopReason: stop.stopReason,
        partial: collector.text,
        ...(stop.reason ? { reason: stop.reason } : {}),
      })
    }
  }

  return {
    sessionId: null, // there is no session to reuse on the one-shot path
    transport: 'subprocess',
    result: collector.text,
    stopReason: collector.stopSeen ? collector.stopReason : undefined,
    metadata: collector.metadata,
  }
}
