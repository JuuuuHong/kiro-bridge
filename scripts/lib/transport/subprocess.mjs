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

  const splitter = createLineSplitter((line) => {
    const event = normalizeStreamJsonLine(line)
    if (!event) return
    collector.push(event)
    onEvent?.(event)
  })

  child.stdout.on('data', (c) => splitter.push(String(c)))
  child.stderr.on('data', (c) => { stderr += String(c) })

  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch {}
  }, timeoutMs)

  const onAbort = () => { try { child.kill('SIGTERM') } catch {} }
  signal?.addEventListener('abort', onAbort, { once: true })

  // The payload always goes through the stdin pipe, regardless of size (ADR-003 decision 4).
  try {
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  } catch (err) {
    clearTimeout(timer)
    throw bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) })
  }

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })

  clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  splitter.flush()

  if (timedOut) {
    throw bridgeError(CODES.TIMEOUT, { partial: collector.text })
  }
  if (signal?.aborted) {
    throw bridgeError(CODES.CANCELLED, { partial: collector.text })
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
