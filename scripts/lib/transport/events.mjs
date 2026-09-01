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
  RAW: 'raw',               // couldn't be normalized. passed through as-is, not dropped
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

// Normalizes ACP session/update's params.update.
// The sessionUpdate discriminant is based on the ACP spec and is pending empirical verification.
export function normalizeAcpUpdate(update) {
  if (!update || typeof update !== 'object') {
    return { type: EVENT_TYPES.RAW, raw: update }
  }
  const kind = update.sessionUpdate

  switch (kind) {
    case 'agent_message_chunk':
      return { type: EVENT_TYPES.MESSAGE, text: textOf(update.content) }
    case 'agent_thought_chunk':
      return { type: EVENT_TYPES.THOUGHT, text: textOf(update.content) }
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

  return {
    push(event) {
      if (!event) return
      if (event.type === EVENT_TYPES.MESSAGE && event.text) chunks.push(event.text)
      if (event.type === EVENT_TYPES.DENIED) denials.push(event)
      if (event.type === EVENT_TYPES.METADATA) meta = event.meta
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
    get metadata() {
      return meta
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
