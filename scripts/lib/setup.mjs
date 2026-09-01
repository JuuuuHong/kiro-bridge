// /kiro:setup — install check, capability detection, agent install + validate.
//
// Passing validate is required (design §6). Installing an agent that fails
// validate means reviews silently hit tool denial — exactly the failure ADR-002 exists to prevent.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

import { detectVersion, detectCapability } from './transport/index.mjs'
import { AGENT_DEFS, probeToolNaming, installAgent, agentsDir } from './agents.mjs'
import { loadConfig, saveConfig } from './config.mjs'
import { classifyOutput, CODES } from './errors.mjs'

function execKiro(bin, args, { execFileFn = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileFn(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => {
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
    steps.push({ step: 'transport', ok: false, detail: String(err?.message || err) })
  }

  // Install agents — resolve the tool naming convention by probing with validate (OQ4).
  const scratch = mkdtempSync(join(tmpdir(), 'kiro-bridge-agent-'))
  const installed = []
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
      steps.push({
        step: `agent:${key}`,
        ok: result.action !== 'skipped',
        detail: `${result.action} (tool convention: ${probe.toolSet}) -> ${result.target}${result.reason ? ` — ${result.reason}` : ''}`,
      })

      // Record the resolved naming convention so the next run doesn't re-probe.
      const config = loadConfig()
      try {
        saveConfig({ ...config, toolNaming: probe.toolSet })
      } catch {
        // Failure to record is not fatal.
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  return { ok: steps.every((s) => s.ok), steps, installed, capability }
}

export function formatSetup(result) {
  const lines = result.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`)
  if (result.hint) lines.push('', result.hint)
  return lines.join('\n')
}
