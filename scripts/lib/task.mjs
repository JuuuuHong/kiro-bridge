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
import { recordUsage, readUsage, formatUsage } from './usage.mjs'

export const DEFAULT_TIMEOUT_MS = 600_000 // design §8 failure mode table (task 600s)

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
  config = loadConfig(),
  command = kind,
}) {
  const { payload, redactions, excludedFiles } = buildPayload(
    { kind, goal, constraints },
    { redaction: config.redaction },
  )

  if (dryRun) {
    return { dryRun: true, payload, redactions, excludedFiles, agent: agentDef.name }
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
  })

  const parsed = parseResponse(res.result)
  return {
    agent: agentDef.name,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    wrapped: wrapForClaude(parsed, { agent: agentDef.name, webDerived: Boolean(agentDef.webDerived) }),
    redactions,
    excludedFiles,
    metadata: res.metadata,
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
      kind: 'task', goal, agentDef, constraints: TASK_CONSTRAINTS, cwd, command: 'task', ...rest,
    })
  }

  return spawnBackground({
    goal, write, cwd, timeoutMs: rest.timeoutMs, model: rest.model, effort: rest.effort,
    ...(spawnFn ? { spawnFn } : {}),
  })
}

function bridgePath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge.mjs')
}

// bg: create job -> re-exec itself detached. stdio is redirected to the log
// files in the job directory — the parent (slash command) returns immediately.
export function spawnBackground({ goal, write, cwd, timeoutMs, model, effort, spawnFn = spawn }) {
  const { jobId, dir } = jobs.createJob({
    cwd,
    command: 'task',
    payloadOptions: { goal, write, timeoutMs, model, effort },
  })

  const logs = jobs.jobLogPaths(jobId, cwd)
  const out = openSync(logs.stdout, 'a')
  const errFd = openSync(logs.stderr, 'a')
  try {
    const child = spawnFn(process.execPath, [bridgePath(), '_worker', jobId], {
      cwd,
      detached: true,
      stdio: ['ignore', out, errFd],
    })
    child.unref()
    jobs.updateMeta(jobId, { pid: child.pid, startedAt: new Date().toISOString() }, cwd)
  } finally {
    closeSync(out)
    closeSync(errFd)
  }

  return { background: true, jobId, dir }
}

// The detached worker body. All state transitions and result recording happen here.
export async function runWorker(jobId, { cwd = process.cwd(), runFn } = {}) {
  const job = jobs.readJob(jobId, cwd)
  if (!job) throw new Error(`unknown job: ${jobId}`)

  jobs.transition(jobId, 'running', cwd)
  const { goal, write, timeoutMs, model, effort } = job.meta.payloadOptions

  try {
    const result = await runDelegated({
      kind: 'task',
      goal,
      agentDef: pickAgent({ write }),
      cwd,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      model,
      effort,
      runFn: runFn || transport.run,
      command: 'task:bg',
    })
    jobs.writeResult(jobId, result.wrapped, cwd)
    jobs.updateMeta(jobId, { sessionId: result.sessionId, transport: result.transport }, cwd)
    jobs.transition(jobId, 'done', cwd)
    return result
  } catch (err) {
    const message = err instanceof BridgeError ? `[${err.code}] ${err.message}` : String(err?.stack || err)
    jobs.updateMeta(jobId, { error: message }, cwd)
    jobs.transition(jobId, 'failed', cwd)
    throw err
  }
}

// /kiro:result — retrieve results. --follow-up continues the session using the saved sessionId.
export async function result(options = {}) {
  const { jobId: requested, cwd = process.cwd(), followUp, runFn = transport.run, ...rest } = options
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

  const agentDef = pickAgent({ write: Boolean(job.meta.payloadOptions?.write) })
  const config = loadConfig()
  const { payload } = buildTaskPayload({ goal: followUp, config })

  const startedAt = Date.now()
  const res = await runFn(payload, {
    cwd,
    agent: agentDef.name,
    sessionId: job.meta.sessionId,
    timeoutMs: rest.timeoutMs || DEFAULT_TIMEOUT_MS,
    onEvent: rest.onEvent,
    onPermissionRequest: rest.onPermissionRequest,
    signal: rest.signal,
  })
  recordUsage({
    command: 'result:follow-up', agent: agentDef.name, transport: res.transport,
    cwd, durationMs: Date.now() - startedAt,
  })

  const parsed = parseResponse(res.result)
  const wrapped = wrapForClaude(parsed, { agent: agentDef.name, webDerived: Boolean(agentDef.webDerived) })
  return { jobId, status: job.status, meta: job.meta, body, followUp: { question: followUp, wrapped } }
}

export function status({ cwd = process.cwd(), config = loadConfig() } = {}) {
  jobs.reapOrphans(cwd)
  const removed = jobs.gcJobs({ cwd, retentionDays: config.logRetentionDays })
  const list = jobs.listJobs({ cwd })
  return { jobs: list, gcRemoved: removed, usage: readUsage() }
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
  return `transport: ${result.transport} | agent: ${result.agent}\n\n${result.wrapped}`
}

export function formatResult(res) {
  if (res.empty) return res.message
  const lines = [`Job ${res.jobId}: ${res.status}`]
  if (res.meta.error) lines.push(`Error: ${res.meta.error}`)
  if (res.body) lines.push('', res.body)
  else if (res.status === 'running' || res.status === 'queued') lines.push('No result yet.')
  if (res.followUp) lines.push('', `--- follow-up: ${res.followUp.question} ---`, res.followUp.wrapped)
  return lines.join('\n')
}

export function formatStatus(res) {
  const lines = []
  if (res.jobs.length === 0) {
    lines.push('No jobs in this repository.')
  } else {
    lines.push('Jobs (this repository):')
    for (const job of res.jobs) {
      const done = job.meta.finishedAt ? ` (finished ${job.meta.finishedAt})` : ''
      lines.push(`  ${job.jobId}  ${job.status}${done}`)
    }
  }
  if (res.gcRemoved.length > 0) lines.push(`GC: ${res.gcRemoved.length} job(s) cleaned up`)
  lines.push('', 'Usage:', formatUsage(res.usage))
  return lines.join('\n')
}

export function formatCancel(res) {
  return res.ok ? `Cancelled: ${res.jobId}` : `Cancel failed: ${res.reason}`
}
