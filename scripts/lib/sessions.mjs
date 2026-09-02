// Resumable ACP session registry (design §8 session reuse; ADR-001R).
//
// Layout: ~/.kiro-bridge/sessions/<cwd-hash>/<recordId>.json
//
// Each successful, resumable ACP turn is persisted as one immutable, atomic
// 0600 JSON record. Records are *independent files* — two concurrent processes
// each write their own recordId file and never clobber each other. The recordId
// is generated locally and is the only thing a path is ever derived from: an
// untrusted sessionId never touches the filesystem path (path traversal guard).
//
// The stored metadata is deliberately bounded: recordId, sessionId, agent name,
// source { kind, command }, write flag, transport, optional model, createdAt.
// Prompts, focus text, diffs, file paths, model output, raw diagnostics, and
// any arbitrary caller metadata are NEVER persisted here — those are either
// external data (ADR-004) or outbound-redacted context (design §7), and have no
// place in a resume index. Every field is validated/sanitized on write and
// again on read, so a hand-edited or malformed record is ignored rather than
// trusted.
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs'
import { bridgeHome } from './config.mjs'

// Bounded caps. Anything longer is rejected (record ignored), never truncated —
// a truncated sessionId would resume the wrong session, so reject is the only
// safe choice.
export const LIMITS = {
  sessionId: 512,
  agent: 128,
  command: 64,
  transport: 32,
  model: 128,
  kind: 32,
}

// A sessionId is agent-supplied: it arrives verbatim in the `session/new`
// response, so it is external data (ADR-004) and never inherently trustworthy.
// It is also the one stored field that later gets rendered into a command line
// the user is invited to run (`kiro-cli chat --resume-id <id>`, see
// transfer.mjs). Constrain it to an opaque token charset here, at the single
// point where it enters persistent state, so no shell metacharacter, quote,
// whitespace, or control byte can ever reach that rendering. A value outside
// this shape is rejected — never escaped or truncated — because a mangled id
// would resume the wrong session.
// The charset is chosen to be permissive about *format* (UUID, ULID, base64url,
// standard base64, opaque vendor strings all pass) while excluding every
// character that carries meaning to a shell: no whitespace, quotes, backslash,
// `;`, `|`, `&`, `$`, backtick, redirection, glob, or brace/tilde expansion.
const SESSION_ID_RE = /^[A-Za-z0-9._:+/=@-]+$/

export function isValidSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LIMITS.sessionId
    && SESSION_ID_RE.test(value)
}

// Only ACP turns are resumable. A subprocess/one-shot turn has no session to
// reuse, so it must never produce a record.
export const RESUMABLE_TRANSPORT = 'acp'

// Retention + count caps are configurable via the caller (loadConfig supplies
// logRetentionDays); MAX_RECORDS bounds unbounded growth even within retention.
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_MAX_RECORDS = 200

// recordId: a generated, bounded, filesystem-safe token. Time-prefixed so a
// plain directory listing sorts chronologically (latest resolution). Never
// derived from the sessionId.
let recordSeq = 0
export function generateRecordId() {
  recordSeq += 1
  const seq = String(recordSeq % 1000).padStart(3, '0')
  return `${String(Date.now()).padStart(14, '0')}${seq}-${randomUUID().slice(0, 8)}`
}

// A recordId used to build a path must match this exact shape. This is the
// path-traversal guard: even if a caller passes a crafted string as an "exact"
// recordId selector, we only ever join a value matching this pattern.
const RECORD_ID_RE = /^[0-9]{14,}[0-9]{3}-[0-9a-f]{8}$/

export function isValidRecordId(id) {
  return typeof id === 'string' && RECORD_ID_RE.test(id)
}

export function cwdHash(cwd = process.cwd()) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

export function sessionsRoot() {
  return join(bridgeHome(), 'sessions')
}

// Scope by cwd hash so records from different repositories never mix.
export function sessionsDir(cwd = process.cwd()) {
  return join(sessionsRoot(), cwdHash(cwd))
}

function recordPath(recordId, cwd = process.cwd()) {
  // Guard: only a locally-validated recordId ever becomes a path component.
  if (!isValidRecordId(recordId)) {
    throw new Error(`refusing to derive a path from an invalid recordId`)
  }
  return join(sessionsDir(cwd), `${recordId}.json`)
}

function writeAtomic(target, contents) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  // PID + UUID guarantees a unique temp name across concurrent writers.
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

// Bounded, trimmed string or null. Rejects (returns undefined) when the value
// is present but exceeds its cap or is not a string, so the caller can decide
// to drop the whole record rather than silently store a bad field.
function boundedString(value, max) {
  if (value == null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) return undefined
  return trimmed
}

// Validate + sanitize a candidate record down to exactly the bounded field set.
// Returns null when any required field is missing/invalid, so malformed input
// never becomes a stored (or trusted) record.
export function sanitizeRecord(input) {
  if (!input || typeof input !== 'object') return null

  const sessionId = boundedString(input.sessionId, LIMITS.sessionId)
  if (!sessionId) return null // a record with no session is not resumable
  // Shape check, not just length: see SESSION_ID_RE. Applied on both write and
  // read, so a hand-edited record file cannot smuggle one in either.
  if (!isValidSessionId(sessionId)) return null

  const agent = boundedString(input.agent, LIMITS.agent)
  if (!agent) return null

  const transport = boundedString(input.transport, LIMITS.transport)
  // Only ACP turns are resumable; anything else is not a valid record.
  if (transport !== RESUMABLE_TRANSPORT) return null

  const source = input.source && typeof input.source === 'object' ? input.source : {}
  const kind = boundedString(source.kind, LIMITS.kind)
  const command = boundedString(source.command, LIMITS.command)
  if (!kind || !command) return null

  const model = boundedString(input.model, LIMITS.model)
  if (model === undefined) return null // present-but-invalid model → drop record

  // write is a strict boolean; anything non-boolean is coerced to false rather
  // than stored as arbitrary data.
  const write = input.write === true

  // createdAt must be a valid ISO timestamp; regenerate if absent, reject if
  // present-but-unparseable (a bad timestamp would corrupt latest resolution).
  let createdAt
  if (input.createdAt == null) {
    createdAt = new Date().toISOString()
  } else if (typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt))) {
    createdAt = input.createdAt
  } else {
    return null
  }

  // recordId: keep only if it is a valid generated id; otherwise this is a
  // read-path concern (see readRecord) — on write we always assign a fresh one.
  const recordId = isValidRecordId(input.recordId) ? input.recordId : null

  const record = {
    recordId,
    sessionId,
    agent,
    source: { kind, command },
    write,
    transport,
    createdAt,
  }
  // model is optional — only present when supplied (keeps records minimal).
  if (model) record.model = model
  return record
}

// Persist one resumable ACP turn. Returns the stored record (with its generated
// recordId) or null when the turn is not resumable / input is malformed. Never
// throws for a non-resumable turn — callers persist best-effort after success.
//
// GC runs opportunistically on every successful register so the index stays
// bounded by retention + max count without a separate sweep.
export function registerSession(input, {
  cwd = process.cwd(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxRecords = DEFAULT_MAX_RECORDS,
  now = Date.now(),
} = {}) {
  const sanitized = sanitizeRecord({ ...input, recordId: null })
  if (!sanitized) return null

  const recordId = generateRecordId()
  const record = { ...sanitized, recordId }
  const target = recordPath(recordId, cwd)
  try {
    writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // Registry writes are best-effort: a failure here must never fail the
    // actual (already-succeeded) delegated call.
    return null
  }
  try {
    gcSessions({ cwd, retentionDays, maxRecords, now })
  } catch {
    // GC is opportunistic; a failure to prune never fails registration.
  }
  return record
}

// Read + validate one record by its (validated) recordId. Returns null for a
// missing, unparseable, or malformed record.
export function readRecord(recordId, cwd = process.cwd()) {
  if (!isValidRecordId(recordId)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(recordPath(recordId, cwd), 'utf8'))
  } catch {
    return null
  }
  const sanitized = sanitizeRecord(raw)
  if (!sanitized) return null
  // Trust the filename's recordId (locally generated + validated), not any
  // recordId the file body may claim.
  return { ...sanitized, recordId }
}

// List every valid record for this cwd scope, sorted by recordId (chronological
// because the id is time-prefixed). Malformed records are silently skipped.
export function listSessions({ cwd = process.cwd() } = {}) {
  let names = []
  try {
    names = readdirSync(sessionsDir(cwd))
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidRecordId)
    .sort()
    .map((id) => readRecord(id, cwd))
    .filter(Boolean)
}

// Latest resumable record for this cwd, or null.
export function latestSession({ cwd = process.cwd() } = {}) {
  const all = listSessions({ cwd })
  return all.length > 0 ? all[all.length - 1] : null
}

// Resolve a session for resume. With no selector, the latest record wins. An
// exact selector matches a recordId first, then falls back to the most recent
// record whose sessionId equals the selector. Returns null when nothing matches.
export function resolveSession({ selector, cwd = process.cwd() } = {}) {
  if (selector == null || String(selector).trim() === '') {
    return latestSession({ cwd })
  }
  const wanted = String(selector).trim()

  // Exact recordId match: only attempt a path read for a well-formed id.
  if (isValidRecordId(wanted)) {
    const byId = readRecord(wanted, cwd)
    if (byId) return byId
  }

  // Fall back to sessionId match — most recent wins if several share one.
  const all = listSessions({ cwd })
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].sessionId === wanted) return all[i]
  }
  return null
}

// Prune records by retention age and a hard maximum count. Age uses createdAt,
// falling back to the file mtime. When more than maxRecords remain after the
// age sweep, the oldest are removed until the cap holds. Best-effort per file.
export function gcSessions({
  cwd = process.cwd(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxRecords = DEFAULT_MAX_RECORDS,
  now = Date.now(),
} = {}) {
  const dir = sessionsDir(cwd)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidRecordId)
    .sort()

  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const removed = []

  // Surviving ids in chronological order, so the count cap can drop the oldest.
  const survivors = []
  for (const id of ids) {
    let createdMs
    const rec = readRecord(id, cwd)
    if (rec) {
      createdMs = Date.parse(rec.createdAt)
    }
    if (!Number.isFinite(createdMs)) {
      try {
        createdMs = statSync(join(dir, `${id}.json`)).mtimeMs
      } catch {
        createdMs = null
      }
    }
    // A record older than the cutoff (or an unreadable malformed file) is pruned.
    if (!rec || (Number.isFinite(createdMs) && createdMs < cutoff)) {
      try { unlinkSync(join(dir, `${id}.json`)) ; removed.push(id) } catch {}
      continue
    }
    survivors.push(id)
  }

  // Enforce the hard maximum by dropping the oldest survivors.
  if (Number.isFinite(maxRecords) && maxRecords >= 0 && survivors.length > maxRecords) {
    const excess = survivors.length - maxRecords
    for (let i = 0; i < excess; i += 1) {
      const id = survivors[i]
      try { unlinkSync(join(dir, `${id}.json`)) ; removed.push(id) } catch {}
    }
  }
  return removed
}
