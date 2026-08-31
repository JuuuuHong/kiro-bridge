// Kiro 커스텀 에이전트 정의 — 권한 명세의 단일 진실 공급원 (ADR-002, 설계 §6).
//
// tool 정식 명칭이 미확정이다: `--trust-tools` 도움말 예시는 `fs_read,fs_write`
// 인데 session/new 응답의 built-in 목록은 `read, write, grep...` 이다 (OQ4).
// 여기서는 둘 중 하나를 찍지 않고, 설치 시 `agent validate` 로 어느 쪽이
// 통과하는지 탐침해서 확정한다 — 미확정을 코드가 스스로 해소하게 만든다.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'

export const AGENT_PREFIX = 'kiro-bridge-'
export const AGENT_VERSION = '0.1.0'

// 후보 명명 규약. 순서가 시도 순서다.
export const TOOL_NAME_SETS = {
  short: { read: 'read', grep: 'grep', glob: 'glob', write: 'write', shell: 'shell' },
  prefixed: { read: 'fs_read', grep: 'grep', glob: 'glob', write: 'fs_write', shell: 'execute_bash' },
}

const REVIEWER_PROMPT = [
  '너는 코드 리뷰 전용 에이전트다. stdin 으로 받은 JSON 페이로드를 읽고 리뷰한다.',
  '',
  '규칙:',
  '- 파일을 직접 읽어 확인한 것만 주장한다. 읽지 못했으면 그 사실을 summary 에 적는다.',
  '- 파일을 수정하지 않는다. 쓰기 툴은 신뢰되지 않았다.',
  '- 응답은 아래 JSON 스키마 하나만 출력한다. 산문 설명을 덧붙이지 않는다.',
  '',
  '{"findings":[{"severity":"low|medium|high","file":"경로","line":0,',
  '"claim":"한 문장 결함 서술","evidence":"근거","suggestion":"수정 방향"}],',
  '"summary":"전체 판단"}',
].join('\n')

// 정의는 tool 이름에 독립적으로 쓰고, 렌더링 시점에 명명 규약을 주입한다.
export const AGENT_DEFS = {
  reviewer: {
    name: `${AGENT_PREFIX}reviewer`,
    description: 'Read-only code reviewer that returns structured findings JSON.',
    prompt: REVIEWER_PROMPT,
    // 읽기 계열만 명시적으로 pre-trust. 쓰기·실행은 미신뢰 (ADR-002).
    trust: ['read', 'grep', 'glob'],
    deny: ['write', 'shell'],
  },
}

export function renderAgent(def, toolSet) {
  const names = TOOL_NAME_SETS[toolSet]
  if (!names) throw new Error(`unknown tool name set: ${toolSet}`)
  return {
    name: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.trust.map((t) => names[t]),
    allowedTools: def.trust.map((t) => names[t]),
    toolAliases: {},
    _kiroBridge: { version: AGENT_VERSION, toolSet },
  }
}

// 스탬프를 제외한 본문 해시. 사용자가 손댔는지 판단하는 기준이다.
export function agentHash(json) {
  const { _kiroBridge, ...body } = json
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
}

export function agentsDir() {
  return process.env.KIRO_AGENTS_DIR || join(homedir(), '.kiro', 'agents')
}

function writeAtomic(target, contents) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

// 어느 명명 규약이 실제로 통과하는지 탐침한다 (OQ4 해소 경로).
// validateFn(path) 가 통과하면 resolve, 전부 실패하면 마지막 오류를 돌려준다.
export async function probeToolNaming(def, { validateFn, tmpPath }) {
  const attempts = []
  for (const toolSet of Object.keys(TOOL_NAME_SETS)) {
    const rendered = renderAgent(def, toolSet)
    writeAtomic(tmpPath, `${JSON.stringify(rendered, null, 2)}\n`)
    try {
      await validateFn(tmpPath)
      return { toolSet, rendered, attempts }
    } catch (err) {
      attempts.push({ toolSet, error: String(err?.message || err) })
    }
  }
  return { toolSet: null, rendered: null, attempts }
}

// 설치. 사용자가 수정한 파일은 덮어쓰지 않고 경고만 한다 (설계 §6).
export function installAgent(rendered, { dir = agentsDir(), force = false } = {}) {
  const target = join(dir, `${rendered.name}.json`)

  if (existsSync(target) && !force) {
    let existing
    try {
      existing = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      return { target, action: 'skipped', reason: 'existing file is not valid JSON' }
    }
    const stamp = existing._kiroBridge
    if (!stamp) {
      return { target, action: 'skipped', reason: 'not managed by kiro-bridge' }
    }
    if (stamp.hash && stamp.hash !== agentHash(existing)) {
      return { target, action: 'skipped', reason: 'user-modified — 덮어쓰지 않음' }
    }
    if (stamp.version === AGENT_VERSION && stamp.toolSet === rendered._kiroBridge.toolSet) {
      return { target, action: 'unchanged' }
    }
  }

  const stamped = {
    ...rendered,
    _kiroBridge: { ...rendered._kiroBridge, hash: agentHash(rendered) },
  }
  writeAtomic(target, `${JSON.stringify(stamped, null, 2)}\n`)
  return { target, action: existsSync(target) ? 'installed' : 'installed' }
}
