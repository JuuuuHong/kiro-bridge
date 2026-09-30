import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRefSpec, resolveRef, collectDiff } from '../scripts/lib/git.mjs'
import { buildPayload, LIMITS } from '../scripts/lib/context.mjs'
import { review } from '../scripts/lib/review.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'

// A stub git: records every argv it is handed and answers the few reads
// collectDiff performs. `diffNames` is returned NUL-separated, as -z produces.
function fakeGit({ diffNames = [], untracked = [], knownRefs = null, diff = 'D' } = {}) {
  const calls = []
  const execFileFn = (bin, args, opts, cb) => {
    calls.push(args)
    const joined = args.join(' ')
    if (joined.startsWith('rev-parse --is-inside-work-tree')) return cb(null, 'true\n', '')
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      const target = args[args.length - 1]
      if (knownRefs && !knownRefs.some((r) => target.startsWith(r))) {
        return cb(Object.assign(new Error('bad rev'), { code: 128 }), '', '')
      }
      return cb(null, 'abc123\n', '')
    }
    if (args[0] === 'ls-files') return cb(null, untracked.join('\0'), '')
    if (args.includes('--name-only')) return cb(null, diffNames.join('\0'), '')
    return cb(null, diff, '')
  }
  return { execFileFn, calls }
}

const diffCall = (calls) => calls.find((a) => a[0] === 'diff' && !a.includes('--name-only'))
const nameCall = (calls) => calls.find((a) => a[0] === 'diff' && a.includes('--name-only'))

// --- ref spec parsing ---

test('parseRefSpec: a plain commit-ish is a point', () => {
  assert.deepEqual(parseRefSpec('HEAD~3'), { kind: 'point', spec: 'HEAD~3', endpoints: ['HEAD~3'] })
})

test('parseRefSpec: dots inside a tag name are not a range', () => {
  assert.equal(parseRefSpec('v1.2.3').kind, 'point')
})

test('parseRefSpec: two- and three-dot ranges expose both endpoints', () => {
  assert.deepEqual(parseRefSpec('a..b'), { kind: 'range', spec: 'a..b', endpoints: ['a', 'b'] })
  assert.deepEqual(parseRefSpec('a...b'), { kind: 'range', spec: 'a...b', endpoints: ['a', 'b'] })
})

test('parseRefSpec: an omitted side means HEAD, as git reads it', () => {
  assert.deepEqual(parseRefSpec('..b').endpoints, ['HEAD', 'b'])
  assert.deepEqual(parseRefSpec('a..').endpoints, ['a', 'HEAD'])
})

test('parseRefSpec: no ref is no spec', () => {
  assert.equal(parseRefSpec(null), null)
  assert.equal(parseRefSpec(''), null)
})

// --- endpoint verification ---

test('resolveRef verifies every endpoint of a range', async () => {
  const { execFileFn, calls } = fakeGit({})
  await resolveRef('main..HEAD', { execFileFn })
  const verified = calls.filter((a) => a.includes('--verify')).map((a) => a[a.length - 1])
  assert.deepEqual(verified, ['main^{commit}', 'HEAD^{commit}'])
})

test('resolveRef names which endpoint of a range is unknown', async () => {
  const { execFileFn } = fakeGit({ knownRefs: ['main'] })
  await assert.rejects(
    resolveRef('main..nope', { execFileFn }),
    (err) => {
      assert.match(err.details.reason, /unknown git ref in range main\.\.nope: nope/)
      return true
    },
  )
})

test('an unverifiable range endpoint never reaches git diff', async () => {
  const { execFileFn, calls } = fakeGit({ knownRefs: ['main'] })
  await assert.rejects(collectDiff({ ref: 'main..; rm -rf /', execFileFn }))
  assert.equal(diffCall(calls), undefined, 'no diff may run once an endpoint failed')
})

// --- range diffs ---

test('a range is passed to git diff verbatim, as one argv element', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'] })
  const res = await collectDiff({ ref: 'origin/dev..HEAD', execFileFn })
  assert.deepEqual(nameCall(calls), ['diff', '--name-only', '-z', 'origin/dev..HEAD', '--'])
  assert.equal(diffCall(calls)[1], 'origin/dev..HEAD')
  assert.equal(res.ref, 'origin/dev..HEAD')
})

test('a range never mixes in untracked working-tree files', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'], untracked: ['scratch.md'] })
  const res = await collectDiff({ ref: 'main..HEAD', execFileFn })
  assert.deepEqual(res.untracked, [], 'a range compares two recorded points')
  assert.ok(!calls.some((a) => a[0] === 'ls-files'), 'untracked must not even be listed')
  assert.ok(!res.files.some((f) => f.path === 'scratch.md'))
})

// --- staged ---

test('--staged adds --cached and names no ref of its own', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'] })
  const res = await collectDiff({ staged: true, execFileFn })
  assert.deepEqual(nameCall(calls), ['diff', '--name-only', '-z', '--cached', '--'])
  assert.equal(res.staged, true)
  assert.match(res.ref, /index/)
})

test('--staged with a point ref compares the index to that commit', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'] })
  await collectDiff({ ref: 'HEAD~1', staged: true, execFileFn })
  assert.deepEqual(nameCall(calls), ['diff', '--name-only', '-z', '--cached', 'HEAD~1', '--'])
})

test('--staged excludes untracked files: they are not in the index', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'], untracked: ['scratch.md'] })
  const res = await collectDiff({ staged: true, execFileFn })
  assert.deepEqual(res.untracked, [])
  assert.ok(!calls.some((a) => a[0] === 'ls-files'))
})

test('--staged never looks for HEAD — it works before the first commit', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'] })
  await collectDiff({ staged: true, execFileFn })
  const headProbe = calls.find((a) => a.includes('--verify') && a[a.length - 1] === 'HEAD')
  assert.equal(headProbe, undefined)
})

test('--staged and a range are rejected rather than handed to git', async () => {
  const { execFileFn, calls } = fakeGit({})
  await assert.rejects(
    collectDiff({ ref: 'a..b', staged: true, execFileFn }),
    (err) => {
      assert.match(err.details.reason, /cannot take the range a\.\.b/)
      return true
    },
  )
  assert.equal(diffCall(calls), undefined)
})

// --- the default is unchanged ---

test('the default comparison still means HEAD vs the working tree, untracked included', async () => {
  const { execFileFn, calls } = fakeGit({ diffNames: ['a.js'], untracked: ['new.md'] })
  const res = await collectDiff({ execFileFn })
  assert.deepEqual(nameCall(calls), ['diff', '--name-only', '-z', 'HEAD', '--'])
  assert.equal(res.ref, 'HEAD')
  assert.equal(res.staged, false)
  assert.deepEqual(res.untracked, ['new.md'])
})

// --- payload ordering: the file cap must not eat the untracked entries ---

test('untracked paths are listed before tracked ones', async () => {
  const { execFileFn } = fakeGit({ diffNames: ['a.js', 'b.js'], untracked: ['new.md'] })
  const res = await collectDiff({ execFileFn })
  assert.equal(res.files[0].path, 'new.md', 'the only trace of a new file must survive truncation first')
  assert.match(res.files[0].reason, /untracked/)
})

test('a change touching more tracked files than the cap still carries the new files', async () => {
  const tracked = Array.from({ length: 60 }, (_, i) => `src/f${i}.js`)
  const { execFileFn } = fakeGit({ diffNames: tracked, untracked: ['new-a.md', 'new-b.md'] })
  const collected = await collectDiff({ execFileFn })
  const { payload, droppedFiles } = buildPayload({
    kind: 'review',
    goal: 'g',
    diff: 'd',
    files: collected.files,
  })
  const sent = payload.files.map((f) => f.path)
  assert.ok(sent.includes('new-a.md') && sent.includes('new-b.md'), 'new files must not be the first casualty')
  assert.equal(payload.files.length, LIMITS.files)
  assert.ok(droppedFiles > 0, 'the overflow is still reported')
})

test('review reports the untracked files that actually travelled', async () => {
  // The header used to count what the working tree held, so it claimed new
  // files had gone out after the cap dropped them.
  const tracked = Array.from({ length: 60 }, (_, i) => `src/f${i}.js`)
  const res = await review({
    collectDiffFn: async () => ({
      diff: 'd',
      files: [
        ...tracked.map((path) => ({ path, reason: 'changed in diff' })),
        { path: 'late.md', reason: 'untracked new file — not in diff, read it directly to review' },
      ],
      excludedFiles: [],
      untracked: ['late.md'],
      ref: 'HEAD',
    }),
    dryRun: true,
    config: CONFIG_DEFAULTS,
    runFn: async () => { throw new Error('must not send') },
  })
  const sent = res.payload.files.map((f) => f.path)
  assert.equal(sent.includes('late.md'), false, 'this fixture deliberately puts it past the cap')
  assert.deepEqual(res.untracked, [], 'the result must not claim it travelled')
})
