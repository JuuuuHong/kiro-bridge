// /kiro:task 플로우 + 잡 커맨드(result/status/cancel).
//
// fg 는 review 와 같은 조립이고, bg 는 잡을 만들어 자기 자신(bridge.mjs)의
// _worker 커맨드를 detached 로 띄운 뒤 잡 id 만 돌려준다. 워커가 죽어도
// 상태 파일이 남으므로 result/status 로 항상 추적할 수 있다.
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

export const DEFAULT_TIMEOUT_MS = 600_000 // 설계 §8 실패 모드 표 (task 600s)

const TASK_CONSTRAINTS = [
  '읽어서 확인하지 못한 내용은 주장하지 말 것.',
]

// --write 는 전권이 아니라 쓰기 허용 scoped 에이전트 사용을 뜻한다 (ADR-002 결정 4).
export function pickAgent({ write = false } = {}) {
  return write ? AGENT_DEFS.worker : AGENT_DEFS.researcher
}

function buildTaskPayload({ goal, constraints = [], config }) {
  return buildPayload(
    { kind: 'task', goal, constraints: [...TASK_CONSTRAINTS, ...constraints] },
    { redaction: config.redaction },
  )
}

// fg 실행 공통 경로. spec.mjs 도 이 함수를 쓴다.
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
    throw bridgeError(CODES.PROTOCOL, { reason: 'task 목표가 비어 있습니다' })
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

// bg: 잡 생성 → 자기 자신을 detached 로 재실행. stdio 는 잡 디렉토리의
// 로그 파일로 리다이렉트한다 — 부모(슬래시 커맨드)는 즉시 반환된다.
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

// detached 워커 본체. 상태 전이와 결과 기록이 전부 여기서 일어난다.
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

// /kiro:result — 결과 회수. --follow-up 은 저장된 sessionId 로 세션을 이어간다.
export async function result(options = {}) {
  const { jobId: requested, cwd = process.cwd(), followUp, runFn = transport.run, ...rest } = options
  jobs.reapOrphans(cwd)

  const jobId = requested || jobs.latestJobId(cwd)
  if (!jobId) return { empty: true, message: '이 저장소에 잡이 없습니다.' }

  const job = jobs.readJob(jobId, cwd)
  if (!job) return { empty: true, message: `잡을 찾을 수 없습니다: ${jobId}` }

  const body = jobs.readResult(jobId, cwd)

  if (!followUp) {
    return { jobId, status: job.status, meta: job.meta, body }
  }

  // follow-up 은 ACP 세션 재사용이 전제다 (설계 §8). 원샷 경로에는 세션이 없다.
  if (!job.meta.sessionId) {
    throw bridgeError(CODES.PROTOCOL, {
      reason: `잡 ${jobId} 에 재사용할 세션이 없습니다 (transport: ${job.meta.transport || 'unknown'})`,
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
  if (!jobId) return { ok: false, reason: 'job id 가 필요합니다. /kiro-bridge:status 로 확인하세요.' }
  return jobs.cancelJob(jobId, { cwd })
}

// --- 사람이 읽는 요약 ---

export function formatTask(result) {
  if (result.background) {
    return [
      `백그라운드 잡 시작: ${result.jobId}`,
      `결과 회수: /kiro-bridge:result ${result.jobId}`,
      `상태 확인: /kiro-bridge:status`,
    ].join('\n')
  }
  if (result.dryRun) {
    return `[dry-run] agent: ${result.agent}\n${JSON.stringify(result.payload, null, 2)}`
  }
  return `transport: ${result.transport} | agent: ${result.agent}\n\n${result.wrapped}`
}

export function formatResult(res) {
  if (res.empty) return res.message
  const lines = [`잡 ${res.jobId}: ${res.status}`]
  if (res.meta.error) lines.push(`오류: ${res.meta.error}`)
  if (res.body) lines.push('', res.body)
  else if (res.status === 'running' || res.status === 'queued') lines.push('아직 결과가 없습니다.')
  if (res.followUp) lines.push('', `--- follow-up: ${res.followUp.question} ---`, res.followUp.wrapped)
  return lines.join('\n')
}

export function formatStatus(res) {
  const lines = []
  if (res.jobs.length === 0) {
    lines.push('이 저장소에 잡이 없습니다.')
  } else {
    lines.push('잡 목록 (이 저장소):')
    for (const job of res.jobs) {
      const done = job.meta.finishedAt ? ` (종료 ${job.meta.finishedAt})` : ''
      lines.push(`  ${job.jobId}  ${job.status}${done}`)
    }
  }
  if (res.gcRemoved.length > 0) lines.push(`GC: ${res.gcRemoved.length}개 잡 정리됨`)
  lines.push('', '사용량:', formatUsage(res.usage))
  return lines.join('\n')
}

export function formatCancel(res) {
  return res.ok ? `취소됨: ${res.jobId}` : `취소 실패: ${res.reason}`
}
