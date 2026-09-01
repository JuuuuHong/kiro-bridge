#!/usr/bin/env node
// 엔트리포인트. 커맨드 라우팅만 하고 로직은 lib/ 에 둔다 (설계 §3).
import { review, formatSummary } from './lib/review.mjs'
import { setup, formatSetup } from './lib/setup.mjs'
import {
  task, runWorker, result, status, cancel,
  formatTask, formatResult, formatStatus, formatCancel,
} from './lib/task.mjs'
import { spec, formatSpec } from './lib/spec.mjs'
import { EVENT_TYPES } from './lib/transport/events.mjs'
import { BridgeError } from './lib/errors.mjs'

const USAGE = `kiro-bridge

  bridge.mjs setup  [--force]
  bridge.mjs review [ref]    [--dry-run] [--timeout <ms>] [--quiet]
  bridge.mjs task   <목표>   [--bg] [--write] [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs spec   <목표>   [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs result [job-id] [--follow-up <질문>]
  bridge.mjs status
  bridge.mjs cancel <job-id>

review/task/spec 은 결과를 자동 반영하지 않는다 — 출력은 검토용 데이터다 (ADR-004).
`

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = { _: [] }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--quiet') flags.quiet = true
    else if (arg === '--bg') flags.background = true
    else if (arg === '--write') flags.write = true
    else if (arg === '--timeout') { flags.timeoutMs = Number(rest[i + 1]); i += 1 }
    else if (arg === '--model') { flags.model = rest[i + 1]; i += 1 }
    else if (arg === '--effort') { flags.effort = rest[i + 1]; i += 1 }
    else if (arg === '--follow-up') { flags.followUp = rest[i + 1]; i += 1 }
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    else flags._.push(arg)
  }
  return { command, flags }
}

// 스트리밍 진행 상황을 stderr 로 흘린다 — stdout 은 결과 전용이라
// 상위(Claude Code)가 결과만 파싱할 수 있다.
function makeReporter(quiet) {
  if (quiet) return undefined
  return (event) => {
    if (event.type === EVENT_TYPES.TOOL_CALL) {
      process.stderr.write(`  · ${event.title || 'tool'}\n`)
    } else if (event.type === EVENT_TYPES.DENIED) {
      process.stderr.write(`  ! 툴 거부 감지\n`)
    }
  }
}

async function main(argv) {
  const { command, flags } = parseArgs(argv)

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'setup') {
    const result = await setup({ force: flags.force })
    process.stdout.write(`${formatSetup(result)}\n`)
    return result.ok ? 0 : 1
  }

  if (command === 'review') {
    const res = await review({
      ref: flags._[0] || null,
      dryRun: flags.dryRun,
      timeoutMs: flags.timeoutMs,
      onEvent: makeReporter(flags.quiet),
    })
    process.stdout.write(`${formatSummary(res)}\n`)
    return 0
  }

  if (command === 'task') {
    const res = await task({
      goal: flags._.join(' '),
      write: flags.write,
      background: flags.background,
      dryRun: flags.dryRun,
      timeoutMs: flags.timeoutMs,
      model: flags.model,
      effort: flags.effort,
      onEvent: makeReporter(flags.quiet),
    })
    process.stdout.write(`${formatTask(res)}\n`)
    return 0
  }

  if (command === 'spec') {
    const res = await spec({
      goal: flags._.join(' '),
      dryRun: flags.dryRun,
      timeoutMs: flags.timeoutMs,
      model: flags.model,
      effort: flags.effort,
      onEvent: makeReporter(flags.quiet),
    })
    process.stdout.write(`${formatSpec(res)}\n`)
    return 0
  }

  if (command === 'result') {
    const res = await result({
      jobId: flags._[0] || null,
      followUp: flags.followUp,
      timeoutMs: flags.timeoutMs,
      onEvent: makeReporter(flags.quiet),
    })
    process.stdout.write(`${formatResult(res)}\n`)
    return 0
  }

  if (command === 'status') {
    process.stdout.write(`${formatStatus(status())}\n`)
    return 0
  }

  if (command === 'cancel') {
    const res = cancel({ jobId: flags._[0] })
    process.stdout.write(`${formatCancel(res)}\n`)
    return res.ok ? 0 : 1
  }

  // 내부용: task --bg 가 detached 로 재실행하는 워커 엔트리. 문서화하지 않는다.
  if (command === '_worker') {
    await runWorker(flags._[0])
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
  return 2
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof BridgeError) {
        process.stderr.write(`[${err.code}] ${err.message}\n`)
        if (err.details?.reason) {
          process.stderr.write(`  ${err.details.reason}\n`)
        }
        if (err.details?.partial) {
          process.stderr.write(`\n부분 출력:\n${err.details.partial}\n`)
        }
        process.exit(1)
      }
      process.stderr.write(`${err?.stack || err}\n`)
      process.exit(1)
    })
}

export { main }
