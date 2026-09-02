// Config/capability cache. All state lives under ~/.kiro-bridge/ (design §3).
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const DEFAULTS = {
  version: 1,
  // kiro-cli version -> capability detection result. Naturally invalidated when the version changes (ADR-001R).
  capabilities: {},
  redaction: {
    // Outbound protection (design §7). The user can extend this in config.json.
    excludeFiles: [
      '.env', '.env.*', '*.pem', '*.key', '*credentials*',
      'id_rsa', 'id_ed25519', '*.p12', '*.pfx',
    ],
    privateHosts: [],
  },
  // Extra *exact* environment variable names to forward to kiro-cli child
  // processes, on top of the built-in allowlist (design §7). Opt-in only; no
  // wildcards. See scripts/lib/env.mjs. The hard denial floor there still
  // applies, so listing a denied name (e.g. AWS_*) has no effect.
  envPassthrough: [],
  logRetentionDays: 30,
}

export function bridgeHome() {
  return process.env.KIRO_BRIDGE_HOME || join(homedir(), '.kiro-bridge')
}

export function configPath() {
  return join(bridgeHome(), 'config.json')
}

// Project-level overlay. Kiro's own convention is a global/project pair —
// `~/.kiro/settings/*.json` mirrored by `.kiro/settings/*.json` in the repo
// (alongside `.kiro/agents/`, `.kiro/specs/`, `.kiro/steering/`) — so we live
// there rather than inventing a bridge-specific location.
export function projectConfigPath(cwd = process.cwd()) {
  return join(cwd, '.kiro', 'settings', 'kiro-bridge.json')
}

// The user-level config only. This is the layer saveConfig round-trips, so the
// capability cache must be written from here — never from the merged view, or
// a repository-local file would be promoted into the user's global config.
export function loadUserConfig() {
  let onDisk = {}
  try {
    onDisk = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    // Start from defaults if the file is missing or corrupted. Never fail here.
  }
  return {
    ...DEFAULTS,
    ...onDisk,
    redaction: { ...DEFAULTS.redaction, ...(onDisk.redaction || {}) },
    capabilities: { ...(onDisk.capabilities || {}) },
    // Only accept string entries; anything else is ignored so a malformed
    // config can never inject non-name values into the env allowlist.
    envPassthrough: Array.isArray(onDisk.envPassthrough)
      ? onDisk.envPassthrough.filter((v) => typeof v === 'string')
      : DEFAULTS.envPassthrough,
  }
}

export function loadProjectConfig(cwd = process.cwd()) {
  try {
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim() !== '') : []
}

// Merge the project layer into a user config.
//
// Strictly one-directional: a repository file may only *tighten* outbound
// protection. This matters because the file ships inside the repository, so
// for any repo you did not write yourself it is attacker-controlled input.
//
// Allowed: adding redaction.excludeFiles / redaction.privateHosts patterns.
// Ignored, deliberately:
//   - removing or replacing any default exclude pattern (union only)
//   - entropyThreshold / minSecretLength (raising them would weaken detection)
//   - envPassthrough (must never widen the child-process env allowlist)
//   - capabilities (the version cache is user-scoped state, not policy)
export function applyProjectConfig(config, project = {}) {
  const projectRedaction = project.redaction && typeof project.redaction === 'object'
    ? project.redaction
    : {}
  const added = {
    excludeFiles: stringList(projectRedaction.excludeFiles),
    privateHosts: stringList(projectRedaction.privateHosts),
  }
  if (added.excludeFiles.length === 0 && added.privateHosts.length === 0) return config
  return {
    ...config,
    redaction: {
      ...config.redaction,
      excludeFiles: [...new Set([...(config.redaction.excludeFiles || []), ...added.excludeFiles])],
      privateHosts: [...new Set([...(config.redaction.privateHosts || []), ...added.privateHosts])],
    },
  }
}

// The effective config for building outbound payloads: user layer plus the
// tightening-only project overlay.
export function loadConfig(cwd = process.cwd()) {
  return applyProjectConfig(loadUserConfig(), loadProjectConfig(cwd))
}

// Atomic save via tmpfile + rename. State files are 0600 (design §7).
export function saveConfig(config) {
  const target = configPath()
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`
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
