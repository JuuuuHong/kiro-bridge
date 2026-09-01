import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { task, runWorker, result, status, cancel, pickAgent, formatTask } from '../scripts/lib/task.mjs'
import { spec } from '../scripts/lib/spec.mjs'
import { AGENT_DEFS, AGENT_PREFIX } from '../scripts/lib/agents.mjs'
import { TRUST_FENCE } from '../scripts/lib/findings.mjs'
import { CODES } from '../scripts/lib/errors.mjs'
import * as jobs from '../scripts/lib/jobs.mjs'
import { readUsage } from '../scripts/lib/usage.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-task-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/tmp/fake-repo'

const okRun = (overrides = {}) => async (payload, options) => ({
  sessionId: 'sess-1',
  transport: 'acp',
  result: '조사 결과 본문',
  metadata: { contextUsagePercentage: 12 },
  _seen: { payload, options },
  ...overrides,
})

// --- 에이전트 선택 (ADR-002) ---

test('pickAgent: 기본은 읽기 전용 researcher, --write 는 worker', () => {
  assert.equal(pickAgent({}).name, `${AGENT_PREFIX}researcher`)
  assert.equal(pickAgent({ write: true }).name, `${AGENT_PREFIX}worker`)
})

test('worker/spec-writer 도 shell 은 어떤 경우에도 미신뢰다', () => {
  for (const def of [AGENT_DEFS.worker, AGENT_DEFS.specWriter]) {
    assert.ok(!def.trust.includes('shell'), `${def.name} must not trust shell`)
    assert.ok(def.deny.includes('shell'))
  }
})

// --- task fg ---

test('task: goal 이 비면 거부한다', async () => {
  await assert.rejects(() => task({ goal: '  ' }), (err) => err.code === CODES.PROTOCOL)
})

test('task: fg 실행 — researcher 에이전트, 래핑된 출력, usage 기록', async () => {
  let seen
  const res = await task({
    goal: '이 버그 원인 조사',
    cwd: CWD,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}researcher`)
  assert.equal(seen.payload.kind, 'task')
  assert.ok(res.wrapped.includes(TRUST_FENCE.open))
  // researcher 는 웹 유래 경고가 붙는다 (ADR-004).
  assert.match(res.wrapped, /웹 유래/)

  const usage = readUsage()
  assert.equal(usage.length, 1)
  assert.equal(usage[0].command, 'task')
  assert.equal(usage[0].transport, 'acp')
  assert.equal(usage[0].contextUsagePercentage, 12)
})

test('task: 실패해도 usage 에 실패로 기록된다', async () => {
  await assert.rejects(() =>
    task({ goal: 'g', cwd: CWD, runFn: async () => { throw new Error('boom') } }))
  const usage = readUsage()
  assert.equal(usage.length, 1)
  assert.equal(usage[0].ok, false)
})

test('task: dry-run 은 전송하지 않는다', async () => {
  let called = false
  const res = await task({ goal: 'g', dryRun: true, runFn: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(res.dryRun, true)
  assert.equal(res.agent, `${AGENT_PREFIX}researcher`)
})

// --- task bg + worker ---

test('task --bg: 잡을 만들고 워커를 detached 로 띄운다', async () => {
  const spawned = []
  const bg = await task({
    goal: '백그라운드 조사',
    background: true,
    cwd: CWD,
    spawnFn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return { pid: 4242, unref() {} }
    },
  })
  assert.ok(bg.jobId)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args[1], '_worker')
  assert.equal(spawned[0].args[2], bg.jobId)
  assert.equal(spawned[0].opts.detached, true)
  const job = jobs.readJob(bg.jobId, CWD)
  assert.equal(job.meta.pid, 4242)
  assert.equal(job.status, 'queued')
  assert.match(formatTask({ background: true, jobId: bg.jobId }), /result/)
})

test('runWorker: 성공 시 결과 저장 + done, sessionId 보존', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'done')
  assert.equal(job.meta.sessionId, 'sess-1')
  assert.ok(jobs.readResult(jobId, CWD).includes(TRUST_FENCE.open))
})

test('runWorker: 실패 시 failed + 오류 메시지 기록', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g' },
  })
  await assert.rejects(() =>
    runWorker(jobId, { cwd: CWD, runFn: async () => { throw new Error('kaput') } }))
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'failed')
  assert.match(job.meta.error, /kaput/)
})

// --- result / status / cancel ---

test('result: 잡이 없으면 빈손을 명확히 알린다', async () => {
  const res = await result({ cwd: CWD })
  assert.equal(res.empty, true)
})

test('result: 완료된 잡의 본문을 돌려준다 (id 생략 시 최신 잡)', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const res = await result({ cwd: CWD })
  assert.equal(res.jobId, jobId)
  assert.equal(res.status, 'done')
  assert.ok(res.body.includes(TRUST_FENCE.open))
})

test('result --follow-up: sessionId 로 세션을 재사용한다', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })

  let seen
  const res = await result({
    cwd: CWD,
    jobId,
    followUp: '근거를 더 줘',
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.sessionId, 'sess-1')
  assert.equal(seen.payload.goal, '근거를 더 줘')
  assert.ok(res.followUp.wrapped.includes(TRUST_FENCE.open))
})

test('result --follow-up: 세션 없는 잡(subprocess)은 명확한 오류', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun({ sessionId: null, transport: 'subprocess' }) })
  await assert.rejects(
    () => result({ cwd: CWD, jobId, followUp: 'q' }),
    (err) => err.code === CODES.PROTOCOL,
  )
})

test('status: 잡 목록과 usage 요약을 함께 낸다', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const res = status({ cwd: CWD })
  assert.equal(res.jobs.length, 1)
  assert.equal(res.usage.length, 1)
})

test('cancel: job id 없이는 거부한다', () => {
  assert.equal(cancel({ cwd: CWD }).ok, false)
})

// --- spec ---

test('spec: spec-writer 에이전트로 kind=spec 페이로드를 보낸다', async () => {
  let seen
  const res = await spec({
    goal: '알림 설정 기능',
    cwd: CWD,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}spec-writer`)
  assert.equal(seen.payload.kind, 'spec')
  assert.ok(seen.payload.constraints.some((c) => c.includes('.kiro/specs/')))
  assert.ok(res.wrapped.includes(TRUST_FENCE.open))
  assert.equal(readUsage()[0].command, 'spec')
})

test('spec: goal 이 비면 거부한다', async () => {
  await assert.rejects(() => spec({ goal: '' }), (err) => err.code === CODES.PROTOCOL)
})
