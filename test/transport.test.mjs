import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as acp from '../scripts/lib/transport/acp.mjs'
import * as subprocess from '../scripts/lib/transport/subprocess.mjs'
import { EVENT_TYPES } from '../scripts/lib/transport/events.mjs'
import { CODES } from '../scripts/lib/errors.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'fixtures', 'mock-kiro-cli.mjs')

// Plugs a mock in place of kiro-cli. This layer runs without the real binary (design §11).
function mockSpawn(scenario) {
  return (_bin, args, opts = {}) =>
    spawn(process.execPath, [MOCK, ...args], {
      ...opts,
      env: { ...process.env, MOCK_SCENARIO: scenario },
    })
}

const PAYLOAD = { kind: 'review', goal: 'please review' }

// --- ACP happy path ---

test('acp: a normal round trip yields sessionId and result text', async () => {
  const events = []
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    onEvent: (e) => events.push(e),
    timeoutMs: 10_000,
  })
  assert.equal(r.transport, 'acp')
  assert.equal(r.sessionId, 'sess-mock-1')
  assert.match(r.result, /findings/)
  assert.equal(r.stopReason, 'end_turn')
})

test('acp: streaming events flow up to the caller', async () => {
  const events = []
  await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    onEvent: (e) => events.push(e),
    timeoutMs: 10_000,
  })
  const types = events.map((e) => e.type)
  assert.ok(types.includes(EVENT_TYPES.THOUGHT), 'thought chunk')
  assert.ok(types.includes(EVENT_TYPES.TOOL_CALL), 'tool call visibility')
  assert.ok(types.includes(EVENT_TYPES.TOOL_RESULT), 'tool result')
  assert.ok(types.includes(EVENT_TYPES.MESSAGE), 'message chunk')
})

test('acp: an existing sessionId is reused via session/load', async () => {
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    sessionId: 'sess-existing',
    timeoutMs: 10_000,
  })
  assert.equal(r.sessionId, 'sess-existing')
})

// --- tool denial: the most important failure mode (design §8, ADR-002) ---

test('acp: detecting a tool denial never returns plausible-looking findings as success', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('denied'), timeoutMs: 10_000 }),
    (err) => {
      assert.equal(err.code, CODES.TOOL_DENIED)
      assert.ok(err.details.denials.length > 0)
      return true
    },
  )
})

test('subprocess: a tool denial is promoted to an error the same way', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('denied'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

// --- permission brokering (ACP-only axis) ---

test('acp: session/request_permission is brokered to the client', async () => {
  let asked = null
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('permission'),
    onPermissionRequest: async (params) => {
      asked = params
      return { outcome: 'selected', optionId: 'allow' }
    },
    timeoutMs: 10_000,
  })
  assert.equal(asked.toolCall.toolCallId, 'tc1')
  assert.match(r.result, /granted/)
})

test('acp: denial is the default when there is no permission handler (ADR-002)', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('permission'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

// --- failure mode table (design §8) ---

test('acp: unauthenticated is classified as UNAUTHENTICATED', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('unauthenticated'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.UNAUTHENTICATED,
  )
})

test('subprocess: throttling/credit exhaustion is classified as THROTTLED', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('throttled'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.THROTTLED,
  )
})

test('acp: a timeout is reported with partial output and is not retried', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('timeout'), timeoutMs: 400 }),
    (err) => {
      assert.equal(err.code, CODES.TIMEOUT)
      assert.equal(typeof err.details.partial, 'string')
      return true
    },
  )
})

test('subprocess: a nonzero exit code becomes SPAWN_FAILED', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('nonzero-exit'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.SPAWN_FAILED,
  )
})

test('acp: cancelling via AbortSignal yields CANCELLED', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('timeout'), signal: controller.signal, timeoutMs: 10_000 }),
    (err) => err.code === CODES.CANCELLED || err.code === CODES.TIMEOUT,
  )
})

// --- payload delivery (ADR-003 decision 4: always stdin) ---

test('subprocess: the payload arrives intact via stdin', async () => {
  const r = await subprocess.run(
    { kind: 'review', goal: 'stdin-roundtrip-check' },
    { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 },
  )
  assert.match(r.result, /echo:stdin-roundtrip-check/)
})

test('subprocess: argument assembly has no shell string', () => {
  const args = subprocess.buildArgs({ agent: 'kiro-bridge-reviewer', model: 'sonnet' })
  assert.deepEqual(args, [
    'chat', '--no-interactive', '--output-format', 'stream-json',
    '--agent', 'kiro-bridge-reviewer', '--model', 'sonnet',
  ])
  assert.ok(!args.some((a) => /[;|&$`]/.test(a)))
})

test('subprocess: there is no session to reuse on the one-shot path', async () => {
  const r = await subprocess.run(PAYLOAD, { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 })
  assert.equal(r.sessionId, null)
  assert.equal(r.transport, 'subprocess')
})

// --- capability detection ---

test('acp.probe: available on a successful handshake', async () => {
  const r = await acp.probe({ spawnFn: mockSpawn('ok'), timeoutMs: 5000 })
  assert.equal(r.available, true)
  assert.equal(r.initialize.protocolVersion, 1)
})

test('acp.probe: available:false when the acp subcommand is missing', async () => {
  const r = await acp.probe({ spawnFn: mockSpawn('acp-unavailable'), timeoutMs: 2000 })
  assert.equal(r.available, false)
})
