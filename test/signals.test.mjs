import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNAL_KEYS,
  normalizeSignals,
  tailTruncate,
  validateTestCommand,
  runTestCommand,
  readSignalsFile,
  collectSignals,
} from '../scripts/lib/signals.mjs'
import { buildPayload, LIMITS } from '../scripts/lib/context.mjs'
import { applyProjectConfig, CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'

test('normalizeSignals keeps only whitelisted non-empty strings', () => {
  const out = normalizeSignals({
    failing_tests: '3 failed',
    lint: '  ',
    notes: 'ok',
    evil: 'drop me',
    numeric: 12,
  })
  assert.deepEqual(Object.keys(out), ['failing_tests', 'notes'])
  assert.equal(out.failing_tests, '3 failed')
})

test('normalizeSignals returns null when nothing survives', () => {
  assert.equal(normalizeSignals({ evil: 'x' }), null)
  assert.equal(normalizeSignals(null), null)
  assert.equal(normalizeSignals([]), null)
  assert.equal(normalizeSignals('failing_tests'), null)
})

test('tailTruncate keeps the tail, where the failures are', () => {
  const text = `${'a'.repeat(LIMITS.signal)}TAIL`
  const out = tailTruncate(text)
  assert.ok(out.endsWith('TAIL'), 'the end of the output must survive')
  assert.ok(out.startsWith('… [truncated'))
  assert.ok(out.length <= LIMITS.signal + 64)
})

test('tailTruncate leaves short text untouched', () => {
  assert.equal(tailTruncate('short'), 'short')
})

test('validateTestCommand rejects a shell string with an actionable message', () => {
  assert.throws(() => validateTestCommand('npm test'), (err) => {
    assert.match(err.message, /argv array/)
    assert.match(err.message, /never runs a shell/)
    return true
  })
})

test('validateTestCommand rejects non-string or empty entries', () => {
  assert.throws(() => validateTestCommand(['npm', '']), /non-string or empty/)
  assert.throws(() => validateTestCommand(['npm', 7]), /non-string or empty/)
})

test('validateTestCommand normalizes absent and empty to null', () => {
  assert.equal(validateTestCommand(null), null)
  assert.equal(validateTestCommand(undefined), null)
  assert.equal(validateTestCommand([]), null)
})

test('runTestCommand captures output when the command exits non-zero', async () => {
  const execFileFn = (bin, args, opts, cb) => {
    assert.equal(bin, 'npm')
    assert.deepEqual(args, ['test'])
    cb(Object.assign(new Error('exit 1'), { code: 1 }), 'FAIL suite\n', 'stderr line\n')
  }
  const res = await runTestCommand(['npm', 'test'], { execFileFn })
  assert.equal(res.ok, true)
  assert.match(res.text, /\$ npm test/)
  assert.match(res.text, /\[exit 1\]/)
  assert.match(res.text, /FAIL suite/)
  assert.match(res.text, /stderr line/)
})

test('runTestCommand reports a spawn failure instead of an empty pass-looking signal', async () => {
  const execFileFn = (bin, args, opts, cb) => {
    cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '')
  }
  const res = await runTestCommand(['nope'], { execFileFn })
  assert.equal(res.ok, false)
  assert.match(res.reason, /failed to run: ENOENT/)
})

test('runTestCommand marks a timeout rather than passing partial output off as complete', async () => {
  const execFileFn = (bin, args, opts, cb) => {
    cb(Object.assign(new Error('killed'), { killed: true }), 'partial', '')
  }
  const res = await runTestCommand(['npm', 'test'], { execFileFn, timeoutMs: 5 })
  assert.equal(res.ok, true)
  assert.match(res.text, /timed out after 5ms/)
})

test('runTestCommand child env drops credentials like any kiro-cli spawn', async () => {
  let seenEnv
  const execFileFn = (bin, args, opts, cb) => { seenEnv = opts.env; cb(null, 'ok', '') }
  await runTestCommand(['npm', 'test'], {
    execFileFn,
    config: { envPassthrough: [] },
  })
  assert.equal(seenEnv.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined)
  assert.equal(seenEnv.NO_COLOR, '1')
})

test('readSignalsFile rejects unparseable and key-less files', () => {
  assert.throws(
    () => readSignalsFile('/x', { readFileFn: () => 'not json' }),
    /could not read/,
  )
  assert.throws(
    () => readSignalsFile('/x', { readFileFn: () => '{"evil":"x"}' }),
    /no usable keys/,
  )
})

test('readSignalsFile normalizes a valid file', () => {
  const out = readSignalsFile('/x', {
    readFileFn: () => JSON.stringify({ failing_tests: '2 failed', evil: 'x' }),
  })
  assert.deepEqual(out, { failing_tests: '2 failed' })
})

test('collectSignals: --no-signals wins over everything', async () => {
  const out = await collectSignals({
    disabled: true,
    signalsPath: '/x',
    config: { signals: { testCommand: ['npm', 'test'] } },
    runTestCommandFn: () => assert.fail('must not run'),
    readSignalsFileFn: () => assert.fail('must not read'),
  })
  assert.deepEqual(out, { signals: null, note: null })
})

test('collectSignals: an explicit --signals file beats a configured command', async () => {
  const out = await collectSignals({
    signalsPath: '/given',
    config: { signals: { testCommand: ['npm', 'test'] } },
    runTestCommandFn: () => assert.fail('must not run when a file was given'),
    readSignalsFileFn: (path) => {
      assert.equal(path, '/given')
      return { notes: 'from file' }
    },
  })
  assert.deepEqual(out.signals, { notes: 'from file' })
})

test('collectSignals falls back to the configured command when no file is given', async () => {
  const out = await collectSignals({
    config: { signals: { testCommand: ['npm', 'test'], timeoutMs: 42 } },
    runTestCommandFn: (argv, opts) => {
      assert.deepEqual(argv, ['npm', 'test'])
      assert.equal(opts.timeoutMs, 42)
      return { ok: true, text: 'captured' }
    },
  })
  assert.deepEqual(out.signals, { failing_tests: 'captured' })
})

test('collectSignals yields nothing when neither source is configured', async () => {
  const out = await collectSignals({ config: {} })
  assert.deepEqual(out, { signals: null, note: null })
})

test('collectSignals degrades a run failure to a note, never an exception', async () => {
  const out = await collectSignals({
    config: { signals: { testCommand: ['nope'] } },
    runTestCommandFn: () => ({ ok: false, reason: 'boom' }),
  })
  assert.equal(out.signals, null)
  assert.equal(out.note, 'boom')
})

test('collected signals ride the normal outbound redaction path', () => {
  const { payload } = buildPayload({
    kind: 'review',
    goal: 'g',
    diff: 'd',
    signals: { failing_tests: 'expected AKIAIOSFODNN7EXAMPLE in output' },
  })
  assert.ok(!payload.signals.failing_tests.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.match(payload.signals.failing_tests, /REDACTED/)
})

test('payload signal keys and the module whitelist stay in agreement', () => {
  const { payload } = buildPayload({
    kind: 'review',
    goal: 'g',
    diff: 'd',
    signals: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 'x'])),
  })
  assert.deepEqual(Object.keys(payload.signals).sort(), [...SIGNAL_KEYS].sort())
})

test('a repository config can never hand the bridge a command to execute', () => {
  const user = { ...CONFIG_DEFAULTS, signals: { testCommand: [], timeoutMs: 1000 } }
  const merged = applyProjectConfig(user, {
    signals: { testCommand: ['curl', 'http://evil.example.com'] },
    // Paired with a legitimate tightening key so the merge is not short-circuited
    // by the "nothing to add" early return.
    redaction: { excludeFiles: ['secrets/**'] },
  })
  assert.deepEqual(merged.signals.testCommand, [], 'project layer must not inject a command')
  assert.ok(merged.redaction.excludeFiles.includes('secrets/**'), 'tightening still applies')
})
