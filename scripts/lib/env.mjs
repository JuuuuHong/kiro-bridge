// Child-process environment allowlist (design §7 hardening).
//
// Every kiro-cli spawn/exec inherits an *explicit* environment rather than the
// parent process.env. The default set is a conservative allowlist: enough to
// let a normal CLI resolve its binary, home, locale, temp dir, XDG paths,
// proxy, and CA bundle — but nothing that leaks credentials or lets an
// attacker-influenced value change the child's behaviour (NODE_OPTIONS, npm
// internals, cloud/provider API keys, SSH agent socket, etc.).
//
// A user who genuinely needs to forward an extra variable can list its *exact*
// name in config.json under `envPassthrough`. This is opt-in and merges safely
// with the defaults (no wildcards). Credential-bearing and runtime-injection
// variables remain hard-denied; non-secret AWS selectors such as AWS_PROFILE
// or AWS_REGION can be explicitly opted in by exact name.


// Exact names always forwarded when present in the parent environment.
export const DEFAULT_ALLOW_EXACT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Locale — needed so the CLI renders/encodes text correctly.
  'LANG',
  'LANGUAGE',
  // Proxy configuration (both cases are honoured by common HTTP stacks).
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // CA bundle / TLS trust — required for HTTPS to succeed in some environments.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  // Kiro's own custom-agent directory override may be needed by the CLI.
  'KIRO_AGENTS_DIR',
]

// Exact-name prefixes always forwarded when present. Covers the LC_* locale
// family and XDG base-directory spec vars.
export const DEFAULT_ALLOW_PREFIX = [
  'LC_',
  'XDG_',
]

// Names that are *never* forwarded, even if a prefix rule or a passthrough
// entry would otherwise match. This is the hard denial floor: it protects
// against a passthrough list accidentally (or maliciously) re-introducing a
// dangerous variable. Matched as exact names or, when ending in `_`, prefixes.
export const DEFAULT_DENY = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'SSH_AUTH_SOCK',
  'NODE_OPTIONS',
  'FORCE_COLOR',
  'npm_', // npm_config_*, npm_package_*, npm_lifecycle_*, ...
  'NPM_TOKEN',
  'NPM_CONFIG_', // uppercase form of npm config injection
]

function isDenied(name, deny) {
  for (const entry of deny) {
    if (entry.endsWith('_')) {
      if (name.startsWith(entry)) return true
    } else if (name === entry) {
      return true
    }
  }
  return false
}

function isPrefixAllowed(name, prefixes) {
  return prefixes.some((p) => name.startsWith(p))
}

// Normalize the config passthrough list into an array of exact string names.
// Anything that isn't a non-empty string is ignored — no wildcards, no globs.
export function normalizePassthrough(passthrough) {
  if (!Array.isArray(passthrough)) return []
  const seen = new Set()
  for (const entry of passthrough) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name === '') continue
    seen.add(name)
  }
  return [...seen]
}

// Build the explicit child environment.
//
// options:
//   source      - the environment to draw from (defaults to process.env)
//   passthrough - extra exact names to forward (from config.envPassthrough)
//   allowExact / allowPrefix / deny - override the built-in rule sets (tests)
//
// Precedence: deny always wins. Then a name is included if it is an exact
// allow, a prefix allow, or an explicit passthrough entry — and present in the
// source with a string value.
export function buildChildEnv(options = {}) {
  const {
    source = process.env,
    passthrough = [],
    allowExact = DEFAULT_ALLOW_EXACT,
    allowPrefix = DEFAULT_ALLOW_PREFIX,
    deny = DEFAULT_DENY,
  } = options

  const exactAllow = new Set(allowExact)
  const extra = normalizePassthrough(passthrough)
  for (const name of extra) exactAllow.add(name)

  const env = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    if (isDenied(name, deny)) continue
    if (exactAllow.has(name) || isPrefixAllowed(name, allowPrefix)) {
      env[name] = value
    }
  }
  // Reduce escape-sequence output at the source. The final output boundary is
  // still sanitized independently; this is defense in depth, not a substitute.
  env.NO_COLOR = '1'
  return env
}

// Convenience: derive the passthrough list from a loaded config and build the
// child env in one call. Used by every spawn/exec site.
export function childEnvFromConfig(config = {}, source = process.env) {
  return buildChildEnv({
    source,
    passthrough: config.envPassthrough,
  })
}
