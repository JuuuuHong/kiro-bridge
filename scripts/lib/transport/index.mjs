// transport 선택. 상위 계층은 이 파일의 run() 만 안다 (ADR-001R).
//
// 능력 감지는 kiro-cli 버전을 키로 캐시한다 — 매 호출마다 핸드셰이크
// 프로세스를 띄우지 않기 위해서다. 버전이 바뀌면 키가 달라져 자연히 무효화된다.
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

// 캐시 우선. 없으면 ACP 핸드셰이크를 1회 시도하고 결과를 적어둔다.
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
    // 캐시 저장 실패는 치명적이지 않다. 다음 호출에서 다시 감지한다.
  }
  return { ...capability, version, cached: false }
}

// payload 를 실행한다. transport 를 명시하면 감지를 건너뛴다.
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
