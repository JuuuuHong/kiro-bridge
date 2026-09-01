// Transport selection. Upper layers only know this file's run() (ADR-001R).
//
// Capability detection caches keyed by kiro-cli version — this avoids
// spawning a handshake process on every call. A version change gives a different key, invalidating it naturally.
import { execFile, spawn } from 'node:child_process'
import * as acp from './acp.mjs'
import * as subprocess from './subprocess.mjs'
import { loadConfig, saveConfig, getCachedCapability, setCachedCapability } from '../config.mjs'
import { bridgeError, CODES } from '../errors.mjs'

export const TRANSPORTS = { ACP: 'acp', SUBPROCESS: 'subprocess' }

export function detectVersion({ bin = 'kiro-cli', execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    execFileFn(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const match = String(stdout).match(/(\d+\.\d+\.\d+)/)
      resolve(match ? match[1] : String(stdout).trim() || null)
    })
  })
}

// Cache-first. If absent, try one ACP handshake and record the result.
export async function detectCapability(options = {}) {
  const { bin = 'kiro-cli', force = false, probeFn = acp.probe } = options

  const version = await detectVersion(options)
  if (!version) {
    throw bridgeError(CODES.TRANSPORT_UNAVAILABLE, { bin })
  }

  const config = loadConfig()
  if (!force) {
    const cached = getCachedCapability(config, version)
    if (cached?.transport) return { ...cached, version, cached: true }
  }

  const probed = await probeFn({ bin })
  const capability = {
    transport: probed.available ? TRANSPORTS.ACP : TRANSPORTS.SUBPROCESS,
    reason: probed.available ? 'acp handshake ok' : probed.reason || 'acp unavailable',
    detectedAt: new Date().toISOString(),
  }

  try {
    saveConfig(setCachedCapability(config, version, capability))
  } catch {
    // Cache save failure is not fatal. It's detected again on the next call.
  }
  return { ...capability, version, cached: false }
}

// Runs the payload. Specifying transport skips detection.
export async function run(payload, options = {}) {
  const { transport: forced, ...rest } = options
  let chosen = forced

  if (!chosen) {
    const capability = await detectCapability(rest)
    chosen = capability.transport
  }

  if (chosen === TRANSPORTS.ACP) {
    return acp.run(payload, rest)
  }
  if (chosen === TRANSPORTS.SUBPROCESS) {
    return subprocess.run(payload, rest)
  }
  throw bridgeError(CODES.TRANSPORT_UNAVAILABLE, { transport: chosen })
}

export { acp, subprocess, spawn }
