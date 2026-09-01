// 백그라운드 잡 상태 (설계 §8 잡 수명주기).
//
// 레이아웃: ~/.kiro-bridge/jobs/<cwd-hash>/<job-id>/{meta.json,stdout.log,status}
// cwd 해시로 스코프해 리포 간 잡이 섞이지 않게 한다. 상태 전이는
// queued → running → done | failed | cancelled 이며 쓰기는 항상 임시파일+rename.
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  readdirSync, rmSync, statSync,
} from 'node:fs'
import { bridgeHome } from './config.mjs'

export const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled']
export const TERMINAL = new Set(['done', 'failed', 'cancelled'])

// 유효한 전이만 허용한다. 그 외는 코드 버그이므로 조용히 넘기지 않는다.
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

export function jobDir(jobId, cwd = process.cwd()) {
  return join(jobsDir(cwd), jobId)
}

function writeAtomic(target, contents, mode = 0o600) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, contents, { mode })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

// 같은 ms 에 만든 잡도 생성 순으로 정렬되도록 프로세스 내 단조 카운터를 붙인다.
let jobSeq = 0

export function createJob({ cwd = process.cwd(), command, payloadOptions = {} } = {}) {
  // 시각을 앞세운 id — 디렉토리 나열만으로 시간순이 된다.
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

export function updateMeta(jobId, patch, cwd = process.cwd()) {
  const job = readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  const meta = { ...job.meta, ...patch }
  writeAtomic(join(job.dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

export function transition(jobId, next, cwd = process.cwd()) {
  const job = readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  if (TERMINAL.has(job.status)) {
    // 종결 상태는 불변이다. 취소 경합에서 결과가 뒤집히는 것을 막는다.
    return job.status
  }
  const allowed = TRANSITIONS[job.status]
  if (!allowed || !allowed.has(next)) {
    throw new Error(`invalid transition: ${job.status} → ${next} (${jobId})`)
  }
  writeAtomic(join(job.dir, 'status'), `${next}\n`)
  if (TERMINAL.has(next)) {
    updateMeta(jobId, { finishedAt: new Date().toISOString() }, cwd)
  }
  return next
}

export function writeResult(jobId, text, cwd = process.cwd()) {
  const job = readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  writeAtomic(join(job.dir, 'result.txt'), text)
}

export function readResult(jobId, cwd = process.cwd()) {
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

// 살아있는 잡인지 판단. PID 재사용까지는 구분하지 못하므로(플랫폼 의존),
// running 인데 프로세스가 없으면 고아로 보고 failed 처리한다.
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function reapOrphans(cwd = process.cwd()) {
  const reaped = []
  for (const job of listJobs({ cwd })) {
    if (job.status === 'running' && !isProcessAlive(job.meta.pid)) {
      updateMeta(job.jobId, { error: 'orphaned: process no longer alive' }, cwd)
      transition(job.jobId, 'failed', cwd)
      reaped.push(job.jobId)
    }
  }
  return reaped
}

export function cancelJob(jobId, { cwd = process.cwd(), killFn = (pid) => process.kill(pid, 'SIGTERM') } = {}) {
  const job = readJob(jobId, cwd)
  if (!job) return { ok: false, reason: `unknown job: ${jobId}` }
  if (TERMINAL.has(job.status)) return { ok: false, reason: `이미 종결됨 (${job.status})` }

  if (job.meta.pid && isProcessAlive(job.meta.pid)) {
    try {
      killFn(job.meta.pid)
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) }
    }
  }
  transition(jobId, 'cancelled', cwd)
  return { ok: true, jobId }
}

// 종결된 잡을 보존기간 이후 정리한다. finishedAt 이 없으면 디렉토리 mtime 을 쓴다.
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
