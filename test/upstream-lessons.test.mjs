// Defects found by studying comparable CLI-bridge plugins' issue trackers and
// checking whether the same failure shape exists here. Each test fails against
// the pre-fix code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as jobs from '../scripts/lib/jobs.mjs'
import { runWorker } from '../scripts/lib/task.mjs'
import { bridgeError, CODES } from '../scripts/lib/errors.mjs'
import { collectDiff, symlinkExclusionReason } from '../scripts/lib/git.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'
import { isHelpRequest } from '../scripts/bridge.mjs'

// A repo with one commit, awaited so the async body cannot outlive it.
async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-up-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    return await fn(dir, git)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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

// --- A symlink must not smuggle an excluded file past the exclusion list ----
//
// The exclusion list matches the path git reports. A link named `notes.md`
// pointing at `secrets/real.pem` passes that check, and the payload then tells
// Kiro to read the path — its read tool follows the link, and the file the list
// promised would never leave the machine leaves anyway.

test('git: a symlink to an excluded file is withheld', async () => {
  await withRepo(async (dir, git) => {
    mkdirSync(join(dir, 'secrets'))
    writeFileSync(join(dir, 'secrets', 'real.pem'), 'PRIVATE KEY\n')
    symlinkSync('secrets/real.pem', join(dir, 'notes.md'))
    writeFileSync(join(dir, 'normal.mjs'), 'ok\n')
    git('add', '-A')

    const r = await collectDiff({ cwd: dir, excludeFiles: CONFIG_DEFAULTS.redaction.excludeFiles })
    assert.deepEqual(r.files.map((f) => f.path), ['normal.mjs'])
    assert.ok(r.excludedFiles.includes('notes.md'), 'the link itself must be reported as withheld')
  })
})

test('git: a symlink pointing outside the repository is withheld', async () => {
  await withRepo(async (dir, git) => {
    symlinkSync('/etc/hosts', join(dir, 'outside.md'))
    writeFileSync(join(dir, 'normal.mjs'), 'ok\n')
    git('add', '-A')

    const r = await collectDiff({ cwd: dir, excludeFiles: [] })
    assert.deepEqual(r.files.map((f) => f.path), ['normal.mjs'])
    assert.ok(r.excludedFiles.includes('outside.md'))
  })
})

test('git: an ordinary symlink inside the repo is still reviewable', async () => {
  await withRepo(async (dir, git) => {
    writeFileSync(join(dir, 'target.mjs'), 'export const a = 1\n')
    symlinkSync('target.mjs', join(dir, 'alias.mjs'))
    git('add', '-A')

    const r = await collectDiff({ cwd: dir, excludeFiles: CONFIG_DEFAULTS.redaction.excludeFiles })
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['alias.mjs', 'target.mjs'])
    assert.deepEqual(r.excludedFiles, [])
  })
})

test('symlinkExclusionReason returns null for a plain file', async () => {
  await withRepo(async (dir) => {
    writeFileSync(join(dir, 'plain.mjs'), 'x\n')
    assert.equal(symlinkExclusionReason('plain.mjs', { cwd: dir, excludeFiles: ['*.pem'] }), null)
  })
})

// --- A request for usage must never become a delegated goal ----------------

test('a bare help token is usage, not a goal that spends credits', () => {
  for (const token of ['-h', '-?', 'help', '--help', '-H']) {
    assert.equal(isHelpRequest([token]), true, `${token} must be treated as usage`)
  }
})

test('a goal that merely mentions a flag still delegates', () => {
  assert.equal(isHelpRequest(['fix', 'the', '-h', 'handling']), false)
  assert.equal(isHelpRequest(['help', 'me', 'debug', 'this']), false)
  assert.equal(isHelpRequest([]), false)
})

// --- A diff larger than the read buffer must be named, not a raw stack ------

test('git: an oversized diff surfaces as a classified error', async () => {
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === 'rev-parse') return cb(null, 'true\n', '')
    const err = new Error('stdout maxBuffer length exceeded')
    err.code = 'ENOBUFS'
    return cb(err, '', '')
  }
  await assert.rejects(
    collectDiff({ cwd: '/repo', execFileFn }),
    (err) => {
      assert.equal(err.code, CODES.PROTOCOL)
      assert.match(err.details.reason, /exceeded .*MB/)
      return true
    },
  )
})
