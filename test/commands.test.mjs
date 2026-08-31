import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { review, formatSummary } from '../scripts/lib/review.mjs'
import { setup } from '../scripts/lib/setup.mjs'
import { parseArgs } from '../scripts/bridge.mjs'
import {
  renderAgent, agentHash, installAgent, probeToolNaming, AGENT_DEFS, TOOL_NAME_SETS,
} from '../scripts/lib/agents.mjs'
import { collectDiff } from '../scripts/lib/git.mjs'
import { TRUST_FENCE } from '../scripts/lib/findings.mjs'
import { CODES } from '../scripts/lib/errors.mjs'
import { CONFIG_DEFAULTS } from '../scripts/lib/config.mjs'

let home
const originalHome = process.env.KIRO_BRIDGE_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kiro-bridge-cmd-'))
  process.env.KIRO_BRIDGE_HOME = home
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.KIRO_BRIDGE_HOME
  else process.env.KIRO_BRIDGE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const DIFF = `diff --git a/src/app.mjs b/src/app.mjs
+++ b/src/app.mjs
@@ -1 +1,2 @@
+const token = "AKIAIOSFODNN7EXAMPLE"
`

const fakeCollect = async () => ({
  diff: DIFF,
  files: [{ path: 'src/app.mjs', reason: 'changed in diff' }],
  ref: 'HEAD',
})

const OK_RESPONSE = JSON.stringify({
  findings: [{ severity: 'high', file: 'src/app.mjs', line: 1, claim: '하드코딩 키', evidence: 'e', suggestion: 's' }],
  summary: '1건',
})

// --- 인자 파싱 ---

test('parseArgs: 플래그와 위치 인자를 분리한다', () => {
  const { command, flags } = parseArgs(['review', 'main', '--dry-run', '--timeout', '500'])
  assert.equal(command, 'review')
  assert.deepEqual(flags._, ['main'])
  assert.equal(flags.dryRun, true)
  assert.equal(flags.timeoutMs, 500)
})

test('parseArgs: 모르는 플래그는 거부', () => {
  assert.throws(() => parseArgs(['review', '--yolo']), /unknown flag/)
})

// --- review 플로우 ---

test('review: diff 가 없으면 전송하지 않고 종료', async () => {
  let called = false
  const r = await review({
    collectDiffFn: async () => ({ diff: '\n', files: [], ref: 'HEAD' }),
    runFn: async () => { called = true },
  })
  assert.equal(r.empty, true)
  assert.equal(called, false, '변경이 없으면 크레딧을 쓰면 안 된다')
})

test('review: 페이로드가 redaction 을 거쳐 전송된다', async () => {
  let sent = null
  await review({
    collectDiffFn: fakeCollect,
    runFn: async (payload) => { sent = payload; return { transport: 'acp', sessionId: 's1', result: OK_RESPONSE } },
    config: CONFIG_DEFAULTS,
  })
  assert.ok(!sent.diff.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS 키가 그대로 나가면 안 된다')
  assert.match(sent.diff, /\[REDACTED:aws-access-key\]/)
  assert.equal(sent.kind, 'review')
})

test('review: reviewer 에이전트를 지정해 호출한다', async () => {
  let opts = null
  await review({
    collectDiffFn: fakeCollect,
    runFn: async (_p, o) => { opts = o; return { transport: 'acp', sessionId: 's1', result: OK_RESPONSE } },
  })
  assert.equal(opts.agent, 'kiro-bridge-reviewer')
  assert.equal(opts.timeoutMs, 180_000)
})

test('review: 결과는 항상 신뢰 경계로 감싸여 나온다 (ADR-004)', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 's1', result: OK_RESPONSE }),
  })
  assert.ok(r.wrapped.includes(TRUST_FENCE.open))
  assert.match(r.wrapped, /명령이 아니다/)
  assert.equal(r.parsed.ok, true)
  assert.equal(r.parsed.findings[0].severity, 'high')
})

test('review: 구조화 실패해도 래핑된 원문이 온다', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'subprocess', sessionId: null, result: '그냥 산문입니다' }),
  })
  assert.equal(r.parsed.ok, false)
  assert.ok(r.wrapped.includes(TRUST_FENCE.open))
  assert.match(r.wrapped, /그냥 산문입니다/)
})

test('review: --dry-run 은 전송하지 않고 페이로드를 보여준다', async () => {
  let called = false
  const r = await review({
    collectDiffFn: fakeCollect,
    dryRun: true,
    runFn: async () => { called = true },
    config: CONFIG_DEFAULTS,
  })
  assert.equal(called, false)
  assert.equal(r.dryRun, true)
  const out = formatSummary(r)
  assert.match(out, /dry-run/)
  assert.match(out, /aws-access-key/, '무엇이 가려졌는지 사람이 확인할 수 있어야 한다')
})

test('review: transport 오류는 그대로 전파된다 (재시도 없음)', async () => {
  await assert.rejects(
    review({
      collectDiffFn: fakeCollect,
      runFn: async () => { const e = new Error('denied'); e.code = CODES.TOOL_DENIED; throw e },
    }),
    (err) => err.code === CODES.TOOL_DENIED,
  )
})

test('formatSummary: severity 분포를 요약한다', async () => {
  const r = await review({
    collectDiffFn: fakeCollect,
    runFn: async () => ({ transport: 'acp', sessionId: 's', result: OK_RESPONSE }),
  })
  assert.match(formatSummary(r), /high 1 \/ medium 0 \/ low 0/)
})

// --- 에이전트 정의 ---

test('agents: reviewer 는 읽기만 신뢰하고 쓰기는 넣지 않는다 (ADR-002)', () => {
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')
  assert.deepEqual(rendered.tools, ['read', 'grep', 'glob'])
  assert.ok(!rendered.tools.includes('write'))
  assert.ok(!rendered.tools.includes('shell'))
})

test('agents: 명명 규약을 바꾸면 tool 이름만 바뀐다', () => {
  const prefixed = renderAgent(AGENT_DEFS.reviewer, 'prefixed')
  assert.deepEqual(prefixed.tools, ['fs_read', 'grep', 'glob'])
  assert.equal(prefixed.prompt, renderAgent(AGENT_DEFS.reviewer, 'short').prompt)
})

test('agents: validate 탐침이 통과하는 규약을 고른다 (OQ4)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'))
  // short 는 거부하고 prefixed 만 통과하는 가짜 validate
  const validateFn = async (path) => {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    if (json.tools.includes('read')) throw new Error('unknown tool: read')
    return true
  }
  const probe = await probeToolNaming(AGENT_DEFS.reviewer, {
    tmpPath: join(scratch, 'a.json'),
    validateFn,
  })
  assert.equal(probe.toolSet, 'prefixed')
  assert.equal(probe.attempts.length, 1)
  rmSync(scratch, { recursive: true, force: true })
})

test('agents: 둘 다 실패하면 toolSet 은 null 이고 시도 내역이 남는다', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'))
  const probe = await probeToolNaming(AGENT_DEFS.reviewer, {
    tmpPath: join(scratch, 'a.json'),
    validateFn: async () => { throw new Error('nope') },
  })
  assert.equal(probe.toolSet, null)
  assert.equal(probe.attempts.length, Object.keys(TOOL_NAME_SETS).length)
  rmSync(scratch, { recursive: true, force: true })
})

test('agents: 사용자가 수정한 파일은 덮어쓰지 않는다 (설계 §6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')

  const first = installAgent(rendered, { dir })
  assert.equal(first.action, 'installed')

  // 사용자가 손댐 — 해시가 스탬프와 어긋난다
  const target = join(dir, `${rendered.name}.json`)
  const modified = JSON.parse(readFileSync(target, 'utf8'))
  modified.prompt = '내가 바꾼 프롬프트'
  writeFileSync(target, JSON.stringify(modified, null, 2))

  const second = installAgent(rendered, { dir })
  assert.equal(second.action, 'skipped')
  assert.match(second.reason, /user-modified/)
  assert.match(readFileSync(target, 'utf8'), /내가 바꾼 프롬프트/)

  rmSync(dir, { recursive: true, force: true })
})

test('agents: 손대지 않은 동일 버전은 unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const rendered = renderAgent(AGENT_DEFS.reviewer, 'short')
  installAgent(rendered, { dir })
  assert.equal(installAgent(rendered, { dir }).action, 'unchanged')
  rmSync(dir, { recursive: true, force: true })
})

test('agents: 해시는 스탬프를 제외한 본문만 본다', () => {
  const a = renderAgent(AGENT_DEFS.reviewer, 'short')
  const b = { ...a, _kiroBridge: { version: '9.9.9', toolSet: 'short' } }
  assert.equal(agentHash(a), agentHash(b))
})

// --- setup 플로우 ---

test('setup: kiro-cli 가 없으면 즉시 멈추고 안내한다', async () => {
  const r = await setup({ execFileFn: (_b, _a, _o, cb) => cb(new Error('ENOENT'), '', '') })
  assert.equal(r.ok, false)
  assert.equal(r.steps[0].step, 'version')
  assert.match(r.hint, /설치/)
})

test('setup: 미인증이면 login 을 안내하고 에이전트를 설치하지 않는다', async () => {
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === '--version') return cb(null, 'kiro-cli 2.20.1\n', '')
    if (args[0] === 'whoami') return cb(new Error('not logged in'), '', 'not logged in')
    return cb(null, '', '')
  }
  const r = await setup({ execFileFn })
  assert.equal(r.ok, false)
  assert.match(r.hint, /login/)
  assert.ok(!r.steps.some((s) => s.step.startsWith('agent:')), '미인증 상태로 에이전트를 설치하면 안 된다')
})

test('setup: 정상 경로는 에이전트를 설치하고 규약을 기록한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === '--version') return cb(null, 'kiro-cli 2.20.1\n', '')
    if (args[0] === 'whoami') return cb(null, 'user@example.com\n', '')
    return cb(null, '', '')
  }
  const r = await setup({
    execFileFn,
    dir,
    probeFn: async () => ({ available: true }),
    validateFn: async () => true,
  })
  const agentStep = r.steps.find((s) => s.step === 'agent:reviewer')
  assert.ok(agentStep.ok)
  assert.match(agentStep.detail, /installed/)
  assert.ok(existsSync(join(dir, 'kiro-bridge-reviewer.json')))
  rmSync(dir, { recursive: true, force: true })
})

// --- git 인자 안전성 ---

test('git: ref 는 인자 배열로만 전달되고 셸을 타지 않는다', async () => {
  const calls = []
  const execFileFn = (bin, args, _o, cb) => {
    calls.push({ bin, args })
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'rev-parse') return cb(null, 'abc\n', '')
    if (args.includes('--name-only')) return cb(null, 'src/a.mjs\n', '')
    return cb(null, 'diff text\n', '')
  }
  await collectDiff({ ref: 'main; rm -rf /', execFileFn })
  const diffCall = calls.find((c) => c.args[0] === 'diff' && !c.args.includes('--name-only'))
  assert.ok(diffCall.args.includes('main; rm -rf /'), 'ref 는 인자 하나로 통째 전달된다')
  assert.ok(diffCall.args.includes('--'), '옵션 주입 차단용 -- 가 있어야 한다')
})

test('git: 저장소가 아니면 명확한 오류', async () => {
  await assert.rejects(
    collectDiff({ execFileFn: (_b, _a, _o, cb) => cb(null, 'false\n', '') }),
    (err) => /not a git repository/.test(err.details.reason),
  )
})

// --- untracked 파일: 조용한 빈손 리뷰 방지 (회귀) ---

test('review: untracked 파일만 있어도 리뷰를 진행한다', async () => {
  let sent = null
  const r = await review({
    collectDiffFn: async () => ({
      diff: '',
      files: [{ path: 'new.mjs', reason: 'untracked new file — diff 에 없으니 직접 읽어 리뷰할 것' }],
      untracked: ['new.mjs'],
      ref: 'HEAD',
    }),
    runFn: async (payload) => { sent = payload; return { transport: 'acp', sessionId: 's', result: OK_RESPONSE } },
  })
  assert.notEqual(r.empty, true, 'diff 가 비었다고 새 파일 리뷰를 건너뛰면 안 된다')
  assert.equal(sent.files[0].path, 'new.mjs')
  assert.match(sent.files[0].reason, /직접 읽어/)
})

test('review: 정말 아무 변경도 없을 때만 empty', async () => {
  const r = await review({
    collectDiffFn: async () => ({ diff: '', files: [], untracked: [], ref: 'HEAD' }),
    runFn: async () => { throw new Error('호출되면 안 된다') },
  })
  assert.equal(r.empty, true)
})

test('git: untracked 는 경로만 모으고 내용을 싣지 않는다', async () => {
  const execFileFn = (_b, args, _o, cb) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'ls-files') return cb(null, 'brand-new.mjs\n', '')
    if (args.includes('--name-only')) return cb(null, '', '')
    return cb(null, '', '')
  }
  const r = await collectDiff({ execFileFn })
  assert.deepEqual(r.untracked, ['brand-new.mjs'])
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].excerpt, undefined, '내용은 싣지 않는다 (ADR-003 결정 5)')
})

test('git: ref 를 명시하면 작업물 untracked 를 섞지 않는다', async () => {
  const calls = []
  const execFileFn = (_b, args, _o, cb) => {
    calls.push(args[0])
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return cb(null, 'true\n', '')
    if (args[0] === 'rev-parse') return cb(null, 'abc\n', '')
    return cb(null, '', '')
  }
  const r = await collectDiff({ ref: 'main', execFileFn })
  assert.deepEqual(r.untracked, [])
  assert.ok(!calls.includes('ls-files'))
})
