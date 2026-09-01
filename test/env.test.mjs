import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChildEnv,
  childEnvFromConfig,
  normalizePassthrough,
  DEFAULT_ALLOW_EXACT,
  DEFAULT_ALLOW_PREFIX,
  DEFAULT_DENY,
} from '../scripts/lib/env.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'

// --- default allowlist ---

test('PATH, HOME, and locale vars are forwarded', () => {
  const source = { PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C' }
  const env = buildChildEnv({ source })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.LC_ALL, 'C')
})

test('XDG vars are forwarded via prefix rule', () => {
  const source = { XDG_CONFIG_HOME: '/home/u/.config', XDG_DATA_HOME: '/home/u/.local/share' }
  const env = buildChildEnv({ source })
  assert.equal(env.XDG_CONFIG_HOME, '/home/u/.config')
  assert.equal(env.XDG_DATA_HOME, '/home/u/.local/share')
})

test('proxy and CA vars are forwarded', () => {
  const source = {
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    http_proxy: 'http://proxy:8080',
    https_proxy: 'http://proxy:8080',
    no_proxy: 'localhost',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
  }
  const env = buildChildEnv({ source })
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080')
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080')
  assert.equal(env.http_proxy, 'http://proxy:8080')
  assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/extra.pem')
})

test('TMPDIR, TMP, TEMP are forwarded', () => {
  const source = { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' }
  const env = buildChildEnv({ source })
  assert.equal(env.TMPDIR, '/tmp')
  assert.equal(env.TMP, '/tmp')
  assert.equal(env.TEMP, '/tmp')
})

test('bridge state and inherited PWD are not forwarded; KIRO_AGENTS_DIR is', () => {
  const source = {
    KIRO_BRIDGE_HOME: '/custom/.kiro-bridge',
    KIRO_AGENTS_DIR: '/custom/agents',
    PWD: '/stale/parent/cwd',
  }
  const env = buildChildEnv({ source })
  assert.equal(env.KIRO_BRIDGE_HOME, undefined)
  assert.equal(env.PWD, undefined)
  assert.equal(env.KIRO_AGENTS_DIR, '/custom/agents')
})

// --- deny list ---

test('AWS vars are blocked by default', () => {
  const source = {
    PATH: '/usr/bin',
    AWS_ACCESS_KEY_ID: 'AKIA…',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'tok',
    AWS_PROFILE: 'dev',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
  }
  const env = buildChildEnv({ source })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.AWS_SESSION_TOKEN, undefined)
  assert.equal(env.AWS_PROFILE, undefined)
  assert.equal(env.AWS_REGION, undefined)
  assert.equal(env.AWS_DEFAULT_REGION, undefined)
})

test('non-secret AWS selectors can be explicitly passed through, credentials cannot', () => {
  const source = {
    AWS_PROFILE: 'dev',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIA…',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token',
  }
  const env = buildChildEnv({
    source,
    passthrough: ['AWS_PROFILE', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE'],
  })
  assert.equal(env.AWS_PROFILE, 'dev')
  assert.equal(env.AWS_REGION, 'us-east-1')
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined)
  assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, undefined)
})

test('AWS_CA_BUNDLE requires explicit passthrough', () => {
  const source = { AWS_CA_BUNDLE: '/etc/ssl/aws.pem' }
  assert.equal(buildChildEnv({ source }).AWS_CA_BUNDLE, undefined)
  assert.equal(buildChildEnv({ source, passthrough: ['AWS_CA_BUNDLE'] }).AWS_CA_BUNDLE, '/etc/ssl/aws.pem')
})

test('ANTHROPIC_API_KEY is blocked', () => {
  const source = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-…' }
  const env = buildChildEnv({ source })
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
})

test('GITHUB_TOKEN is blocked', () => {
  const source = { GITHUB_TOKEN: 'ghp_…' }
  const env = buildChildEnv({ source })
  assert.equal(env.GITHUB_TOKEN, undefined)
})

test('OPENAI_API_KEY is blocked', () => {
  const source = { OPENAI_API_KEY: 'sk-…' }
  const env = buildChildEnv({ source })
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('SSH_AUTH_SOCK is blocked', () => {
  const source = { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' }
  const env = buildChildEnv({ source })
  assert.equal(env.SSH_AUTH_SOCK, undefined)
})

test('NODE_OPTIONS is blocked', () => {
  const source = { NODE_OPTIONS: '--max-old-space-size=4096' }
  const env = buildChildEnv({ source })
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('npm_* internals are blocked', () => {
  const source = {
    npm_config_registry: 'https://evil.example.com',
    npm_package_name: 'foo',
    npm_lifecycle_event: 'postinstall',
  }
  const env = buildChildEnv({ source })
  assert.equal(env.npm_config_registry, undefined)
  assert.equal(env.npm_package_name, undefined)
  assert.equal(env.npm_lifecycle_event, undefined)
})

test('NPM_TOKEN is blocked', () => {
  const source = { NPM_TOKEN: 'tok123' }
  const env = buildChildEnv({ source })
  assert.equal(env.NPM_TOKEN, undefined)
})

test('NPM_CONFIG_* uppercase form is blocked', () => {
  const source = { NPM_CONFIG_REGISTRY: 'https://evil.example.com' }
  const env = buildChildEnv({ source })
  assert.equal(env.NPM_CONFIG_REGISTRY, undefined)
})

test('unknown vars not in allowlist are excluded', () => {
  const source = {
    PATH: '/usr/bin',
    MY_SECRET: 'sensitive',
    DATABASE_URL: 'postgres://…',
    STRIPE_API_KEY: 'sk_…',
  }
  const env = buildChildEnv({ source })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.MY_SECRET, undefined)
  assert.equal(env.DATABASE_URL, undefined)
  assert.equal(env.STRIPE_API_KEY, undefined)
})

// --- opt-in passthrough ---

test('passthrough adds exact names that pass the deny check', () => {
  const source = { PATH: '/usr/bin', MY_CUSTOM: 'value', ANOTHER: '42' }
  const env = buildChildEnv({ source, passthrough: ['MY_CUSTOM', 'ANOTHER'] })
  assert.equal(env.MY_CUSTOM, 'value')
  assert.equal(env.ANOTHER, '42')
})

test('passthrough cannot override the deny list', () => {
  const source = { PATH: '/usr/bin', AWS_ACCESS_KEY_ID: 'AKIA…', ANTHROPIC_API_KEY: 'sk-ant-…' }
  const env = buildChildEnv({ source, passthrough: ['AWS_ACCESS_KEY_ID', 'ANTHROPIC_API_KEY'] })
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
})

test('NO_COLOR is forced and FORCE_COLOR cannot be passed through', () => {
  const env = buildChildEnv({
    source: { NO_COLOR: '0', FORCE_COLOR: '3' },
    passthrough: ['NO_COLOR', 'FORCE_COLOR'],
  })
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.FORCE_COLOR, undefined)
})

test('passthrough does not add vars absent from source', () => {
  const source = { PATH: '/usr/bin' }
  const env = buildChildEnv({ source, passthrough: ['NONEXISTENT'] })
  assert.ok(!('NONEXISTENT' in env))
})

test('normalizePassthrough filters non-string and empty entries', () => {
  const result = normalizePassthrough(['A', '', 42, null, undefined, 'B', '  C  '])
  assert.deepEqual(result, ['A', 'B', 'C'])
})

test('normalizePassthrough deduplicates', () => {
  const result = normalizePassthrough(['A', 'B', 'A', 'B'])
  assert.deepEqual(result, ['A', 'B'])
})

test('normalizePassthrough handles non-array input safely', () => {
  assert.deepEqual(normalizePassthrough(null), [])
  assert.deepEqual(normalizePassthrough('A'), [])
  assert.deepEqual(normalizePassthrough(42), [])
})

// --- childEnvFromConfig convenience ---

test('childEnvFromConfig reads envPassthrough from config', () => {
  const config = { envPassthrough: ['MY_VAR'] }
  const source = { PATH: '/usr/bin', MY_VAR: 'yes' }
  const env = childEnvFromConfig(config, source)
  assert.equal(env.MY_VAR, 'yes')
  assert.equal(env.PATH, '/usr/bin')
})

test('childEnvFromConfig with empty config works with defaults', () => {
  const source = { PATH: '/usr/bin', HOME: '/home/u', AWS_SECRET_ACCESS_KEY: 'bad' }
  const env = childEnvFromConfig({}, source)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
})

// --- spawn/exec options shape ---

test('returned env is a plain object suitable as spawn options.env', () => {
  const source = { PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8' }
  const env = buildChildEnv({ source })
  // spawn requires a plain object with string values
  assert.equal(typeof env, 'object')
  assert.ok(!Array.isArray(env))
  for (const [k, v] of Object.entries(env)) {
    assert.equal(typeof k, 'string')
    assert.equal(typeof v, 'string')
  }
})

test('non-string values in source are excluded', () => {
  const source = { PATH: '/usr/bin', WEIRD: 42, ANOTHER: true }
  const env = buildChildEnv({ source })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.WEIRD, undefined)
  assert.equal(env.ANOTHER, undefined)
})

// --- DEFAULT_ALLOW_EXACT coverage ---

test('DEFAULT_ALLOW_EXACT includes expected essentials without bridge state or PWD', () => {
  const required = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'KIRO_AGENTS_DIR']
  for (const name of required) {
    assert.ok(DEFAULT_ALLOW_EXACT.includes(name), `${name} should be in DEFAULT_ALLOW_EXACT`)
  }
  assert.equal(DEFAULT_ALLOW_EXACT.includes('PWD'), false)
  assert.equal(DEFAULT_ALLOW_EXACT.includes('KIRO_BRIDGE_HOME'), false)
})

test('DEFAULT_ALLOW_PREFIX includes LC_ and XDG_', () => {
  assert.ok(DEFAULT_ALLOW_PREFIX.includes('LC_'))
  assert.ok(DEFAULT_ALLOW_PREFIX.includes('XDG_'))
})

test('DEFAULT_DENY blocks expected secrets and injection vectors', () => {
  const expected = [
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK',
    'NODE_OPTIONS', 'FORCE_COLOR', 'npm_', 'NPM_TOKEN',
  ]
  for (const name of expected) {
    assert.ok(DEFAULT_DENY.includes(name), `${name} should be in DEFAULT_DENY`)
  }
})

// --- config defaults ---

test('CONFIG_DEFAULTS ships an empty envPassthrough array', () => {
  assert.deepEqual(CONFIG_DEFAULTS.envPassthrough, [])
})
