import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as jobs from '../scripts/lib/jobs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRITER = join(HERE, 'fixtures', 'concurrent-meta-writer.mjs')

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

test('worker lifecycle helpers atomically start and complete a job', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.equal(jobs.startJob(jobId, { pid: 123, startedAt: 'start' }, CWD), 'running')
  assert.equal(jobs.completeJob(jobId, 'result body', { sessionId: 's1' }, CWD), 'done')
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'done')
  assert.equal(job.meta.pid, 123)
  assert.equal(job.meta.sessionId, 's1')
  assert.equal(jobs.readResult(jobId, CWD), 'result body')
})

test('completeJob does not persist result or metadata when cancellation won first', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.startJob(jobId, { pid: null }, CWD)
  jobs.transition(jobId, 'cancelled', CWD)
  assert.equal(jobs.completeJob(jobId, 'late result', { sessionId: 'late' }, CWD), 'cancelled')
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.meta.sessionId, null)
  assert.equal(jobs.readResult(jobId, CWD), null)
})

test('failJob records an error atomically but preserves an existing terminal state', () => {
  const first = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.equal(jobs.failJob(first.jobId, 'startup failed', CWD), 'failed')
  assert.equal(jobs.readJob(first.jobId, CWD).meta.error, 'startup failed')

  const cancelled = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(cancelled.jobId, 'cancelled', CWD)
  assert.equal(jobs.failJob(cancelled.jobId, 'late failure', CWD), 'cancelled')
  assert.equal(jobs.readJob(cancelled.jobId, CWD).meta.error, null)
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

test('cancelJob: sends SIGTERM to a live job with matching identity and cancels', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, {
    cwd: CWD,
    killFn: (pid) => killed.push(pid),
    identityFn: () => 'id-A',
  })
  assert.equal(res.ok, true)
  assert.deepEqual(killed, [process.pid])
  assert.equal(jobs.readJob(jobId, CWD).status, 'cancelled')
})

test('cancelJob: fails closed on identity mismatch for a live pid (no signal, no transition)', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, {
    cwd: CWD,
    killFn: (pid) => killed.push(pid),
    identityFn: () => 'id-B', // reused pid
  })
  assert.equal(res.ok, false)
  assert.match(res.reason, /identity does not match/)
  assert.deepEqual(killed, [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('cancelJob: fails closed when identity is missing for a live pid', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: null }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, { cwd: CWD, killFn: (pid) => killed.push(pid) })
  assert.equal(res.ok, false)
  assert.match(res.reason, /no stored process identity/)
  assert.deepEqual(killed, [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('cancelJob: fails closed when identity is unverifiable for a live pid', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  const res = jobs.cancelJob(jobId, { cwd: CWD, killFn: () => {}, identityFn: () => null })
  assert.equal(res.ok, false)
  assert.match(res.reason, /unverifiable/)
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('cancelJob: a dead process transitions to cancelled without signalling', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: 999999999, procIdentity: 'id-A' }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, { cwd: CWD, killFn: (pid) => killed.push(pid) })
  assert.equal(res.ok, true)
  assert.deepEqual(killed, [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'cancelled')
})

test('reapOrphans: alive pid with mismatched identity is orphaned but not killed', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  const reaped = jobs.reapOrphans(CWD, { identityFn: () => 'id-B' })
  assert.deepEqual(reaped, [jobId])
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'failed')
  assert.match(job.meta.error, /identity mismatch/)
})

test('reapOrphans: alive pid with matching identity is left running', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  assert.deepEqual(jobs.reapOrphans(CWD, { identityFn: () => 'id-A' }), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('reapOrphans: alive pid with unverifiable identity is left running (no false orphan)', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  assert.deepEqual(jobs.reapOrphans(CWD, { identityFn: () => null }), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('processIdentity: returns null for invalid pids', () => {
  assert.equal(jobs.processIdentity(0), null)
  assert.equal(jobs.processIdentity(-1), null)
  assert.equal(jobs.processIdentity('x'), null)
})

test('processIdentity: best-effort for the current process (null tolerated)', () => {
  const id = jobs.processIdentity(process.pid)
  assert.ok(id === null || typeof id === 'string')
})

// --- observability: sanitized events + health ---

test('sanitizeEventSummary: message/thought keep only char counts, no prose', () => {
  const s = jobs.sanitizeEventSummary({ type: 'message', text: 'secret prose here' }, { now: 0 })
  assert.equal(s.type, 'message')
  assert.equal(s.chars, 'secret prose here'.length)
  assert.ok(!('text' in s))
})

test('sanitizeEventSummary: strips ANSI/control chars from tool titles', () => {
  const s = jobs.sanitizeEventSummary(
    { type: 'tool_call', toolCallId: 'tc1', title: '\u001b[31mread\u001b[0m\tfile', status: 'pending' },
    { now: 0 },
  )
  assert.ok(!/\u001b/.test(s.title))
  assert.ok(!/[\u0000-\u001f]/.test(s.title))
  assert.match(s.title, /read/)
})

test('sanitizeEventSummary: usage keeps numeric fields, plan keeps counts', () => {
  const u = jobs.sanitizeEventSummary(
    { type: 'usage', used: 5, size: 10, cost: { amount: 0.1, currency: 'USD' } },
    { now: 0 },
  )
  assert.equal(u.used, 5)
  assert.equal(u.size, 10)
  assert.deepEqual(u.cost, { amount: 0.1, currency: 'USD' })
  const p = jobs.sanitizeEventSummary(
    { type: 'plan', entries: [{ status: 'pending' }, { status: 'pending' }, { status: 'completed' }] },
    { now: 0 },
  )
  assert.equal(p.count, 3)
  assert.equal(p.statusCounts.pending, 2)
  assert.equal(p.statusCounts.completed, 1)
  assert.equal(p.statusCounts.in_progress, 0)
  assert.equal(p.statusCounts.unknown, 0)
})

// --- summarizePlan: bounded, prototype-safe status counting ---

test('summarizePlan: only known statuses are counted, always four bounded keys', () => {
  const { count, statusCounts } = jobs.summarizePlan([
    { status: 'pending' }, { status: 'in_progress' }, { status: 'completed' },
  ])
  assert.equal(count, 3)
  assert.deepEqual(Object.keys(statusCounts).sort(), ['completed', 'in_progress', 'pending', 'unknown'])
  assert.deepEqual(
    { ...statusCounts },
    { pending: 1, in_progress: 1, completed: 1, unknown: 0 },
  )
})

test('summarizePlan: non-standard / untrusted statuses map to unknown', () => {
  const { count, statusCounts } = jobs.summarizePlan([
    { status: 'weird' },
    { status: 'x'.repeat(5000) },       // arbitrary long string
    { status: 'constructor' },
    { status: 42 },                     // non-string
    {},                                 // missing status
    { status: 'pending' },
  ])
  assert.equal(count, 6)
  assert.equal(statusCounts.pending, 1)
  assert.equal(statusCounts.unknown, 5)
  // No dynamic keys leaked from untrusted input.
  assert.deepEqual(Object.keys(statusCounts).sort(), ['completed', 'in_progress', 'pending', 'unknown'])
})

test('summarizePlan: __proto__ status cannot pollute prototypes and counts as unknown', () => {
  const { statusCounts } = jobs.summarizePlan([
    { status: '__proto__' }, { status: '__proto__' }, { status: 'prototype' },
  ])
  // Counted as unknown, never as an own or prototype key.
  assert.equal(statusCounts.unknown, 3)
  // The accumulator has only fixed own keys; no untrusted key is assigned.
  assert.equal(Object.getPrototypeOf(statusCounts), Object.prototype)
  assert.ok(!Object.prototype.hasOwnProperty.call(statusCounts, '__proto__'))
  // Global Object prototype is untouched.
  assert.equal(({}).polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
})

test('summarizePlan: a malicious __proto__ payload does not pollute Object.prototype', () => {
  const evil = JSON.parse('[{"status": "__proto__"}, {"__proto__": {"polluted": true}}]')
  jobs.summarizePlan(evil)
  assert.equal(({}).polluted, undefined)
})

test('summarizePlan: tolerates non-array input', () => {
  assert.deepEqual(jobs.summarizePlan(undefined), {
    count: 0,
    statusCounts: { pending: 0, in_progress: 0, completed: 0, unknown: 0 },
  })
  assert.deepEqual(jobs.summarizePlan(null).count, 0)
})

test('sanitizeEventSummary: plan branch reuses summarizePlan (bounded shape, __proto__ → unknown)', () => {
  const s = jobs.sanitizeEventSummary(
    { type: 'plan', entries: [{ status: '__proto__' }, { status: 'completed' }] },
    { now: 0 },
  )
  assert.equal(s.count, 2)
  assert.deepEqual(Object.keys(s.statusCounts).sort(), ['completed', 'in_progress', 'pending', 'unknown'])
  assert.equal(s.statusCounts.completed, 1)
  assert.equal(s.statusCounts.unknown, 1)
  assert.equal(({}).polluted, undefined)
})

test('sanitizeCost: keeps { amount, currency } and bounds/drops arbitrary fields', () => {
  assert.deepEqual(jobs.sanitizeCost({ amount: 0.5, currency: 'usd' }), { amount: 0.5, currency: 'USD' })
  assert.deepEqual(
    jobs.sanitizeCost({ amount: 1, currency: 'bogus', evil: 'x' }),
    { amount: 1, currency: null },
  )
  assert.equal(jobs.sanitizeCost({ currency: 'USD' }), null, 'no amount → null')
  assert.equal(jobs.sanitizeCost(null), null)
  assert.equal(jobs.sanitizeCost('junk'), null)
})

test('sanitizeCost: tolerates a legacy numeric cost as { amount, currency: null }', () => {
  assert.deepEqual(jobs.sanitizeCost(0.5), { amount: 0.5, currency: null })
})

test('formatCost: renders amount + currency safely', () => {
  assert.equal(jobs.formatCost({ amount: 0.5, currency: 'USD' }), '0.5 USD')
  assert.equal(jobs.formatCost({ amount: 0.5, currency: null }), '0.5')
  assert.equal(jobs.formatCost(null), '-')
})

test('recordJobEvent: keeps at most MAX_RECENT_EVENTS and updates lastProgressAt', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  for (let i = 0; i < jobs.MAX_RECENT_EVENTS + 5; i++) {
    jobs.recordJobEvent(jobId, { type: 'message', text: `m${i}` }, { cwd: CWD, now: 1000 + i })
  }
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.meta.recentEvents.length, jobs.MAX_RECENT_EVENTS)
  assert.ok(job.meta.lastProgressAt)
})

test('classifyHealth: running job graded by time since last progress', () => {
  const base = { status: 'running', meta: { lastProgressAt: new Date(0).toISOString() } }
  assert.equal(jobs.classifyHealth(base, { now: 1000 }), 'active')
  assert.equal(jobs.classifyHealth(base, { now: jobs.HEALTH_QUIET_MS + 1 }), 'quiet')
  assert.equal(jobs.classifyHealth(base, { now: jobs.HEALTH_STALLED_MS + 1 }), 'possibly_stalled')
})

test('classifyHealth: terminal statuses map through directly', () => {
  assert.equal(jobs.classifyHealth({ status: 'done', meta: {} }), 'done')
  assert.equal(jobs.classifyHealth({ status: 'failed', meta: {} }), 'failed')
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

// --- F4: locked updater merge + concurrency ---

test('updateMeta: accepts an updater callback evaluated under the lock', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.updateMeta(jobId, { a: 1 }, CWD)
  jobs.updateMeta(jobId, (meta) => ({ b: (meta.a || 0) + 1 }), CWD)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.meta.a, 1)
  assert.equal(job.meta.b, 2, 'updater sees the freshly-read meta under the lock')
})

test('updateMeta: an updater re-reads so concurrent distinct fields are not lost', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  // Two sequential updater merges targeting distinct fields both survive.
  jobs.updateMeta(jobId, () => ({ fieldX: 'x' }), CWD)
  jobs.updateMeta(jobId, () => ({ fieldY: 'y' }), CWD)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.meta.fieldX, 'x')
  assert.equal(job.meta.fieldY, 'y')
})

test('acquireLock/releaseLock: mutual exclusion and safe release', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const dir = jobs.jobDir(jobId, CWD)
  const h = jobs.acquireLock(dir, { timeoutMs: 200 })
  // A second acquisition must time out while the first is held.
  assert.throws(() => jobs.acquireLock(dir, { timeoutMs: 100 }), /lock timeout/)
  jobs.releaseLock(h)
  // After release, acquisition succeeds again.
  const h2 = jobs.acquireLock(dir, { timeoutMs: 200 })
  jobs.releaseLock(h2)
})

test('acquireLock: recovers a stale lock past staleMs', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const dir = jobs.jobDir(jobId, CWD)
  // Hold a lock and never release it, then acquire with a tiny staleMs so the
  // held lock is considered abandoned and recovered.
  jobs.acquireLock(dir, { timeoutMs: 200 })
  const recovered = jobs.acquireLock(dir, { timeoutMs: 500, staleMs: 0 })
  assert.ok(recovered.token, 'stale lock was recovered')
  jobs.releaseLock(recovered)
})

test('withJobLock: always releases the lock even when fn throws', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const dir = jobs.jobDir(jobId, CWD)
  assert.throws(() => jobs.withJobLock(dir, () => { throw new Error('boom') }), /boom/)
  // Lock must be free afterward.
  const h = jobs.acquireLock(dir, { timeoutMs: 100 })
  jobs.releaseLock(h)
})

test('recordJobEvent: ring is computed under the lock and merges with other fields', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { sideField: 'keep-me' }, CWD)
  jobs.recordJobEvent(jobId, { type: 'message', text: 'hi' }, { cwd: CWD, now: 1000 })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.meta.sideField, 'keep-me', 'concurrent fields survive the ring update')
  assert.equal(job.meta.recentEvents.length, 1)
})

// --- F5: queued false-reap avoidance using the persisted queued PID ---

test('reapOrphans: queued past grace with a LIVE pid is not reaped (worker starting)', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.updateMeta(jobId, { pid: process.pid }, CWD) // live, no identity → starting up
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 6000
  assert.deepEqual(jobs.reapOrphans(CWD, { now, startupGraceMs: 5000 }), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'queued')
})

test('reapOrphans: queued past grace with a live pid but MISMATCHED identity fails (no signal)', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'id-A' }, CWD)
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 6000
  const reaped = jobs.reapOrphans(CWD, { now, startupGraceMs: 5000, identityFn: () => 'id-B' })
  assert.deepEqual(reaped, [jobId])
  const reapedJob = jobs.readJob(jobId, CWD)
  assert.equal(reapedJob.status, 'failed')
  assert.match(reapedJob.meta.error, /identity mismatch/)
})

test('reapOrphans: queued past grace with a DEAD pid becomes failed', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.updateMeta(jobId, { pid: 999999999 }, CWD)
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 6000
  assert.deepEqual(jobs.reapOrphans(CWD, { now, startupGraceMs: 5000 }), [jobId])
  const reaped = jobs.readJob(jobId, CWD)
  assert.equal(reaped.status, 'failed')
  assert.match(reaped.meta.error, /did not start/)
})

test('reapOrphans: legacy queued record with null pid still reaps after grace', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  // pid stays null (legacy record) → dead-by-definition → reap after grace.
  const job = jobs.readJob(jobId, CWD)
  const now = Date.parse(job.meta.createdAt) + 6000
  assert.deepEqual(jobs.reapOrphans(CWD, { now, startupGraceMs: 5000 }), [jobId])
  assert.equal(jobs.readJob(jobId, CWD).status, 'failed')
})

test('parent/worker fast-start merge: parent queued pid write does not clobber worker fields', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  // Simulate the worker starting fast: it reasserts its own pid/identity and
  // flips to running before the parent's queued write lands.
  jobs.updateMeta(jobId, {
    pid: process.pid, procIdentity: 'worker-id', startedAt: new Date().toISOString(),
  }, CWD)
  jobs.transition(jobId, 'running', CWD)
  // Parent's late queued write uses an updater that only fills absent fields.
  jobs.updateMeta(jobId, (meta) => {
    const patch = { spawnedAt: new Date().toISOString() }
    if (meta.pid == null) patch.pid = 4242
    if (meta.procIdentity == null) patch.procIdentity = 'parent-id'
    return patch
  }, CWD)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'running', 'worker status preserved')
  assert.equal(job.meta.pid, process.pid, 'worker pid not clobbered by late parent write')
  assert.equal(job.meta.procIdentity, 'worker-id', 'worker identity not clobbered')
  assert.ok(job.meta.spawnedAt, 'parent still recorded spawnedAt')
})

// --- F6: atomic temp files use a unique PID + UUID suffix ---

test('writeAtomic (via createJob): concurrent-style repeated writes never collide', () => {
  // Many rapid writes in the same process/ms must all succeed with no leftover
  // temp files (unique suffix guarantees no clobber).
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  for (let i = 0; i < 25; i++) jobs.updateMeta(jobId, { i }, CWD)
  assert.equal(jobs.readJob(jobId, CWD).meta.i, 24)
})

test('cross-process: concurrent writers under the lock lose no fields', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  const iterations = 40
  const labels = ['A', 'B', 'C']
  // Launch all writers concurrently (spawn), then wait for each.
  const children = labels.map((label) =>
    spawn(process.execPath, [WRITER, jobId, CWD, label, String(iterations)], {
      env: { ...process.env, KIRO_BRIDGE_HOME: home },
      stdio: 'ignore',
    }))
  const done = children.map((c) => new Promise((resolve) => c.once('exit', resolve)))
  return Promise.all(done).then(() => {
    const job = jobs.readJob(jobId, CWD)
    assert.ok(job.meta.marks, 'marks object exists')
    // No field loss: each label's counter reached the full iteration count.
    for (const label of labels) {
      assert.equal(job.meta.marks[label], iterations, `label ${label} lost no increments`)
    }
  })
})
