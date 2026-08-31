// 이벤트 정규화. ACP 의 session/update 와 subprocess 의 stream-json 을
// 동일한 상위 계약으로 접는다 (ADR-001R 결정 2).
//
// 상위 계층(커맨드·findings)은 어느 transport 를 탔는지 알지 못한다.
import { detectDenial } from '../errors.mjs'

export const EVENT_TYPES = {
  MESSAGE: 'message',       // 모델이 사용자에게 내는 텍스트
  THOUGHT: 'thought',       // 내부 추론 (표시는 선택)
  TOOL_CALL: 'tool_call',   // 툴 호출 시작
  TOOL_RESULT: 'tool_result',
  DENIED: 'denied',         // 툴 거부 감지 — 결과 신뢰를 취소해야 한다
  METADATA: 'metadata',     // contextUsagePercentage 등
  RAW: 'raw',               // 정규화하지 못한 것. 버리지 않고 그대로 흘린다
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

// ACP session/update 의 params.update 를 정규화한다.
// sessionUpdate 판별자는 ACP 스펙 기준이며 실측 대기 항목이다.
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

// subprocess 의 --output-format stream-json 한 줄을 정규화한다.
// 줄 형식이 ACP session/update 를 그대로 싣는 경우와, 평평한 형태 양쪽을 받는다.
export function normalizeStreamJsonLine(line) {
  if (line == null) return null
  let obj = line
  if (typeof line === 'string') {
    const trimmed = line.trim()
    if (trimmed === '') return null
    try {
      obj = JSON.parse(trimmed)
    } catch {
      // JSON 이 아닌 줄은 사람이 읽는 로그다. 거부 문자열이 여기 실려오는
      // 경우가 있어 텍스트로도 검사한다.
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

// 이벤트 스트림을 모아 최종 텍스트와 거부 여부를 낸다.
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

// 줄 단위 스트림 분해기. 청크 경계에 걸친 줄을 버리지 않는다.
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
