import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseModelList,
  suggestModel,
  listModels,
  validateModel,
  assertModelSupported,
  MODEL_CAPS,
  MODEL_CACHE_TTL_MS,
  formatModels,
} from '../scripts/lib/models.mjs'
import { parseArgs, validateCommandFlags } from '../scripts/bridge.mjs'
import { loadUserConfig, saveConfig, getCachedModels } from '../scripts/lib/config.mjs'

let home
const original = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-models-'))
  process.env.KIRO_BRIDGE_HOME = home
})

afterEach(() => {
  if (original === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = original
  rmSync(home, { recursive: true, force: true })
})

const LIST = JSON.stringify({
  models: [
    { model_id: 'auto', description: 'Models chosen by task' },
    { model_id: 'claude-opus-5', description: 'Claude Opus 5 model' },
    { model_id: 'gpt-5.6-sol', description: 'Experimental preview of GPT 5.6 Sol' },
    { model_id: 'claude-sonnet-5', description: 'Claude Sonnet 5 model' },
  ],
  default_model: 'auto',
})

// execFile stub: (bin, args, opts, cb)
function stub({ version = 'kiro-cli 2.21.0\n', list = LIST, listErr = null } = {}) {
  const calls = []
  const fn = (bin, args, _opts, cb) => {
    calls.push(args)
    if (args.includes('--version')) return cb(null, version, '')
    if (args.includes('--list-models')) {
      return listErr ? cb(listErr, '', 'boom') : cb(null, list, '')
    }
    return cb(new Error(`unexpected args: ${args.join(' ')}`), '', '')
  }
  fn.calls = calls
  return fn
}

// --- parsing ---

test('parseModelList reads ids and the default from the --format json payload', () => {
  const parsed = parseModelList(LIST)
  assert.deepEqual(parsed.models.map((m) => m.id), ['auto', 'claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5'])
  assert.equal(parsed.defaultModel, 'auto')
})

test('parseModelList returns null on malformed output rather than throwing', () => {
  assert.equal(parseModelList('not json at all'), null)
  assert.equal(parseModelList('{"models":"nope"}'), null)
})

test('parseModelList drops ids that are not plain identifiers', () => {
  const hostile = JSON.stringify({
    models: [
      { model_id: 'ok-1', description: 'fine' },
      { model_id: 'bad id with spaces', description: 'x' },
      { model_id: '\u001B[31mred', description: 'x' },
      { model_id: '', description: 'x' },
      { model_id: 42, description: 'x' },
    ],
  })
  assert.deepEqual(parseModelList(hostile).models.map((m) => m.id), ['ok-1'])
})

test('parseModelList caps the entry count and description length', () => {
  const many = JSON.stringify({
    models: Array.from({ length: MODEL_CAPS.count + 20 }, (_, i) => ({
      model_id: `m-${i}`,
      description: 'd'.repeat(MODEL_CAPS.description + 50),
    })),
  })
  const parsed = parseModelList(many)
  assert.equal(parsed.models.length, MODEL_CAPS.count)
  assert.ok(parsed.models[0].description.length <= MODEL_CAPS.description)
})

test('parseModelList strips terminal control sequences from descriptions', () => {
  const parsed = parseModelList(JSON.stringify({
    models: [{ model_id: 'ok', description: 'plain\u001B]52;c;cGF5bG9hZA==\u0007 text' }],
  }))
  assert.equal(parsed.models[0].description, 'plain text')
})

// --- suggestions ---

const MODELS = parseModelList(LIST).models

test('suggestModel maps a short nickname onto the full id', () => {
  assert.deepEqual(suggestModel('sol', MODELS), ['gpt-5.6-sol'])
})

test('suggestModel ignores separators and case', () => {
  assert.deepEqual(suggestModel('OPUS5', MODELS), ['claude-opus-5'])
})

test('suggestModel tolerates a small typo', () => {
  assert.deepEqual(suggestModel('claude-sonet-5', MODELS), ['claude-sonnet-5'])
})

test('suggestModel returns nothing for input with no relation', () => {
  assert.deepEqual(suggestModel('zzzzzzzzzz', MODELS), [])
})

// --- discovery + cache ---

test('listModels reads from kiro-cli and caches under the version key', async () => {
  const execFileFn = stub()
  const first = await listModels({ execFileFn })
  assert.equal(first.cached, false)
  assert.equal(first.version, '2.21.0')
  assert.deepEqual(first.models.map((m) => m.id), ['auto', 'claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5'])

  const cachedEntry = getCachedModels(loadUserConfig(), '2.21.0')
  assert.ok(cachedEntry)
  assert.equal(cachedEntry.defaultModel, 'auto')

  const second = await listModels({ execFileFn: stub() })
  assert.equal(second.cached, true)
})

test('listModels re-probes once the cache entry is older than the TTL', async () => {
  await listModels({ execFileFn: stub() })
  const later = await listModels({ execFileFn: stub(), now: Date.now() + MODEL_CACHE_TTL_MS + 1 })
  assert.equal(later.cached, false)
})

test('listModels force-refreshes past a warm cache', async () => {
  await listModels({ execFileFn: stub() })
  const forced = await listModels({ execFileFn: stub(), force: true })
  assert.equal(forced.cached, false)
})

test('listModels reports a discovery failure instead of inventing a list', async () => {
  await assert.rejects(
    () => listModels({ execFileFn: stub({ listErr: new Error('exit 2') }) }),
    (err) => err.code === 'PROTOCOL' || err.code === 'TRANSPORT_UNAVAILABLE',
  )
})

// --- validation ---

test('validateModel accepts a known id', async () => {
  const res = await validateModel('gpt-5.6-sol', { execFileFn: stub() })
  assert.equal(res.ok, true)
  assert.equal(res.verified, true)
})

test('validateModel rejects an unknown id and points at the real one', async () => {
  const res = await validateModel('sol', { execFileFn: stub() })
  assert.equal(res.ok, false)
  assert.deepEqual(res.suggestions, ['gpt-5.6-sol'])
})

test('validateModel is a no-op when no model was requested', async () => {
  const execFileFn = stub()
  const res = await validateModel(undefined, { execFileFn })
  assert.equal(res.ok, true)
  assert.equal(execFileFn.calls.length, 0, 'must not spawn anything when there is nothing to check')
})

// A new model released after this kiro-cli version, or an offline discovery
// call, must never become a hard block — kiro-cli stays the authority.
test('validateModel passes the value through when discovery is unavailable', async () => {
  const res = await validateModel('some-new-model', { execFileFn: stub({ listErr: new Error('exit 2') }) })
  assert.equal(res.ok, true)
  assert.equal(res.verified, false)
})

test('assertModelSupported throws a message naming the suggestion', async () => {
  await assert.rejects(
    () => assertModelSupported('sol', { execFileFn: stub() }),
    (err) => err.code === 'PROTOCOL' && /gpt-5\.6-sol/.test(err.message) && /models/.test(err.details.reason),
  )
})

test('assertModelSupported stays silent for a valid id', async () => {
  await assertModelSupported('claude-opus-5', { execFileFn: stub() })
})

// --- CLI wiring ---

test('parseArgs accepts `models` with --force and --json', () => {
  const { command, flags } = parseArgs(['models', '--force', '--json'])
  assert.equal(command, 'models')
  assert.equal(flags.force, true)
  assert.equal(flags.json, true)
  validateCommandFlags('models', flags)
})

test('models rejects flags that mean nothing to it', () => {
  assert.throws(() => validateCommandFlags('models', { model: 'claude-opus-5' }), /--model/)
  assert.throws(() => validateCommandFlags('models', { background: true }), /--bg/)
})

test('formatModels lists every id and marks the default', () => {
  const text = formatModels({ ...parseModelList(LIST), version: '2.21.0', cached: false })
  for (const id of ['auto', 'claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5']) {
    assert.ok(text.includes(id), `missing ${id}`)
  }
  assert.match(text, /auto.*\(default\)/)
  assert.ok(text.includes('2.21.0'))
})

// --- cache entries are disk content, not something we get to assume we wrote ---

function seedCache(entry) {
  saveConfig({ ...loadUserConfig(), models: { '2.21.0': entry } })
}

const FRESH = new Date().toISOString()

test('listModels re-probes when the cache entry has no models array', async () => {
  seedCache({ detectedAt: FRESH })
  const res = await listModels({ execFileFn: stub() })
  assert.equal(res.cached, false, 'a shapeless entry must not be served')
  assert.deepEqual(res.models.map((m) => m.id), ['auto', 'claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5'])
})

test('listModels re-probes when the cache entry holds ids of the wrong shape', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: '--trust-all-tools', description: 'x' }] })
  const res = await listModels({ execFileFn: stub() })
  assert.equal(res.cached, false)
  assert.ok(!res.models.some((m) => m.id.startsWith('-')), 'flag-shaped id must never survive')
})

test('listModels keeps serving a cache entry that is still well formed', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'claude-opus-5', description: 'ok' }] })
  const res = await listModels({ execFileFn: stub() })
  assert.equal(res.cached, true)
  assert.deepEqual(res.models.map((m) => m.id), ['claude-opus-5'])
})

test('validateModel survives a corrupted cache instead of throwing', async () => {
  seedCache({ detectedAt: FRESH, models: 'not an array' })
  const res = await validateModel('gpt-5.6-sol', { execFileFn: stub() })
  assert.equal(res.ok, true)
  assert.equal(res.verified, true)
})

test('descriptions cannot forge extra rows in the models listing', () => {
  const parsed = parseModelList(JSON.stringify({
    models: [{ model_id: 'ok', description: 'real\n  fake-model      Looks like its own row' }],
  }))
  assert.ok(!parsed.models[0].description.includes('\n'))
  assert.equal(formatModels({ ...parsed, version: '2.21.0', cached: false }).split('\n')
    .filter((l) => l.startsWith('  ')).length, 1)
})

// --- a stale cache must never be the reason an id is rejected ---

// The cache is up to 24h behind, and the account's model set can change inside
// that window. "Not in the cache" is therefore not evidence of "kiro-cli does
// not know it" — only a fresh list is.
test('an id missing from the cache is re-checked against a fresh list before rejecting', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'auto', description: 'stale' }] })
  const execFileFn = stub()
  const res = await validateModel('claude-opus-5', { execFileFn })
  assert.equal(res.ok, true, 'a live model must not be rejected on stale cache evidence')
  assert.ok(
    execFileFn.calls.some((args) => args.includes('--list-models')),
    'rejection path must refresh rather than trust the cache',
  )
})

test('an id absent from the fresh list is still rejected', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'auto', description: 'stale' }] })
  const res = await validateModel('sol', { execFileFn: stub() })
  assert.equal(res.ok, false)
  assert.deepEqual(res.suggestions, ['gpt-5.6-sol'])
})

test('a hit in a warm cache costs no extra spawn', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'claude-opus-5', description: 'ok' }] })
  const execFileFn = stub()
  const res = await validateModel('claude-opus-5', { execFileFn })
  assert.equal(res.ok, true)
  assert.ok(!execFileFn.calls.some((args) => args.includes('--list-models')), 'no refresh needed on a hit')
})

test('a refresh that fails leaves the id passed through, not rejected', async () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'auto', description: 'stale' }] })
  const res = await validateModel('claude-opus-5', { execFileFn: stub({ listErr: new Error('offline') }) })
  assert.equal(res.ok, true)
  assert.equal(res.verified, false)
})

// --- end-to-end: the CLI must actually run the check ---

// The unit tests above all call validateModel directly, so deleting the
// assertModelSupported call in bridge.mjs would leave them green. This drives
// the real binary with a kiro-cli shim on PATH instead.
function runBridge(args, env = {}, cwd = undefined) {
  const shimDir = mkdtempSync(join(tmpdir(), 'kiro-bridge-shim-'))
  const mock = join(import.meta.dirname, 'fixtures', 'mock-kiro-cli.mjs')
  writeFileSync(join(shimDir, 'kiro-cli'), `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, { mode: 0o755 })
  try {
    return spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'bridge.mjs'), ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, KIRO_BRIDGE_HOME: home, ...env },
    })
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
  }
}

// A throwaway repo with one uncommitted change.
//
// `review` collects its diff from the process cwd, so a test that runs it
// without a cwd reviews *this* repo — and only reaches the dry-run payload
// while this working tree happens to be dirty. On a clean checkout (CI, or
// right after committing) the same test gets "No reviewable changes" instead,
// and the assertion fails for a reason that has nothing to do with --model.
function withReviewableRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-bridge-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  try {
    git('init', '-q')
    writeFileSync(join(dir, 'app.mjs'), 'export const answer = 1\n')
    git('add', 'app.mjs')
    // Identity is passed per-invocation — a test must not depend on, or touch,
    // the developer's git config.
    git('-c', 'user.email=test@example.invalid', '-c', 'user.name=kiro-bridge test',
      'commit', '-q', '-m', 'seed')
    writeFileSync(join(dir, 'app.mjs'), 'export const answer = 2\n')
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the CLI rejects an unknown --model before running the command', () => {
  const res = runBridge(['review', '--model', 'sol', '--dry-run'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /unknown --model "sol"/)
  assert.match(res.stderr, /gpt-5\.6-sol/)
  assert.equal(res.stdout.trim(), '', 'the command must not run')
})

test('the CLI lets a known --model through to the command', () => {
  withReviewableRepo((repo) => {
    const res = runBridge(['review', '--model', 'claude-opus-5', '--dry-run'], {}, repo)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /\[dry-run\]/)
  })
})

test('the CLI reports an unknown --model through the --json envelope', () => {
  const res = runBridge(['review', '--model', 'sol', '--dry-run', '--json'])
  assert.equal(res.status, 1)
  const envelope = JSON.parse(res.stdout)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'PROTOCOL')
  assert.match(envelope.error.message, /gpt-5\.6-sol/)
})

test('models emits the discovered list as a --json envelope', () => {
  const res = runBridge(['models', '--json'])
  assert.equal(res.status, 0)
  const envelope = JSON.parse(res.stdout)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.command, 'models')
  assert.equal(envelope.defaultModel, 'auto')
  assert.deepEqual(envelope.models.map((m) => m.id), ['auto', 'claude-opus-5', 'gpt-5.6-sol'])
})

test('a cache entry that only partly survives normalization is not served', async () => {
  seedCache({
    detectedAt: FRESH,
    defaultModel: 'auto',
    models: [{ id: 'claude-opus-5', description: 'ok' }, { id: '--trust-all-tools', description: 'x' }],
  })
  const res = await listModels({ execFileFn: stub() })
  assert.equal(res.cached, false, 'a partly-corrupt entry must be replaced, not silently trimmed')
  assert.deepEqual(res.models.map((m) => m.id), ['auto', 'claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5'])
})

test('suggestModel does not answer a one-character input with arbitrary ids', () => {
  assert.deepEqual(suggestModel('5', MODELS), [])
})

test('an unknown command is reported as such, without running model discovery', () => {
  const execFileFn = stub()
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'auto', description: 'ok' }] })
  const res = runBridge(['bogus', '--model', 'sol'])
  assert.match(res.stderr, /unknown command: bogus/)
  assert.doesNotMatch(res.stderr, /unknown --model/)
  assert.equal(execFileFn.calls.length, 0)
})

test('a --json rejection carries the suggestions as data, not only in the message', () => {
  const res = runBridge(['review', '--model', 'sol', '--dry-run', '--json'])
  const envelope = JSON.parse(res.stdout)
  assert.deepEqual(envelope.error.suggestions, ['gpt-5.6-sol'])
})

// The regression behind Important #1, at the CLI level: a warm cache that
// predates a model must not be the reason the CLI rejects it.
test('the CLI accepts a model the warm cache has not heard of yet', () => {
  seedCache({ detectedAt: FRESH, defaultModel: 'auto', models: [{ id: 'auto', description: 'stale' }] })
  withReviewableRepo((repo) => {
    const res = runBridge(['review', '--model', 'claude-opus-5', '--dry-run'], {}, repo)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /\[dry-run\]/)
  })
})
