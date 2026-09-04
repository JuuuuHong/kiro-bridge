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
  /\b((?:[a-z0-9]+[_-])*(?:aws_secret_access_key|aws_session_token|password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|token))\b(\s*[=:]\s*)(["']?)([^\s"'`,;]{6,})\3/gi
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

// glob-lite: `*` matches within one path segment, `**` crosses directories,
// and `?` matches exactly one non-separator character.
// Patterns are checked against both the full path and the basename.
//
// Every character that is not one of those three wildcards is escaped. `?` used
// to fall through unescaped, which made it a regex quantifier rather than a
// wildcard: a pattern like `a?a?a?…` compiled to nested optionals and matched
// in exponential time. Since a repository's own `.kiro/settings/kiro-bridge.json`
// may add exclude patterns, that turned the tightening-only overlay into a way
// to hang the bridge on the reviewer's machine.
const REGEX_META = /[.*+?^${}()|[\]\\/-]/

function globToRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i += 1
    } else if (ch === '*') {
      source += '[^/]*'
    } else if (ch === '?') {
      source += '[^/]'
    } else if (REGEX_META.test(ch)) {
      source += `\\${ch}`
    } else {
      source += ch
    }
  }
  return new RegExp(`^${source}$`, 'i')
}

// Compiling is the expensive half and the pattern set is tiny and stable, but
// isExcludedPath runs per path per pattern — so without this the compile cost
// is paid files x patterns times per review.
const REGEX_CACHE = new Map()
const REGEX_CACHE_MAX = 500

function compiled(pattern) {
  const hit = REGEX_CACHE.get(pattern)
  if (hit) return hit
  const re = globToRegExp(pattern)
  // A plain size ceiling; the pattern set is bounded by config.mjs anyway, so
  // this only guards against a long-lived process seeing many repositories.
  if (REGEX_CACHE.size >= REGEX_CACHE_MAX) REGEX_CACHE.clear()
  REGEX_CACHE.set(pattern, re)
  return re
}

export function isExcludedPath(path, patterns) {
  if (!path) return false
  const name = basename(path)
  return patterns.some((pattern) => {
    const re = compiled(pattern)
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
  out = out.replace(ASSIGNED_SECRET, (match, key, sep, quote, value) => {
    if (value.startsWith('[REDACTED:')) return match
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
  let droppedFiles = 0
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

  // Exclusion runs before the count cap, not inside it. Capping first would let
  // excluded paths consume the budget — 50 leading .env files would push every
  // reviewable file out of a review that then looks merely "large".
  if (Array.isArray(input.files) && input.files.length > 0) {
    const candidates = []
    for (const file of input.files) {
      if (!file || !file.path) continue
      if (isExcludedPath(file.path, excludeFiles)) {
        excluded.push(file.path)
        continue
      }
      candidates.push(file)
    }

    // The cap is a real limit, but a silently shortened file list reads to the
    // caller as "these are all the changed files". Report the overflow so the
    // omission is visible (design §9: no silent caps).
    droppedFiles = Math.max(0, candidates.length - LIMITS.files)

    const kept = candidates.slice(0, LIMITS.files).map((file) => {
      const entry = { path: file.path }
      if (file.reason) entry.reason = scrub(file.reason, `files[${file.path}].reason`, LIMITS.constraint)
      if (file.excerpt) entry.excerpt = scrub(file.excerpt, `files[${file.path}].excerpt`, LIMITS.excerpt)
      return entry
    })
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

  return { payload, redactions, excludedFiles: excluded, droppedFiles }
}
