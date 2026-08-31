import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectVersion, detectCapability, TRANSPORTS } from '../scripts/lib/transport/index.mjs'
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

// execFile 스텁: (bin, args, opts, cb)
const versionOk = (_b, _a, _o, cb) => cb(null, 'kiro-cli 2.20.1\n', '')
const versionMissing = (_b, _a, _o, cb) => cb(new Error('ENOENT'), '', '')

// --- 설정 저장 ---

test('config: 저장 후 다시 읽으면 값이 보존된다', () => {
  const saved = saveConfig({ ...loadConfig(), logRetentionDays: 7 })
  assert.ok(existsSync(saved))
  assert.equal(loadConfig().logRetentionDays, 7)
})

test('config: 깨진 JSON 은 기본값으로 폴백하고 던지지 않는다', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(home, { recursive: true })
  writeFileSync(configPath(), '{ not json')
  const config = loadConfig()
  assert.equal(config.version, 1)
  assert.ok(Array.isArray(config.redaction.excludeFiles))
})

test('config: 사용자 redaction 설정이 기본값과 병합된다', () => {
  saveConfig({ ...loadConfig(), redaction: { privateHosts: ['.internal.corp'] } })
  const config = loadConfig()
  assert.deepEqual(config.redaction.privateHosts, ['.internal.corp'])
  assert.ok(config.redaction.excludeFiles.includes('*.pem'), '기본 제외 목록이 살아있어야 한다')
})

// --- 버전 감지 ---

test('detectVersion: 출력에서 semver 를 뽑는다', async () => {
  assert.equal(await detectVersion({ execFileFn: versionOk }), '2.20.1')
})

test('detectVersion: 바이너리가 없으면 null', async () => {
  assert.equal(await detectVersion({ execFileFn: versionMissing }), null)
})

// --- 능력 감지 + 캐시 ---

test('detectCapability: ACP 핸드셰이크 성공 → acp 선택', async () => {
  const r = await detectCapability({
    execFileFn: versionOk,
    probeFn: async () => ({ available: true }),
  })
  assert.equal(r.transport, TRANSPORTS.ACP)
  assert.equal(r.version, '2.20.1')
  assert.equal(r.cached, false)
})

test('detectCapability: 핸드셰이크 실패 → subprocess 폴백', async () => {
  const r = await detectCapability({
    execFileFn: versionOk,
    probeFn: async () => ({ available: false, reason: 'no acp subcommand' }),
  })
  assert.equal(r.transport, TRANSPORTS.SUBPROCESS)
  assert.match(r.reason, /no acp subcommand/)
})

test('detectCapability: 두 번째 호출은 캐시를 쓰고 probe 를 다시 띄우지 않는다', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }

  const first = await detectCapability({ execFileFn: versionOk, probeFn })
  const second = await detectCapability({ execFileFn: versionOk, probeFn })

  assert.equal(probes, 1, '핸드셰이크 프로세스를 매 호출 띄우면 안 된다')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.transport, TRANSPORTS.ACP)
})

test('detectCapability: 버전이 바뀌면 캐시가 자연히 무효화된다', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }
  const v221 = (_b, _a, _o, cb) => cb(null, 'kiro-cli 2.21.0\n', '')

  await detectCapability({ execFileFn: versionOk, probeFn })
  const next = await detectCapability({ execFileFn: v221, probeFn })

  assert.equal(probes, 2)
  assert.equal(next.cached, false)
  assert.equal(next.version, '2.21.0')

  // 두 버전의 감지 결과가 각각 남아있다
  const config = loadConfig()
  assert.ok(getCachedCapability(config, '2.20.1'))
  assert.ok(getCachedCapability(config, '2.21.0'))
})

test('detectCapability: force 는 캐시를 무시한다', async () => {
  let probes = 0
  const probeFn = async () => { probes += 1; return { available: true } }
  await detectCapability({ execFileFn: versionOk, probeFn })
  const forced = await detectCapability({ execFileFn: versionOk, probeFn, force: true })
  assert.equal(probes, 2)
  assert.equal(forced.cached, false)
})

test('detectCapability: kiro-cli 가 없으면 TRANSPORT_UNAVAILABLE', async () => {
  await assert.rejects(
    detectCapability({ execFileFn: versionMissing, probeFn: async () => ({ available: true }) }),
    (err) => err.code === CODES.TRANSPORT_UNAVAILABLE,
  )
})
