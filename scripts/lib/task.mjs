// /kiro:task flow + job commands (result/status/cancel).
//
// fg is the same assembly as review; bg creates a job, spawns its own
// (bridge.mjs) _worker command detached, and returns only the job id. Even if
// the worker dies, the state file remains, so result/status can always track it.
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { buildPayload } from './context.mjs'
import { parseResponse, wrapForClaude } from './findings.mjs'
import { loadConfig } from './config.mjs'
import * as transport from './transport/index.mjs'
import { AGENT_DEFS } from './agents.mjs'
import { bridgeError, BridgeError, CODES } from './errors.mjs'
import * as jobs from './jobs.mjs'
import * as sessions from './sessions.mjs'
import { recordUsage, readUsage, formatUsage, pruneUsage } from './usage.mjs'
import {
  review as runReview,
  formatSummary as formatReviewSummary,
  DEFAULT_TIMEOUT_MS as REVIEW_TIMEOUT_MS,
} from './review.mjs'

export const DEFAULT_TIMEOUT_MS = 600_000 // design §8 failure mode table (task 600s)

// Persist a successful ACP turn into the resume registry, best-effort. Only an
// ACP turn that surfaced a sessionId is resumable — a subprocess/one-shot turn
// (sessionId null) produces no record. Returns the new recordId or null. Never
// throws: registration must never fail an already-succeeded delegated call.
export function registerResumable({
  res, agentDef, kind, command, write = false, cwd, config = loadConfig(cwd),
}) {
  if (!res || !res.sessionId) return null
  const record = sessions.registerSession(
    {
      sessionId: res.sessionId,
      agent: agentDef.name,
      source: { kind, command },
      write: Boolean(write),
      transport: res.transport,
      model: res.metadata?.model || res.model,
    },
    { cwd, retentionDays: config.logRetentionDays },
  )
  return record ? record.recordId : null
}

// One concise, prose-free hint pointing at the resume command. Shown only when
// a resumable record was actually created. Kept command-agnostic so task/spec/
// review foreground output and the completed-job result share one wording.
export function resumeHint(sessionRecordId) {
  if (!sessionRecordId) return null
  return `Resume this session: /kiro-bridge:resume "<question>" --session ${sessionRecordId}`
}

const TASK_CONSTRAINTS = [
  'Do not claim anything you could not confirm by reading it.',
]

// --write does not mean full access — it means using a write-permitted scoped agent (ADR-002 decision 4).
export function pickAgent({ write = false } = {}) {
  return write ? AGENT_DEFS.worker : AGENT_DEFS.researcher
}

function buildTaskPayload({ goal, constraints = [], config }) {
  return buildPayload(
    { kind: 'task', goal, constraints: [...TASK_CONSTRAINTS, ...constraints] },
    { redaction: config.redaction },
  )
}

// Common fg execution path. spec.mjs also uses this function.
export async function runDelegated({
  kind = 'task',
  goal,
  agentDef,
  constraints = [],
  cwd = process.cwd(),
  dryRun = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model,
  effort,
  onEvent,
  onPermissionRequest,
  signal,
  runFn = transport.run,
  config = loadConfig(cwd),
  command = kind,
  // Foreground callers register the successful resumable turn here. The
  // background worker MUST leave this false and register only after its atomic
  // completeJob returns 'done' — otherwise a cancel-first race would leave a
  // resumable record for a job that never produced a result (see runWorker).
  register = false,
  write = false,
}) {
  const { payload, redactions, excludedFiles, droppedFiles } = buildPayload(
    { kind, goal, constraints },
    { redaction: config.redaction },
  )

  if (dryRun) {
    return { dryRun: true, payload, redactions, excludedFiles, droppedFiles, agent: agentDef.name }
  }

  const startedAt = Date.now()
  let res
  try {
    res = await runFn(payload, {
      cwd,
      agent: agentDef.name,
      model,
      effort,
      timeoutMs,
      onEvent,
      onPermissionRequest,
      signal,
    })
  } catch (err) {
    recordUsage({
      command, agent: agentDef.name, model, cwd, ok: false,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }

  recordUsage({
    command,
    agent: agentDef.name,
    model,
    transport: res.transport,
    cwd,
    durationMs: Date.now() - startedAt,
    contextUsagePercentage: res.metadata?.contextUsagePercentage,
    acpUsed: res.metadata?.usage?.used,
    acpSize: res.metadata?.usage?.size,
    acpCost: res.metadata?.usage?.cost,
  })

  const parsed = parseResponse(res.result)
  // Only foreground callers register here. A resumable record is created only
  // for an ACP turn with a sessionId; subprocess/null-session turns yield null.
  const sessionRecordId = register
    ? registerResumable({ res, agentDef, kind, command, write, cwd, config })
    : null
  return {
    agent: agentDef.name,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    wrapped: wrapForClaude(parsed, { agent: agentDef.name, webDerived: Boolean(agentDef.webDerived) }),
    redactions,
    excludedFiles,
    droppedFiles,
    metadata: res.metadata,
    sessionRecordId,
  }
}

export async function task(options = {}) {
  const {
    goal,
    write = false,
    background = false,
    cwd = process.cwd(),
    spawnFn,
    ...rest
  } = options
  if (!goal || !goal.trim()) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'task goal is empty' })
  }

  const agentDef = pickAgent({ write })

  if (!background) {
    return runDelegated({
      kind: 'task', goal, agentDef, constraints: TASK_CONSTRAINTS, cwd, command: 'task',
      register: true, write, ...rest,
    })
  }

  return spawnBackground({
    command: 'task',
    cwd,
    payloadOptions: {
      goal, write, timeoutMs: rest.timeoutMs, model: rest.model, effort: rest.effort,
    },
    ...(spawnFn ? { spawnFn } : {}),
  })
}

function bridgePath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge.mjs')
}

// bg: create job -> re-exec itself detached. stdio is redirected to the log
// files in the job directory — the parent (slash command) returns immediately.
//
// Command-agnostic: task and review share this exact lifecycle. The command
// name and its bounded payloadOptions are persisted on the job, and runWorker
// dispatches on the command. payloadOptions must never carry diff or file
// contents — the worker collects those itself (design §7).
export function spawnBackground({ command, cwd, payloadOptions = {}, spawnFn = spawn }) {
  const { jobId, dir } = jobs.createJob({
    cwd,
    command,
    payloadOptions,
  })

  const logs = jobs.jobLogPaths(jobId, cwd)
  const out = openSync(logs.stdout, 'a')
  const errFd = openSync(logs.stderr, 'a')
  let child
  try {
    child = spawnFn(process.execPath, [bridgePath(), '_worker', jobId], {
      cwd,
      detached: true,
      stdio: ['ignore', out, errFd],
    })
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      throw new Error('worker process did not provide a valid pid')
    }
    child.once?.('error', (err) => {
      const current = jobs.readJob(jobId, cwd)
      if (!current || jobs.TERMINAL.has(current.status)) return
      jobs.updateMeta(jobId, { error: `[${CODES.SPAWN_FAILED}] ${String(err?.message || err)}` }, cwd)
      jobs.transition(jobId, 'failed', cwd)
    })
    // Persist the spawned child's PID + best-effort identity while the job is
    // still queued, so reapOrphans can tell "worker spawned but hasn't flipped
    // to running yet" apart from "worker never started". The write goes through
    // the per-job lock via an updater callback: if the worker started fast and
    // already reasserted its own pid/identity/startedAt, we must not clobber
    // those fresher fields — only fill in what the worker hasn't written yet.
    jobs.updateMeta(jobId, (meta) => {
      const patch = { spawnedAt: new Date().toISOString() }
      if (meta.pid == null) patch.pid = child.pid
      if (meta.procIdentity == null) patch.procIdentity = jobs.processIdentity(child.pid)
      return patch
    }, cwd)
    child.unref()
  } catch (err) {
    const message = `[${CODES.SPAWN_FAILED}] ${String(err?.message || err)}`
    try { jobs.failJob(jobId, message, cwd) } catch {}
    throw bridgeError(CODES.SPAWN_FAILED, { jobId, cause: String(err?.message || err) })
  } finally {
    closeSync(out)
    closeSync(errFd)
  }

  return { background: true, jobId, dir }
}

// review --bg entry point. Reuses the exact same jobs lifecycle and detached
// worker as task --bg. Only ref/focus/adversarial/model/effort/timeout are
// persisted — the diff and file contents are collected later, in the worker
// (design §7: no diff/file contents in the job payload).
export function reviewBackground({
  ref, focus, adversarial = false, cwd = process.cwd(),
  timeoutMs, model, effort, spawnFn,
} = {}) {
  return spawnBackground({
    command: 'review',
    cwd,
    payloadOptions: {
      ref: ref || null,
      focus,
      adversarial: Boolean(adversarial),
      timeoutMs,
      model,
      effort,
    },
    ...(spawnFn ? { spawnFn } : {}),
  })
}

// The detached worker body. All state transitions and result recording happen here.
// Command-agnostic: dispatches to the per-command executor after the shared
// queued→running startup. The executor returns a { wrapped, ...metaPatch }
// shape; completion/cancellation semantics are identical across commands.
export async function runWorker(jobId, { cwd = process.cwd(), runFn, collectDiffFn } = {}) {
  const job = jobs.readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)
  if (jobs.TERMINAL.has(job.status)) return null

  try {
    // PID metadata and queued→running are one locked operation. Keeping startup
    // inside this try also ensures any lock or malformed-payload failure reaches
    // the explicit failed-state path instead of escaping as a queued worker.
    const now = new Date().toISOString()
    const started = jobs.startJob(jobId, {
      pid: process.pid,
      procIdentity: jobs.processIdentity(process.pid),
      startedAt: now,
      lastProgressAt: now,
    }, cwd)
    if (started !== 'running') return null

    const onEvent = (event) => { jobs.recordJobEvent(jobId, event, { cwd }) }
    const executor = WORKER_EXECUTORS[job.meta.command]
    if (!executor) throw new Error(`unsupported background command: ${job.meta.command}`)
    const result = await executor(job, { cwd, onEvent, runFn: runFn || transport.run, collectDiffFn })

    const metaPatch = { sessionId: result.sessionId, transport: result.transport }
    // Persist latest structured usage/plan from the completed ACP result.
    if (result.metadata?.usage) {
      const u = result.metadata.usage
      metaPatch.usage = {
        used: Number.isFinite(u.used) ? u.used : null,
        size: Number.isFinite(u.size) ? u.size : null,
        cost: jobs.sanitizeCost(u.cost),
      }
    }
    if (result.metadata?.plan?.entries) {
      metaPatch.plan = jobs.summarizePlan(result.metadata.plan.entries)
    }
    // Result + metadata + running→done share one lock. If cancel won first,
    // completeJob returns cancelled and never persists a result body.
    const finished = jobs.completeJob(jobId, result.wrapped, metaPatch, cwd)
    if (finished !== 'done') return null
    // Register the resumable session ONLY after completion is atomically won.
    // A cancel-first race returns 'cancelled' above, so a cancelled job never
    // leaves a resumable record — there is no result to resume from. Subprocess
    // / no-session results (e.g. review's no-changes body) yield null.
    const agentDef = job.meta.command === 'review'
      ? AGENT_DEFS.reviewer
      : pickAgent({ write: Boolean(job.meta.payloadOptions?.write) })
    const sessionRecordId = registerResumable({
      res: result,
      agentDef,
      kind: job.meta.command === 'review' ? 'review' : 'task',
      command: job.meta.command === 'review' ? 'review:bg' : 'task:bg',
      write: Boolean(job.meta.payloadOptions?.write),
      cwd,
    })
    if (sessionRecordId) {
      try { jobs.updateMeta(jobId, { sessionRecordId }, cwd) } catch {}
    }
    return { ...result, sessionRecordId }
  } catch (err) {
    const message = err instanceof BridgeError ? `[${err.code}] ${err.message}` : String(err?.stack || err)
    // A turn that died to a throttle, timeout, or tool denial still consumed
    // credits, and the ACP session it opened is still resumable on Kiro's side —
    // the transport puts its sessionId on the error. Persisting it before
    // failing means `result --follow-up` can pick the conversation back up
    // instead of paying to redo the work from scratch. Best-effort and ahead of
    // failJob, since a terminal status must not block on this.
    const failedSessionId = err?.details?.sessionId
    if (failedSessionId) {
      try { jobs.updateMeta(jobId, { sessionId: failedSessionId }, cwd) } catch {}
    }
    // A startup lock timeout may still have a live holder. Keep this best-effort
    // and bounded; reapOrphans remains the final self-healing fallback.
    try { jobs.failJob(jobId, message, cwd, { timeoutMs: 250 }) } catch {}
    throw err
  }
}

// Per-command background executors. Each returns the same shape a foreground
// call would (wrapped body + sessionId/transport/metadata) so the persisted
// result body is identical to the foreground path.
const WORKER_EXECUTORS = {
  task(job, { cwd, onEvent, runFn }) {
    const { goal, write, timeoutMs, model, effort } = job.meta.payloadOptions
    return runDelegated({
      kind: 'task',
      goal,
      agentDef: pickAgent({ write }),
      // Must mirror the foreground task payload exactly (see task()) — otherwise
      // adding --bg silently drops the no-unverified-claims constraint.
      constraints: TASK_CONSTRAINTS,
      cwd,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      model,
      effort,
      onEvent,
      runFn,
      command: 'task:bg',
    })
  },
  // Review collects its own diff in the worker: the job payload stores only
  // ref/focus/adversarial/model/effort/timeout, never diff or file contents.
  // The returned body is the same wrapped findings the foreground path produces.
  async review(job, { cwd, onEvent, runFn, collectDiffFn }) {
    const { ref, focus, adversarial, timeoutMs, model, effort } = job.meta.payloadOptions
    const res = await runReview({
      cwd,
      ref: ref || null,
      focus,
      adversarial: Boolean(adversarial),
      timeoutMs: timeoutMs || REVIEW_TIMEOUT_MS,
      model,
      effort,
      onEvent,
      runFn,
      ...(collectDiffFn ? { collectDiffFn } : {}),
    })
    // A no-reviewable-changes outcome has no wrapped body. Persist the same
    // human-readable message the foreground path prints so result.txt is never
    // empty and status/result stay consistent with foreground behaviour.
    if (res.empty) {
      return { wrapped: formatReviewSummary(res), sessionId: null, transport: null, metadata: undefined }
    }
    return res
  },
}

// /kiro:result — retrieve results. --follow-up continues the session using the saved sessionId.
export async function result(options = {}) {
  const { jobId: requested, cwd = process.cwd(), followUp, model, effort, runFn = transport.run, ...rest } = options
  jobs.reapOrphans(cwd)

  const jobId = requested || jobs.latestJobId(cwd)
  if (!jobId) return { empty: true, message: 'No jobs in this repository.' }

  const job = jobs.readJob(jobId, cwd)
  if (!job) return { empty: true, message: `Job not found: ${jobId}` }

  const body = jobs.readResult(jobId, cwd)

  if (!followUp) {
    return { jobId, status: job.status, meta: job.meta, body }
  }

  // follow-up assumes ACP session reuse (design §8). The one-shot path has no session.
  if (!job.meta.sessionId) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: `job ${jobId} has no session to reuse (transport: ${job.meta.transport || 'unknown'})`,
    })
  }

  // A review background job must continue under the reviewer agent, not the
  // researcher — the follow-up is a review-context question about the same diff.
  // Task jobs keep their write/read agent selection.
  const agentDef = job.meta.command === 'review'
    ? AGENT_DEFS.reviewer
    : pickAgent({ write: Boolean(job.meta.payloadOptions?.write) })
  const config = loadConfig(cwd)
  const { payload } = buildTaskPayload({ goal: followUp, config })

  const startedAt = Date.now()
  let res
  try {
    res = await runFn(payload, {
      cwd,
      agent: agentDef.name,
      sessionId: job.meta.sessionId,
      timeoutMs: rest.timeoutMs || DEFAULT_TIMEOUT_MS,
      model,
      effort,
      onEvent: rest.onEvent,
      onPermissionRequest: rest.onPermissionRequest,
      signal: rest.signal,
    })
  } catch (err) {
    recordUsage({
      command: 'result:follow-up', agent: agentDef.name, model, cwd, ok: false,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
  recordUsage({
    command: 'result:follow-up', agent: agentDef.name, model, transport: res.transport,
    cwd, durationMs: Date.now() - startedAt,
    contextUsagePercentage: res.metadata?.contextUsagePercentage,
    acpUsed: res.metadata?.usage?.used,
    acpSize: res.metadata?.usage?.size,
    acpCost: res.metadata?.usage?.cost,
  })

  const parsed = parseResponse(res.result)
  const wrapped = wrapForClaude(parsed, { agent: agentDef.name, webDerived: Boolean(agentDef.webDerived) })
  // A successful follow-up is itself a resumable ACP turn — persist it so the
  // conversation can continue via /kiro-bridge:resume. Non-ACP/null-session
  // follow-ups (the only kind that reach here already have a session, but keep
  // the guard) yield no record.
  const sessionRecordId = registerResumable({
    res,
    agentDef,
    kind: job.meta.command === 'review' ? 'review' : 'task',
    command: 'result:follow-up',
    write: Boolean(job.meta.payloadOptions?.write),
    cwd,
    config,
  })
  return {
    jobId, status: job.status, meta: job.meta, body,
    followUp: { question: followUp, wrapped, sessionRecordId },
  }
}

export function status({ cwd = process.cwd(), config = loadConfig(cwd), now = Date.now(), identityFn } = {}) {
  jobs.reapOrphans(cwd, { now, ...(identityFn ? { identityFn } : {}) })
  const removed = jobs.gcJobs({ cwd, retentionDays: config.logRetentionDays, now })
  // The usage log is append-only and global (not cwd-scoped), so bound it on
  // the same opportunistic sweep that prunes jobs.
  try { pruneUsage({ retentionDays: config.logRetentionDays, now }) } catch {}
  const list = jobs.listJobs({ cwd })
  const withHealth = list.map((job) => ({ ...job, health: jobs.classifyHealth(job, { now }) }))
  return { jobs: withHealth, gcRemoved: removed, usage: readUsage() }
}

export function cancel({ jobId, cwd = process.cwd() } = {}) {
  if (!jobId) return { ok: false, reason: 'job id is required. Check with /kiro-bridge:status.' }
  return jobs.cancelJob(jobId, { cwd })
}

// --- human-readable summaries ---

export function formatTask(result) {
  if (result.background) {
    return [
      `Background job started: ${result.jobId}`,
      `Retrieve result: /kiro-bridge:result ${result.jobId}`,
      `Check status: /kiro-bridge:status`,
    ].join('\n')
  }
  if (result.dryRun) {
    return `[dry-run] agent: ${result.agent}\n${JSON.stringify(result.payload, null, 2)}`
  }
  const lines = [`transport: ${result.transport} | agent: ${result.agent}`, '', result.wrapped]
  const hint = resumeHint(result.sessionRecordId)
  if (hint) lines.push('', hint)
  return lines.join('\n')
}

export function formatResult(res) {
  if (res.empty) return res.message
  const lines = [`Job ${res.jobId}: ${res.status}`]
  if (res.meta.error) lines.push(`Error: ${res.meta.error}`)
  if (res.body) lines.push('', res.body)
  else if (res.status === 'running' || res.status === 'queued') lines.push('No result yet.')
  if (res.followUp) lines.push('', `--- follow-up: ${res.followUp.question} ---`, res.followUp.wrapped)
  // A completed job that produced a resumable ACP session surfaces the same
  // concise resume hint as the foreground paths, where available. A follow-up
  // turn's fresh record takes precedence over the original job record.
  const recordId = res.followUp?.sessionRecordId
    || (res.status === 'done' ? res.meta.sessionRecordId : null)
  const hint = resumeHint(recordId)
  if (hint) lines.push('', hint)
  return lines.join('\n')
}

export function formatStatus(res) {
  const lines = []
  if (res.jobs.length === 0) {
    lines.push('No jobs in this repository.')
  } else {
    lines.push('Jobs (this repository):')
    for (const job of res.jobs) {
      const health = job.health && job.health !== job.status ? ` [${job.health}]` : ''
      const done = job.meta.finishedAt ? ` (finished ${job.meta.finishedAt})` : ''
      lines.push(`  ${job.jobId}  ${job.status}${health}${done}`)
      if (job.meta.lastProgressAt && !jobs.TERMINAL.has(job.status)) {
        lines.push(`    Last progress: ${job.meta.lastProgressAt}`)
      }
      if (job.meta.usage) {
        const u = job.meta.usage
        lines.push(`    Usage: used=${u.used ?? '-'} size=${u.size ?? '-'} cost=${jobs.formatCost(u.cost)}`)
      }
      const recent = Array.isArray(job.meta.recentEvents) ? job.meta.recentEvents.slice(-3) : []
      for (const ev of recent) {
        lines.push(`    · ${jobs.formatEventSummary(ev)}`)
      }
    }
  }
  if (res.gcRemoved.length > 0) lines.push(`GC: ${res.gcRemoved.length} job(s) cleaned up`)
  lines.push('', 'Usage:', formatUsage(res.usage))
  return lines.join('\n')
}

export function formatCancel(res) {
  return res.ok ? `Cancelled: ${res.jobId}` : `Cancel failed: ${res.reason}`
}
