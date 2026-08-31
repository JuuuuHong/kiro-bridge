// /kiro:setup — 설치 확인, 능력 감지, 에이전트 설치 + validate.
//
// validate 통과는 필수다 (설계 §6). 통과하지 못한 에이전트를 설치해두면
// 리뷰가 조용히 툴 거부를 맞고, 그게 바로 ADR-002 가 막으려는 실패다.
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
  steps.push({ step: 'version', ok: Boolean(version), detail: version || 'kiro-cli 를 찾지 못했습니다' })
  if (!version) {
    return { ok: false, steps, hint: 'kiro-cli 설치 후 다시 실행하세요.' }
  }

  const auth = await checkAuth({ bin, ...options })
  steps.push({ step: 'auth', ok: auth.authenticated, detail: auth.detail })
  if (!auth.authenticated) {
    return { ok: false, steps, hint: '`kiro-cli login` 을 실행한 뒤 다시 시도하세요.' }
  }

  let capability = null
  try {
    capability = await detectCapability({ bin, force, ...options })
    steps.push({
      step: 'transport',
      ok: true,
      detail: `${capability.transport} (${capability.cached ? '캐시' : capability.reason})`,
    })
  } catch (err) {
    steps.push({ step: 'transport', ok: false, detail: String(err?.message || err) })
  }

  // 에이전트 설치 — tool 명명 규약을 validate 로 탐침해 확정한다 (OQ4).
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
          detail: `validate 실패 — 시도: ${probe.attempts.map((a) => a.toolSet).join(', ')}`,
          attempts: probe.attempts,
        })
        continue
      }

      const result = installAgent(probe.rendered, { dir, force })
      installed.push({ key, toolSet: probe.toolSet, ...result })
      steps.push({
        step: `agent:${key}`,
        ok: result.action !== 'skipped',
        detail: `${result.action} (tool 규약: ${probe.toolSet}) → ${result.target}${result.reason ? ` — ${result.reason}` : ''}`,
      })

      // 확정된 명명 규약을 기록해 다음 실행에서 재탐침하지 않는다.
      const config = loadConfig()
      try {
        saveConfig({ ...config, toolNaming: probe.toolSet })
      } catch {
        // 기록 실패는 치명적이지 않다.
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
