import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerSession, readRecord, listSessions, latestSession, resolveSession,
  gcSessions, sanitizeRecord, generateRecordId, isValidRecordId,
  sessionsDir, cwdHash, LIMITS,
} from '../scripts/lib/sessions.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-sessions-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const CWD_A = '/tmp/repo-a'
const CWD_B = '/tmp/repo-b'

const goodInput = (overrides = {}) => ({
  sessionId: 'sess-abc',
  agent: 'kiro-bridge-researcher',
  source: { kind: 'task', command: 'task' },
  write: false,
  transport: 'acp',
  ...overrides,
})

// --- recordId shape / path-traversal guard ---

test('generateRecordId: produces a validatable, filesystem-safe id', () => {
  const id = generateRecordId()
  assert.ok(isValidRecordId(id))
  assert.ok(!id.includes('/'))
  assert.ok(!id.includes('.'))
})

test('isValidRecordId: rejects traversal and arbitrary strings', () => {
  for (const bad of ['../evil', 'a/b', 'sess-abc', '', '..', '%2e%2e', 'x'.repeat(40), null, 42]) {
    assert.equal(isValidRecordId(bad), false)
  }
})

// --- scoping by cwd hash ---

test('registry: records are scoped by cwd hash and never mix across repos', () => {
  registerSession(goodInput(), { cwd: CWD_A })
  registerSession(goodInput({ sessionId: 'sess-b' }), { cwd: CWD_B })

  const a = listSessions({ cwd: CWD_A })
  const b = listSessions({ cwd: CWD_B })
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(a[0].sessionId, 'sess-abc')
  assert.equal(b[0].sessionId, 'sess-b')
  assert.notEqual(cwdHash(CWD_A), cwdHash(CWD_B))
})

// --- atomic independent records / concurrency shape ---

test('registry: each register writes an independent 0600 file (no shared index)', () => {
  const r1 = registerSession(goodInput(), { cwd: CWD_A })
  const r2 = registerSession(goodInput({ sessionId: 'sess-2' }), { cwd: CWD_A })
  assert.notEqual(r1.recordId, r2.recordId)

  const dir = sessionsDir(CWD_A)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 2, 'two independent files, not one merged index')
  for (const f of files) {
    const mode = statSync(join(dir, f)).mode & 0o777
    assert.equal(mode, 0o600, 'records are 0600')
  }
})

test('registry: interleaved writes from "concurrent" callers all survive', () => {
  // Simulate two processes interleaving: distinct recordIds, distinct files,
  // no lost update because there is no shared file to clobber.
  const ids = []
  for (let i = 0; i < 10; i += 1) {
    ids.push(registerSession(goodInput({ sessionId: `sess-${i}` }), { cwd: CWD_A }).recordId)
  }
  const all = listSessions({ cwd: CWD_A })
  assert.equal(all.length, 10)
  assert.equal(new Set(ids).size, 10, 'all recordIds unique')
})

// --- malformed / bounded records ---

test('sanitizeRecord: drops records missing required fields', () => {
  assert.equal(sanitizeRecord(null), null)
  assert.equal(sanitizeRecord({}), null)
  assert.equal(sanitizeRecord(goodInput({ sessionId: '' })), null)
  assert.equal(sanitizeRecord(goodInput({ agent: null })), null)
  assert.equal(sanitizeRecord(goodInput({ source: {} })), null)
})

test('sanitizeRecord: only ACP transport is resumable', () => {
  assert.equal(sanitizeRecord(goodInput({ transport: 'subprocess' })), null)
  assert.equal(sanitizeRecord(goodInput({ transport: null })), null)
  assert.ok(sanitizeRecord(goodInput({ transport: 'acp' })))
})

test('sanitizeRecord: over-cap fields reject the whole record (never truncate a sessionId)', () => {
  assert.equal(sanitizeRecord(goodInput({ sessionId: 'x'.repeat(LIMITS.sessionId + 1) })), null)
  assert.equal(sanitizeRecord(goodInput({ agent: 'x'.repeat(LIMITS.agent + 1) })), null)
  assert.equal(sanitizeRecord(goodInput({ model: 'x'.repeat(LIMITS.model + 1) })), null)
})

test('sanitizeRecord: keeps only the bounded field set — arbitrary metadata is dropped', () => {
  const rec = sanitizeRecord(goodInput({
    model: 'model-x',
    prompt: 'secret prompt',
    diff: 'secret diff',
    focus: 'secret focus',
    filePaths: ['/etc/passwd'],
    rawOutput: 'model said things',
    diagnostics: { stack: 'trace' },
    extra: 'nope',
  }))
  assert.deepEqual(
    Object.keys(rec).sort(),
    ['agent', 'createdAt', 'model', 'recordId', 'sessionId', 'source', 'transport', 'write'],
  )
  assert.deepEqual(Object.keys(rec.source).sort(), ['command', 'kind'])
})

test('registry: no prompt / diff / path / output content is ever written to disk', () => {
  registerSession(goodInput({
    model: 'model-x',
    prompt: 'RAWPROMPT',
    diff: 'RAWDIFF',
    focus: 'RAWFOCUS',
    filePaths: ['/RAWPATH'],
    rawOutput: 'RAWOUTPUT',
    diagnostics: 'RAWDIAG',
  }), { cwd: CWD_A })
  const dir = sessionsDir(CWD_A)
  const contents = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
  for (const forbidden of ['RAWPROMPT', 'RAWDIFF', 'RAWFOCUS', 'RAWPATH', 'RAWOUTPUT', 'RAWDIAG']) {
    assert.ok(!contents.includes(forbidden), `${forbidden} must never be persisted`)
  }
})

test('write flag is coerced to a strict boolean', () => {
  assert.equal(sanitizeRecord(goodInput({ write: 'yes' })).write, false)
  assert.equal(sanitizeRecord(goodInput({ write: 1 })).write, false)
  assert.equal(sanitizeRecord(goodInput({ write: true })).write, true)
})

test('readRecord: ignores a malformed file on disk', () => {
  const { recordId } = registerSession(goodInput(), { cwd: CWD_A })
  const dir = sessionsDir(CWD_A)
  // Corrupt the file body: transport downgraded → no longer resumable.
  const path = join(dir, `${recordId}.json`)
  const body = JSON.parse(readFileSync(path, 'utf8'))
  body.transport = 'subprocess'
  writeFileSync(path, JSON.stringify(body))
  assert.equal(readRecord(recordId, CWD_A), null)
  // A garbage file is skipped entirely by the listing.
  writeFileSync(join(dir, generateRecordId() + '.json'), 'not json{')
  const all = listSessions({ cwd: CWD_A })
  assert.ok(all.every((r) => r.transport === 'acp'))
})

test('readRecord: refuses to build a path from an invalid recordId', () => {
  assert.equal(readRecord('../../etc/passwd', CWD_A), null)
  assert.equal(readRecord('anything', CWD_A), null)
})

// --- retention + max cap GC ---

test('gcSessions: prunes records older than retention', () => {
  const { recordId } = registerSession(goodInput(), { cwd: CWD_A })
  // Rewrite with an ancient createdAt so the age sweep removes it.
  const path = join(sessionsDir(CWD_A), `${recordId}.json`)
  const body = JSON.parse(readFileSync(path, 'utf8'))
  body.createdAt = new Date('2000-01-01T00:00:00Z').toISOString()
  writeFileSync(path, JSON.stringify(body))
  const removed = gcSessions({ cwd: CWD_A, retentionDays: 30 })
  assert.deepEqual(removed, [recordId])
  assert.equal(listSessions({ cwd: CWD_A }).length, 0)
})

test('registry: enforces a hard maximum record count, dropping the oldest', () => {
  const ids = []
  for (let i = 0; i < 6; i += 1) {
    ids.push(registerSession(goodInput({ sessionId: `s${i}` }), { cwd: CWD_A, maxRecords: 3 }).recordId)
  }
  const all = listSessions({ cwd: CWD_A })
  assert.equal(all.length, 3, 'capped at maxRecords')
  // The three newest survive; the three oldest were dropped.
  const surviving = new Set(all.map((r) => r.recordId))
  assert.ok(!surviving.has(ids[0]))
  assert.ok(surviving.has(ids[5]))
})

// --- latest / exact resolution ---

test('resolveSession: latest by default', () => {
  registerSession(goodInput({ sessionId: 'old' }), { cwd: CWD_A })
  const newer = registerSession(goodInput({ sessionId: 'new' }), { cwd: CWD_A })
  assert.equal(latestSession({ cwd: CWD_A }).recordId, newer.recordId)
  assert.equal(resolveSession({ cwd: CWD_A }).recordId, newer.recordId)
})

test('resolveSession: exact recordId', () => {
  const first = registerSession(goodInput({ sessionId: 'a' }), { cwd: CWD_A })
  registerSession(goodInput({ sessionId: 'b' }), { cwd: CWD_A })
  const resolved = resolveSession({ selector: first.recordId, cwd: CWD_A })
  assert.equal(resolved.recordId, first.recordId)
  assert.equal(resolved.sessionId, 'a')
})

test('resolveSession: exact sessionId (most recent match wins)', () => {
  registerSession(goodInput({ sessionId: 'dup' }), { cwd: CWD_A })
  const second = registerSession(goodInput({ sessionId: 'dup' }), { cwd: CWD_A })
  const resolved = resolveSession({ selector: 'dup', cwd: CWD_A })
  assert.equal(resolved.recordId, second.recordId)
})

test('resolveSession: returns null when nothing matches', () => {
  assert.equal(resolveSession({ cwd: CWD_A }), null)
  registerSession(goodInput(), { cwd: CWD_A })
  assert.equal(resolveSession({ selector: 'no-such-session', cwd: CWD_A }), null)
})

// --- non-resumable inputs produce no record ---

test('registerSession: a null-session (subprocess) turn produces no record', () => {
  assert.equal(registerSession(goodInput({ sessionId: null }), { cwd: CWD_A }), null)
  assert.equal(registerSession(goodInput({ transport: 'subprocess' }), { cwd: CWD_A }), null)
  assert.equal(listSessions({ cwd: CWD_A }).length, 0)
})
