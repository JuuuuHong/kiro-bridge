// Event normalization. Folds ACP's session/update and subprocess's stream-json
// into the same upper-layer contract (ADR-001R decision 2).
//
// Upper layers (commands, findings) never know which transport was used.
import { detectDenial } from '../errors.mjs'

export const EVENT_TYPES = {
  MESSAGE: 'message',       // text the model emits to the user
  THOUGHT: 'thought',       // internal reasoning (display is optional)
  TOOL_CALL: 'tool_call',   // start of a tool call
  TOOL_RESULT: 'tool_result',
  DENIED: 'denied',         // tool denial detected — result trust must be revoked
  METADATA: 'metadata',     // contextUsagePercentage, etc.
  USAGE: 'usage',           // structured usage_update (token/context/cost accounting)
  PLAN: 'plan',             // agent plan (full replacement of the entry list)
  RAW: 'raw',               // couldn't be normalized. passed through as-is, not dropped
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Bound a currency code to an ISO-4217-shaped token: exactly three ASCII
// letters, upper-cased. Anything else (arbitrary strings, injected control
// chars, non-strings) collapses to null so nothing unbounded is ever stored.
function currencyOrNull(v) {
  if (typeof v !== 'string') return null
  const code = v.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

// ACP v1 usage_update.cost is an optional object { amount: number,
// currency: ISO-4217 string }. Normalize to a bounded, stable shape
// { amount, currency } (or null) — never preserving arbitrary object fields.
//
// A bare numeric cost (legacy/pre-spec builds) is tolerated and mapped to
// { amount, currency: null }; the alias costUsd is treated the same way.
function normalizeCost(update) {
  const raw = update.cost
  if (raw && typeof raw === 'object') {
    const amount = numOrNull(raw.amount)
    if (amount === null) return null
    return { amount, currency: currencyOrNull(raw.currency) }
  }
  // Tolerance path: a bare number (or the costUsd alias) has no currency.
  const legacy = numOrNull(raw) ?? numOrNull(update.costUsd)
  return legacy === null ? null : { amount: legacy, currency: null }
}

// usage_update carries token/context accounting. Field names vary across
// kiro-cli builds, so several known aliases are folded into a stable shape.
// Only official (`used`/`size`) and explicitly-supported compatibility aliases
// are honored — an unverified `total` field is intentionally NOT treated as
// `size`, since it has never been confirmed to carry context size (F7).
function normalizeUsage(update) {
  const used = numOrNull(update.used) ?? numOrNull(update.usedTokens) ?? numOrNull(update.contextUsed)
  const size = numOrNull(update.size) ?? numOrNull(update.contextSize)
  const cost = normalizeCost(update)
  return {
    type: EVENT_TYPES.USAGE,
    used: used ?? null,
    size: size ?? null,
    cost,
  }
}

// plan is a full replacement of the entry list (ACP semantics): each plan
// update supersedes the previous one rather than appending.
function normalizePlan(update) {
  const rawEntries = Array.isArray(update.entries) ? update.entries : []
  const entries = rawEntries.map((e) => ({
    content: typeof e?.content === 'string' ? e.content : textOf(e?.content),
    status: typeof e?.status === 'string' ? e.status : 'pending',
    priority: typeof e?.priority === 'string' ? e.priority : null,
  }))
  return { type: EVENT_TYPES.PLAN, entries }
}

function textOf(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (value.content != null) return textOf(value.content)
  }
  return ''
}

// Kiro context metadata carries a contextUsagePercentage used to warn against
// over-stuffing the payload (design §2.2). It arrives in several real shapes;
// we accept only a finite percentage in [0, 100] and never persist arbitrary
// _meta fields. Anything else → null.
export const KIRO_METADATA_KEY = '_kiro.dev/metadata'

function percentOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null
}

// Extract contextUsagePercentage from a single candidate container: either a
// direct { contextUsagePercentage } or a nested { '_kiro.dev/metadata': {...} }.
function pctFromContainer(container) {
  if (!container || typeof container !== 'object') return null
  const direct = percentOrNull(container.contextUsagePercentage)
  if (direct !== null) return direct
  const nested = container[KIRO_METADATA_KEY]
  if (nested && typeof nested === 'object') return percentOrNull(nested.contextUsagePercentage)
  return null
}

// Bounded normalization of Kiro context metadata from any reasonable shape:
//  - a custom update whose sessionUpdate is '_kiro.dev/metadata'
//  - params._meta with a direct contextUsagePercentage
//  - params._meta['_kiro.dev/metadata']
//  - update._meta equivalents of the above
// Returns a METADATA event carrying ONLY contextUsagePercentage, or null when
// no valid finite 0..100 percentage is present. Never carries arbitrary fields.
export function normalizeKiroMetadata(params) {
  if (!params || typeof params !== 'object') return null
  const update = params.update && typeof params.update === 'object' ? params.update : null

  let pct = null
  // Custom metadata update shape: update.sessionUpdate === '_kiro.dev/metadata'.
  if (update && update.sessionUpdate === KIRO_METADATA_KEY) {
    pct = pctFromContainer(update)
  }
  // params._meta (direct or nested).
  if (pct === null) pct = pctFromContainer(params._meta)
  // update._meta (direct or nested).
  if (pct === null && update) pct = pctFromContainer(update._meta)

  if (pct === null) return null
  return { type: EVENT_TYPES.METADATA, contextUsagePercentage: pct }
}

// Normalizes ACP session/update's params.update.
// The sessionUpdate discriminant follows the ACP spec.
export function normalizeAcpUpdate(update) {
  if (!update || typeof update !== 'object') {
    return { type: EVENT_TYPES.RAW, raw: update }
  }
  const kind = update.sessionUpdate

  switch (kind) {
    case 'agent_message_chunk':    return { type: EVENT_TYPES.MESSAGE, text: textOf(update.content) }
    case 'agent_thought_chunk':
      return { type: EVENT_TYPES.THOUGHT, text: textOf(update.content) }
    case 'usage_update':
      return normalizeUsage(update)
    case 'plan':
      return normalizePlan(update)
    case 'tool_call':
      return {
        type: EVENT_TYPES.TOOL_CALL,
        toolCallId: update.toolCallId,
        title: update.title || update.kind || '',
        status: update.status || 'pending',
      }
    case 'tool_call_update': {
      const text = textOf(update.content)
      if (update.status === 'failed' && detectDenial(text)) {
        return { type: EVENT_TYPES.DENIED, toolCallId: update.toolCallId, text }
      }
      return {
        type: EVENT_TYPES.TOOL_RESULT,
        toolCallId: update.toolCallId,
        status: update.status || 'completed',
        text,
      }
    }
    default: {
      const text = textOf(update.content)
      if (detectDenial(text)) {
        return { type: EVENT_TYPES.DENIED, text }
      }
      return { type: EVENT_TYPES.RAW, raw: update }
    }
  }
}

// Normalizes one line of subprocess's --output-format stream-json.
// Handles both a line carrying an ACP session/update verbatim and a flat-form line.
export function normalizeStreamJsonLine(line) {
  if (line == null) return null
  let obj = line
  if (typeof line === 'string') {
    const trimmed = line.trim()
    if (trimmed === '') return null
    try {
      obj = JSON.parse(trimmed)
    } catch {
      // A non-JSON line is a human-readable log. A denial string sometimes
      // rides here too, so it's also checked as plain text.
      return detectDenial(trimmed)
        ? { type: EVENT_TYPES.DENIED, text: trimmed }
        : { type: EVENT_TYPES.RAW, raw: trimmed }
    }
  }

  if (obj && typeof obj === 'object') {
    if (obj.method === 'session/update' && obj.params?.update) {
      return normalizeAcpUpdate(obj.params.update)
    }
    if (obj.sessionUpdate) return normalizeAcpUpdate(obj)
    if (obj.type === 'metadata' || obj._meta) {
      return { type: EVENT_TYPES.METADATA, meta: obj._meta || obj }
    }
    const text = textOf(obj)
    if (detectDenial(text)) return { type: EVENT_TYPES.DENIED, text }
    if (text) return { type: EVENT_TYPES.MESSAGE, text }
  }
  return { type: EVENT_TYPES.RAW, raw: obj }
}

// Aggregates the event stream into the final text and denial status.
export function createCollector() {
  const chunks = []
  const denials = []
  let meta = null
  let contextUsagePercentage = null
  let usage = null
  let plan = null

  return {
    push(event) {
      if (!event) return
      if (event.type === EVENT_TYPES.MESSAGE && event.text) chunks.push(event.text)
      if (event.type === EVENT_TYPES.DENIED) denials.push(event)
      if (event.type === EVENT_TYPES.METADATA) {
        // New bounded shape carries only contextUsagePercentage. The legacy
        // shape carried a raw `meta` object (kept for backward compatibility).
        if (typeof event.contextUsagePercentage === 'number') {
          contextUsagePercentage = event.contextUsagePercentage
        }
        if (event.meta && typeof event.meta === 'object') meta = event.meta
      }
      // usage/plan keep only the latest — plan is a full replacement (ACP), and
      // usage accounting is cumulative from kiro-cli's side.
      if (event.type === EVENT_TYPES.USAGE) {
        usage = { used: event.used, size: event.size, cost: event.cost }
      }
      if (event.type === EVENT_TYPES.PLAN) {
        plan = { entries: event.entries }
      }
    },
    get text() {
      return chunks.join('')
    },
    get denied() {
      return denials.length > 0
    },
    get denials() {
      return denials.slice()
    },
    get usage() {
      return usage
    },
    get plan() {
      return plan
    },
    // metadata merges the raw METADATA payload (contextUsagePercentage, etc.)
    // with the latest structured usage/plan. Existing fields are preserved.
    get metadata() {
      if (meta == null && contextUsagePercentage == null && usage == null && plan == null) return null
      const out = meta && typeof meta === 'object' ? { ...meta } : {}
      if (contextUsagePercentage != null) out.contextUsagePercentage = contextUsagePercentage
      if (usage != null) out.usage = usage
      if (plan != null) out.plan = plan
      return out
    },
  }
}

// Line-based stream splitter. Never drops a line split across chunk boundaries.
export function createLineSplitter(onLine) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() !== '') onLine(line)
        index = buffer.indexOf('\n')
      }
    },
    flush() {
      if (buffer.trim() !== '') onLine(buffer)
      buffer = ''
    },
  }
}
