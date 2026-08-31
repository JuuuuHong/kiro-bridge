// 설정·능력 캐시. 상태는 모두 ~/.kiro-bridge/ 하위에 둔다 (설계 §3).
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'

const DEFAULTS = {
  version: 1,
  // kiro-cli 버전 → 능력 감지 결과. 버전이 바뀌면 자연히 무효화된다 (ADR-001R).
  capabilities: {},
  redaction: {
    // 아웃바운드 방어 (설계 §7). 사용자가 config.json에서 확장할 수 있다.
    excludeFiles: [
      '.env', '.env.*', '*.pem', '*.key', '*credentials*',
      'id_rsa', 'id_ed25519', '*.p12', '*.pfx',
    ],
    privateHosts: [],
  },
  logRetentionDays: 30,
}

export function bridgeHome() {
  return process.env.KIRO_BRIDGE_HOME || join(homedir(), '.kiro-bridge')
}

export function configPath() {
  return join(bridgeHome(), 'config.json')
}

export function loadConfig() {
  let onDisk = {}
  try {
    onDisk = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    // 없거나 깨졌으면 기본값으로 시작한다. 여기서 실패시키지 않는다.
  }
  return {
    ...DEFAULTS,
    ...onDisk,
    redaction: { ...DEFAULTS.redaction, ...(onDisk.redaction || {}) },
    capabilities: { ...(onDisk.capabilities || {}) },
  }
}

// 임시파일 + rename 으로 원자적 저장. 상태 파일은 0600 (설계 §7).
export function saveConfig(config) {
  const target = configPath()
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return target
}

export function getCachedCapability(config, kiroVersion) {
  if (!kiroVersion) return null
  return config.capabilities[kiroVersion] || null
}

export function setCachedCapability(config, kiroVersion, capability) {
  if (!kiroVersion) return config
  return {
    ...config,
    capabilities: { ...config.capabilities, [kiroVersion]: capability },
  }
}

export { DEFAULTS as CONFIG_DEFAULTS }
