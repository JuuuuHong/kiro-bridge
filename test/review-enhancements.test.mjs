// Focused tests for the review enhancements: --focus / --adversarial / --bg
// parsing + allow-list, focus/adversarial payload + constraints, background
// persistence and worker execution, cancellation, and reviewer-agent selection
// on a review job follow-up. Existing tests remain the source of truth for the
// pre-existing behaviour; these only cover the additions.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  review, formatSummary, buildReviewGoal, reviewConstraints,
} from '../scripts/lib/review.mjs'
import { runWorker, result, reviewBackground } from '../scripts/lib/task.mjs'
import { parseArgs, validateCommandFlags } from '../scripts/bridge.mjs'
import { AGENT_PREFIX } from '../scripts/lib/agents.mjs'
import { TRUST_FENCE } from '../scripts/lib/findings.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'
import * as jobs from '../scripts/lib/jobs.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-rev-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/tmp/fake-repo'

const DIFF = `diff --git a/src/app.mjs b/src/app.mjs
+++ b/src/app.mjs
@@ -1 +1,2 @@
+const x = 1
`

const fakeCollect = async () => ({
  diff: DIFF,
  files: [{ path: 'src/app.mjs', reason: 'changed in diff' }],
  untracked: [],
  ref: 'HEAD',
})

const OK_RESPONSE = JSON.stringify({
  findings: [{ severity: 'high', file: 'src/app.mjs', line: 1, claim: 'c', evidence: 'e', suggestion: 's' }],
  summary: '1 finding',
})

// --- parsing + allow-list ---

test('parseArgs: review captures --focus, --adversarial, and --bg', () => {
  const { command, flags } = parseArgs(['review', 'main', '--focus', 'auth boundaries', '--adversarial', '--bg'])
  assert.equal(command, 'review')
  assert.deepEqual(flags._, ['main'])
  assert.equal(flags.focus, 'auth boundaries')
  assert.equal(flags.adversarial, true)
  assert.equal(flags.background, true)
})

test('parseArgs: --focus requires a non-empty value', () => {
  assert.throws(() => parseArgs(['review', '--focus']), /requires .*value/)
  assert.throws(() => parseArgs(['review', '--focus', '   ']), /non-empty value/)
  assert.throws(() => parseArgs(['review', '--focus', '--adversarial']), /requires .*value/)
})

test('validateCommandFlags: review allows focus/adversarial/bg; task and others reject them', () => {
  const rev = parseArgs(['review', '--focus', 'x', '--adversarial', '--bg'])
  assert.doesNotThrow(() => validateCommandFlags(rev.command, rev.flags))

  const taskAdv = parseArgs(['task', 'goal', '--adversarial'])
  assert.throws(() => validateCommandFlags(taskAdv.command, taskAdv.flags), /--adversarial is not supported by task/)

  const taskFocus = parseArgs(['task', 'goal', '--focus', 'x'])
  assert.throws(() => validateCommandFlags(taskFocus.command, taskFocus.flags), /--focus is not supported by task/)

  const specBg = parseArgs(['spec', 'goal', '--focus', 'x'])
  assert.throws(() => validateCommandFlags(specBg.command, specBg.flags), /--focus is not supported by spec/)
})

test('validateCommandFlags: --bg + --dry-run is rejected for both review and task', () => {
  for (const cmd of ['review', 'task']) {
    const argv = cmd === 'task' ? [cmd, 'goal', '--bg', '--dry-run'] : [cmd, '--bg', '--dry-run']
    const parsed = parseArgs(argv)
    assert.throws(() => validateCommandFlags(parsed.command, parsed.flags), /--bg cannot be combined with --dry-run/)
  }
})

// --- focus / adversarial goal + constraints ---

test('buildReviewGoal: appends non-empty focus, ignores empty/whitespace', () => {
  const base = buildReviewGoal({})
  assert.match(base, /report defects as findings JSON/)
  assert.doesNotMatch(base, /Focus/)

  const focused = buildReviewGoal({ focus: 'session fixation' })
  assert.match(focused, /Focus especially on: session fixation/)

  assert.equal(buildReviewGoal({ focus: '   ' }), base, 'whitespace focus is ignored')
})

test('reviewConstraints: adversarial adds skeptical pressure-testing constraints, still read-only', () => {
  const std = reviewConstraints({})
  const adv = reviewConstraints({ adversarial: true })
  assert.ok(adv.length > std.length)
  const joined = adv.join('\n').toLowerCase()
  for (const probe of ['trust boundaries', 'concurrency', 'rollback', 'data-loss', 'alternative design']) {
    assert.ok(joined.includes(probe), `adversarial constraints must mention ${probe}`)
  }
  // Read-only / findings-only invariant is preserved.
  assert.ok(joined.includes('read-only'))
  assert.ok(std.some((c) => /do not modify files/i.test(c)))
})

test('review: focus is included in the outbound goal and passes through redaction', async () => {
  let sent = null
  await review({
    collectDiffFn: fakeCollect,
    focus: 'authz and injection AKIAIOSFODNN7EXAMPLE',
    config: CONFIG_DEFAULTS,
    runFn: async (payload) => { sent = payload; return { transport: 'acp', sessionId: 's', result: OK_RESPONSE } },
  })
  assert.match(sent.goal, /Focus especially on: authz and injection/)
  // Redaction runs on the whole goal, including the focus text.
  assert.ok(!sent.goal.includes('AKIAIOSFODNN7EXAMPLE'), 'focus text must be redacted like any outbound string')
  assert.match(sent.goal, /\[REDACTED:/)
})

test('review: adversarial constraints reach the outbound payload; standard does not', async () => {
  let advPayload = null
  await review({
    collectDiffFn: fakeCollect,
    adversarial: true,
    config: CONFIG_DEFAULTS,
    runFn: async (payload) => { advPayload = payload; return { transport: 'acp', sessionId: 's', result: OK_RESPONSE } },
  })
  const advText = advPayload.constraints.join('\n').toLowerCase()
  assert.ok(advText.includes('adversarial'))
  assert.ok(advText.includes('trust boundaries'))

  let stdPayload = null
  await review({
    collectDiffFn: fakeCollect,
    config: CONFIG_DEFAULTS,
    runFn: async (payload) => { stdPayload = payload; return { transport: 'acp', sessionId: 's', result: OK_RESPONSE } },
  })
  assert.ok(!stdPayload.constraints.join('\n').toLowerCase().includes('adversarial'))
})

test('formatSummary: header and dry-run identify standard vs adversarial', async () => {
  const std = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 's', result: OK_RESPONSE }),
  })
  assert.match(formatSummary(std), /mode: standard/)

  const adv = await review({
    collectDiffFn: fakeCollect,
    adversarial: true,
    runFn: async () => ({ transport: 'acp', sessionId: 's', result: OK_RESPONSE }),
  })
  assert.match(formatSummary(adv), /mode: adversarial/)

  const dry = await review({
    collectDiffFn: fakeCollect,
    adversarial: true,
    dryRun: true,
    config: CONFIG_DEFAULTS,
    runFn: async () => { throw new Error('must not send') },
  })
  assert.match(formatSummary(dry), /mode: adversarial/)
})

// --- background persistence: payload options only carry safe fields ---

test('reviewBackground: persists only selectors — never diff, files, or collected signal output', async () => {
  const spawned = []
  const bg = reviewBackground({
    ref: 'main',
    focus: 'concurrency',
    adversarial: true,
    model: 'model-x',
    effort: 'high',
    timeoutMs: 5000,
    cwd: CWD,
    spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: 5151, unref() {} } },
  })
  assert.ok(bg.jobId)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args[1], '_worker')
  assert.equal(spawned[0].args[2], bg.jobId)
  assert.equal(spawned[0].opts.detached, true)

  const job = jobs.readJob(bg.jobId, CWD)
  assert.equal(job.meta.command, 'review')
  const po = job.meta.payloadOptions
  assert.deepEqual(Object.keys(po).sort(), [
    'adversarial', 'effort', 'focus', 'model', 'noSignals', 'ref', 'signalsPath',
    'staged', 'timeoutMs',
  ])
  assert.equal(po.ref, 'main')
  assert.equal(po.focus, 'concurrency')
  assert.equal(po.adversarial, true)
  assert.ok(!('diff' in po), 'diff must never be persisted in the job payload')
  assert.ok(!('files' in po), 'file contents must never be persisted in the job payload')
  // Signals follow the same rule as the diff: only the selector is persisted,
  // so captured test output never sits in job metadata waiting to be read.
  assert.equal(po.signalsPath, null)
  assert.equal(po.noSignals, false)
  assert.equal(po.staged, false, 'diff scope travels as a selector, resolved in the worker')
  assert.ok(!('signals' in po), 'collected signal output must never be persisted')
  assert.equal(job.meta.pid, 5151, 'parent records the spawned pid while queued')
})

// --- worker execution: diff collected in the worker, same wrapped body ---

test('runWorker: review job collects the diff in the worker and stores the wrapped findings body', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD,
    command: 'review',
    payloadOptions: { ref: null, focus: 'auth', adversarial: true, model: 'model-x', effort: 'high' },
  })

  let collected = false
  let sentPayload = null
  let sentOptions = null
  await runWorker(jobId, {
    cwd: CWD,
    collectDiffFn: async () => { collected = true; return fakeCollect() },
    runFn: async (payload, options) => {
      sentPayload = payload
      sentOptions = options
      return { transport: 'acp', sessionId: 'rev-sess', result: OK_RESPONSE }
    },
  })

  assert.equal(collected, true, 'the worker itself collects the diff')
  assert.equal(sentOptions.agent, `${AGENT_PREFIX}reviewer`, 'review runs under the reviewer agent')
  assert.equal(sentOptions.model, 'model-x')
  assert.equal(sentOptions.effort, 'high')
  assert.match(sentPayload.goal, /Focus especially on: auth/)
  assert.ok(sentPayload.constraints.join('\n').toLowerCase().includes('adversarial'))

  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'done')
  assert.equal(job.meta.sessionId, 'rev-sess')
  const body = jobs.readResult(jobId, CWD)
  assert.ok(body.includes(TRUST_FENCE.open), 'result body is the same wrapped findings as foreground')
  assert.match(body, /findings/)
})

test('runWorker: a review job with no reviewable changes stores the empty message, not undefined', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'review', payloadOptions: { ref: null },
  })
  await runWorker(jobId, {
    cwd: CWD,
    collectDiffFn: async () => ({ diff: '', files: [], untracked: [], ref: 'HEAD' }),
    runFn: async () => { throw new Error('must not send for an empty review') },
  })
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'done')
  const body = jobs.readResult(jobId, CWD)
  assert.ok(body && body.length > 0)
  assert.match(body, /No reviewable changes/)
})

// --- cancellation semantics carry over unchanged for review jobs ---

test('runWorker: cancel winning before completion leaves no result body (review job)', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'review', payloadOptions: { ref: null },
  })
  const workerResult = await runWorker(jobId, {
    cwd: CWD,
    collectDiffFn: fakeCollect,
    runFn: async (payload, options) => {
      jobs.transition(jobId, 'cancelled', CWD)
      return { transport: 'acp', sessionId: 's', result: OK_RESPONSE }
    },
  })
  assert.equal(workerResult, null)
  const job = jobs.readJob(jobId, CWD)
  assert.equal(job.status, 'cancelled')
  assert.equal(jobs.readResult(jobId, CWD), null, 'a cancelled review persists no result body')
})

test('runWorker: a review job cancelled before worker start never sends', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'review', payloadOptions: { ref: null },
  })
  jobs.transition(jobId, 'cancelled', CWD)
  let sent = false
  const r = await runWorker(jobId, {
    cwd: CWD,
    collectDiffFn: async () => { sent = true; return fakeCollect() },
    runFn: async () => { sent = true },
  })
  assert.equal(r, null)
  assert.equal(sent, false)
})

// --- reviewer agent selection on a review job follow-up ---

test('result --follow-up: a review job continues under the reviewer agent, not researcher', async () => {
  const { jobId } = jobs.createJob({
    cwd: CWD, command: 'review', payloadOptions: { ref: null },
  })
  await runWorker(jobId, {
    cwd: CWD,
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 'rev-sess', result: OK_RESPONSE }),
  })

  let followOptions = null
  const res = await result({
    cwd: CWD,
    jobId,
    followUp: 'expand on the highest-severity finding',
    runFn: async (payload, options) => {
      followOptions = options
      return { transport: 'acp', sessionId: 'rev-sess', result: OK_RESPONSE }
    },
  })
  assert.equal(followOptions.agent, `${AGENT_PREFIX}reviewer`)
  assert.equal(followOptions.sessionId, 'rev-sess')
  assert.ok(res.followUp.wrapped.includes(TRUST_FENCE.open))
})
