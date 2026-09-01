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

test('createJob: meta 와 queued 상태가 만들어진다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task', payloadOptions: { goal: 'g' } })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'queued')
  assert.equal(job.meta.command, 'task')
  assert.equal(job.meta.payloadOptions.goal, 'g')
})

test('transition: 유효한 전이만 허용한다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.throws(() => jobs.transition(jobId, 'done', CWD), /invalid transition/)
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  assert.equal(jobs.readJob(jobId, CWD).status, 'done')
  assert.ok(jobs.readJob(jobId, CWD).meta.finishedAt)
})

test('transition: 종결 상태는 불변이다 — 취소 경합에 뒤집히지 않는다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  assert.equal(jobs.transition(jobId, 'cancelled', CWD), 'done')
  assert.equal(jobs.readJob(jobId, CWD).status, 'done')
})

test('cwd 스코프: 다른 저장소의 잡은 보이지 않는다', () => {
  jobs.createJob({ cwd: '/tmp/repo-a', command: 'task' })
  assert.equal(jobs.listJobs({ cwd: '/tmp/repo-b' }).length, 0)
  assert.equal(jobs.listJobs({ cwd: '/tmp/repo-a' }).length, 1)
})

test('latestJobId: 시간순 마지막 잡을 돌려준다', () => {
  jobs.createJob({ cwd: CWD, command: 'task' })
  const second = jobs.createJob({ cwd: CWD, command: 'task' })
  assert.equal(jobs.latestJobId(CWD), second.jobId)
})

test('result 저장·회수 왕복', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.writeResult(jobId, '결과 본문', CWD)
  assert.equal(jobs.readResult(jobId, CWD), '결과 본문')
  assert.equal(jobs.readResult('없는-잡', CWD), null)
})

test('reapOrphans: running 인데 프로세스가 죽었으면 failed 로 처리한다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  // 존재할 수 없는 PID — kill(pid, 0) 이 실패한다.
  jobs.updateMeta(jobId, { pid: 999999999 }, CWD)
  const reaped = jobs.reapOrphans(CWD)
  assert.deepEqual(reaped, [jobId])
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'failed')
  assert.match(job.meta.error, /orphaned/)
})

test('reapOrphans: 살아있는 프로세스는 건드리지 않는다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid }, CWD) // 이 테스트 프로세스 = 확실히 살아있음
  assert.deepEqual(jobs.reapOrphans(CWD), [])
  assert.equal(jobs.readJob(jobId, CWD).status, 'running')
})

test('cancelJob: 이미 종결된 잡은 취소 실패를 명확히 알린다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.transition(jobId, 'done', CWD)
  const res = jobs.cancelJob(jobId, { cwd: CWD })
  assert.equal(res.ok, false)
  assert.match(res.reason, /종결/)
})

test('cancelJob: 살아있는 잡에 SIGTERM 을 보내고 cancelled 로 전이한다', () => {
  const { jobId } = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(jobId, 'running', CWD)
  jobs.updateMeta(jobId, { pid: process.pid }, CWD)
  const killed = []
  const res = jobs.cancelJob(jobId, { cwd: CWD, killFn: (pid) => killed.push(pid) })
  assert.equal(res.ok, true)
  assert.deepEqual(killed, [process.pid])
  assert.equal(jobs.readJob(jobId, CWD).status, 'cancelled')
})

test('gcJobs: 보존기간이 지난 종결 잡만 지운다', () => {
  const old = jobs.createJob({ cwd: CWD, command: 'task' })
  jobs.transition(old.jobId, 'running', CWD)
  jobs.transition(old.jobId, 'done', CWD)
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  jobs.updateMeta(old.jobId, { finishedAt: past }, CWD)

  const fresh = jobs.createJob({ cwd: CWD, command: 'task' }) // queued — GC 대상 아님

  const removed = jobs.gcJobs({ cwd: CWD, retentionDays: 30 })
  assert.deepEqual(removed, [old.jobId])
  assert.equal(jobs.readJob(old.jobId, CWD), null)
  assert.ok(jobs.readJob(fresh.jobId, CWD))
})
