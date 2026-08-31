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

// 목업을 kiro-cli 자리에 꽂는다. 실제 바이너리 없이 도는 계층이다 (설계 §11).
function mockSpawn(scenario) {
  return (_bin, args, opts = {}) =>
    spawn(process.execPath, [MOCK, ...args], {
      ...opts,
      env: { ...process.env, MOCK_SCENARIO: scenario },
    })
}

const PAYLOAD = { kind: 'review', goal: '리뷰해줘' }

// --- ACP 정상 경로 ---

test('acp: 정상 왕복 — sessionId 와 결과 텍스트를 낸다', async () => {
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

test('acp: 스트리밍 이벤트가 상위로 흐른다', async () => {
  const events = []
  await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    onEvent: (e) => events.push(e),
    timeoutMs: 10_000,
  })
  const types = events.map((e) => e.type)
  assert.ok(types.includes(EVENT_TYPES.THOUGHT), '사고 청크')
  assert.ok(types.includes(EVENT_TYPES.TOOL_CALL), '툴 호출 가시화')
  assert.ok(types.includes(EVENT_TYPES.TOOL_RESULT), '툴 결과')
  assert.ok(types.includes(EVENT_TYPES.MESSAGE), '메시지 청크')
})

test('acp: 기존 sessionId 를 주면 session/load 로 재사용한다', async () => {
  const r = await acp.run(PAYLOAD, {
    spawnFn: mockSpawn('ok'),
    sessionId: 'sess-existing',
    timeoutMs: 10_000,
  })
  assert.equal(r.sessionId, 'sess-existing')
})

// --- 툴 거부: 가장 중요한 실패 모드 (설계 §8, ADR-002) ---

test('acp: 툴 거부를 감지하면 그럴듯한 findings 를 성공으로 반환하지 않는다', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('denied'), timeoutMs: 10_000 }),
    (err) => {
      assert.equal(err.code, CODES.TOOL_DENIED)
      assert.ok(err.details.denials.length > 0)
      return true
    },
  )
})

test('subprocess: 툴 거부도 동일하게 오류로 승격된다', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('denied'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

// --- 권한 브로커링 (ACP 전용 축) ---

test('acp: session/request_permission 이 클라이언트로 브로커링된다', async () => {
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
  assert.match(r.result, /허가됨/)
})

test('acp: 권한 핸들러가 없으면 거부가 기본값이다 (ADR-002)', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('permission'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

// --- 실패 모드 표 (설계 §8) ---

test('acp: 미인증은 UNAUTHENTICATED 로 분류된다', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('unauthenticated'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.UNAUTHENTICATED,
  )
})

test('subprocess: 스로틀/크레딧 소진은 THROTTLED 로 분류된다', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('throttled'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.THROTTLED,
  )
})

test('acp: 타임아웃은 부분 출력과 함께 보고되고 재시도하지 않는다', async () => {
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('timeout'), timeoutMs: 400 }),
    (err) => {
      assert.equal(err.code, CODES.TIMEOUT)
      assert.equal(typeof err.details.partial, 'string')
      return true
    },
  )
})

test('subprocess: 0 아닌 종료 코드는 SPAWN_FAILED', async () => {
  await assert.rejects(
    subprocess.run(PAYLOAD, { spawnFn: mockSpawn('nonzero-exit'), timeoutMs: 10_000 }),
    (err) => err.code === CODES.SPAWN_FAILED,
  )
})

test('acp: AbortSignal 로 취소하면 CANCELLED', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    acp.run(PAYLOAD, { spawnFn: mockSpawn('timeout'), signal: controller.signal, timeoutMs: 10_000 }),
    (err) => err.code === CODES.CANCELLED || err.code === CODES.TIMEOUT,
  )
})

// --- 페이로드 전달 (ADR-003 결정 4: 항상 stdin) ---

test('subprocess: 페이로드가 stdin 으로 온전히 전달된다', async () => {
  const r = await subprocess.run(
    { kind: 'review', goal: 'stdin-왕복-확인' },
    { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 },
  )
  assert.match(r.result, /echo:stdin-왕복-확인/)
})

test('subprocess: 인자 조립에 셸 문자열이 없다', () => {
  const args = subprocess.buildArgs({ agent: 'kiro-bridge-reviewer', model: 'sonnet' })
  assert.deepEqual(args, [
    'chat', '--no-interactive', '--output-format', 'stream-json',
    '--agent', 'kiro-bridge-reviewer', '--model', 'sonnet',
  ])
  assert.ok(!args.some((a) => /[;|&$`]/.test(a)))
})

test('subprocess: 원샷 경로에는 재사용할 세션이 없다', async () => {
  const r = await subprocess.run(PAYLOAD, { spawnFn: mockSpawn('ok'), timeoutMs: 10_000 })
  assert.equal(r.sessionId, null)
  assert.equal(r.transport, 'subprocess')
})

// --- 능력 감지 ---

test('acp.probe: 핸드셰이크 성공 시 available', async () => {
  const r = await acp.probe({ spawnFn: mockSpawn('ok'), timeoutMs: 5000 })
  assert.equal(r.available, true)
  assert.equal(r.initialize.protocolVersion, 1)
})

test('acp.probe: acp 서브커맨드가 없으면 available:false', async () => {
  const r = await acp.probe({ spawnFn: mockSpawn('acp-unavailable'), timeoutMs: 2000 })
  assert.equal(r.available, false)
})
