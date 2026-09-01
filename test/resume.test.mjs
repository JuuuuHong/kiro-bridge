import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resume, formatResume } from '../scripts/lib/resume.mjs'
import { registerSession, listSessions } from '../scripts/lib/sessions.mjs'
import { AGENT_PREFIX } from '../scripts/lib/agents.mjs'
import { TRUST_FENCE } from '../scripts/lib/findings.mjs'
import { CODES } from '../scripts/lib/errors.mjs'
import { readUsage } from '../scripts/lib/usage.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-resume-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/tmp/resume-repo'

const okRun = (overrides = {}) => async (payload, options) => ({
  sessionId: options.sessionId || 'sess-new',
  transport: 'acp',
  result: JSON.stringify({ findings: [], summary: 'resumed answer' }),
  metadata: { contextUsagePercentage: 7 },
  _seen: { payload, options },
  ...overrides,
})

function seedResearcher(overrides = {}) {
  return registerSession({
    sessionId: 'sess-orig',
    agent: `${AGENT_PREFIX}researcher`,
    source: { kind: 'task', command: 'task' },
    write: false,
    transport: 'acp',
    ...overrides,
  }, { cwd: CWD })
}

// --- validation ---

test('resume: rejects an empty question', async () => {
  seedResearcher()
  await assert.rejects(() => resume({ question: '  ', cwd: CWD }), (err) => err.code === CODES.PROTOCOL)
})

test('resume: clear PROTOCOL error when no resumable session exists', async () => {
  await assert.rejects(
    () => resume({ question: 'q', cwd: CWD, runFn: async () => { throw new Error('must not call') } }),
    (err) => err.code === CODES.PROTOCOL && /no resumable ACP session/.test(err.details.reason),
  )
})

test('resume: clear PROTOCOL error when an explicit --session does not match', async () => {
  seedResearcher()
  await assert.rejects(
    () => resume({ question: 'q', session: 'no-match', cwd: CWD, runFn: async () => { throw new Error('nope') } }),
    (err) => err.code === CODES.PROTOCOL && /matches "no-match"/.test(err.details.reason),
  )
})

// --- resumes with the original agent + session, passes options ---

test('resume: reuses the recorded sessionId with the original agent + options', async () => {
  seedResearcher()
  let seen
  const res = await resume({
    question: 'follow-up question',
    cwd: CWD,
    model: 'model-x',
    effort: 'high',
    timeoutMs: 1234,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}researcher`)
  assert.equal(seen.options.sessionId, 'sess-orig')
  assert.equal(seen.options.model, 'model-x')
  assert.equal(seen.options.effort, 'high')
  assert.equal(seen.options.timeoutMs, 1234)
  assert.equal(seen.payload.kind, 'task')
  assert.equal(seen.payload.goal, 'follow-up question')
  assert.ok(res.wrapped.includes(TRUST_FENCE.open))
})

test('resume: a reviewer session stays a reviewer (not downgraded to researcher)', async () => {
  registerSession({
    sessionId: 'sess-rev',
    agent: `${AGENT_PREFIX}reviewer`,
    source: { kind: 'review', command: 'review' },
    write: false,
    transport: 'acp',
  }, { cwd: CWD })
  let seen
  await resume({
    question: 'why is this a defect?',
    cwd: CWD,
    runFn: async (payload, options) => { seen = { payload, options }; return okRun()(payload, options) },
  })
  assert.equal(seen.options.agent, `${AGENT_PREFIX}reviewer`)
})

test('resume: preserves webDerived wrapping for the researcher agent', async () => {
  seedResearcher()
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun() })
  assert.match(res.wrapped, /Web-derived/)
})

test('resume: reviewer wrapping omits the web-derived warning', async () => {
  registerSession({
    sessionId: 'sess-rev',
    agent: `${AGENT_PREFIX}reviewer`,
    source: { kind: 'review', command: 'review' },
    write: false,
    transport: 'acp',
  }, { cwd: CWD })
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun() })
  assert.doesNotMatch(res.wrapped, /Web-derived/)
})

// --- exact selection ---

test('resume: --session accepts a recordId', async () => {
  const first = seedResearcher({ sessionId: 'sess-1' })
  seedResearcher({ sessionId: 'sess-2' })
  let seen
  await resume({
    question: 'q', session: first.recordId, cwd: CWD,
    runFn: async (p, o) => { seen = o; return okRun()(p, o) },
  })
  assert.equal(seen.sessionId, 'sess-1')
})

test('resume: --session accepts a raw sessionId', async () => {
  seedResearcher({ sessionId: 'sess-A' })
  seedResearcher({ sessionId: 'sess-B' })
  let seen
  await resume({
    question: 'q', session: 'sess-A', cwd: CWD,
    runFn: async (p, o) => { seen = o; return okRun()(p, o) },
  })
  assert.equal(seen.sessionId, 'sess-A')
})

// --- redaction on the outbound question ---

test('resume: the question goes through outbound redaction', async () => {
  seedResearcher()
  let sent
  await resume({
    question: 'here is a key AKIAIOSFODNN7EXAMPLE do not leak',
    cwd: CWD,
    config: CONFIG_DEFAULTS,
    runFn: async (payload) => { sent = payload; return okRun()(payload, { sessionId: 'sess-orig' }) },
  })
  assert.ok(!sent.goal.includes('AKIAIOSFODNN7EXAMPLE'), 'the AWS key must be redacted')
  assert.match(sent.goal, /\[REDACTED:/)
})

// --- registration of the resumed turn + source/new ids ---

test('resume: registers the resumed turn and returns source + new record ids', async () => {
  const orig = seedResearcher()
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun({ sessionId: 'sess-next' }) })
  assert.equal(res.sourceRecordId, orig.recordId)
  assert.ok(res.sessionRecordId)
  assert.notEqual(res.sessionRecordId, orig.recordId)
  const all = listSessions({ cwd: CWD })
  const created = all.find((r) => r.recordId === res.sessionRecordId)
  assert.equal(created.sessionId, 'sess-next')
  assert.equal(created.source.command, 'resume')
  assert.equal(created.source.kind, 'task')
})

test('resume: a resumed worker session preserves the write flag on the new record', async () => {
  seedResearcher({ agent: `${AGENT_PREFIX}worker`, source: { kind: 'task', command: 'task' }, write: true })
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun({ sessionId: 'sess-w' }) })
  const created = listSessions({ cwd: CWD }).find((r) => r.recordId === res.sessionRecordId)
  assert.equal(created.write, true)
})

test('resume: a subprocess/null-session reply creates no new record', async () => {
  seedResearcher()
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun({ sessionId: null, transport: 'subprocess' }) })
  assert.equal(res.sessionRecordId, null)
  // Only the seeded record remains.
  assert.equal(listSessions({ cwd: CWD }).length, 1)
})

// --- usage metering success + failure ---

test('resume: meters a successful call as command "resume"', async () => {
  seedResearcher()
  await resume({
    question: 'q', cwd: CWD, model: 'model-x',
    runFn: okRun({ metadata: { contextUsagePercentage: 15, usage: { used: 3, size: 4, cost: { amount: 0.01, currency: 'USD' } } } }),
  })
  const rec = readUsage().find((u) => u.command === 'resume')
  assert.ok(rec)
  assert.equal(rec.ok, true)
  assert.equal(rec.agent, `${AGENT_PREFIX}researcher`)
  assert.equal(rec.model, 'model-x')
  assert.equal(rec.contextUsagePercentage, 15)
  assert.equal(rec.acpUsed, 3)
  assert.equal(rec.acpCostAmount, 0.01)
})

test('resume: meters a failed call as command "resume" (ok:false)', async () => {
  seedResearcher()
  await assert.rejects(
    () => resume({ question: 'q', cwd: CWD, model: 'model-x', runFn: async () => { throw new Error('boom') } }),
    /boom/,
  )
  const rec = readUsage().find((u) => u.command === 'resume')
  assert.ok(rec)
  assert.equal(rec.ok, false)
  assert.equal(rec.model, 'model-x')
})

// --- formatting ---

test('formatResume: shows the resumed source and a next-resume hint', async () => {
  const orig = seedResearcher()
  const res = await resume({ question: 'q', cwd: CWD, runFn: okRun({ sessionId: 'sess-next' }) })
  const out = formatResume(res)
  assert.match(out, new RegExp(`resumed: ${orig.recordId}`))
  assert.match(out, /Resume again:.*--session/)
  assert.ok(out.includes(TRUST_FENCE.open))
})
