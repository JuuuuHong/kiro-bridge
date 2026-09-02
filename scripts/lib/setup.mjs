// /kiro:setup — install check, capability detection, agent install + validate.
//
// Passing validate is required (design §6). Installing an agent that fails
// validate means reviews silently hit tool denial — exactly the failure ADR-002 exists to prevent.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

import { detectVersion, detectCapability, TRANSPORTS } from './transport/index.mjs'
import { AGENT_DEFS, probeToolNaming, installAgent, agentsDir } from './agents.mjs'
import { loadConfig } from './config.mjs'
import { childEnvFromConfig } from './env.mjs'
import { classifyOutput, CODES } from './errors.mjs'

function execKiro(bin, args, { execFileFn = execFile, config = loadConfig() } = {}) {
  return new Promise((resolve, reject) => {
    execFileFn(bin, args, { timeout: 15_000, env: childEnvFromConfig(config) }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`
      if (err) return reject(Object.assign(new Error(out || err.message), { output: out }))
      resolve(String(stdout || ''))
    })
  })
}

export async function checkAuth(options = {}) {
  const { bin = 'kiro-cli' } = options
  try {
    const out = await execKiro(bin, ['whoami'], options)
    return { authenticated: true, detail: out.trim() }
  } catch (err) {
    const code = classifyOutput(err.output || err.message) || CODES.UNAUTHENTICATED
    return { authenticated: false, code, detail: (err.output || err.message).trim() }
  }
}

export async function setup(options = {}) {
  const { bin = 'kiro-cli', force = false, dir = agentsDir() } = options
  const steps = []

  const version = await detectVersion({ bin, ...options })
  steps.push({ step: 'version', ok: Boolean(version), detail: version || 'kiro-cli was not found' })
  if (!version) {
    return { ok: false, steps, hint: 'Install kiro-cli and run again.' }
  }

  const auth = await checkAuth({ bin, ...options })
  steps.push({ step: 'auth', ok: auth.authenticated, detail: auth.detail })
  if (!auth.authenticated) {
    return { ok: false, steps, hint: 'Run `kiro-cli login` and try again.' }
  }

  let capability = null
  try {
    capability = await detectCapability({ bin, force, ...options })
    steps.push({
      step: 'transport',
      ok: true,
      detail: `${capability.transport} (${capability.cached ? 'cached' : capability.reason})`,
    })
  } catch (err) {
    capability = {
      transport: TRANSPORTS.SUBPROCESS,
      reason: `ACP probe failed: ${String(err?.message || err)}`,
      cached: false,
    }
    steps.push({
      step: 'transport',
      ok: true,
      detail: `${capability.transport} fallback (${capability.reason})`,
      warning: true,
    })
  }

  // Install agents — resolve the tool naming convention by probing with validate (OQ4).
  const scratch = mkdtempSync(join(tmpdir(), 'kiro-bridge-agent-'))
  const installed = []
  let resolvedToolNaming = null
  try {
    for (const [key, def] of Object.entries(AGENT_DEFS)) {
      const probe = await probeToolNaming(def, {
        tmpPath: join(scratch, `${def.name}.json`),
        validateFn: (path) =>
          options.validateFn
            ? options.validateFn(path)
            : execKiro(bin, ['agent', 'validate', '--path', path], options),
      })

      if (!probe.toolSet) {
        steps.push({
          step: `agent:${key}`,
          ok: false,
          detail: `validate failed — attempted: ${probe.attempts.map((a) => a.toolSet).join(', ')}`,
          attempts: probe.attempts,
        })
        continue
      }

      const result = installAgent(probe.rendered, { dir, force })
      installed.push({ key, toolSet: probe.toolSet, ...result })
      // A 'skipped' install is a deliberate non-overwrite (user-modified or
      // unmanaged file), not a setup failure — surface it as a warning so it
      // stays visible without turning a working install into exit code 1.
      steps.push({
        step: `agent:${key}`,
        ok: true,
        ...(result.action === 'skipped' ? { warning: true } : {}),
        detail: `${result.action} (tool convention: ${probe.toolSet}) -> ${result.target}${result.reason ? ` — ${result.reason}` : ''}`,
      })

      resolvedToolNaming = probe.toolSet
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  // The resolved convention is stamped per-agent into each installed file's
  // _kiroBridge.toolSet (read back by installAgent), so there is no separate
  // config key to keep in sync.
  return { ok: steps.every((s) => s.ok), steps, installed, capability, toolNaming: resolvedToolNaming }
}

export function formatSetup(result) {
  const mark = (s) => {
    if (!s.ok) return '✗'
    return s.warning ? '!' : '✓'
  }
  const lines = result.steps.map((s) => `${mark(s)} ${s.step}: ${s.detail}`)
  if (result.hint) lines.push('', result.hint)
  return lines.join('\n')
}
