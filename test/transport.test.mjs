import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as acp from '../scripts/lib/transport/acp.mjs'
import * as subprocess from '../scripts/lib/transport/subprocess.mjs'
import { EVENT_TYPES, normalizeAcpUpdate, normalizeKiroMetadata, createCollector } from '../scripts/lib/transport/events.mjs'
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
  assert.ok(types.includes(EVENT_TYPES.USAGE), 'usage update')
  assert.ok(types.includes(EVENT_TYPES.PLAN), 'plan update')
})

test('acp: an existing sessionId is reused via session/load', async () => {
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    sessionId: 'sess-existing',
    timeoutMs: 10_000,
  })
  assert.equal(r.sessionId, 'sess-existing')
})

// --- ACP conformance: protocol version + capabilities + stopReason ---

test('acp.run: protocol version mismatch throws PROTOCOL with a reason', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('protocol-mismatch'), timeoutMs: 10_000 }),
    (err) => {
      assert.equal(err.code, CODES.PROTOCOL)
      assert.match(err.details.reason, /protocolVersion mismatch/)
      return true
    },
  )
})

test('acp.probe: protocol version mismatch yields available:false', async () => {
  const r = await acp.probe({ spawnFn: mockSpawn('protocol-mismatch'), timeoutMs: 5000 })
  assert.equal(r.available, false)
  assert.match(r.reason, /protocolVersion mismatch/)
})

test('acp.run: session reuse fails clearly when loadSession is unsupported', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('load-unsupported'), sessionId: 'sess-x', timeoutMs: 10_000 }),
    (err) => {
      assert.equal(err.code, CODES.PROTOCOL)
      assert.match(err.details.reason, /loadSession/)
      return true
    },
  )
})

test('acp.run: end_turn succeeds (baseline for stopReason handling)', async () => {
  const r = await acp.run(PAYLOAD, { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 })
  assert.equal(r.stopReason, 'end_turn')
})

for (const [scenario, code] of [
  ['stop-max-tokens', CODES.INCOMPLETE],
  ['stop-max-turns', CODES.INCOMPLETE],
  ['stop-refusal', CODES.REFUSED],
  ['stop-cancelled', CODES.CANCELLED],
  ['stop-unknown', CODES.PROTOCOL],
  ['stop-missing', CODES.PROTOCOL],
]) {
  test(`acp.run: stopReason ${scenario} → ${code} with partial`, async () => {
    await assert.rejects(
      acp.run(PAYLOAD, { spawnFn: mockSpawn(scenario), timeoutMs: 10_000 }),
      (err) => {
        assert.equal(err.code, code)
        assert.equal(typeof err.details.partial, 'string')
        return true
      },
    )
  })
}

test('acp.classifyStopReason: pure mapping', () => {
  assert.equal(acp.classifyStopReason('end_turn').ok, true)
  assert.equal(acp.classifyStopReason('max_tokens').code, CODES.INCOMPLETE)
  assert.equal(acp.classifyStopReason('max_turn_requests').code, CODES.INCOMPLETE)
  assert.equal(acp.classifyStopReason('refusal').code, CODES.REFUSED)
  assert.equal(acp.classifyStopReason('cancelled').code, CODES.CANCELLED)
  assert.equal(acp.classifyStopReason(undefined).code, CODES.PROTOCOL)
  assert.equal(acp.classifyStopReason('nope').code, CODES.PROTOCOL)
})

test('acp.validateInitialize: rejects mismatched/malformed responses', () => {
  assert.equal(acp.validateInitialize({ protocolVersion: 1, agentCapabilities: { loadSession: true } }).ok, true)
  assert.equal(acp.validateInitialize({ protocolVersion: 2 }).ok, false)
  assert.equal(acp.validateInitialize(null).ok, false)
})

test('acp.run: usage and plan surface through metadata', async () => {
  const r = await acp.run(PAYLOAD, { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 })
  assert.equal(r.metadata.usage.used, 1200)
  assert.equal(r.metadata.usage.size, 100000)
  assert.equal(r.metadata.plan.entries.length, 2)
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


test('acp: timeout force-kills a child that ignores SIGTERM', async () => {
  const started = Date.now()
  await assert.rejects(
    acp.run(PAYLOAD, {
      spawnFn: mockSpawn('timeout-ignore-term'),
      timeoutMs: 100,
      terminationGraceMs: 50,
    }),
    (err) => err.code === CODES.TIMEOUT,
  )
  assert.ok(Date.now() - started < 1000, 'timeout must remain bounded')
})

test('subprocess: timeout force-kills a child that ignores SIGTERM', async () => {
  const started = Date.now()
  await assert.rejects(
    subprocess.run(PAYLOAD, {
      spawnFn: mockSpawn('timeout-ignore-term'),
      timeoutMs: 100,
      terminationGraceMs: 50,
    }),
    (err) => err.code === CODES.TIMEOUT,
  )
  assert.ok(Date.now() - started < 1000, 'timeout must remain bounded')
})

test('subprocess: early child exit turns stdin EPIPE into SPAWN_FAILED', async () => {
  await assert.rejects(
    subprocess.run(
      { kind: 'task', goal: 'x'.repeat(8 * 1024 * 1024) },
      {
        timeoutMs: 2000,
        spawnFn: (_bin, _args, opts) => spawn(process.execPath, ['-e', 'process.exit(0)'], opts),
      },
    ),
    (err) => err.code === CODES.SPAWN_FAILED && /stdin|pipe|write/i.test(err.details.cause),
  )
})


test('acp: a pre-aborted signal still force-terminates the child', async () => {
  const controller = new AbortController()
  controller.abort()
  const started = Date.now()
  await assert.rejects(
    acp.run(PAYLOAD, {
      spawnFn: mockSpawn('timeout-ignore-term'),
      signal: controller.signal,
      timeoutMs: 2000,
      terminationGraceMs: 50,
    }),
    (err) => err.code === CODES.CANCELLED,
  )
  assert.ok(Date.now() - started < 1000, 'pre-aborted cancellation must remain bounded')
})

// --- F1: auth/throttle classified only from stderr, never model/collector text ---

test('acp: a clean success message containing auth/throttle phrases still succeeds', async () => {
  const r = await acp.run(PAYLOAD, { spawnFn: mockSpawn('benign-keywords'), timeoutMs: 10_000 })
  assert.equal(r.transport, 'acp')
  assert.equal(r.stopReason, 'end_turn')
  assert.match(r.result, /unauthorized/)
  assert.match(r.result, /not logged in/)
  assert.match(r.result, /rate limit/)
  assert.match(r.result, /insufficient credits/)
})

test('subprocess: a clean success message containing auth/throttle phrases still succeeds', async () => {
  const r = await subprocess.run(PAYLOAD, { spawnFn: mockSpawn('benign-keywords'), timeoutMs: 10_000 })
  assert.equal(r.transport, 'subprocess')
  assert.match(r.result, /unauthorized/)
  assert.match(r.result, /not logged in/)
  assert.match(r.result, /rate limit/)
  assert.match(r.result, /insufficient credits/)
})

// --- events: usage / plan normalization + collector ---

test('events: usage_update normalizes cost to the official { amount, currency } object', () => {
  const e = normalizeAcpUpdate({
    sessionUpdate: 'usage_update', used: 10, size: 200,
    cost: { amount: 0.5, currency: 'usd' },
  })
  assert.deepEqual(e, {
    type: EVENT_TYPES.USAGE, used: 10, size: 200,
    cost: { amount: 0.5, currency: 'USD' },
  })
})

test('events: usage_update cost drops arbitrary fields and bounds a bad currency to null', () => {
  const e = normalizeAcpUpdate({
    sessionUpdate: 'usage_update',
    cost: { amount: 1.25, currency: 'not-a-code', evil: 'x', nested: { a: 1 } },
  })
  assert.deepEqual(e.cost, { amount: 1.25, currency: null })
})

test('events: usage_update tolerates a legacy numeric cost as { amount, currency: null }', () => {
  const e = normalizeAcpUpdate({ sessionUpdate: 'usage_update', cost: 0.5 })
  assert.deepEqual(e.cost, { amount: 0.5, currency: null })
})

test('events: usage_update tolerates aliases and missing fields', () => {
  const e = normalizeAcpUpdate({ sessionUpdate: 'usage_update', usedTokens: 7, contextSize: 99 })
  assert.equal(e.used, 7)
  assert.equal(e.size, 99)
  assert.equal(e.cost, null)
})

test('events: plan normalizes entries and is a full replacement', () => {
  const e = normalizeAcpUpdate({
    sessionUpdate: 'plan',
    entries: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }],
  })
  assert.equal(e.type, EVENT_TYPES.PLAN)
  assert.equal(e.entries.length, 2)
  assert.equal(e.entries[0].content, 'a')
})

test('events: collector exposes latest usage and plan through metadata', () => {
  const c = createCollector()
  c.push({ type: EVENT_TYPES.METADATA, meta: { contextUsagePercentage: 42 } })
  c.push(normalizeAcpUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 3, currency: 'USD' } }))
  c.push(normalizeAcpUpdate({ sessionUpdate: 'usage_update', used: 5, size: 6, cost: { amount: 7, currency: 'EUR' } }))
  c.push(normalizeAcpUpdate({ sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending' }] }))
  c.push(normalizeAcpUpdate({ sessionUpdate: 'plan', entries: [{ content: 'y', status: 'done' }, { content: 'z', status: 'done' }] }))
  const m = c.metadata
  assert.equal(m.contextUsagePercentage, 42)
  assert.deepEqual(m.usage, { used: 5, size: 6, cost: { amount: 7, currency: 'EUR' } })
  assert.equal(m.plan.entries.length, 2, 'plan is fully replaced, not appended')
})

test('events: collector metadata is null when nothing structured arrived', () => {
  const c = createCollector()
  c.push({ type: EVENT_TYPES.MESSAGE, text: 'hi' })
  assert.equal(c.metadata, null)
})

// --- F3: bounded Kiro context metadata normalization ---

test('normalizeKiroMetadata: custom _kiro.dev/metadata update', () => {
  const e = normalizeKiroMetadata({ update: { sessionUpdate: '_kiro.dev/metadata', contextUsagePercentage: 40 } })
  assert.deepEqual(e, { type: EVENT_TYPES.METADATA, contextUsagePercentage: 40 })
})

test('normalizeKiroMetadata: params._meta direct percentage', () => {
  const e = normalizeKiroMetadata({ update: { sessionUpdate: 'agent_message_chunk' }, _meta: { contextUsagePercentage: 55 } })
  assert.deepEqual(e, { type: EVENT_TYPES.METADATA, contextUsagePercentage: 55 })
})

test('normalizeKiroMetadata: params._meta nested _kiro.dev/metadata', () => {
  const e = normalizeKiroMetadata({ update: {}, _meta: { '_kiro.dev/metadata': { contextUsagePercentage: 66 } } })
  assert.deepEqual(e, { type: EVENT_TYPES.METADATA, contextUsagePercentage: 66 })
})

test('normalizeKiroMetadata: update._meta equivalents', () => {
  const direct = normalizeKiroMetadata({ update: { _meta: { contextUsagePercentage: 77 } } })
  assert.deepEqual(direct, { type: EVENT_TYPES.METADATA, contextUsagePercentage: 77 })
  const nested = normalizeKiroMetadata({ update: { _meta: { '_kiro.dev/metadata': { contextUsagePercentage: 88 } } } })
  assert.deepEqual(nested, { type: EVENT_TYPES.METADATA, contextUsagePercentage: 88 })
})

test('normalizeKiroMetadata: only finite 0..100 accepted, no arbitrary fields', () => {
  assert.equal(normalizeKiroMetadata({ _meta: { contextUsagePercentage: 999 } }), null)
  assert.equal(normalizeKiroMetadata({ _meta: { contextUsagePercentage: -1 } }), null)
  assert.equal(normalizeKiroMetadata({ _meta: { contextUsagePercentage: NaN } }), null)
  assert.equal(normalizeKiroMetadata({ _meta: { contextUsagePercentage: 'x' } }), null)
  assert.equal(normalizeKiroMetadata({}), null)
  // Only contextUsagePercentage is ever emitted — never other _meta fields.
  const e = normalizeKiroMetadata({ _meta: { contextUsagePercentage: 10, secret: 'nope', other: { a: 1 } } })
  assert.deepEqual(Object.keys(e).sort(), ['contextUsagePercentage', 'type'])
})

test('acp: real session/update notifications surface contextUsagePercentage via metadata', async () => {
  const events = []
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('metadata'),
    onEvent: (e) => events.push(e),
    timeoutMs: 10_000,
  })
  // The normal update events are preserved (message chunks flow through).
  assert.ok(events.some((e) => e.type === EVENT_TYPES.MESSAGE))
  // Metadata events were emitted for each valid shape (40, 55, 66, 77); 999 dropped.
  const metaPcts = events.filter((e) => e.type === EVENT_TYPES.METADATA).map((e) => e.contextUsagePercentage)
  assert.deepEqual(metaPcts, [40, 55, 66, 77])
  // Collector keeps the latest valid percentage.
  assert.equal(r.metadata.contextUsagePercentage, 77)
  // Metadata never carries arbitrary fields — only the percentage (plus any
  // structured usage/plan, which this scenario does not emit).
  assert.deepEqual(Object.keys(r.metadata), ['contextUsagePercentage'])
})

test('acp: no duplicate metadata event for the custom metadata update', async () => {
  const events = []
  await acp.run(PAYLOAD, { spawnFn: mockSpawn('metadata'), onEvent: (e) => events.push(e), timeoutMs: 10_000 })
  const metaCount = events.filter((e) => e.type === EVENT_TYPES.METADATA).length
  // Exactly four valid metadata events (one per valid shape), none duplicated.
  assert.equal(metaCount, 4)
})

// --- F7: unverified `total` alias no longer populates size ---

test('events: an unrelated usage_update.total does not populate size', () => {
  const e = normalizeAcpUpdate({ sessionUpdate: 'usage_update', used: 5, total: 12345 })
  assert.equal(e.used, 5)
  assert.equal(e.size, null, 'total must not be treated as context size')
})

test('events: official size and supported alias contextSize still work', () => {
  assert.equal(normalizeAcpUpdate({ sessionUpdate: 'usage_update', size: 100 }).size, 100)
  assert.equal(normalizeAcpUpdate({ sessionUpdate: 'usage_update', contextSize: 200 }).size, 200)
})
