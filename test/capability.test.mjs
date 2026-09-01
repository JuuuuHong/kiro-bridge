import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectVersion, detectCapability, TRANSPORTS, NEGATIVE_CACHE_TTL_MS,
} from '../scripts/lib/transport/index.mjs'
import { loadConfig, saveConfig, configPath, getCachedCapability } from '../scripts/lib/config.mjs'
import { CODES } from '../scripts/lib/errors.mjs'

let home
const original = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-test-'))
  process.env.KIRO_BRIDGE_HOME = home
})

afterEach(() => {
  if (original === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = original
  rmSync(home, { recursive: true, force: true })
})

// execFile stub: (bin, args, opts, cb)
const versionOk = (_b, _a, _o, cb) => cb(null, 'kiro-cli 2.20.1\n', '')
const versionMissing = (_b, _a, _o, cb) => cb(new Error('ENOENT'), '', '')

// --- config persistence ---

test('config: a value survives save then reload', () => {
  const saved = saveConfig({ ...loadConfig(), logRetentionDays: 7 })
  assert.ok(existsSync(saved))
  assert.equal(loadConfig().logRetentionDays, 7)
})

test('config: falls back to defaults on broken JSON, never throws', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(home, { recursive: true })
  writeFileSync(configPath(), '{ not json')
  const config = loadConfig()
  assert.equal(config.version, 1)
  assert.ok(Array.isArray(config.redaction.excludeFiles))
})

test('config: user redaction settings are merged with the defaults', () => {
  saveConfig({ ...loadConfig(), redaction: { privateHosts: ['.internal.corp'] } })
  const config = loadConfig()
  assert.deepEqual(config.redaction.privateHosts, ['.internal.corp'])
  assert.ok(config.redaction.excludeFiles.includes('*.pem'), 'the default exclude list must still be present')
})

// --- version detection ---

test('detectVersion: extracts semver from the output', async () => {
  assert.equal(await detectVersion({ execFileFn: versionOk }), '2.20.1')
})

test('detectVersion: null when the binary is missing', async () => {
  assert.equal(await detectVersion({ execFileFn: versionMissing }), null)
})

// --- capability detection + cache ---

test('detectCapability: a successful ACP handshake -> chooses acp', async () => {
  const r = await detectCapability({
    execFileFn: versionOk,
    probeFn: async () => ({ available: true }),
  })
  assert.equal(r.transport, TRANSPORTS.ACP)
  assert.equal(r.version, '2.20.1')
  assert.equal(r.cached, false)
})

test('detectCapability: a failed handshake -> falls back to subprocess', async () => {
  const r = await detectCapability({
    execFileFn: versionOk,
    probeFn: async () => ({ available: false, reason: 'no acp subcommand' }),
  })
  assert.equal(r.transport, TRANSPORTS.SUBPROCESS)
  assert.match(r.reason, /no acp subcommand/)
})

test('detectCapability: the second call uses the cache and never re-runs probe', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }

  const first = await detectCapability({ execFileFn: versionOk, probeFn })
  const second = await detectCapability({ execFileFn: versionOk, probeFn })

  assert.equal(probes, 1, 'must not spawn a handshake process on every call')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.transport, TRANSPORTS.ACP)
})

test('detectCapability: the cache naturally invalidates when the version changes', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }
  const v221 = (_b, _a, _o, cb) => cb(null, 'kiro-cli 2.21.0\n', '')

  await detectCapability({ execFileFn: versionOk, probeFn })
  const next = await detectCapability({ execFileFn: v221, probeFn })

  assert.equal(probes, 2)
  assert.equal(next.cached, false)
  assert.equal(next.version, '2.21.0')

  // Detection results for both versions remain in the cache
  const config = loadConfig()
  assert.ok(getCachedCapability(config, '2.20.1'))
  assert.ok(getCachedCapability(config, '2.21.0'))
})

test('detectCapability: force ignores the cache', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }
  await detectCapability({ execFileFn: versionOk, probeFn })
  const forced = await detectCapability({ execFileFn: versionOk, probeFn, force: true })
  assert.equal(probes, 2)
  assert.equal(forced.cached, false)
})

test('detectCapability: TRANSPORT_UNAVAILABLE when kiro-cli is missing', async () => {
  await assert.rejects(
    detectCapability({ execFileFn: versionMissing, probeFn: async () => ({ available: true }) }),
    (err) => err.code === CODES.TRANSPORT_UNAVAILABLE,
  )
})


test('detectCapability: a negative cache expires and ACP is probed again', async () => {
  let probes = 0
  const probeFn = async () => {
    probes += 1
    return probes === 1
      ? { available: false, reason: 'temporary failure' }
      : { available: true }
  }
  const base = Date.now()
  const first = await detectCapability({ execFileFn: versionOk, probeFn, now: base })
  const cached = await detectCapability({
    execFileFn: versionOk, probeFn, now: base + NEGATIVE_CACHE_TTL_MS - 1,
  })
  const recovered = await detectCapability({
    execFileFn: versionOk, probeFn, now: base + NEGATIVE_CACHE_TTL_MS + 1,
  })

  assert.equal(first.transport, TRANSPORTS.SUBPROCESS)
  assert.equal(cached.cached, true)
  assert.equal(recovered.transport, TRANSPORTS.ACP)
  assert.equal(recovered.cached, false)
  assert.equal(probes, 2)
})
