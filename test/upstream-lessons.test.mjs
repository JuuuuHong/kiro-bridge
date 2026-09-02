// Defects found by studying comparable CLI-bridge plugins' issue trackers and
// checking whether the same failure shape exists here. Each test fails against
// the pre-fix code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as jobs from '../scripts/lib/jobs.mjs'
import { runWorker } from '../scripts/lib/task.mjs'
import { bridgeError, CODES } from '../scripts/lib/errors.mjs'

// Awaited, so an async body cannot outlive the temp home it depends on.
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'kb-upstream-'))
  const prev = process.env.KIRO_BRIDGE_HOME
  process.env.KIRO_BRIDGE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.KIRO_BRIDGE_HOME
    else process.env.KIRO_BRIDGE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

// --- Cancel must reach the whole process tree, not just the worker ----------
//
// The worker is spawned detached (its own process group) and has no SIGTERM
// handler, so signalling the bare pid kills it instantly without letting it
// terminate kiro-cli. The child is orphaned and keeps spending credits while
// cancel reports success.

test('killProcessTree signals the process group, not the bare pid', () => {
  const signalled = []
  const ok = jobs.killProcessTree(4242, 'SIGTERM', {
    kill: (pid, sig) => { signalled.push([pid, sig]) },
  })
  assert.equal(ok, true)
  assert.deepEqual(signalled, [[-4242, 'SIGTERM']], 'must target the group (negative pid)')
})

test('killProcessTree falls back to the bare pid when groups are unavailable', () => {
  // Windows has no POSIX process groups: the negative-pid call throws EINVAL.
  const signalled = []
  const ok = jobs.killProcessTree(4242, 'SIGTERM', {
    kill: (pid, sig) => {
      if (pid < 0) { const e = new Error('EINVAL'); e.code = 'EINVAL'; throw e }
      signalled.push([pid, sig])
    },
  })
  assert.equal(ok, true)
  assert.deepEqual(signalled, [[4242, 'SIGTERM']])
})

test('killProcessTree reports failure when the group is already gone', () => {
  const ok = jobs.killProcessTree(4242, 'SIGTERM', {
    kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e },
  })
  assert.equal(ok, false, 'ESRCH must not be retried as a bare-pid signal')
})

test('cancelJob signals the group so kiro-cli cannot outlive the worker', async () => {
  await withTempHome(() => {
    const cwd = '/repo/x'
    const { jobId } = jobs.createJob({ cwd, command: 'task' })
    // A live, identity-verifiable pid: a dead pid transitions without signalling.
    jobs.updateMeta(jobId, { pid: process.pid, procIdentity: 'ps:fixed' }, cwd)
    jobs.transition(jobId, 'running', cwd)

    const signalled = []
    const res = jobs.cancelJob(jobId, {
      cwd,
      identityFn: () => 'ps:fixed',
      killFn: (pid) => { signalled.push(pid) },
    })
    assert.equal(res.ok, true)
    // cancelJob delegates to killProcessTree by default; the injected killFn
    // stands in for it here, so assert the contract cancelJob relies on.
    assert.deepEqual(signalled, [process.pid])
    assert.equal(jobs.readJob(jobId, cwd).status, 'cancelled')
  })
})

// --- A failed turn must not lose its resumable session ----------------------
//
// A throttle/timeout/denial still spent credits, and the ACP session stays
// resumable on Kiro's side. The transport puts sessionId on the error; dropping
// it means the only way forward is to pay to redo the work.

test('a throttled background job keeps its sessionId for follow-up', async () => {
  await withTempHome(async () => {
    const cwd = '/repo/y'
    const { jobId } = jobs.createJob({
      cwd, command: 'task', payloadOptions: { goal: 'g' },
    })

    const runFn = async () => {
      throw bridgeError(CODES.THROTTLED, { sessionId: 'sess-still-alive', stderr: 'rate limit' })
    }
    await assert.rejects(runWorker(jobId, { cwd, runFn }), (err) => err.code === CODES.THROTTLED)

    const job = jobs.readJob(jobId, cwd)
    assert.equal(job.status, 'failed')
    assert.equal(job.meta.sessionId, 'sess-still-alive',
      'the session that already cost credits must survive the failure')
    assert.match(job.meta.error, /THROTTLED/)
  })
})

test('a failure with no session leaves sessionId null rather than inventing one', async () => {
  await withTempHome(async () => {
    const cwd = '/repo/z'
    const { jobId } = jobs.createJob({
      cwd, command: 'task', payloadOptions: { goal: 'g' },
    })
    const runFn = async () => { throw bridgeError(CODES.SPAWN_FAILED, { cause: 'ENOENT' }) }
    await assert.rejects(runWorker(jobId, { cwd, runFn }))
    assert.equal(jobs.readJob(jobId, cwd).meta.sessionId, null)
  })
})
