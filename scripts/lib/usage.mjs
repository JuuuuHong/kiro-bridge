// 호출별 사용량 계측 (설계 §4). Kiro 위임은 크레딧을 쓰는 호출이므로
// 언제 무엇에 얼마나 썼는지가 남아야 한다. usage.jsonl 은 append-only 다.
import { join, dirname } from 'node:path'
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { bridgeHome } from './config.mjs'

export function usagePath() {
  return join(bridgeHome(), 'usage.jsonl')
}

export function recordUsage(entry) {
  const record = {
    at: new Date().toISOString(),
    command: entry.command,
    agent: entry.agent || null,
    model: entry.model || null,
    transport: entry.transport || null,
    durationMs: entry.durationMs ?? null,
    cwd: entry.cwd || process.cwd(),
    ok: entry.ok !== false,
    // ACP metadata 에서 오는 값. 없으면 null — 계측 실패로 호출을 막지 않는다.
    contextUsagePercentage: entry.contextUsagePercentage ?? null,
  }
  try {
    const target = usagePath()
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    appendFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // 계측은 best-effort. 기록 실패가 본 호출을 실패시키면 안 된다.
  }
  return record
}

export function readUsage({ limit = 1000 } = {}) {
  let lines = []
  try {
    lines = readFileSync(usagePath(), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

export function summarizeUsage(records) {
  const byCommand = {}
  for (const r of records) {
    const key = r.command || 'unknown'
    byCommand[key] = byCommand[key] || { calls: 0, failed: 0, totalMs: 0 }
    byCommand[key].calls += 1
    if (r.ok === false) byCommand[key].failed += 1
    if (Number.isFinite(r.durationMs)) byCommand[key].totalMs += r.durationMs
  }
  return { total: records.length, byCommand }
}

export function formatUsage(records) {
  if (records.length === 0) return '기록된 사용량이 없습니다.'
  const { total, byCommand } = summarizeUsage(records)
  const lines = [`총 ${total}회 호출`]
  for (const [command, s] of Object.entries(byCommand)) {
    const avg = s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0
    lines.push(`  ${command}: ${s.calls}회 (실패 ${s.failed}) · 평균 ${avg}ms`)
  }
  return lines.join('\n')
}
