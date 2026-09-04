// Model discovery for the --model flag.
//
// The set of models kiro-cli accepts is not ours to declare: it shifts with the
// kiro-cli version and with the account (experimental previews come and go), so
// a list hardcoded here or in the skill docs would be wrong within a release.
// kiro-cli already answers the question — `chat --list-models --format json` —
// so the bridge asks it and caches the answer under the kiro-cli version, the
// same key the ACP capability cache uses (ADR-001R).
//
// The point of caching is that validation must be cheap enough to run before
// every delegated call. Without it a caller guesses an id, we spawn, kiro-cli
// rejects it, and the round trip is only visible after the process is gone.
import { execFile } from 'node:child_process'
import { loadConfig, loadUserConfig, saveConfig, getCachedModels, setCachedModels } from './config.mjs'
import { childEnvFromConfig } from './env.mjs'
import { sanitizeLine } from './sanitize.mjs'
import { bridgeError, BridgeError, CODES } from './errors.mjs'
import { detectVersion } from './transport/index.mjs'

// A day is well inside how often kiro-cli ships, and the version key already
// invalidates on upgrade. The TTL only covers same-version account changes
// (a preview model enabled or withdrawn).
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export const MODEL_CAPS = { count: 100, id: 120, description: 300 }

// kiro-cli output is external process text, so ids are held to a plain
// identifier shape rather than trusted: anything that could carry a terminal
// escape, an argument separator, or a shell-looking token is dropped instead
// of being echoed back into a suggestion the caller might paste.
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

// Descriptions are collapsed to a single line, not just sanitized: sanitizeLine
// deliberately preserves \n, and formatModels renders one model per line, so a
// description carrying a newline could forge an extra row that looks like a
// model this kiro-cli offers.
function cap(text, limit) {
  const clean = sanitizeLine(String(text ?? '')).replace(/\s+/g, ' ').trim()
  return clean.length > limit ? clean.slice(0, limit) : clean
}

function validId(value) {
  if (typeof value !== 'string') return null
  // Checked *before* sanitizing, not after: stripping an escape out of
  // `\u001B[31mred` would leave the perfectly valid id `red`, and the bridge
  // would go on to offer that as a suggestion. An id has to arrive clean.
  const id = value.trim()
  return id.length <= MODEL_CAPS.id && ID_SHAPE.test(id) ? id : null
}

// The one shape guard, shared by both ways a listing enters the module: fresh
// kiro-cli stdout, and a cache entry read back from ~/.kiro-bridge/config.json.
// The cache is a file on disk — hand-editable, corruptible, and possibly
// written by an older schema — so it gets exactly the same scrutiny as the
// process output rather than being trusted because we wrote it once.
// Accepts `id` (our shape) or `model_id` (kiro-cli's). Null means "unusable" —
// the caller falls back to a cold probe or reports failure.
export function normalizeListing(listing) {
  if (!listing || typeof listing !== 'object') return null

  const models = []
  for (const entry of Array.isArray(listing.models) ? listing.models : []) {
    if (models.length >= MODEL_CAPS.count) break
    if (!entry || typeof entry !== 'object') continue
    const id = validId(entry.id ?? entry.model_id)
    if (!id) continue
    models.push({ id, description: cap(entry.description, MODEL_CAPS.description) })
  }
  if (models.length === 0) return null

  return { models, defaultModel: validId(listing.defaultModel ?? listing.default_model) }
}

// `chat --list-models --format json` -> { models: [{ id, description }], defaultModel }.
// Returns null (never throws) when the payload is not the shape we expect —
// the caller decides whether that is fatal.
export function parseModelList(stdout) {
  let payload
  try {
    return normalizeListing(JSON.parse(String(stdout)))
  } catch {
    return null
  }
}

function norm(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function editDistance(a, b) {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

// Ranked nearest ids for a value kiro-cli would reject. Ordering inside a tier
// follows kiro-cli's own ordering, which puts preferred models first.
export function suggestModel(input, models = [], limit = 5) {
  const target = norm(input)
  if (!target) return []

  // Scale the typo budget to the input so short strings can't match everything.
  const budget = Math.min(3, Math.floor(target.length / 3))

  const tiers = [[], [], []]
  for (const model of models) {
    const candidate = norm(model.id)
    if (candidate === target) tiers[0].push(model.id)
    // A single character is a substring of nearly every id, so it would return
    // five arbitrary suggestions. Two is the shortest input that says anything.
    else if (target.length >= 2 && (candidate.includes(target) || target.includes(candidate))) {
      tiers[1].push(model.id)
    }
    // A length gap wider than the budget cannot be closed, and checking that
    // first keeps a long --model argument from paying the O(n*m) DP against
    // every id: the value is unbounded (bridge.mjs accepts any non-flag token).
    else if (Math.abs(candidate.length - target.length) <= budget
      && editDistance(candidate, target) <= budget) tiers[2].push(model.id)
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, limit)
}

// Cache-first, mirroring detectCapability. Reads and writes the *user* config
// layer only — the project overlay is tightening-only policy, not machine state.
export async function listModels(options = {}) {
  const {
    bin = 'kiro-cli',
    force = false,
    execFileFn = execFile,
    now = Date.now(),
    ttlMs = MODEL_CACHE_TTL_MS,
  } = options

  const version = await detectVersion({ bin, execFileFn, config: loadConfig() })
  if (!version) throw bridgeError(CODES.TRANSPORT_UNAVAILABLE, { bin })

  const config = loadUserConfig()
  if (!force) {
    const cached = getCachedModels(config, version)
    const detectedAt = Date.parse(cached?.detectedAt || '')
    if (cached && Number.isFinite(detectedAt) && now - detectedAt < ttlMs) {
      // Re-guard on read. Everything written through setCachedModels is clean,
      // but that only holds while the file is exactly what we last wrote — and
      // every consumer downstream assumes models is an array of valid ids.
      //
      // Stricter than the kiro-cli path on purpose: there, dropping an entry we
      // don't recognise is right (kiro-cli may add an id shape we don't admit,
      // and the rest of the list is still good). Here, a dropped entry means
      // the file is not what we wrote, so the whole entry is suspect — serving
      // the surviving subset would quietly hand back a partial list.
      const revalidated = normalizeListing(cached)
      const intact = revalidated
        && Array.isArray(cached.models)
        && revalidated.models.length === cached.models.length
      if (intact) return { ...revalidated, detectedAt: cached.detectedAt, version, cached: true }
      // Unusable or tampered entry: fall through to a cold probe rather than serve it.
    }
  }

  const stdout = await new Promise((resolve, reject) => {
    execFileFn(
      bin,
      ['chat', '--list-models', '--format', 'json'],
      { timeout: 15000, env: childEnvFromConfig(config) },
      (err, out) => (err ? reject(err) : resolve(String(out))),
    )
  }).catch((err) => {
    throw bridgeError(CODES.PROTOCOL, {
      reason: 'could not list models from kiro-cli',
      cause: sanitizeLine(String(err?.message || err)).slice(0, 200),
    })
  })

  const parsed = parseModelList(stdout)
  if (!parsed) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'kiro-cli returned no usable model list' })
  }

  const entry = { ...parsed, detectedAt: new Date(now).toISOString() }
  try {
    // Read-modify-write on config.json, same as detectCapability. Two bridge
    // processes racing here can lose one of the two cache entries; both are
    // caches that rebuild on the next call, so this is not worth a lock.
    saveConfig(setCachedModels(config, version, entry))
  } catch {
    // Cache save failure is not fatal — it is detected again next call.
  }
  return { ...entry, version, cached: false }
}

// Deliberately soft. A model this kiro-cli does not know about is a hard no,
// because that is the guess we are trying to catch. Discovery *failing* is not:
// falling back to "let kiro-cli decide" keeps the bridge from blocking a model
// that shipped after this cache entry, or when kiro-cli is momentarily offline.
export async function validateModel(model, options = {}) {
  if (model === undefined || model === null || String(model).trim() === '') {
    return { ok: true, verified: false, reason: 'no model requested' }
  }
  const requested = String(model).trim()
  const passThrough = (err) => ({
    ok: true,
    verified: false,
    reason: err?.details?.reason || 'model discovery unavailable',
  })
  const known = (entries) => entries.some((entry) => entry.id === requested)

  let listing
  try {
    listing = await listModels(options)
  } catch (err) {
    return passThrough(err)
  }

  if (known(listing.models)) return { ok: true, verified: true, model: requested }

  // A miss against a *cached* list is not evidence of anything. The entry can
  // be a full TTL behind, and the account's model set changes inside that
  // window (a preview enabled, an id renamed) — which is exactly the case
  // constraint 1 says must not be blocked. Rejecting costs a delegated call
  // either way, so confirm against a fresh list first; the extra spawn only
  // happens on the path that was about to fail.
  if (listing.cached) {
    try {
      listing = await listModels({ ...options, force: true })
    } catch (err) {
      return passThrough(err)
    }
    if (known(listing.models)) return { ok: true, verified: true, model: requested }
  }

  return {
    ok: false,
    verified: true,
    model: requested,
    suggestions: suggestModel(requested, listing.models),
  }
}

// Thrown as a BridgeError so the CLI renders `[PROTOCOL] ...` and a --json
// caller gets an error envelope, rather than a stack trace for what is an
// ordinary bad-argument case.
export async function assertModelSupported(model, options = {}) {
  const res = await validateModel(model, options)
  if (res.ok) return res
  const hint = res.suggestions.length > 0
    ? `did you mean ${res.suggestions.join(', ')}?`
    : 'no close match found'
  throw new BridgeError(
    CODES.PROTOCOL,
    `unknown --model "${res.model}" — ${hint}`,
    { reason: "run 'bridge.mjs models' for the ids this kiro-cli accepts", suggestions: res.suggestions },
  )
}

// Human rendering for `bridge.mjs models`. Descriptions come from kiro-cli, so
// they are already length-capped and terminal-sanitized by parseModelList.
export function formatModels(listing) {
  const label = (entry) => `${entry.id}${entry.id === listing.defaultModel ? ' (default)' : ''}`
  // Width comes from the rendered labels, not the ids: when the default model
  // also has the longest id, padding to the id width leaves its description
  // butted against the marker.
  const width = listing.models.reduce((max, entry) => Math.max(max, label(entry).length), 0)
  const lines = listing.models.map((entry) => (
    `  ${label(entry).padEnd(width + 2)}${entry.description}`.trimEnd()
  ))
  const source = listing.cached ? 'cached' : 'from kiro-cli'
  return [
    `kiro-cli ${listing.version} — ${listing.models.length} model(s) (${source})`,
    '',
    ...lines,
    '',
    'Pass one of these ids to --model. Anything else is rejected before the call.',
  ].join('\n')
}
