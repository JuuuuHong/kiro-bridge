import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { review, formatSummary } from '../scripts/lib/review.mjs'
import { setup } from '../scripts/lib/setup.mjs'
import { parseArgs, validateCommandFlags } from '../scripts/bridge.mjs'
import {
  renderAgent, agentHash, installAgent, probeToolNaming, AGENT_DEFS, TOOL_NAME_SETS,
} from '../scripts/lib/agents.mjs'
import { collectDiff } from '../scripts/lib/git.mjs'
import { TRUST_FENCE } from '../scripts/lib/findings.mjs'
import { CODES, MESSAGES } from '../scripts/lib/errors.mjs'
import { CONFIG_DEFAULTS, saveConfig, loadConfig } from '../scripts/lib/config.mjs'
import { readUsage } from '../scripts/lib/usage.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-cmd-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const DIFF = `diff --git a/src/app.mjs b/src/app.mjs
+++ b/src/app.mjs
@@ -1 +1,2 @@
+const token = "AKIAIOSFODNN7EXAMPLE"
`

const fakeCollect = async () => ({
  diff: DIFF,
  files: [{ path: 'src/app.mjs', reason: 'changed in diff' }],
  ref: 'HEAD',
})

const OK_RESPONSE = JSON.stringify({
  findings: [{ severity: 'high', file: 'src/app.mjs', line: 1, claim: 'hardcoded key', evidence: 'e', suggestion: 's' }],
  summary: '1 finding',
})

// --- argument parsing ---

test('parseArgs: separates flags from positional args', () => {
  const { command, flags } = parseArgs(['review', 'main', '--dry-run', '--model', 'model-x', '--effort', 'high', '--timeout', '500'])
  assert.equal(command, 'review')
  assert.deepEqual(flags._, ['main'])
  assert.equal(flags.dryRun, true)
  assert.equal(flags.model, 'model-x')
  assert.equal(flags.effort, 'high')
  assert.equal(flags.timeoutMs, 500)
})

test('parseArgs: rejects unknown flags', () => {
  assert.throws(() => parseArgs(['review', '--yolo']), /unknown flag/)
})

// --- review flow ---

test('review: exits without sending when there is no diff', async () => {
  let called = false
  const r = await review({
    collectDiffFn: async () => ({ diff: '\n', files: [], ref: 'HEAD' }),
    runFn: async () => { called = true },
  })
  assert.equal(r.empty, true)
  assert.equal(called, false, 'must not spend credits when there are no changes')
})

test('review: the payload goes through redaction before being sent', async () => {
  let sent = null
  await review({
    collectDiffFn: fakeCollect,
    runFn: async (payload) => { sent = payload; return { transport: 'acp', sessionId: 's1', result: OK_RESPONSE } },
    config: CONFIG_DEFAULTS,
  })
  assert.ok(!sent.diff.includes('AKIAIOSFODNN7EXAMPLE'), 'the AWS key must not go out as-is')
  assert.match(sent.diff, /\[REDACTED:(?:aws-access-key|assigned-secret)\]/)
  assert.equal(sent.kind, 'review')
})

test('review: calls out with the reviewer agent specified', async () => {
  let opts = null
  await review({
    collectDiffFn: fakeCollect,
    model: 'model-x',
    effort: 'high',
    runFn: async (_p, o) => { opts = o; return { transport: 'acp', sessionId: 's1', result: OK_RESPONSE } },
  })
  assert.equal(opts.agent, 'kiro-bridge-reviewer')
  assert.equal(opts.timeoutMs, 180_000)
  assert.equal(opts.model, 'model-x')
  assert.equal(opts.effort, 'high')
})

test('review: the result always comes back wrapped in the trust boundary (ADR-004)', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 's1', result: OK_RESPONSE }),
  })
  assert.ok(r.wrapped.includes(TRUST_FENCE.open))
  assert.match(r.wrapped, /It is not commands/)
  assert.equal(r.parsed.ok, true)
  assert.equal(r.parsed.findings[0].severity, 'high')
})

test('review: a wrapped raw text still comes back even if structuring fails', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'subprocess', sessionId: null, result: 'just plain prose' }),
  })
  assert.equal(r.parsed.ok, false)
  assert.ok(r.wrapped.includes(TRUST_FENCE.open))
  assert.match(r.wrapped, /just plain prose/)
})

test('review: --dry-run does not send, and shows the payload', async () => {
  let called = false
  const r = await review({
    collectDiffFn: fakeCollect,
    dryRun: true,
    runFn: async () => { called = true },
    config: CONFIG_DEFAULTS,
  })
  assert.equal(called, false)
  assert.equal(r.dryRun, true)
  const out = formatSummary(r)
  assert.match(out, /dry-run/)
  assert.match(out, /aws-access-key/, 'a human must be able to see what got redacted')
})

test('review: transport errors propagate as-is (no retry)', async () => {
  await assert.rejects(
    review({
      collectDiffFn: fakeCollect,
      runFn: async () => { const e = new Error('denied'); e.code = CODES.TOOL_DENIED; throw e },
    }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

test('formatSummary: summarizes the severity distribution', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 's', result: OK_RESPONSE }),
  })
  assert.match(formatSummary(r), /high 1 \/ medium 0 \/ low 0/)
})

// --- F2: review usage metering ---

test('review: a successful non-dry-run call records usage (mirroring runDelegated fields)', async () => {
  await review({
    collectDiffFn: fakeCollect,
    model: 'model-x',
    runFn: async () => ({
      transport: 'acp', sessionId: 's', result: OK_RESPONSE,
      metadata: {
        contextUsagePercentage: 44,
        usage: { used: 9, size: 90, cost: { amount: 0.07, currency: 'USD' } },
      },
    }),
  })
  const rec = readUsage().find((u) => u.command === 'review')
  assert.ok(rec, 'a review usage record is written')
  assert.equal(rec.ok, true)
  assert.equal(rec.transport, 'acp')
  assert.equal(rec.agent, 'kiro-bridge-reviewer')
  assert.equal(rec.model, 'model-x')
  assert.equal(rec.contextUsagePercentage, 44)
  assert.equal(rec.acpUsed, 9)
  assert.equal(rec.acpSize, 90)
  assert.equal(rec.acpCostAmount, 0.07)
  assert.equal(rec.acpCostCurrency, 'USD')
})

test('review: a failed non-dry-run call still records usage as failed', async () => {
  await assert.rejects(
    review({
      collectDiffFn: fakeCollect,
      runFn: async () => { const e = new Error('denied'); e.code = CODES.TOOL_DENIED; throw e },
    }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
  const rec = readUsage().find((u) => u.command === 'review')
  assert.ok(rec, 'a failed review still records usage')
  assert.equal(rec.ok, false)
})

test('review: dry-run does not record usage (no credit spent)', async () => {
  await review({ collectDiffFn: fakeCollect, dryRun: true, config: CONFIG_DEFAULTS, runFn: async () => { throw new Error('must not call') } })
  assert.equal(readUsage().filter((u) => u.command === 'review').length, 0)
})

test('review: an empty (no-change) review does not record usage', async () => {
  await review({
    collectDiffFn: async () => ({ diff: '\n', files: [], untracked: [], ref: 'HEAD' }),
    runFn: async () => { throw new Error('must not call') },
  })
  assert.equal(readUsage().filter((u) => u.command === 'review').length, 0)
})

// --- agent definitions ---

test('agents: reviewer only trusts read and never gets write (ADR-002)', () => {
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')
  assert.deepEqual(rendered.tools, ['read', 'grep', 'glob'])
  assert.ok(!rendered.tools.includes('write'))
  assert.ok(!rendered.tools.includes('shell'))
})

test('agents: changing the naming convention only changes tool names', () => {
  const prefixed = renderAgent(AGENT_DEFS.reviewer, 'prefixed')
  assert.deepEqual(prefixed.tools, ['fs_read', 'grep', 'glob'])
  assert.equal(prefixed.prompt, renderAgent(AGENT_DEFS.reviewer, 'short').prompt)
})

test('agents: the validate probe picks whichever convention passes (OQ4)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'))
  // fake validate that rejects short and only passes prefixed
  const validateFn = async (path) => {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    if (json.tools.includes('read')) throw new Error('unknown tool: read')
    return true
  }
  const probe = await probeToolNaming(AGENT_DEFS.reviewer, {
    tmpPath: join(scratch, 'a.json'),
    validateFn,
  })
  assert.equal(probe.toolSet, 'prefixed')
  assert.equal(probe.attempts.length, 1)
  rmSync(scratch, { recursive: true, force: true })
})

test('agents: if both fail, toolSet is null and the attempt history is kept', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'))
  const probe = await probeToolNaming(AGENT_DEFS.reviewer, {
    tmpPath: join(scratch, 'a.json'),
    validateFn: async () => { throw new Error('nope') },
  })
  assert.equal(probe.toolSet, null)
  assert.equal(probe.attempts.length, Object.keys(TOOL_NAME_SETS).length)
  rmSync(scratch, { recursive: true, force: true })
})

test('agents: a file the user modified is not overwritten (design §6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')

  const first = installAgent(rendered, { dir })
  assert.equal(first.action, 'installed')

  // User touched it — the hash now diverges from the stamp
  const target = join(dir, `${rendered.name}.json`)
  const modified = JSON.parse(readFileSync(target, 'utf8'))
  modified.prompt = 'my custom prompt'
  writeFileSync(target, JSON.stringify(modified, null, 2))

  const second = installAgent(rendered, { dir })
  assert.equal(second.action, 'skipped')
  assert.match(second.reason, /user-modified/)
  assert.match(readFileSync(target, 'utf8'), /my custom prompt/)

  rmSync(dir, { recursive: true, force: true })
})

test('agents: an untouched, same-version install is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')
  installAgent(rendered, { dir })
  assert.equal(installAgent(rendered, { dir }).action, 'unchanged')
  rmSync(dir, { recursive: true, force: true })
})

test('agents: the hash only looks at the body, excluding the stamp', () => {
  const a = renderAgent(AGENT_DEFS.reviewer, 'short')
  const b = { ...a, _kiroBridge: { version: '9.9.9', toolSet: 'short' } }
  assert.equal(agentHash(a), agentHash(b))
})

// --- setup flow ---

test('setup: stops immediately and guides the user when kiro-cli is missing', async () => {
  const r = await setup({ execFileFn: (_b, _a, _o, cb) => cb(new Error('ENOENT'), '', '') })
  assert.equal(r.ok, false)
  assert.equal(r.steps[0].step, 'version')
  assert.match(r.hint, /Install/)
})

test('setup: guides to login and skips agent install when unauthenticated', async () => {
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === '--version') return cb(null, 'kiro-cli 2.20.1\n', '')
    if (args[0] === 'whoami') return cb(new Error('not logged in'), '', 'not logged in')
    return cb(null, '', '')
  }
  const r = await setup({ execFileFn })
  assert.equal(r.ok, false)
  assert.match(r.hint, /login/)
  assert.ok(!r.steps.some((s) => s.step.startsWith('agent:')), 'must not install agents while unauthenticated')
})

test('setup: the happy path installs agents and records the convention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === '--version') return cb(null, 'kiro-cli 2.20.1\n', '')
    if (args[0] === 'whoami') return cb(null, 'user@example.com\n', '')
    return cb(null, '', '')
  }
  const r = await setup({
    execFileFn,
    dir,
    probeFn: async () => ({ available: true }),
    validateFn: async () => true,
  })
  const agentStep = r.steps.find((s) => s.step === 'agent:reviewer')
  assert.ok(agentStep.ok)
  assert.match(agentStep.detail, /installed/)
  assert.ok(existsSync(join(dir, 'kiro-bridge-reviewer.json')))
  rmSync(dir, { recursive: true, force: true })
})

// --- git argument safety ---

test('git: ref is passed only as an argument array and never touches a shell', async () => {
  const calls = []
  const execFileFn = (bin, args, _o, cb) => {
    calls.push({ bin, args })
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'rev-parse') return cb(null, 'abc\n', '')
    if (args.includes('--name-only')) return cb(null, 'src/a.mjs\0', '')
    return cb(null, 'diff text\n', '')
  }
  await collectDiff({ ref: 'main; rm -rf /', execFileFn })
  const diffCall = calls.find((c) => c.args[0] === 'diff' && !c.args.includes('--name-only'))
  assert.ok(diffCall.args.includes('main; rm -rf /'), 'ref is passed whole as a single argument')
  assert.ok(diffCall.args.includes('--'), 'must include -- to block option injection')
})

test('git: a clear error when not a repository', async () => {
  await assert.rejects(
    collectDiff({ execFileFn: (_b, _a, _o, cb) => cb(null, 'false\n', '') }),
    (err) => /not a git repository/.test(err.details.reason),
  )
})

// --- untracked files: prevent a silently empty-handed review (regression) ---

test('review: proceeds with the review even with only untracked files', async () => {
  let sent = null
  const r = await review({
    collectDiffFn: async () => ({
      diff: '',
      files: [{ path: 'new.mjs', reason: 'untracked new file — not in diff, read it directly to review' }],
      untracked: ['new.mjs'],
      ref: 'HEAD',
    }),
    runFn: async (payload) => { sent = payload; return { transport: 'acp', sessionId: 's', result: OK_RESPONSE } },
  })
  assert.notEqual(r.empty, true, 'must not skip reviewing new files just because diff is empty')
  assert.equal(sent.files[0].path, 'new.mjs')
  assert.match(sent.files[0].reason, /read it directly/)
})

test('review: empty only when there really are no changes at all', async () => {
  const r = await review({
    collectDiffFn: async () => ({ diff: '', files: [], untracked: [], ref: 'HEAD' }),
    runFn: async () => { throw new Error('must not be called') },
  })
  assert.equal(r.empty, true)
})

test('git: untracked collects only paths, never content', async () => {
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'ls-files') return cb(null, 'brand-new.mjs\0', '')
    if (args.includes('--name-only')) return cb(null, '', '')
    return cb(null, '', '')
  }
  const r = await collectDiff({ execFileFn })
  assert.deepEqual(r.untracked, ['brand-new.mjs'])
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].excerpt, undefined, 'content is never included (ADR-003 decision 5)')
})

test('git: specifying ref does not mix in working-tree untracked files', async () => {
  const calls = []
  const execFileFn = (_b, args, _o, cb) => {
    calls.push(args[0])
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'rev-parse') return cb(null, 'abc\n', '')
    return cb(null, '', '')
  }
  const r = await collectDiff({ ref: 'main', execFileFn })
  assert.deepEqual(r.untracked, [])
  assert.ok(!calls.includes('ls-files'))
})


test('review: excluded tracked files never enter payload.diff', async () => {
  const secret = 'abcdefghijklmnopqrstuvwx'
  const calls = []
  const execFileFn = (_bin, args, _opts, cb) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return cb(null, 'true\n', '')
    if (args[0] === 'ls-files') return cb(null, '', '')
    if (args.includes('--name-only')) return cb(null, '.env\0', '')
    return cb(null, `diff --git a/.env b/.env\n+SERVICE_TOKEN=${secret}\n`, '')
  }

  const r = await review({
    dryRun: true,
    config: CONFIG_DEFAULTS,
    collectDiffFn: (options) => collectDiff({ ...options, execFileFn }),
  })

  assert.equal(r.empty, true, 'excluded-only changes must not call Kiro')
  assert.deepEqual(r.excludedFiles, ['.env'])
  assert.equal(calls.some((args) => args[0] === 'diff' && !args.includes('--name-only')), false,
    'git diff content must not be read for excluded paths')
  assert.ok(!JSON.stringify(r).includes(secret))
})


test('parseArgs: rejects missing, non-finite, and non-positive timeout values', () => {
  assert.throws(() => parseArgs(['review', '--timeout']), /requires .*value/)
  assert.throws(() => parseArgs(['review', '--timeout', 'abc']), /positive finite/)
  assert.throws(() => parseArgs(['review', '--timeout', '0']), /positive finite/)
  assert.throws(() => parseArgs(['review', '--timeout', '-1']), /positive finite/)
})

test('parseArgs: rejects a missing value for model and follow-up', () => {
  assert.throws(() => parseArgs(['task', '--model']), /requires .*value/)
  assert.throws(() => parseArgs(['result', '--follow-up', '--quiet']), /requires .*value/)
})

test('validateCommandFlags: model overrides are limited to delegated commands', () => {
  for (const argv of [
    ['review', '--model', 'x', '--effort', 'high'],
    ['task', 'goal', '--model', 'x'],
    ['spec', 'goal', '--effort', 'high'],
    ['result', 'job', '--follow-up', 'q', '--model', 'x', '--effort', 'high'],
  ]) {
    const parsed = parseArgs(argv)
    assert.doesNotThrow(() => validateCommandFlags(parsed.command, parsed.flags))
  }
  const setupArgs = parseArgs(['setup', '--model', 'x'])
  assert.throws(() => validateCommandFlags(setupArgs.command, setupArgs.flags), /not supported by setup/)
  for (const argv of [
    ['result', 'job', '--model', 'x'],
    ['result', 'job', '--effort', 'high'],
    ['result', 'job', '--timeout', '1000'],
    ['result', 'job', '--quiet'],
  ]) {
    const parsed = parseArgs(argv)
    assert.throws(() => validateCommandFlags(parsed.command, parsed.flags), /require --follow-up/)
  }
  const statusArgs = parseArgs(['status', '--quiet'])
  assert.throws(() => validateCommandFlags(statusArgs.command, statusArgs.flags), /not supported by status/)
})

test('agents: a managed older version is reported as updated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')
  const first = installAgent(rendered, { dir })
  const existing = JSON.parse(readFileSync(first.target, 'utf8'))
  existing._kiroBridge.version = '0.0.0'
  writeFileSync(first.target, JSON.stringify(existing, null, 2))
  assert.equal(installAgent(rendered, { dir }).action, 'updated')
  rmSync(dir, { recursive: true, force: true })
})

// --- F6: atomic temp files use a unique suffix ---

test('config: repeated saves in the same process never collide (unique temp suffix)', () => {
  for (let i = 0; i < 20; i++) {
    saveConfig({ ...CONFIG_DEFAULTS, logRetentionDays: i })
  }
  assert.equal(loadConfig().logRetentionDays, 19)
})

test('errors: throttled guidance points to the installed command namespace', () => {
  assert.match(MESSAGES[CODES.THROTTLED], /\/kiro-bridge:status/)
  assert.doesNotMatch(MESSAGES[CODES.THROTTLED], /`\/kiro:status`/)
})


test('git: excluded untracked files are separated from reviewable files', async () => {
  const execFileFn = (_bin, args, _opts, cb) => {
    if (args[0] === 'rev-parse') return cb(null, 'true\n', '')
    if (args[0] === 'ls-files') return cb(null, '.env\0src/new.mjs\0', '')
    if (args.includes('--name-only')) return cb(null, '', '')
    return cb(null, '', '')
  }
  const r = await collectDiff({
    execFileFn,
    excludeFiles: CONFIG_DEFAULTS.redaction.excludeFiles,
  })
  assert.deepEqual(r.files.map((f) => f.path), ['src/new.mjs'])
  assert.deepEqual(r.untracked, ['src/new.mjs'])
  assert.deepEqual(r.excludedFiles, ['.env'])
})


test('setup: ACP probe exception falls back to subprocess without failing install', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const execFileFn = (_bin, args, _opts, cb) => {
    if (args[0] === '--version') return cb(null, 'kiro-cli 2.20.1\n', '')
    if (args[0] === 'whoami') return cb(null, 'user@example.com\n', '')
    return cb(null, '', '')
  }
  const r = await setup({
    execFileFn,
    dir,
    probeFn: async () => { throw new Error('temporary ACP failure') },
    validateFn: async () => true,
  })
  const transport = r.steps.find((step) => step.step === 'transport')
  assert.equal(r.ok, true)
  assert.equal(r.capability.transport, 'subprocess')
  assert.equal(transport.ok, true)
  assert.equal(transport.warning, true)
  assert.ok(r.steps.some((step) => step.step === 'agent:reviewer' && step.ok))
  rmSync(dir, { recursive: true, force: true })
})


test('parseArgs: rejects an empty follow-up value', () => {
  assert.throws(() => parseArgs(['result', '--follow-up', '   ']), /non-empty value/)
})

// --- resume command parsing / validation ---

test('parseArgs: resume separates the question from --session and execution flags', () => {
  const { command, flags } = parseArgs(['resume', 'why', 'is', 'this', '--session', 'rec-1', '--model', 'm', '--effort', 'high', '--timeout', '5000', '--quiet'])
  assert.equal(command, 'resume')
  assert.deepEqual(flags._, ['why', 'is', 'this'])
  assert.equal(flags.session, 'rec-1')
  assert.equal(flags.model, 'm')
  assert.equal(flags.effort, 'high')
  assert.equal(flags.timeoutMs, 5000)
  assert.equal(flags.quiet, true)
})

test('parseArgs: --session requires a non-empty value', () => {
  assert.throws(() => parseArgs(['resume', 'q', '--session']), /requires .*value/)
  assert.throws(() => parseArgs(['resume', 'q', '--session', '   ']), /non-empty value/)
})

test('validateCommandFlags: resume accepts session/model/effort/timeout/quiet', () => {
  const parsed = parseArgs(['resume', 'q', '--session', 'r', '--model', 'm', '--effort', 'high', '--timeout', '1000', '--quiet'])
  assert.doesNotThrow(() => validateCommandFlags(parsed.command, parsed.flags))
})

test('validateCommandFlags: --session is not allowed on other commands', () => {
  const parsed = parseArgs(['task', 'goal', '--session', 'r'])
  assert.throws(() => validateCommandFlags(parsed.command, parsed.flags), /--session is not supported by task/)
})

test('validateCommandFlags: --follow-up is not allowed on resume', () => {
  const parsed = parseArgs(['resume', 'q', '--follow-up', 'x'])
  assert.throws(() => validateCommandFlags(parsed.command, parsed.flags), /--follow-up is not supported by resume/)
})
