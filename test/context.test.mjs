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

test('kind 검증: 알 수 없는 kind 는 거부', () => {
  assert.throws(() => buildPayload({ kind: 'nope', goal: 'x' }), /unknown kind/)
})

test('goal 은 필수', () => {
  assert.throws(() => buildPayload({ kind: 'review' }), /goal is required/)
})

test('최소 페이로드는 kind 와 goal 만 담는다', () => {
  const { payload } = buildPayload({ kind: 'review', goal: '리뷰해줘' })
  assert.deepEqual(payload, { kind: 'review', goal: '리뷰해줘' })
})

// --- redaction 양성 (반드시 가려져야 하는 것) ---

test('양성: AWS 액세스 키 ID 마스킹', () => {
  const { text, hits } = redactText('key is AKIAIOSFODNN7EXAMPLE here')
  assert.match(text, /\[REDACTED:aws-access-key\]/)
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(hits.find((h) => h.kind === 'aws-access-key').count, 1)
})

test('양성: 대입식 시크릿은 값만 가리고 키 이름은 남긴다', () => {
  const { text } = redactText('aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')
  assert.match(text, /aws_secret_access_key = \[REDACTED:assigned-secret\]/)
  assert.ok(!text.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'))
})

test('양성: password/token 대입식도 마스킹', () => {
  const { text } = redactText('password: hunter2hunter2\napi_key = "sk-abc123def456"')
  assert.ok(!text.includes('hunter2hunter2'))
  assert.ok(!text.includes('sk-abc123def456'))
})

test('양성: PEM private key 블록 통째로 제거', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxGZk9F0oq2mNvJ8kLpQ7',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const { text } = redactText(pem)
  assert.equal(text, '[REDACTED:private-key-block]')
})

test('양성: 고엔트로피 혼합 문자열 마스킹', () => {
  const secret = 'aZ3kQ9pL2mX7vB4nR8tY6wE1sD5fG0hJcV2bN9mK'
  const { text } = redactText(`token=${secret}`)
  assert.ok(!text.includes(secret))
})

test('양성: private 호스트명은 설정으로 마스킹', () => {
  const { text } = redactText('curl http://svc-a.internal.corp/health', {
    privateHosts: ['.internal.corp'],
  })
  assert.match(text, /\[REDACTED:private-host\]/)
  assert.ok(!text.includes('svc-a.internal.corp'))
})

// --- redaction 음성 (가려지면 안 되는 것) ---

test('음성: git SHA(소문자 hex 40자)는 마스킹하지 않는다', () => {
  const sha = 'ae8a498a0155cdf4f1c33951bfa742401485dec7'
  const { text, hits } = redactText(`commit ${sha}`)
  assert.ok(text.includes(sha), 'git SHA 가 마스킹되면 diff 리뷰가 망가진다')
  assert.equal(hits.length, 0)
})

test('음성: 소문자 스네이크 식별자는 길어도 남는다', () => {
  const ident = 'very_long_lowercase_identifier_for_a_function_name'
  const { text } = redactText(`export function ${ident}() {}`)
  assert.ok(text.includes(ident))
})

test('음성: 일반 산문은 그대로', () => {
  const prose = '이 함수는 입력을 검증한 뒤 결과를 반환한다.'
  const { text, hits } = redactText(prose)
  assert.equal(text, prose)
  assert.equal(hits.length, 0)
})

test('음성: 소문자 hex 64자(sha256)도 남는다', () => {
  const digest = 'a'.repeat(20) + 'b3f19c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'
  const { text } = redactText(digest)
  assert.ok(text.includes(digest))
})

// --- 파일 제외 ---

test('제외 목록: .env / pem / credentials 는 페이로드에서 빠진다', () => {
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

test('isExcludedPath 는 경로와 basename 양쪽을 본다', () => {
  assert.equal(isExcludedPath('a/b/id_rsa', EXCLUDE), true)
  assert.equal(isExcludedPath('id_rsa', EXCLUDE), true)
  assert.equal(isExcludedPath('src/keyboard.mjs', EXCLUDE), false)
})

// --- 상한·소독 ---

test('excerpt 는 상한으로 잘린다', () => {
  const { payload } = buildPayload({
    kind: 'review',
    goal: 'g',
    files: [{ path: 'big.mjs', excerpt: 'x'.repeat(LIMITS.excerpt + 500) }],
  })
  assert.ok(payload.files[0].excerpt.length < LIMITS.excerpt + 100)
  assert.match(payload.files[0].excerpt, /truncated/)
})

test('제어문자는 제거된다', () => {
  const { payload } = buildPayload({ kind: 'task', goal: 'a\u0007b\u001Fc' })
  assert.equal(payload.goal, 'abc')
})

test('redactions 는 어디서 무엇을 가렸는지 기록한다', () => {
  const { redactions } = buildPayload(
    { kind: 'review', goal: 'g', diff: 'AKIAIOSFODNN7EXAMPLE' },
    { redaction: { excludeFiles: EXCLUDE } },
  )
  const hit = redactions.find((r) => r.where === 'diff')
  assert.equal(hit.kind, 'aws-access-key')
  assert.equal(hit.count, 1)
})

test('signals 는 화이트리스트 키만 통과', () => {
  const { payload } = buildPayload({
    kind: 'task',
    goal: 'g',
    signals: { failing_tests: 'boom', evil: 'drop me' },
  })
  assert.deepEqual(Object.keys(payload.signals), ['failing_tests'])
})

test('shannonEntropy 는 균일 문자열에서 낮다', () => {
  assert.ok(shannonEntropy('aaaaaaaa') < 0.001)
  assert.ok(shannonEntropy('aZ3kQ9pL2mX7vB4n') > 3.5)
})
