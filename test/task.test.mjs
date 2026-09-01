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
  result: 'investigation result body',
  metadata: { contextUsagePercentage: 12 },
  _seen: { payload, options },
  ...overrides,
})

// --- agent selection (ADR-002) ---

test('pickAgent: defaults to read-only researcher, --write picks worker', () => {
  assert.equal(pickAgent({}).name, `${AGENT_PREFIX}researcher`)
  assert.equal(pickAgent({ write: true }).name, `${AGENT_PREFIX}worker`)
})

test('worker/spec-writer never trust shell either', () => {
  for (const def of [AGENT_DEFS.worker, AGENT_DEFS.specWriter]) {
    assert.ok(!def.trust.includes('shell'), `${def.name} must not trust shell`)
    assert.ok(def.deny.includes('shell'))
  }
})

// --- task fg ---

test('task: rejects when goal is empty', async () => {
  await assert.rejects(() => task({ goal: '  ' }), (err) => err.code === CODES.PROTOCOL)
})

test('task: fg execution — researcher agent, wrapped output, usage recorded', async () => {
  let seen
  const res = await task({
    goal: 'investigate this bug cause',
    cwd: CWD,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}researcher`)
  assert.equal(seen.payload.kind, 'task')
  assert.ok(res.wrapped.includes(TRUST_FENCE.open))
  // researcher gets the web-derived warning attached (ADR-004).
  assert.match(res.wrapped, /Web-derived/)

  const usage = readUsage()
  assert.equal(usage.length, 1)
  assert.equal(usage[0].command, 'task')
  assert.equal(usage[0].transport, 'acp')
  assert.equal(usage[0].contextUsagePercentage, 12)
})

test('task: still records usage as failed even when it throws', async () => {
  await assert.rejects(() =>
    task({ goal: 'g', cwd: CWD, runFn: async () => { throw new Error('boom') } }))
  const usage = readUsage()
  assert.equal(usage.length, 1)
  assert.equal(usage[0].ok, false)
})

test('task: dry-run does not send anything', async () => {
  let called = false
  const res = await task({ goal: 'g', dryRun: true, runFn: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(res.dryRun, true)
  assert.equal(res.agent, `${AGENT_PREFIX}researcher`)
})

// --- task bg + worker ---

test('task --bg: creates a job and spawns the worker detached', async () => {
  const spawned = []
  const bg = await task({
    goal: 'background investigation',
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

test('runWorker: on success, saves the result + done, keeps sessionId', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'done')
  assert.equal(job.meta.sessionId, 'sess-1')
  assert.ok(jobs.readResult(jobId, CWD).includes(TRUST_FENCE.open))
})

test('runWorker: on failure, records failed + error message', async () => {
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

test('result: clearly reports empty when there are no jobs', async () => {
  const res = await result({ cwd: CWD })
  assert.equal(res.empty, true)
})

test('result: returns the body of a completed job (latest job when id omitted)', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const res = await result({ cwd: CWD })
  assert.equal(res.jobId, jobId)
  assert.equal(res.status, 'done')
  assert.ok(res.body.includes(TRUST_FENCE.open))
})

test('result --follow-up: reuses the session via sessionId', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })

  let seen
  const res = await result({
    cwd: CWD,
    jobId,
    followUp: 'give me more evidence',
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.sessionId, 'sess-1')
  assert.equal(seen.payload.goal, 'give me more evidence')
  assert.ok(res.followUp.wrapped.includes(TRUST_FENCE.open))
})

test('result --follow-up: a clear error for a job with no session (subprocess)', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun({ sessionId: null, transport: 'subprocess' }) })
  await assert.rejects(
    () => result({ cwd: CWD, jobId, followUp: 'q' }),
    (err) => err.code === CODES.PROTOCOL,
  )
})

test('status: reports the job list together with a usage summary', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })
  const res = status({ cwd: CWD })
  assert.equal(res.jobs.length, 1)
  assert.equal(res.usage.length, 1)
})

test('cancel: rejects without a job id', () => {
  assert.equal(cancel({ cwd: CWD }).ok, false)
})

// --- spec ---

test('spec: sends a kind=spec payload to the spec-writer agent', async () => {
  let seen
  const res = await spec({
    goal: 'notification settings feature',
    cwd: CWD,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}spec-writer`)
  assert.equal(seen.payload.kind, 'spec')
  assert.ok(seen.payload.constraints.some((c) => c.includes('.kiro/specs/')))
  assert.ok(res.wrapped.includes(TRUST_FENCE.open))
  assert.equal(readUsage()[0].command, 'spec')
})

test('spec: rejects when goal is empty', async () => {
  await assert.rejects(() => spec({ goal: '' }), (err) => err.code === CODES.PROTOCOL)
})
