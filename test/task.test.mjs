import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { task, runWorker, result, status, cancel, pickAgent, formatTask, formatStatus } from '../scripts/lib/task.mjs'
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
  // F5: the parent persists the spawned child's pid + spawnedAt while the job
  // is still queued, so reapOrphans can distinguish "spawned, not yet running"
  // from "never started". The job stays queued until the worker flips it.
  assert.equal(job.meta.pid, 4242, 'parent records the spawned child pid while queued')
  assert.ok(job.meta.spawnedAt, 'parent records spawnedAt')
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

test('runWorker: startup failures are explicitly recorded as failed', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: null,
  })
  await assert.rejects(() => runWorker(jobId, { cwd: CWD, runFn: okRun() }), TypeError)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'failed')
  assert.match(job.meta.error, /TypeError/)
})

test('runWorker: cancel winning before completion leaves no result body', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  const workerResult = await runWorker(jobId, {
    cwd: CWD,
    runFn: async (...args) => {
      jobs.transition(jobId, 'cancelled', CWD)
      return okRun()(...args)
    },
  })
  assert.equal(workerResult, null)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.meta.sessionId, null)
  assert.equal(jobs.readResult(jobId, CWD), null)
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

test('result --follow-up: records ACP usage/context fields into usage.jsonl (like runDelegated)', async () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  await runWorker(jobId, { cwd: CWD, runFn: okRun() })

  await result({
    cwd: CWD,
    jobId,
    followUp: 'give me more evidence',
    runFn: okRun({
      metadata: {
        contextUsagePercentage: 33,
        usage: { used: 11, size: 22, cost: { amount: 0.05, currency: 'USD' } },
      },
    }),
  })
  const followUpUsage = readUsage().find((u) => u.command === 'result:follow-up')
  assert.ok(followUpUsage, 'a result:follow-up usage record is written')
  assert.equal(followUpUsage.contextUsagePercentage, 33)
  assert.equal(followUpUsage.acpUsed, 11)
  assert.equal(followUpUsage.acpSize, 22)
  assert.equal(followUpUsage.acpCostAmount, 0.05)
  assert.equal(followUpUsage.acpCostCurrency, 'USD')
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


test('task --bg: spawn failure records a terminal failed job', async () => {
  await assert.rejects(
    task({
      goal: 'background investigation',
      background: true,
      cwd: CWD,
      spawnFn: () => { throw new Error('EMFILE') },
    }),
    (err) => err.code === CODES.SPAWN_FAILED,
  )
  const list = jobs.listJobs({ cwd: CWD })
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'failed')
  assert.match(list[0].meta.error, /SPAWN_FAILED.*EMFILE/)
})

test('runWorker: pid is durable before running can be reaped', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, {
    cwd: CWD,
    runFn: async (...args) => {
      assert.deepEqual(jobs.reapOrphans(CWD), [])
      const running = jobs.readJob(jobId, CWD)
      assert.equal(running.status, 'running')
      assert.equal(running.meta.pid, process.pid)
      return okRun()(...args)
    },
  })
  assert.equal(jobs.readJob(jobId, CWD).status, 'done')
})

test('runWorker: a job cancelled before worker start never executes', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  jobs.transition(jobId, 'cancelled', CWD)
  let called = false
  const result = await runWorker(jobId, { cwd: CWD, runFn: async () => { called = true } })
  assert.equal(result, null)
  assert.equal(called, false)
  assert.equal(jobs.readJob(jobId, CWD).status, 'cancelled')
})

test('runWorker: persists a process start identity when it starts running', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, {
    cwd: CWD,
    runFn: async (...args) => {
      const running = jobs.readJob(jobId, CWD)
      assert.equal(running.meta.pid, process.pid)
      // identity is best-effort: string when supported, null when not — but the
      // field must always be present so cancelJob can reason about it.
      assert.ok('procIdentity' in running.meta)
      return okRun()(...args)
    },
  })
})

test('runWorker: persists bounded, sanitized recent events (no raw prose)', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  const runFn = async (payload, options) => {
    options.onEvent?.({ type: 'message', text: 'sensitive raw prose that must not persist' })
    options.onEvent?.({ type: 'tool_call', toolCallId: 'tc1', title: 'read file', status: 'pending' })
    options.onEvent?.({ type: 'usage', used: 42, size: 1000, cost: { amount: 0.01, currency: 'USD' } })
    return okRun()(payload, options)
  }
  await runWorker(jobId, { cwd: CWD, runFn })
  const job = jobs.readJob(jobId, CWD)
  const raw = JSON.stringify(job.meta.recentEvents)
  assert.ok(!raw.includes('sensitive raw prose'), 'raw prose must never be persisted')
  assert.ok(job.meta.recentEvents.some((e) => e.type === 'message' && typeof e.chars === 'number'))
  assert.ok(job.meta.recentEvents.some((e) => e.type === 'usage' && e.used === 42))
})

test('runWorker: persists latest usage/plan metadata from the ACP result', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, {
    cwd: CWD,
    runFn: okRun({
      metadata: {
        contextUsagePercentage: 20,
        usage: { used: 100, size: 2000, cost: { amount: 0.02, currency: 'USD' } },
        plan: { entries: [{ status: 'completed' }, { status: 'pending' }] },
      },
    }),
  })
  const job = jobs.readJob(jobId, CWD)
  assert.deepEqual(job.meta.usage, { used: 100, size: 2000, cost: { amount: 0.02, currency: 'USD' } })
  assert.equal(job.meta.plan.count, 2)
  // runWorker reuses jobs.summarizePlan → the bounded four-key shape.
  assert.deepEqual(job.meta.plan, jobs.summarizePlan([{ status: 'completed' }, { status: 'pending' }]))
  assert.deepEqual(Object.keys(job.meta.plan.statusCounts).sort(), ['completed', 'in_progress', 'pending', 'unknown'])
  assert.equal(job.meta.plan.statusCounts.completed, 1)
  assert.equal(job.meta.plan.statusCounts.pending, 1)
})

test('runWorker: non-standard / __proto__ plan statuses count as unknown (shared summarizePlan shape)', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'task', payloadOptions: { goal: 'g', write: false },
  })
  await runWorker(jobId, {
    cwd: CWD,
    runFn: okRun({
      metadata: {
        plan: { entries: [{ status: '__proto__' }, { status: 'weird' }, { status: 'completed' }] },
      },
    }),
  })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.meta.plan.count, 3)
  assert.equal(job.meta.plan.statusCounts.completed, 1)
  assert.equal(job.meta.plan.statusCounts.unknown, 2)
  // No dynamic keys leak; bounded shape identical to the shared helper.
  assert.deepEqual(Object.keys(job.meta.plan.statusCounts).sort(), ['completed', 'in_progress', 'pending', 'unknown'])
  assert.equal(({}).polluted, undefined)
})

test('task: records ACP usage fields into usage.jsonl when present', async () => {
  await task({
    goal: 'g',
    cwd: CWD,
    runFn: okRun({
      metadata: {
        contextUsagePercentage: 5,
        usage: { used: 7, size: 8, cost: { amount: 0.9, currency: 'USD' } },
      },
    }),
  })
  const usage = readUsage()
  assert.equal(usage[0].acpUsed, 7)
  assert.equal(usage[0].acpSize, 8)
  assert.equal(usage[0].acpCostAmount, 0.9)
  assert.equal(usage[0].acpCostCurrency, 'USD')
  assert.ok(!('acpCost' in usage[0]), 'the incorrect numeric acpCost field is no longer written')
})

test('task: tolerates a legacy numeric ACP cost (amount only, no currency)', async () => {
  await task({
    goal: 'g',
    cwd: CWD,
    runFn: okRun({ metadata: { contextUsagePercentage: 5, usage: { used: 7, size: 8, cost: 0.9 } } }),
  })
  const usage = readUsage()
  assert.equal(usage[0].acpCostAmount, 0.9)
  assert.ok(!('acpCostCurrency' in usage[0]), 'no currency when the source cost was a bare number')
})

test('task: usage record omits ACP fields when the transport had none (backward compatible)', async () => {
  await task({ goal: 'g', cwd: CWD, runFn: okRun({ metadata: { contextUsagePercentage: 5 } }) })
  const usage = readUsage()
  assert.ok(!('acpUsed' in usage[0]))
})

test('status: classifies running-job health with an injected clock', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, {
    pid: process.pid,
    procIdentity: 'id-A',
    lastProgressAt: new Date(0).toISOString(),
  }, CWD)
  // Injected identityFn keeps the live pid matching so reapOrphans leaves it running.
  const res = status({ cwd: CWD, now: jobs.HEALTH_STALLED_MS + 1, identityFn: () => 'id-A' })
  const job = res.jobs.find((j) => j.jobId === jobId)
  assert.equal(job.health, 'possibly_stalled')
  const text = formatStatus(res)
  assert.match(text, /possibly_stalled/)
  assert.match(text, /Last progress/)
})
