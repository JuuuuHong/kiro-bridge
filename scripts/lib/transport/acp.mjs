// Primary transport: kiro-cli acp (stdio JSON-RPC). ADR-001R.
//
// What this path uniquely gives us: streaming, cancellation, session reuse,
// and permission brokering. The core piece is mediating session/request_permission through Claude Code's judgment.
import { spawn } from 'node:child_process'
import { JsonRpcClient } from './jsonrpc.mjs'
import { normalizeAcpUpdate, normalizeKiroMetadata, createCollector, EVENT_TYPES } from './events.mjs'
import { bridgeError, classifyOutput, CODES } from '../errors.mjs'

export const PROTOCOL_VERSION = 1

// Validates an initialize response against our expected protocol version.
// Returns { ok, reason, agentCapabilities }. Never throws.
export function validateInitialize(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'initialize returned no result object' }
  }
  const pv = result.protocolVersion
  if (pv !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocolVersion mismatch: expected ${PROTOCOL_VERSION}, got ${pv === undefined ? 'undefined' : JSON.stringify(pv)}`,
    }
  }
  const agentCapabilities =
    result.agentCapabilities && typeof result.agentCapabilities === 'object' && !Array.isArray(result.agentCapabilities)
      ? result.agentCapabilities
      : {}
  return { ok: true, agentCapabilities }
}

// Maps a prompt stopReason to a terminal disposition.
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
            ? 'session/prompt returned no stopReason'
            : `unknown stopReason: ${JSON.stringify(stopReason)}`,
      }
  }
}

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
    const validation = validateInitialize(result)
    if (!validation.ok) {
      return { available: false, reason: validation.reason }
    }
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
      if (msg.method !== 'session/update') return
      const params = msg.params || {}
      // Always preserve the normal, spec-shaped update event.
      emit(normalizeAcpUpdate(params.update))
      // Additionally emit a single bounded metadata event when a valid
      // contextUsagePercentage is present — whether it arrived as the custom
      // '_kiro.dev/metadata' update or attached as _meta on params/update.
      // normalizeKiroMetadata returns at most one event, so there is never a
      // duplicate metadata emission for the custom metadata update.
      const metaEvent = normalizeKiroMetadata(params)
      if (metaEvent) emit(metaEvent)
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
    const initResult = await client.request('initialize', initializeParams())
    const validation = validateInitialize(initResult)
    if (!validation.ok) {
      throw bridgeError(CODES.PROTOCOL, { reason: validation.reason, details: initResult })
    }
    const agentCapabilities = validation.agentCapabilities

    if (sessionId) {
      // Never silently create a contextless new session in place of a requested
      // reuse. If the agent can't load sessions, fail clearly.
      if (agentCapabilities.loadSession !== true) {
        throw bridgeError(CODES.PROTOCOL, {
          reason: 'session reuse requested but agent does not support session/load (agentCapabilities.loadSession !== true)',
          sessionId,
        })
      }
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

    // Auth/throttle classification is driven strictly by process diagnostics
    // (stderr), never by collector/model text — a clean successful agent
    // message may legitimately contain phrases like "unauthorized" or "rate
    // limit" and must not be misclassified as a failure (F1). Structural denial
    // events above remain authoritative.
    const classified = classifyOutput(stderr)
    if (classified) throw bridgeError(classified, { sessionId, stderr })

    // Non-success stop reasons cannot be trusted as finished results.
    const stop = classifyStopReason(promptResult?.stopReason)
    if (!stop.ok) {
      throw bridgeError(stop.code, {
        sessionId,
        stopReason: stop.stopReason,
        partial: collector.text,
        ...(stop.reason ? { reason: stop.reason } : {}),
      })
    }

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
