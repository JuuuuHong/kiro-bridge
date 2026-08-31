// 구조화 컨텍스트 핸드오프 빌더 + 아웃바운드 redaction (ADR-003, 설계 §5·§7).
//
// 여기서 만든 페이로드가 그대로 AWS로 나가므로, 빌드의 마지막 단계는 항상
// redaction 이다. 무엇이 포함됐는지는 코드로 결정되고 로그로 남는다.
import { basename } from 'node:path'

export const KINDS = ['review', 'task', 'spec']

// excerpt 는 전체 삽입이 아니라 진입점 안내 수준으로 최소화한다 — Kiro 는
// read/grep 으로 스스로 읽을 수 있고, 과대 삽입은 컨텍스트를 밀어낸다 (ADR-003).
export const LIMITS = {
  goal: 1000,
  diff: 200_000,
  excerpt: 2000,
  files: 50,
  constraints: 30,
  constraint: 500,
  signal: 20_000,
}

const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g
const PEM_BLOCK = /-----BEGIN(?:[A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END(?:[A-Z ]*)PRIVATE KEY-----/g
const ASSIGNED_SECRET =
  /\b(aws_secret_access_key|aws_session_token|password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b(\s*[=:]\s*)(["']?)([^\s"'`,;]{6,})\3/gi
// 고엔트로피 후보. 대문자·소문자·숫자를 모두 포함하는 32자 이상만 본다 —
// git SHA(소문자 hex)와 일반 식별자를 태우지 않기 위한 의도적 제약이다.
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function shannonEntropy(str) {
  if (!str) return 0
  const counts = new Map()
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1)
  let entropy = 0
  for (const n of counts.values()) {
    const p = n / str.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function looksMixedCharset(str) {
  return /[a-z]/.test(str) && /[A-Z]/.test(str) && /[0-9]/.test(str)
}

// glob-lite: `*` 만 지원한다. 경로 전체와 basename 양쪽에 대해 검사한다.
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function isExcludedPath(path, patterns) {
  if (!path) return false
  const name = basename(path)
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern)
    return re.test(path) || re.test(name)
  })
}

function truncate(value, max) {
  if (typeof value !== 'string') return value
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`
}

function stripControlChars(value) {
  if (typeof value !== 'string') return value
  return value.replace(CONTROL_CHARS, '')
}

// 텍스트 한 덩어리에 대한 마스킹. 무엇을 몇 번 가렸는지 함께 돌려준다.
export function redactText(text, options = {}) {
  const { privateHosts = [], entropyThreshold = 4.2, minSecretLength = 32 } = options
  const hits = []
  if (typeof text !== 'string' || text === '') return { text, hits }

  let out = text
  const count = (kind, n) => {
    if (n > 0) hits.push({ kind, count: n })
  }

  let n = 0
  out = out.replace(PEM_BLOCK, () => { n += 1; return '[REDACTED:private-key-block]' })
  count('private-key-block', n)

  n = 0
  out = out.replace(AWS_ACCESS_KEY, () => { n += 1; return '[REDACTED:aws-access-key]' })
  count('aws-access-key', n)

  n = 0
  out = out.replace(ASSIGNED_SECRET, (_m, key, sep, quote) => {
    n += 1
    return `${key}${sep}${quote}[REDACTED:assigned-secret]${quote}`
  })
  count('assigned-secret', n)

  n = 0
  out = out.replace(ENTROPY_CANDIDATE, (token) => {
    if (token.length < minSecretLength) return token
    if (!looksMixedCharset(token)) return token
    if (shannonEntropy(token) < entropyThreshold) return token
    n += 1
    return '[REDACTED:high-entropy]'
  })
  count('high-entropy', n)

  n = 0
  for (const host of privateHosts) {
    if (!host) continue
    const re = new RegExp(`[A-Za-z0-9._-]*${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
    out = out.replace(re, () => { n += 1; return '[REDACTED:private-host]' })
  }
  count('private-host', n)

  return { text: out, hits }
}

// 핸드오프 페이로드 조립. 반환값의 redactions 가 감사 로그 겸 --dry-run 표시용이다.
export function buildPayload(input, options = {}) {
  const { kind, goal } = input
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown kind: ${kind} (expected one of ${KINDS.join(', ')})`)
  }
  if (!goal || typeof goal !== 'string') {
    throw new Error('goal is required and must be a string')
  }

  const redaction = options.redaction || {}
  const excludeFiles = redaction.excludeFiles || []
  const textOpts = {
    privateHosts: redaction.privateHosts || [],
    entropyThreshold: redaction.entropyThreshold,
    minSecretLength: redaction.minSecretLength,
  }

  const redactions = []
  const excluded = []
  const scrub = (value, where, max) => {
    if (value == null) return undefined
    const clean = stripControlChars(String(value))
    const { text, hits } = redactText(truncate(clean, max), textOpts)
    for (const hit of hits) redactions.push({ where, ...hit })
    return text
  }

  const payload = { kind, goal: scrub(goal, 'goal', LIMITS.goal) }

  if (input.diff != null) {
    payload.diff = scrub(input.diff, 'diff', LIMITS.diff)
  }

  if (Array.isArray(input.files) && input.files.length > 0) {
    const kept = []
    for (const file of input.files.slice(0, LIMITS.files)) {
      if (!file || !file.path) continue
      if (isExcludedPath(file.path, excludeFiles)) {
        excluded.push(file.path)
        continue
      }
      const entry = { path: file.path }
      if (file.reason) entry.reason = scrub(file.reason, `files[${file.path}].reason`, LIMITS.constraint)
      if (file.excerpt) entry.excerpt = scrub(file.excerpt, `files[${file.path}].excerpt`, LIMITS.excerpt)
      kept.push(entry)
    }
    if (kept.length > 0) payload.files = kept
  }

  if (input.signals && typeof input.signals === 'object') {
    const signals = {}
    for (const key of ['failing_tests', 'lint', 'notes']) {
      const value = input.signals[key]
      if (value == null) continue
      signals[key] = scrub(value, `signals.${key}`, LIMITS.signal)
    }
    if (Object.keys(signals).length > 0) payload.signals = signals
  }

  if (Array.isArray(input.constraints) && input.constraints.length > 0) {
    payload.constraints = input.constraints
      .slice(0, LIMITS.constraints)
      .map((c, i) => scrub(c, `constraints[${i}]`, LIMITS.constraint))
      .filter(Boolean)
  }

  return { payload, redactions, excludedFiles: excluded }
}
