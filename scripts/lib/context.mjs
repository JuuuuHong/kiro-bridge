// Structured context handoff builder + outbound redaction (ADR-003, design §5, §7).
//
// The payload built here goes straight out to AWS, so the last step of the
// build is always redaction. What gets included is decided by code and logged.
import { basename } from 'node:path'

export const KINDS = ['review', 'task', 'spec']

// excerpt is minimized to entry-point guidance, not a full insertion — Kiro
// can read the file itself via read/grep, and over-insertion crowds out context (ADR-003).
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
// High-entropy candidate. Only considers 32+ chars containing upper, lower, and digits —
// a deliberate constraint to avoid flagging git SHAs (lowercase hex) and ordinary identifiers.
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

// glob-lite: only `*` is supported. Checked against both the full path and the basename.
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

// Masking for one chunk of text. Also returns what was masked and how many times.
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

// Assembles the handoff payload. The return value's redactions doubles as an audit log and --dry-run display.
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
