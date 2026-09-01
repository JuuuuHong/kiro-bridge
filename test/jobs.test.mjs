import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as jobs from '../scripts/lib/jobs.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-jobs-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/tmp/fake-repo'

test('createJob: creates meta and a queued status', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'queued')
  assert.equal(job.meta.command, 'task')
  assert.equal(job.meta.payloadOptions.goal, 'g')
})

test('transition: only valid transitions are allowed', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.throws(() => jobs.transition(jobId, 'done', CWD), /invalid transition/)
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  assert.equal(jobs.readJob(jobId, CWD).status, 'done')
  assert.ok(jobs.readJob(jobId, CWD).meta.finishedAt)
})

test('transition: terminal state is immutable — not flipped by a cancel race', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  assert.equal(jobs.transition(jobId, 'cancelled', CWD), 'done')
  assert.equal(jobs.readJob(jobId, CWD).status, 'done')
})

test('cwd scoping: jobs from another repository are not visible', () => {
  jobs.createJob({ cwd: '/tmp/repo-a', command: 'task' })
  assert.equal(jobs.listJobs({ cwd: '/tmp/repo-b' }).length, 0)
  assert.equal(jobs.listJobs({ cwd: '/tmp/repo-a' }).length, 1)
})

test('latestJobId: returns the chronologically last job', () => {
  jobs.createJob({ cwd: CWD, command: 'task' })
  const second = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.equal(jobs.latestJobId(CWD), second.jobId)
})

test('result save/read round trip', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.writeResult(jobId, 'result body', CWD)
  assert.equal(jobs.readResult(jobId, CWD), 'result body')
  assert.equal(jobs.readResult('nonexistent-job', CWD), null)
})

test('reapOrphans: marks failed when running but the process is dead', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  // A PID that cannot exist — kill(pid, 0) fails.
  jobs.updateMeta(jobId, { pid: 999999999 }, CWD)
  const reaped = jobs.reapOrphans(CWD)
  assert.deepEqual(reaped, [jobId])
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'failed')
  assert.match(job.meta.error, /orphaned/)
})

test('reapOrphans: leaves a live process alone', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid }, CWD) // this test process — definitely alive
  assert.deepEqual(jobs.reapOrphans(CWD), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('cancelJob: clearly reports failure for an already-terminal job', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  const res = jobs.cancelJob(jobId, { cwd: CWD })
  assert.equal(res.ok, false)
  assert.match(res.reason, /terminal/)
})

test('cancelJob: sends SIGTERM to a live job and transitions to cancelled', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, { cwd: CWD, killFn: (pid) => killed.push(pid) })
  assert.equal(res.ok, true)
  assert.deepEqual(killed, [process.pid])
  assert.equal(jobs.readJob(jobId, CWD).status, 'cancelled')
})

test('gcJobs: removes only terminal jobs past the retention period', () => {
  const old = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(old.jobId, 'running', CWD)
  jobs.transition(old.jobId, 'done', CWD)
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  jobs.updateMeta(old.jobId, { finishedAt: past }, CWD)

  const fresh = jobs.createJob({ cwd: CWD, command: 'task' }) // queued — not a GC target

  const removed = jobs.gcJobs({ cwd: CWD, retentionDays: 30 })
  assert.deepEqual(removed, [old.jobId])
  assert.equal(jobs.readJob(old.jobId, CWD), null)
  assert.ok(jobs.readJob(fresh.jobId, CWD))
})


test('reapOrphans: marks a stale queued job failed when worker never started', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 5001
  assert.deepEqual(jobs.reapOrphans(CWD, { now, startupGraceMs: 5000 }), [jobId])
  const reaped = jobs.readJob(jobId, CWD)
  assert.equal(reaped.status, 'failed')
  assert.match(reaped.meta.error, /did not start/)
})

test('reapOrphans: leaves a fresh queued job in its startup grace period', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 100
  assert.deepEqual(jobs.reapOrphans(CWD, { now, startupGraceMs: 5000 }), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'queued')
})
