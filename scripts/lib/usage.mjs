// Per-call usage instrumentation (design §4). Kiro delegation spends credits,
// so a record of when, what, and how much must be kept. usage.jsonl is append-only.
import { join, dirname } from 'node:path'
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { bridgeHome } from './config.mjs'

export function usagePath() {
  return join(bridgeHome(), 'usage.jsonl')
}

// ACP v1 usage cost is { amount: number, currency: ISO-4217 string } or null.
// Reduce any input to a bounded { amount, currency } (or null): a finite amount
// plus a 3-letter currency code, dropping arbitrary fields. A bare numeric cost
// (legacy build) is tolerated as an amount with no currency.
function normalizeAcpCost(cost) {
  if (Number.isFinite(cost)) return { amount: cost, currency: null }
  if (!cost || typeof cost !== 'object' || !Number.isFinite(cost.amount)) return null
  let currency = null
  if (typeof cost.currency === 'string') {
    const code = cost.currency.trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(code)) currency = code
  }
  return { amount: cost.amount, currency }
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
    // Value from ACP metadata. null if absent — an instrumentation failure never blocks the call.
    contextUsagePercentage: entry.contextUsagePercentage ?? null,
  }
  // ACP structured usage accounting, when the transport surfaced it. Fields are
  // only added when present so older readers/records stay backward compatible.
  if (Number.isFinite(entry.acpUsed)) record.acpUsed = entry.acpUsed
  if (Number.isFinite(entry.acpSize)) record.acpSize = entry.acpSize
  // ACP v1 usage cost is { amount, currency } (currency optional, ISO-4217) —
  // never a bare number. Persist the amount/currency separately, and only when
  // valid, so nothing arbitrary lands in usage.jsonl. A legacy bare-number cost
  // is tolerated as an amount with no currency. Old records that stored the
  // (incorrect) numeric `acpCost` field remain readable — they are simply not
  // written anymore.
  const cost = normalizeAcpCost(entry.acpCost)
  if (cost) {
    record.acpCostAmount = cost.amount
    if (cost.currency) record.acpCostCurrency = cost.currency
  }
  try {
    const target = usagePath()
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    appendFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // Instrumentation is best-effort. A logging failure must never fail the actual call.
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
  if (records.length === 0) return 'No usage recorded.'
  const { total, byCommand } = summarizeUsage(records)
  const lines = [`${total} call(s) total`]
  for (const [command, s] of Object.entries(byCommand)) {
    const avg = s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0
    lines.push(`  ${command}: ${s.calls} call(s) (${s.failed} failed) - avg ${avg}ms`)
  }
  return lines.join('\n')
}
