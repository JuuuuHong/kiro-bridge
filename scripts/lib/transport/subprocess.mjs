// 폴백 transport: kiro-cli chat --no-interactive --output-format stream-json.
//
// ACP 능력 감지가 실패했을 때만 쓴다 (ADR-001R 결정 1). 상위 계약은 동일하되
// 이 경로에는 역방향 권한 요청이 없다 — 미신뢰 툴은 묻지 않고 자동 거부되므로
// onPermissionRequest 는 "항상 거부"로 축약되고, denial detector 가 그것을 잡는다.
import { spawn } from 'node:child_process'
import { createLineSplitter, normalizeStreamJsonLine, createCollector } from './events.mjs'
import { bridgeError, classifyOutput, CODES } from '../errors.mjs'

export function buildArgs({ agent, model, effort } = {}) {
  const args = ['chat', '--no-interactive', '--output-format', 'stream-json']
  if (agent) args.push('--agent', agent)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  return args
}

export async function run(payload, options = {}) {
  const {
    bin = 'kiro-cli',
    cwd = process.cwd(),
    onEvent,
    signal,
    timeoutMs = 180_000,
    spawnFn = spawn,
  } = options

  let child
  try {
    child = spawnFn(bin, buildArgs(options), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    throw bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) })
  }

  const collector = createCollector()
  let stderr = ''
  let timedOut = false

  const splitter = createLineSplitter((line) => {
    const event = normalizeStreamJsonLine(line)
    if (!event) return
    collector.push(event)
    onEvent?.(event)
  })

  child.stdout.on('data', (c) => splitter.push(String(c)))
  child.stderr.on('data', (c) => { stderr += String(c) })

  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch {}
  }, timeoutMs)

  const onAbort = () => { try { child.kill('SIGTERM') } catch {} }
  signal?.addEventListener('abort', onAbort, { once: true })

  // 페이로드는 크기와 무관하게 항상 stdin 파이프로 (ADR-003 결정 4).
  try {
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  } catch (err) {
    clearTimeout(timer)
    throw bridgeError(CODES.SPAWN_FAILED, { cause: String(err?.message || err) })
  }

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })

  clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  splitter.flush()

  if (timedOut) {
    throw bridgeError(CODES.TIMEOUT, { partial: collector.text })
  }
  if (signal?.aborted) {
    throw bridgeError(CODES.CANCELLED, { partial: collector.text })
  }

  const classified = classifyOutput(`${collector.text}\n${stderr}`)
  if (classified) throw bridgeError(classified, { stderr, exitCode })

  if (collector.denied) {
    throw bridgeError(CODES.TOOL_DENIED, { denials: collector.denials })
  }

  if (exitCode !== 0) {
    throw bridgeError(CODES.SPAWN_FAILED, { exitCode, stderr })
  }

  return {
    sessionId: null, // 원샷 경로에는 재사용할 세션이 없다
    transport: 'subprocess',
    result: collector.text,
    metadata: collector.metadata,
  }
}
