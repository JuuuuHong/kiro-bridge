// Fallback transport: kiro-cli chat --no-interactive --output-format stream-json.
//
// Used only when ACP capability detection fails (ADR-001R decision 1). The
// upper-layer contract is the same, but this path has no reverse permission request — untrusted tools are
// auto-denied without prompting, so onPermissionRequest collapses to "always deny", caught by the denial detector.
import { spawn } from 'node:child_process'
import { createLineSplitter, normalizeStreamJsonLine, createCollector } from './events.mjs'
import { bridgeError, classifyOutput, CODES } from '../errors.mjs'

export function buildArgs({ agent, model, effort } = {}) {
  const args = ['chat', '--no-interactive', '--output-format', 'stream-json']
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
  } = options

  let child
  try {
    child = spawnFn(bin, buildArgs(options), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
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

  const classified = classifyOutput(`${collector.text}\n${stderr}`)
  if (classified) throw bridgeError(classified, { stderr, exitCode })

  if (collector.denied) {
    throw bridgeError(CODES.TOOL_DENIED, { denials: collector.denials })
  }

  if (exitCode !== 0) {
    throw bridgeError(CODES.SPAWN_FAILED, { exitCode, stderr })
  }

  return {
    sessionId: null, // there is no session to reuse on the one-shot path
    transport: 'subprocess',
    result: collector.text,
    metadata: collector.metadata,
  }
}
