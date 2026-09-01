// Background job state (design §8 job lifecycle).
//
// Layout: ~/.kiro-bridge/jobs/<cwd-hash>/<job-id>/{meta.json,stdout.log,status}
// Scoped by cwd hash so jobs from different repos don't mix. State transitions are
// queued -> running -> done | failed | cancelled, writes are always tmpfile+rename.
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  readdirSync, rmSync, statSync, rmdirSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { bridgeHome } from './config.mjs'
import { sanitizeTerminal } from './sanitize.mjs'

export const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled']
export const TERMINAL = new Set(['done', 'failed', 'cancelled'])

// Best-effort, cross-platform process start identity. Combined with the PID,
// it lets us tell a genuinely-still-running worker apart from an unrelated
// process that reused the same PID number. Returns null when unsupported or on
// any failure — callers must treat null as "unverifiable", never as a match.
//
// Linux: field 22 (starttime, in clock ticks) of /proc/<pid>/stat.
// macOS/BSD: `ps -o lstart=` (process start wall-clock, stable per process).
export function processIdentity(pid, { plat = platform(), execFn = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (plat === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // The comm field (field 2) may contain spaces/parens; parse after the last ')'.
      const rparen = stat.lastIndexOf(')')
      if (rparen < 0) return null
      const rest = stat.slice(rparen + 2).trim().split(/\s+/)
      // rest[0] is field 3 (state); starttime is field 22 → index 19 here.
      const starttime = rest[19]
      if (!starttime || !/^\d+$/.test(starttime)) return null
      return `linux:${starttime}`
    }
    // macOS / BSD and other POSIX: ps lstart is stable for the process lifetime.
    const out = execFn('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      maxBuffer: 4096,
    })
    const lstart = String(out || '').trim()
    if (!lstart) return null
    return `ps:${lstart}`
  } catch {
    return null
  }
}

// Only valid transitions are allowed. Anything else is a code bug, so it's never silently passed through.
const TRANSITIONS = {
  queued: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['done', 'failed', 'cancelled']),
}

export function cwdHash(cwd = process.cwd()) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

export function jobsRoot() {
  return join(bridgeHome(), 'jobs')
}

export function jobsDir(cwd = process.cwd()) {
  return join(jobsRoot(), cwdHash(cwd))
}

// Generated job ids are the only values allowed to become path components.
// CLI-supplied ids must match this exact shape, preventing traversal outside
// the cwd-scoped jobs directory.
const JOB_ID_RE = /^[0-9]{17}-[0-9a-f]{8}$/

export function isValidJobId(jobId) {
  return typeof jobId === 'string' && JOB_ID_RE.test(jobId)
}

export function jobDir(jobId, cwd = process.cwd()) {
  if (!isValidJobId(jobId)) {
    throw new Error('refusing to derive a path from an invalid jobId')
  }
  return join(jobsDir(cwd), jobId)
}

function writeAtomic(target, contents, mode = 0o600) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  // PID + a random UUID guarantees a unique temp name even when two writers in
  // the same process (or same millisecond across processes) target one file.
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`
  try {
    writeFileSync(tmp, contents, { mode })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

// --- cross-process per-job lock (design §8 concurrency) ---
//
// A single lock directory per job serializes read/decide/merge/write across
// both processes (parent, worker) and any concurrent status/reap/cancel caller.
// We use mkdir with an implicit O_EXCL: a directory create either succeeds
// (we own the lock) or throws EEXIST (someone else holds it). A unique owner
// token file inside lets stale-lock recovery avoid stealing a lock we didn't
// place. There is no busy-spin — a short Atomics.wait backs off between tries.

export const LOCK_STALE_MS = 30_000     // a lock older than this is considered abandoned
export const LOCK_TIMEOUT_MS = 5_000    // give up acquiring after this long
const LOCK_BACKOFF_MS = 15             // sleep between acquisition attempts

// Synchronous, no-busy-spin sleep. Atomics.wait blocks the thread without
// spinning the CPU; the shared buffer is never notified, so it always waits
// the full duration (or until interrupted).
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // SharedArrayBuffer unavailable — fall back to a bounded blocking spin.
    const end = Date.now() + ms
    while (Date.now() < end) { /* bounded wait */ }
  }
}

function lockPaths(dir) {
  return { lockDir: join(dir, '.lock'), owner: join(dir, '.lock', 'owner') }
}

// Acquire the per-job lock. Returns an opaque handle for releaseLock().
// Bounded wait with stale-lock recovery. Throws on timeout.
export function acquireLock(dir, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  now = Date.now,
} = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { lockDir, owner } = lockPaths(dir)
  const token = `${process.pid}:${randomUUID()}`
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lockDir) // atomic: EEXIST if already held
      // We own it — stamp the owner token so recovery and release can
      // distinguish us from a replacement owner. A lock without an owner token
      // is unsafe to release, so fail acquisition and clean it up immediately.
      try {
        writeFileSync(owner, token, { mode: 0o600 })
      } catch (ownerError) {
        try { rmdirSync(lockDir) } catch {}
        throw ownerError
      }
      return { lockDir, owner, token }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      // Held by someone. Recover if stale.
      let ageMs = 0
      try {
        ageMs = now() - statSync(lockDir).mtimeMs
      } catch {
        // Lock vanished between the failed mkdir and stat — retry immediately.
        continue
      }
      if (ageMs >= staleMs) {
        // Stale. Best-effort steal: remove the owner file then the dir, then
        // loop to re-create it ourselves. If another recoverer wins, our next
        // mkdir throws EEXIST again and we re-evaluate.
        try { unlinkSync(owner) } catch {}
        try { rmdirSync(lockDir) } catch {}
        continue
      }
      if (now() >= deadline) {
        throw new Error(`lock timeout after ${timeoutMs}ms for ${dir}`)
      }
      sleepSync(LOCK_BACKOFF_MS)
    }
  }
}

// Release a lock only if we still own it (token match). Always safe to call.
export function releaseLock(handle) {
  if (!handle) return
  const { lockDir, owner, token } = handle
  let current
  try {
    current = readFileSync(owner, 'utf8')
  } catch {
    // The lock may have been recovered and re-created between our operations.
    // Without our token we cannot prove ownership, so never remove the dir.
    return
  }
  if (current !== token) return // a recoverer stole it; don't remove theirs
  try { unlinkSync(owner) } catch { return }
  try { rmdirSync(lockDir) } catch {}
}

// Run fn while holding the per-job lock. The lock is always released in finally.
export function withJobLock(dir, fn, lockOptions = {}) {
  const handle = acquireLock(dir, lockOptions)
  try {
    return fn()
  } finally {
    releaseLock(handle)
  }
}

// Read job state without any lock. Used by internal helpers that already hold
// the lock, and by pure read callers where a momentary stale view is fine.
function readJobUnlocked(jobId, cwd) {
  if (!isValidJobId(jobId)) return null
  const dir = jobDir(jobId, cwd)
  let meta
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
  let status = 'unknown'
  try {
    status = readFileSync(join(dir, 'status'), 'utf8').trim()
  } catch {}
  return { jobId, dir, meta, status }
}

// Merge a patch (or an updater callback's return) into meta, under the caller's
// already-held lock. Re-reads current meta so concurrent field writes are not
// lost. `patchOrFn` may be a static object or (currentMeta) => partialPatch.
function updateMetaUnlocked(jobId, patchOrFn, cwd) {
  const job = readJobUnlocked(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  const patch = typeof patchOrFn === 'function' ? patchOrFn(job.meta) : patchOrFn
  const meta = { ...job.meta, ...patch }
  writeAtomic(join(job.dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

// Perform a status transition against freshly-re-read status, writing status +
// finishedAt under the caller's already-held lock (no nested acquisition).
function transitionUnlocked(jobId, next, cwd) {
  const job = readJobUnlocked(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  if (TERMINAL.has(job.status)) {
    // Terminal state is immutable. Prevents a cancel race from flipping the result.
    return job.status
  }
  const allowed = TRANSITIONS[job.status]
  if (!allowed || !allowed.has(next)) {
    throw new Error(`invalid transition: ${job.status} → ${next} (${jobId})`)
  }
  writeAtomic(join(job.dir, 'status'), `${next}\n`)
  if (TERMINAL.has(next)) {
    updateMetaUnlocked(jobId, { finishedAt: new Date().toISOString() }, cwd)
  }
  return next
}

// Attach a per-process monotonic counter so jobs created within the same ms still sort by creation order.
let jobSeq = 0

export function createJob({ cwd = process.cwd(), command, payloadOptions = {} } = {}) {
  // A time-prefixed id — simply listing the directory sorts chronologically.
  jobSeq += 1
  const seq = String(jobSeq % 1000).padStart(3, '0')
  const jobId = `${String(Date.now()).padStart(14, '0')}${seq}-${randomUUID().slice(0, 8)}`
  const dir = jobDir(jobId, cwd)
  const meta = {
    jobId,
    command,
    cwd,
    createdAt: new Date().toISOString(),
    pid: null,
    procIdentity: null,
    startedAt: null,
    finishedAt: null,
    sessionId: null,
    transport: null,
    error: null,
    payloadOptions,
  }
  writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  writeAtomic(join(dir, 'status'), 'queued\n')
  return { jobId, dir, meta }
}

export function readJob(jobId, cwd = process.cwd()) {
  if (!isValidJobId(jobId)) return null
  const dir = jobDir(jobId, cwd)
  let meta
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
  let status = 'unknown'
  try {
    status = readFileSync(join(dir, 'status'), 'utf8').trim()
  } catch {}
  return { jobId, dir, meta, status }
}

// Public updateMeta: re-read + merge under the per-job lock. Accepts a static
// patch object or an updater callback (currentMeta) => partialPatch, evaluated
// under the lock so concurrent field writers cannot lose each other's changes.
export function updateMeta(jobId, patchOrFn, cwd = process.cwd()) {
  const dir = jobDir(jobId, cwd)
  return withJobLock(dir, () => updateMetaUnlocked(jobId, patchOrFn, cwd))
}

// Public transition: re-read status + write status/finishedAt under the lock.
export function transition(jobId, next, cwd = process.cwd()) {
  const dir = jobDir(jobId, cwd)
  return withJobLock(dir, () => transitionUnlocked(jobId, next, cwd))
}

// Worker lifecycle operations combine their related metadata, result, and
// status writes under the same per-job lock. This closes the gaps where cancel
// could otherwise interleave between separate updateMeta/transition calls.
export function startJob(jobId, patch, cwd = process.cwd()) {
  const dir = jobDir(jobId, cwd)
  return withJobLock(dir, () => {
    const job = readJobUnlocked(jobId, cwd)
    if (!job) throw new Error(`unknown job: ${jobId}`)
    if (TERMINAL.has(job.status)) return job.status
    updateMetaUnlocked(jobId, patch, cwd)
    return transitionUnlocked(jobId, 'running', cwd)
  })
}

export function completeJob(jobId, text, metaPatch = {}, cwd = process.cwd()) {
  const dir = jobDir(jobId, cwd)
  return withJobLock(dir, () => {
    const job = readJobUnlocked(jobId, cwd)
    if (!job) throw new Error(`unknown job: ${jobId}`)
    if (TERMINAL.has(job.status)) return job.status
    if (job.status !== 'running') {
      throw new Error(`invalid transition: ${job.status} → done (${jobId})`)
    }
    updateMetaUnlocked(jobId, metaPatch, cwd)
    writeAtomic(join(job.dir, 'result.txt'), text)
    return transitionUnlocked(jobId, 'done', cwd)
  })
}

export function failJob(jobId, error, cwd = process.cwd(), lockOptions = {}) {
  const dir = jobDir(jobId, cwd)
  return withJobLock(dir, () => {
    const job = readJobUnlocked(jobId, cwd)
    if (!job) throw new Error(`unknown job: ${jobId}`)
    if (TERMINAL.has(job.status)) return job.status
    updateMetaUnlocked(jobId, { error }, cwd)
    return transitionUnlocked(jobId, 'failed', cwd)
  }, lockOptions)
}

export function writeResult(jobId, text, cwd = process.cwd()) {
  const job = readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  writeAtomic(join(job.dir, 'result.txt'), text)
}

export function readResult(jobId, cwd = process.cwd()) {
  if (!isValidJobId(jobId)) return null
  try {
    return readFileSync(join(jobDir(jobId, cwd), 'result.txt'), 'utf8')
  } catch {
    return null
  }
}

export function listJobs({ cwd = process.cwd(), includeTerminal = true } = {}) {
  let ids = []
  try {
    ids = readdirSync(jobsDir(cwd))
  } catch {
    return []
  }
  return ids
    .sort()
    .map((id) => readJob(id, cwd))
    .filter(Boolean)
    .filter((job) => includeTerminal || !TERMINAL.has(job.status))
}

// Determine whether the job is alive. A liveness check alone cannot tell a
// reused PID apart from our worker; that distinction is made separately via
// processIdentity when a stored identity is available (see reapOrphans /
// cancelJob). A job marked running with no live process is treated as orphaned
// and marked failed.
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function reapOrphans(cwd = process.cwd(), options = {}) {
  const { now = Date.now(), startupGraceMs = 5000, identityFn = processIdentity } = options
  const reaped = []
  for (const job of listJobs({ cwd })) {
    // Take the per-job lock and re-read state under it so the decision and the
    // resulting state write are atomic against a worker's own transition. A
    // worker that just moved queued→running (or wrote its pid) cannot lose to a
    // stale decision made from the pre-lock snapshot.
    const decided = withJobLock(job.dir, () => {
      const fresh = readJobUnlocked(job.jobId, cwd)
      if (!fresh) return false
      const alive = isProcessAlive(fresh.meta.pid)
      const createdAt = Date.parse(fresh.meta.createdAt || '')
      const startupExpired = Number.isFinite(createdAt) && now - createdAt >= startupGraceMs

      if (fresh.status === 'queued') {
        if (!startupExpired) return false
        // Past grace. Use the parent-persisted queued PID to avoid a false reap
        // of a worker that spawned but hasn't flipped to running yet.
        if (alive) {
          // A live PID means the worker exists. If we have a stored identity and
          // it no longer matches, the PID was reused — mark failed without a
          // signal. Otherwise leave it: it is starting up.
          if (fresh.meta.procIdentity) {
            const current = identityFn(fresh.meta.pid)
            if (current !== null && current !== fresh.meta.procIdentity) {
              updateMetaUnlocked(job.jobId, { error: 'orphaned: queued pid reused by an unrelated process (identity mismatch)' }, cwd)
              transitionUnlocked(job.jobId, 'failed', cwd)
              return true
            }
          }
          return false
        }
        // Expired, no live PID (includes legacy records with null PID) → orphan.
        updateMetaUnlocked(job.jobId, { error: 'orphaned: worker process did not start' }, cwd)
        transitionUnlocked(job.jobId, 'failed', cwd)
        return true
      }
      if (fresh.status === 'running') {
        if (!alive) {
          updateMetaUnlocked(job.jobId, { error: 'orphaned: process no longer alive' }, cwd)
          transitionUnlocked(job.jobId, 'failed', cwd)
          return true
        }
        // Alive PID but a stored identity that no longer matches means the PID was
        // reused by an unrelated process. Treat as orphaned — but never signal it,
        // since it is not our worker.
        if (fresh.meta.procIdentity) {
          const current = identityFn(fresh.meta.pid)
          if (current !== null && current !== fresh.meta.procIdentity) {
            updateMetaUnlocked(job.jobId, { error: 'orphaned: pid reused by an unrelated process (identity mismatch)' }, cwd)
            transitionUnlocked(job.jobId, 'failed', cwd)
            return true
          }
        }
      }
      return false
    })
    if (decided) reaped.push(job.jobId)
  }
  return reaped
}

export function cancelJob(jobId, {
  cwd = process.cwd(),
  killFn = (pid) => process.kill(pid, 'SIGTERM'),
  identityFn = processIdentity,
} = {}) {
  if (!isValidJobId(jobId)) return { ok: false, reason: `unknown job: ${jobId}` }
  const dir = jobDir(jobId, cwd)
  // The whole read → identity decision → signal → transition sequence runs
  // under one lock, re-reading fresh state, so a worker transition can never
  // race the decision. Fail-closed semantics are preserved exactly.
  return withJobLock(dir, () => {
    const job = readJobUnlocked(jobId, cwd)
    if (!job) return { ok: false, reason: `unknown job: ${jobId}` }
    if (TERMINAL.has(job.status)) return { ok: false, reason: `already terminal (${job.status})` }

    const pid = job.meta.pid
    if (pid && isProcessAlive(pid)) {
      // Fail closed: only signal a live PID whose stored identity we can confirm
      // still matches. Absent, unverifiable, or mismatched identity → do nothing
      // (no transition, no signal) so we never kill an unrelated reused-PID process.
      if (!job.meta.procIdentity) {
        return { ok: false, reason: 'refusing to signal: no stored process identity for a live pid' }
      }
      const current = identityFn(pid)
      if (current === null) {
        return { ok: false, reason: 'refusing to signal: process identity is unverifiable on this platform' }
      }
      if (current !== job.meta.procIdentity) {
        return { ok: false, reason: 'refusing to signal: live pid identity does not match (pid reused)' }
      }
      try {
        killFn(pid)
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
    }
    // Dead process (or no pid) may transition to cancelled without signalling.
    transitionUnlocked(jobId, 'cancelled', cwd)
    return { ok: true, jobId }
  })
}

// Clean up terminal jobs past the retention period. Falls back to directory mtime when finishedAt is missing.
export function gcJobs({ cwd = process.cwd(), retentionDays = 30, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const removed = []
  for (const job of listJobs({ cwd })) {
    if (!TERMINAL.has(job.status)) continue
    let finished = Date.parse(job.meta.finishedAt || '')
    if (!Number.isFinite(finished)) {
      try {
        finished = statSync(job.dir).mtimeMs
      } catch {
        continue
      }
    }
    if (finished < cutoff) {
      rmSync(job.dir, { recursive: true, force: true })
      removed.push(job.jobId)
    }
  }
  return removed
}

export function jobLogPaths(jobId, cwd = process.cwd()) {
  const dir = jobDir(jobId, cwd)
  return { stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') }
}

export function latestJobId(cwd = process.cwd()) {
  const all = listJobs({ cwd })
  return all.length > 0 ? all[all.length - 1].jobId : null
}

// --- observability: bounded, sanitized event summaries + health ---

export const MAX_RECENT_EVENTS = 20

// Documented health thresholds for running jobs (ms since lastProgressAt).
// active: recent progress; quiet: no progress for a while; possibly_stalled:
// no progress for a long while. These are heuristics, never a hard failure.
export const HEALTH_QUIET_MS = 60_000        // 1 min
export const HEALTH_STALLED_MS = 300_000     // 5 min

// Strip terminal escapes and control chars using the same final-boundary
// sanitizer as foreground output. Event labels are one-line metadata, so the
// otherwise-preserved newline/tab characters collapse to spaces here.
export function stripControl(s) {
  if (typeof s !== 'string') return ''
  return sanitizeTerminal(s).replace(/[\n\t]+/g, ' ').trim()
}

function boundedLabel(s, max = 80) {
  const clean = stripControl(s)
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

// ACP usage cost is { amount: number, currency: ISO-4217 string } or null.
// Persisted usage metadata must never carry arbitrary object fields: keep only
// a finite numeric amount and a bounded 3-letter currency (or null). A bare
// numeric cost from a legacy build is tolerated as { amount, currency: null }.
export function sanitizeCost(cost) {
  if (Number.isFinite(cost)) return { amount: cost, currency: null }
  if (!cost || typeof cost !== 'object') return null
  if (!Number.isFinite(cost.amount)) return null
  let currency = null
  if (typeof cost.currency === 'string') {
    const code = cost.currency.trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(code)) currency = code
  }
  return { amount: cost.amount, currency }
}

// Render a sanitized cost object for a one-line status/summary. Safe on any
// input: null-ish costs collapse to a dash, currency is appended when present.
export function formatCost(cost) {
  const c = sanitizeCost(cost)
  if (!c) return '-'
  return c.currency ? `${c.amount} ${c.currency}` : String(c.amount)
}

// Bounded, prototype-safe plan summary. Only the four known statuses are ever
// counted; any non-standard, untrusted, or dangerous status (including
// `__proto__`, `constructor`, or arbitrary long strings) is collapsed to
// `unknown`. statusCounts has a fixed key set and no dynamic key assignment,
// so untrusted status strings can never reach an object key or pollute a
// prototype.
export const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'unknown']

export function summarizePlan(entries) {
  const list = Array.isArray(entries) ? entries : []
  // Fixed, bounded accumulator — all writes target static known properties;
  // no key derived from untrusted input is ever assigned.
  const statusCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    unknown: 0,
  }
  for (const e of list) {
    const raw = typeof e?.status === 'string' ? e.status : ''
    switch (raw) {
      case 'pending':
        statusCounts.pending += 1
        break
      case 'in_progress':
        statusCounts.in_progress += 1
        break
      case 'completed':
        statusCounts.completed += 1
        break
      default:
        statusCounts.unknown += 1
    }
  }
  return { count: list.length, statusCounts }
}

// Turn a normalized transport event into a bounded summary safe to persist.
// Never stores raw model prose/thought text or raw payloads — only shapes,
// counts, and numeric accounting. Returns null for events not worth recording.
export function sanitizeEventSummary(event, { now = Date.now() } = {}) {
  if (!event || typeof event !== 'object') return null
  const at = new Date(now).toISOString()
  switch (event.type) {
    case 'message':
      return { type: 'message', at, chars: typeof event.text === 'string' ? event.text.length : 0 }
    case 'thought':
      return { type: 'thought', at, chars: typeof event.text === 'string' ? event.text.length : 0 }
    case 'tool_call':
      return {
        type: 'tool_call', at,
        toolCallId: boundedLabel(String(event.toolCallId ?? ''), 40),
        title: boundedLabel(String(event.title ?? ''), 80),
        status: boundedLabel(String(event.status ?? ''), 20),
      }
    case 'tool_result':
      return {
        type: 'tool_result', at,
        toolCallId: boundedLabel(String(event.toolCallId ?? ''), 40),
        status: boundedLabel(String(event.status ?? ''), 20),
      }
    case 'denied':
      return { type: 'denied', at }
    case 'usage':
      return {
        type: 'usage', at,
        used: Number.isFinite(event.used) ? event.used : null,
        size: Number.isFinite(event.size) ? event.size : null,
        cost: sanitizeCost(event.cost),
      }
    case 'plan': {
      const { count, statusCounts } = summarizePlan(event.entries)
      return { type: 'plan', at, count, statusCounts }
    }
    default:
      return null
  }
}

// Append a sanitized event to the job's bounded recent-events ring and bump
// lastProgressAt. Best-effort: instrumentation must never fail the worker.
export function recordJobEvent(jobId, event, { cwd = process.cwd(), now = Date.now() } = {}) {
  const summary = sanitizeEventSummary(event, { now })
  if (!summary) return null
  try {
    // Compute the ring inside updateMeta's locked updater so a concurrent field
    // writer (worker meta patch, parent pid write) cannot clobber recentEvents
    // and vice-versa: both read the same freshly-locked meta.
    let recorded = false
    updateMeta(jobId, (meta) => {
      if (TERMINAL.has(readJobUnlocked(jobId, cwd)?.status)) return {}
      const recent = Array.isArray(meta.recentEvents) ? meta.recentEvents.slice() : []
      recent.push(summary)
      while (recent.length > MAX_RECENT_EVENTS) recent.shift()
      const patch = { recentEvents: recent, lastProgressAt: new Date(now).toISOString() }
      if (summary.type === 'usage') patch.usage = { used: summary.used, size: summary.size, cost: sanitizeCost(summary.cost) }
      if (summary.type === 'plan') patch.plan = { count: summary.count, statusCounts: summary.statusCounts }
      recorded = true
      return patch
    }, cwd)
    return recorded ? summary : null
  } catch {
    return null
  }
}

// Deterministic health classification. Terminal statuses map through directly;
// running jobs are graded by time since last progress.
export function classifyHealth(job, { now = Date.now() } = {}) {
  if (!job) return 'unknown'
  const status = job.status
  if (status !== 'running') return status
  const last = Date.parse(job.meta.lastProgressAt || job.meta.startedAt || '')
  if (!Number.isFinite(last)) return 'active'
  const idle = now - last
  if (idle >= HEALTH_STALLED_MS) return 'possibly_stalled'
  if (idle >= HEALTH_QUIET_MS) return 'quiet'
  return 'active'
}

// One-line, prose-free rendering of a persisted event summary.
export function formatEventSummary(s) {
  if (!s || typeof s !== 'object') return ''
  switch (s.type) {
    case 'message': return `message (${s.chars} chars)`
    case 'thought': return `thought (${s.chars} chars)`
    case 'tool_call': return `tool_call ${s.title || s.toolCallId} [${s.status}]`
    case 'tool_result': return `tool_result ${s.toolCallId} [${s.status}]`
    case 'denied': return 'denied'
    case 'usage': return `usage used=${s.used ?? '-'} size=${s.size ?? '-'} cost=${formatCost(s.cost)}`
    case 'plan': {
      const counts = Object.entries(s.statusCounts || {}).map(([k, v]) => `${k}:${v}`).join(' ')
      return `plan ${s.count} entries${counts ? ` (${counts})` : ''}`
    }
    default: return String(s.type || 'event')
  }
}
