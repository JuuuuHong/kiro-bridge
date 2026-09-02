#!/usr/bin/env node
// Entry point. Only routes commands; logic lives in lib/ (design §3).
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { review, formatSummary } from './lib/review.mjs'
import { setup, formatSetup } from './lib/setup.mjs'
import {
  task, runWorker, result, status, cancel, reviewBackground,
  formatTask, formatResult, formatStatus, formatCancel,
} from './lib/task.mjs'
import { spec, formatSpec } from './lib/spec.mjs'
import { resume, formatResume } from './lib/resume.mjs'
import { EVENT_TYPES } from './lib/transport/events.mjs'
import { BridgeError } from './lib/errors.mjs'
import { sanitizeTerminal } from './lib/sanitize.mjs'

// All bridge output crosses a terminal boundary. Result/status/error strings
// embed model- and process-derived text, so sanitize at the write edge so no
// escape sequence (cursor, screen, OSC 52 clipboard, title) can reach a TTY.
// Findings bodies are already sanitized upstream; this is defence in depth.
//
// Writes to a *pipe* (how Claude Code captures this process) are asynchronous,
// and process.exit() does not flush them — a large result is silently cut at
// the pipe buffer, which can also drop the closing trust fence. Every write is
// therefore tracked here and awaited by flushOutput() before we exit.
const pendingWrites = []

function trackedWrite(stream, text) {
  const clean = sanitizeTerminal(text)
  pendingWrites.push(new Promise((resolve) => {
    try {
      // The callback fires once the chunk is handed to the OS (or errors, e.g.
      // EPIPE); either way the write is no longer pending for our purposes.
      stream.write(clean, () => resolve())
    } catch {
      resolve()
    }
  }))
}

function outWrite(text) {
  trackedWrite(process.stdout, text)
}

function errWrite(text) {
  trackedWrite(process.stderr, text)
}

// Bounded: a reader that stops consuming must not hang the process forever.
export const FLUSH_TIMEOUT_MS = 10_000

export async function flushOutput(timeoutMs = FLUSH_TIMEOUT_MS) {
  const writes = pendingWrites.splice(0)
  if (writes.length === 0) return
  let timer
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
  await Promise.race([Promise.all(writes), bound])
  clearTimeout(timer)
}

const USAGE = `kiro-bridge

  bridge.mjs setup  [--force]
  bridge.mjs review [ref]    [--focus <text>] [--adversarial] [--bg] [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs task   <goal>   [--bg] [--write] [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs spec   <goal>   [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs result [job-id] [--follow-up <question>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs resume <question> [--session <id>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet]
  bridge.mjs status
  bridge.mjs cancel <job-id>

review results are data and are never auto-applied. task --write explicitly permits scoped file writes; review its git diff afterward.
`


const FLAG_NAMES = {
  dryRun: '--dry-run',
  force: '--force',
  quiet: '--quiet',
  background: '--bg',
  write: '--write',
  adversarial: '--adversarial',
  focus: '--focus',
  timeoutMs: '--timeout',
  model: '--model',
  effort: '--effort',
  followUp: '--follow-up',
  session: '--session',
}

const ALLOWED_FLAGS = {
  setup: new Set(['force']),
  review: new Set(['focus', 'adversarial', 'background', 'dryRun', 'model', 'effort', 'timeoutMs', 'quiet']),
  task: new Set(['background', 'write', 'dryRun', 'model', 'effort', 'timeoutMs', 'quiet']),
  spec: new Set(['dryRun', 'model', 'effort', 'timeoutMs', 'quiet']),
  result: new Set(['followUp', 'model', 'effort', 'timeoutMs', 'quiet']),
  resume: new Set(['session', 'model', 'effort', 'timeoutMs', 'quiet']),
  status: new Set(),
  cancel: new Set(),
  _worker: new Set(),
}

function optionValue(rest, index, flag) {
  const value = rest[index + 1]
  if (value == null || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${flag} requires a non-empty value`)
  }
  return value
}

export function validateCommandFlags(command, flags) {
  const allowed = ALLOWED_FLAGS[command]
  if (!allowed) return
  for (const key of Object.keys(FLAG_NAMES)) {
    if (flags[key] !== undefined && !allowed.has(key)) {
      throw new Error(`${FLAG_NAMES[key]} is not supported by ${command}`)
    }
  }
  // --bg detaches a worker and returns a job id immediately; --dry-run only
  // prints the payload without sending. Combining them is contradictory, so
  // reject it outright rather than silently ignoring one (both review + task).
  if ((command === 'review' || command === 'task') && flags.background && flags.dryRun) {
    throw new Error('--bg cannot be combined with --dry-run')
  }
  if (command === 'result' && !flags.followUp && (
    flags.model !== undefined || flags.effort !== undefined
    || flags.timeoutMs !== undefined || flags.quiet !== undefined
  )) {
    throw new Error('--model, --effort, --timeout, and --quiet on result require --follow-up')
  }
}

function assertSupportedRuntime() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`kiro-bridge requires Node 20 or newer (current: ${process.versions.node})`)
  }
}

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
    else if (arg === '--adversarial') flags.adversarial = true
    else if (arg === '--focus') { flags.focus = optionValue(rest, i, arg); i += 1 }
    else if (arg === '--timeout') {
      const raw = optionValue(rest, i, arg)
      const timeoutMs = Number(raw)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`--timeout must be a positive finite number: ${raw}`)
      }
      flags.timeoutMs = timeoutMs
      i += 1
    }
    else if (arg === '--model') { flags.model = optionValue(rest, i, arg); i += 1 }
    else if (arg === '--effort') { flags.effort = optionValue(rest, i, arg); i += 1 }
    else if (arg === '--follow-up') { flags.followUp = optionValue(rest, i, arg); i += 1 }
    else if (arg === '--session') { flags.session = optionValue(rest, i, arg); i += 1 }
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    else flags._.push(arg)
  }
  return { command, flags }
}

// Stream progress to stderr — stdout is result-only, so the caller
// (Claude Code) can parse just the result.
function makeReporter(quiet) {
  if (quiet) return undefined
  return (event) => {
    if (event.type === EVENT_TYPES.TOOL_CALL) {
      errWrite(`  · ${event.title || 'tool'}\n`)
    } else if (event.type === EVENT_TYPES.DENIED) {
      errWrite(`  ! tool denial detected\n`)
    }
  }
}

async function main(argv) {
  assertSupportedRuntime()
  const { command, flags } = parseArgs(argv)

  if (!command || command === 'help' || command === '--help') {
    outWrite(USAGE)
    return 0
  }

  validateCommandFlags(command, flags)

  if (command === 'setup') {
    const result = await setup({ force: flags.force })
    outWrite(`${formatSetup(result)}\n`)
    return result.ok ? 0 : 1
  }

  if (command === 'review') {
    if (flags.background) {
      const bg = reviewBackground({
        ref: flags._[0] || null,
        focus: flags.focus,
        adversarial: flags.adversarial,
        model: flags.model,
        effort: flags.effort,
        timeoutMs: flags.timeoutMs,
      })
      outWrite(`${formatTask(bg)}\n`)
      return 0
    }
    const res = await review({
      ref: flags._[0] || null,
      focus: flags.focus,
      adversarial: flags.adversarial,
      dryRun: flags.dryRun,
      model: flags.model,
      effort: flags.effort,
      timeoutMs: flags.timeoutMs,
      register: true,
      onEvent: makeReporter(flags.quiet),
    })
    outWrite(`${formatSummary(res)}\n`)
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
    outWrite(`${formatTask(res)}\n`)
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
    outWrite(`${formatSpec(res)}\n`)
    return 0
  }

  if (command === 'result') {
    const res = await result({
      jobId: flags._[0] || null,
      followUp: flags.followUp,
      model: flags.model,
      effort: flags.effort,
      timeoutMs: flags.timeoutMs,
      onEvent: makeReporter(flags.quiet),
    })
    outWrite(`${formatResult(res)}\n`)
    return 0
  }

  if (command === 'resume') {
    const res = await resume({
      question: flags._.join(' '),
      session: flags.session,
      model: flags.model,
      effort: flags.effort,
      timeoutMs: flags.timeoutMs,
      onEvent: makeReporter(flags.quiet),
    })
    outWrite(`${formatResume(res)}\n`)
    return 0
  }

  if (command === 'status') {
    outWrite(`${formatStatus(status())}\n`)
    return 0
  }

  if (command === 'cancel') {
    const res = cancel({ jobId: flags._[0] })
    outWrite(`${formatCancel(res)}\n`)
    return res.ok ? 0 : 1
  }

  // Internal: the worker entry re-exec'd detached by task --bg. Not documented.
  if (command === '_worker') {
    await runWorker(flags._[0])
    return 0
  }

  errWrite(`unknown command: ${command}\n\n${USAGE}`)
  return 2
}

// Compare resolved real paths rather than basenames: a same-named script
// elsewhere on the filesystem must not be mistaken for this entry point.
export function isDirectInvocation(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

async function exitAfterFlush(code) {
  await flushOutput()
  process.exit(code)
}

if (isDirectInvocation()) {
  main(process.argv.slice(2))
    .then((code) => exitAfterFlush(code))
    .catch((err) => {
      if (err instanceof BridgeError) {
        errWrite(`[${err.code}] ${err.message}\n`)
        if (err.details?.reason) {
          errWrite(`  ${err.details.reason}\n`)
        }
        if (err.details?.partial) {
          errWrite(`\nPartial output:\n${err.details.partial}\n`)
        }
        return exitAfterFlush(1)
      }
      errWrite(`${err?.stack || err}\n`)
      return exitAfterFlush(1)
    })
}

export { main }
