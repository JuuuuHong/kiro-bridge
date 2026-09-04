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
import { transfer, formatTransfer } from './lib/transfer.mjs'
import { listModels, formatModels, assertModelSupported } from './lib/models.mjs'
import * as json from './lib/json-output.mjs'
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

  bridge.mjs setup  [--force] [--json]
  bridge.mjs review [ref|A..B] [--staged] [--focus <text>] [--adversarial] [--bg] [--dry-run] [--signals <path>] [--no-signals] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet] [--json]
  bridge.mjs task   <goal>   [--bg] [--write] [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet] [--json]
  bridge.mjs spec   <goal>   [--dry-run] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet] [--json]
  bridge.mjs result [job-id] [--follow-up <question>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet] [--json]
  bridge.mjs resume <question> [--session <id>] [--model <id>] [--effort <lv>] [--timeout <ms>] [--quiet] [--json]
  bridge.mjs models [--force] [--json]
  bridge.mjs transfer [--session <id>] [--json]
  bridge.mjs status [--json]
  bridge.mjs cancel <job-id> [--json]

--model takes an id from 'bridge.mjs models', never a guess — an unrecognised id is caught before the delegated call (advisory: it passes through if discovery is unavailable).
review results are data and are never auto-applied. task --write explicitly permits scoped file writes; review its git diff afterward.
--json emits a machine-readable envelope; agent-produced fields stay marked external and fenced.
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
  json: '--json',
  staged: '--staged',
  signals: '--signals',
  noSignals: '--no-signals',
}

const ALLOWED_FLAGS = {
  setup: new Set(['force', 'json']),
  review: new Set(['focus', 'adversarial', 'background', 'dryRun', 'model', 'effort', 'timeoutMs', 'quiet', 'json', 'signals', 'noSignals', 'staged']),
  task: new Set(['background', 'write', 'dryRun', 'model', 'effort', 'timeoutMs', 'quiet', 'json']),
  spec: new Set(['dryRun', 'model', 'effort', 'timeoutMs', 'quiet', 'json']),
  result: new Set(['followUp', 'model', 'effort', 'timeoutMs', 'quiet', 'json']),
  resume: new Set(['session', 'model', 'effort', 'timeoutMs', 'quiet', 'json']),
  models: new Set(['force', 'json']),
  transfer: new Set(['session', 'json']),
  status: new Set(['json']),
  cancel: new Set(['json']),
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

// `task -h` must not become a delegated goal.
//
// `--help` is already rejected as an unknown flag, but a single-dash form is
// not flag-shaped to the parser, so it fell through into the free-text goal and
// spent real credits asking Kiro to act on the string "-h". Only an argument
// list that is *nothing but* a help token counts, so a goal that legitimately
// mentions a flag ("fix the -h handling") still delegates normally.
const HELP_TOKENS = new Set(['-h', '-?', 'help', '--help'])

export function isHelpRequest(positionals) {
  return positionals.length === 1 && HELP_TOKENS.has(positionals[0].toLowerCase())
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
    else if (arg === '--json') flags.json = true
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
    else if (arg === '--staged') flags.staged = true
    else if (arg === '--no-signals') flags.noSignals = true
    else if (arg === '--signals') { flags.signals = optionValue(rest, i, arg); i += 1 }
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

// Renders either the human summary or the --json envelope. The envelope is
// built lazily so the text path never pays for it.
function emit(flags, text, envelopeFn) {
  outWrite(flags.json ? json.render(envelopeFn()) : `${text}\n`)
}

// Remembered so the top-level failure handler can answer in the same format
// the caller asked for.
let invocation = { command: null, json: false }

async function main(argv) {
  // Recorded from the raw argv *before* parsing: a --json caller whose
  // arguments fail to parse must still get a JSON error, not a stack trace.
  invocation = { command: argv[0] ?? null, json: argv.includes('--json') }
  assertSupportedRuntime()
  const { command, flags } = parseArgs(argv)
  invocation = { command: command ?? null, json: Boolean(flags.json) }

  if (!command || command === 'help' || command === '--help') {
    outWrite(USAGE)
    return 0
  }

  validateCommandFlags(command, flags)

  // Checked before any command body so no credit-spending path can be reached
  // by what was plainly a request for usage.
  if (isHelpRequest(flags._)) {
    outWrite(USAGE)
    return 0
  }

  if (command === 'models') {
    const listing = await listModels({ force: flags.force })
    emit(flags, formatModels(listing), () => json.modelsJson(listing))
    return 0
  }

  // Catch a guessed --model here rather than letting kiro-cli reject it: the
  // failure would otherwise surface only after a spawn (and, with --bg, only
  // after a job was created and the caller had already been handed its id).
  // Soft by design — see validateModel; an unverifiable id still goes through.
  //
  // Gated on the command being one that takes --model: an unrecognised command
  // must report itself, not spend a discovery call to complain about a flag.
  if (ALLOWED_FLAGS[command]?.has('model')) {
    await assertModelSupported(flags.model)
  }

  if (command === 'setup') {
    const result = await setup({ force: flags.force })
    emit(flags, formatSetup(result), () => json.setupJson(result))
    return result.ok ? 0 : 1
  }

  if (command === 'review') {
    if (flags.background) {
      const bg = reviewBackground({
        ref: flags._[0] || null,
        staged: flags.staged,
        focus: flags.focus,
        adversarial: flags.adversarial,
        model: flags.model,
        effort: flags.effort,
        timeoutMs: flags.timeoutMs,
        signalsPath: flags.signals,
        noSignals: flags.noSignals,
      })
      emit(flags, formatTask(bg), () => json.taskJson(bg))
      return 0
    }
    const res = await review({
      ref: flags._[0] || null,
      staged: flags.staged,
      focus: flags.focus,
      adversarial: flags.adversarial,
      dryRun: flags.dryRun,
      model: flags.model,
      effort: flags.effort,
      timeoutMs: flags.timeoutMs,
      signalsPath: flags.signals,
      noSignals: flags.noSignals,
      register: true,
      onEvent: makeReporter(flags.quiet),
    })
    emit(flags, formatSummary(res), () => json.reviewJson(res))
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
    emit(flags, formatTask(res), () => json.taskJson(res))
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
    emit(flags, formatSpec(res), () => json.specJson(res))
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
    emit(flags, formatResult(res), () => json.resultJson(res))
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
    emit(flags, formatResume(res), () => json.resumeJson(res))
    return 0
  }

  if (command === 'transfer') {
    const res = transfer({ selector: flags.session })
    emit(flags, formatTransfer(res), () => json.transferJson(res))
    return 0
  }

  if (command === 'status') {
    const res = status()
    emit(flags, formatStatus(res), () => json.statusJson(res))
    return 0
  }

  if (command === 'cancel') {
    const res = cancel({ jobId: flags._[0] })
    emit(flags, formatCancel(res), () => json.cancelJson(res))
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
      // Answer in the format the caller asked for: a --json caller must not
      // have to parse prose to find out the run failed.
      if (invocation.json) {
        outWrite(json.render(json.errorJson(invocation.command, err)))
        return exitAfterFlush(1)
      }
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
