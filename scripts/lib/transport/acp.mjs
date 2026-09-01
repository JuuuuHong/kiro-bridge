// Primary transport: kiro-cli acp (stdio JSON-RPC). ADR-001R.
//
// What this path uniquely gives us: streaming, cancellation, session reuse,
// and permission brokering. The core piece is mediating session/request_permission through Claude Code's judgment.
import { spawn } from 'node:child_process'
import { JsonRpcClient } from './jsonrpc.mjs'
import { normalizeAcpUpdate, createCollector, EVENT_TYPES } from './events.mjs'
import { bridgeError, classifyOutput, CODES } from '../errors.mjs'

export const PROTOCOL_VERSION = 1

function initializeParams() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  }
}


function terminateChild(child, graceMs = 500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return null
  try { child.kill('SIGTERM') } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }, graceMs)
  timer.unref?.()
  return timer
}

// Runs only the handshake to check ACP availability. No prompt is sent, so no credits are spent.
export async function probe({
  bin = 'kiro-cli',
  spawnFn = spawn,
  timeoutMs = 5000,
  terminationGraceMs = 500,
} = {}) {
  let child
  try {
    child = spawnFn(bin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    return { available: false, reason: String(err?.message || err) }
  }

  const client = new JsonRpcClient({ write: (s) => child.stdin.write(s) })
  child.stdout.on('data', (c) => client.feed(c))
  child.stderr.on('data', () => {}) // drain diagnostics so the pipe cannot back-pressure

  const exited = new Promise((resolve) => {
    child.once('close', (code) => {
      client.close(bridgeError(CODES.PROTOCOL, { reason: 'kiro-cli exited during ACP probe', exitCode: code }))
      resolve(code)
    })
    child.once('error', (err) => {
      client.close(bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) }))
      resolve(-1)
    })
  })
  child.stdin.once('error', (err) => {
    client.close(bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) }))
  })

  const timer = setTimeout(() => client.close(bridgeError(CODES.TIMEOUT)), timeoutMs)
  let forceKillTimer = null
  try {
    const result = await client.request('initialize', initializeParams())
    return { available: true, initialize: result }
  } catch (err) {
    return { available: false, reason: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
    client.close()
    forceKillTimer = terminateChild(child, terminationGraceMs)
    await exited
    if (forceKillTimer) clearTimeout(forceKillTimer)
  }
}

export async function run(payload, options = {}) {
  const {
    bin = 'kiro-cli',
    agent,
    model,
    effort,
    cwd = process.cwd(),
    sessionId: existingSessionId,
    onEvent,
    onPermissionRequest,
    signal,
    timeoutMs = 180_000,
    terminationGraceMs = 500,
    spawnFn = spawn,
  } = options

  const args = ['acp']
  if (agent) args.push('--agent', agent)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)

  let child
  try {
    child = spawnFn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    throw bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) })
  }

  const collector = createCollector()
  let stderr = ''
  let timedOut = false
  let forceKillTimer = null
  let terminationStarted = false

  const terminate = () => {
    if (terminationStarted) return
    terminationStarted = true
    forceKillTimer = terminateChild(child, terminationGraceMs)
  }

  const emit = (event) => {
    collector.push(event)
    onEvent?.(event)
  }

  const client = new JsonRpcClient({
    write: (s) => {
      if (child.stdin.writable) child.stdin.write(s)
    },
    onNotification: (msg) => {
      if (msg.method === 'session/update') emit(normalizeAcpUpdate(msg.params?.update))
    },
    onRequest: async (msg) => {
      if (msg.method !== 'session/request_permission') return {}
      // Permission brokering. Denial is the default if there's no handler (ADR-002).
      const decision = onPermissionRequest
        ? await onPermissionRequest(msg.params)
        : { outcome: 'cancelled' }
      if (decision?.outcome !== 'selected') {
        emit({ type: EVENT_TYPES.DENIED, text: '[denied] permission request rejected by client' })
      }
      return decision
    },
  })

  child.stdout.on('data', (c) => client.feed(c))
  child.stderr.on('data', (c) => { stderr += String(c) })
  child.stdin.once('error', (err) => {
    client.close(bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err), code: err?.code }))
  })

  // If the process dies, pending requests are woken up immediately. Without
  // this, auth failures and crashes get misclassified as timeouts, and finding out takes timeoutMs.
  const exited = new Promise((resolve) => {
    child.on('close', (code) => {
      client.close(bridgeError(CODES.PROTOCOL, { reason: 'kiro-cli exited', exitCode: code }))
      resolve(code)
    })
    child.on('error', (err) => {
      client.close(bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) }))
      resolve(-1)
    })
  })

  let sessionId = existingSessionId
  const timer = setTimeout(() => {
    timedOut = true
    client.close(bridgeError(CODES.TIMEOUT))
    terminate()
  }, timeoutMs)

  const onAbort = () => {
    if (sessionId) client.notify('session/cancel', { sessionId })
    client.close(bridgeError(CODES.CANCELLED, { sessionId }))
    terminate()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  try {
    await client.request('initialize', initializeParams())

    if (sessionId) {
      await client.request('session/load', { sessionId, cwd })
    } else {
      const created = await client.request('session/new', { cwd, mcpServers: [] })
      sessionId = created?.sessionId
      if (!sessionId) throw bridgeError(CODES.PROTOCOL, { reason: 'session/new returned no sessionId' })
    }

    // The payload is always passed as the prompt body (ADR-003 decision 4).
    const promptResult = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: JSON.stringify(payload) }],
    })

    if (signal?.aborted) throw bridgeError(CODES.CANCELLED, { sessionId })

    // If a tool denial is detected, revoke trust in findings and promote to an error (design §8).
    if (collector.denied) {
      throw bridgeError(CODES.TOOL_DENIED, { sessionId, denials: collector.denials })
    }

    const classified = classifyOutput(`${collector.text}\n${stderr}`)
    if (classified) throw bridgeError(classified, { sessionId, stderr })

    return {
      sessionId,
      transport: 'acp',
      result: collector.text,
      stopReason: promptResult?.stopReason,
      metadata: collector.metadata,
    }
  } catch (err) {
    if (timedOut) {
      throw bridgeError(CODES.TIMEOUT, { sessionId, partial: collector.text })
    }
    if (signal?.aborted) throw bridgeError(CODES.CANCELLED, { sessionId })
    const classified = classifyOutput(stderr)
    if (classified) throw bridgeError(classified, { sessionId, stderr })
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    client.close()
    try { child.stdin.end() } catch {}
    terminate()
    await exited
    if (forceKillTimer) clearTimeout(forceKillTimer)
  }
}
