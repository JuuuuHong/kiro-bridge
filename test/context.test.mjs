import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPayload,
  redactText,
  isExcludedPath,
  shannonEntropy,
  LIMITS,
} from '../scripts/lib/context.mjs'

const EXCLUDE = ['.env', '.env.*', '*.pem', '*.key', '*credentials*', 'id_rsa']

test('kind validation: rejects an unknown kind', () => {
  assert.throws(() => buildPayload({ kind: 'nope', goal: 'x' }), /unknown kind/)
})

test('goal is required', () => {
  assert.throws(() => buildPayload({ kind: 'review' }), /goal is required/)
})

test('the minimal payload carries only kind and goal', () => {
  const { payload } = buildPayload({ kind: 'review', goal: 'please review' })
  assert.deepEqual(payload, { kind: 'review', goal: 'please review' })
})

// --- redaction positives (things that must be masked) ---

test('positive: masks an AWS access key ID', () => {
  const { text, hits } = redactText('key is AKIAIOSFODNN7EXAMPLE here')
  assert.match(text, /\[REDACTED:aws-access-key\]/)
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(hits.find((h) => h.kind === 'aws-access-key').count, 1)
})

test('positive: an assignment secret masks only the value, keeps the key name', () => {
  const { text } = redactText('aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')
  assert.match(text, /aws_secret_access_key = \[REDACTED:assigned-secret\]/)
  assert.ok(!text.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'))
})

test('positive: password/token assignments are also masked', () => {
  const { text } = redactText('password: hunter2hunter2\napi_key = "sk-abc123def456"')
  assert.ok(!text.includes('hunter2hunter2'))
  assert.ok(!text.includes('sk-abc123def456'))
})

test('positive: a PEM private key block is removed whole', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxGZk9F0oq2mNvJ8kLpQ7',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const { text } = redactText(pem)
  assert.equal(text, '[REDACTED:private-key-block]')
})

test('positive: masks a high-entropy mixed-charset string', () => {
  const secret = 'aZ3kQ9pL2mX7vB4nR8tY6wE1sD5fG0hJcV2bN9mK'
  const { text } = redactText(`token=${secret}`)
  assert.ok(!text.includes(secret))
})

test('positive: private hostnames are masked via config', () => {
  const { text } = redactText('curl http://svc-a.internal.corp/health', {
    privateHosts: ['.internal.corp'],
  })
  assert.match(text, /\[REDACTED:private-host\]/)
  assert.ok(!text.includes('svc-a.internal.corp'))
})

// --- redaction negatives (things that must NOT be masked) ---

test('negative: a git SHA (40-char lowercase hex) is not masked', () => {
  const sha = 'ae8a498a0155cdf4f1c33951bfa742401485dec7'
  const { text, hits } = redactText(`commit ${sha}`)
  assert.ok(text.includes(sha), 'masking a git SHA would break diff review')
  assert.equal(hits.length, 0)
})

test('negative: a lowercase snake_case identifier survives even if long', () => {
  const ident = 'very_long_lowercase_identifier_for_a_function_name'
  const { text } = redactText(`export function ${ident}() {}`)
  assert.ok(text.includes(ident))
})

test('negative: ordinary prose passes through unchanged', () => {
  const prose = 'This function validates the input and then returns the result.'
  const { text, hits } = redactText(prose)
  assert.equal(text, prose)
  assert.equal(hits.length, 0)
})

test('negative: a 64-char lowercase hex string (sha256) also survives', () => {
  const digest = 'a'.repeat(20) + 'b3f19c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'
  const { text } = redactText(digest)
  assert.ok(text.includes(digest))
})

// --- file exclusion ---

test('exclude list: .env / pem / credentials are dropped from the payload', () => {
  const { payload, excludedFiles } = buildPayload(
    {
      kind: 'review',
      goal: 'g',
      files: [
        { path: 'src/app.mjs', reason: 'changed' },
        { path: '.env', reason: 'config' },
        { path: 'deploy/.env.production', reason: 'config' },
        { path: 'certs/server.pem', reason: 'tls' },
        { path: 'aws/credentials.json', reason: 'creds' },
      ],
    },
    { redaction: { excludeFiles: EXCLUDE } },
  )
  assert.deepEqual(payload.files.map((f) => f.path), ['src/app.mjs'])
  assert.equal(excludedFiles.length, 4)
})

test('isExcludedPath checks both the full path and the basename', () => {
  assert.equal(isExcludedPath('a/b/id_rsa', EXCLUDE), true)
  assert.equal(isExcludedPath('id_rsa', EXCLUDE), true)
  assert.equal(isExcludedPath('src/keyboard.mjs', EXCLUDE), false)
})

// --- caps / sanitization ---

test('excerpt is truncated at its cap', () => {
  const { payload } = buildPayload({
    kind: 'review',
    goal: 'g',
    files: [{ path: 'big.mjs', excerpt: 'x'.repeat(LIMITS.excerpt + 500) }],
  })
  assert.ok(payload.files[0].excerpt.length < LIMITS.excerpt + 100)
  assert.match(payload.files[0].excerpt, /truncated/)
})

test('control characters are stripped', () => {
  const { payload } = buildPayload({ kind: 'task', goal: 'abc' })
  assert.equal(payload.goal, 'abc')
})

test('redactions records where and what got masked', () => {
  const { redactions } = buildPayload(
    { kind: 'review', goal: 'g', diff: 'AKIAIOSFODNN7EXAMPLE' },
    { redaction: { excludeFiles: EXCLUDE } },
  )
  const hit = redactions.find((r) => r.where === 'diff')
  assert.equal(hit.kind, 'aws-access-key')
  assert.equal(hit.count, 1)
})

test('signals only lets whitelisted keys through', () => {
  const { payload } = buildPayload({
    kind: 'task',
    goal: 'g',
    signals: { failing_tests: 'boom', evil: 'drop me' },
  })
  assert.deepEqual(Object.keys(payload.signals), ['failing_tests'])
})

test('shannonEntropy is low for a uniform string', () => {
  assert.ok(shannonEntropy('aaaaaaaa') < 0.001)
  assert.ok(shannonEntropy('aZ3kQ9pL2mX7vB4n') > 3.5)
})
