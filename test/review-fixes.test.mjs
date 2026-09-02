// Regression tests for the defects found in the 0.2.0 code review.
// Each test fails against the pre-fix code and passes after it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as transport from '../scripts/lib/transport/index.mjs'
import { normalizeStreamJsonLine, EVENT_TYPES } from '../scripts/lib/transport/events.mjs'
import { JsonRpcClient } from '../scripts/lib/transport/jsonrpc.mjs'
import { renderAgent, AGENT_DEFS } from '../scripts/lib/agents.mjs'
import { pruneUsage, usagePath } from '../scripts/lib/usage.mjs'
import { runWorker } from '../scripts/lib/task.mjs'
import * as jobs from '../scripts/lib/jobs.mjs'

const BRIDGE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'bridge.mjs')

// Awaits fn so an async body cannot outlive the temp home it depends on.
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'kb-fixes-'))
  const prev = process.env.KIRO_BRIDGE_HOME
  process.env.KIRO_BRIDGE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.KIRO_BRIDGE_HOME
    else process.env.KIRO_BRIDGE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

// --- Critical: stdout must not be truncated when it is a pipe ---

test('bridge: a large result survives a piped stdout (no process.exit truncation)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kb-pipe-'))
  const repo = mkdtempSync(join(tmpdir(), 'kb-repo-'))
  try {
    const run = (cmd, args, opts) => new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stdout, stderr }))
        resolve(stdout)
      })
    })
    await run('git', ['init', '-q', '.'])
    await run('git', ['config', 'user.email', 't@t'])
    await run('git', ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'big.txt'), 'lorem ipsum dolor sit amet consectetur\n'.repeat(4000))
    await run('git', ['add', '-A'])
    await run('git', ['commit', '-qm', 'init'])
    // Append enough to push the dry-run payload well past a 64KiB pipe buffer.
    writeFileSync(join(repo, 'big.txt'), 'appended line for the diff\n'.repeat(4000), { flag: 'a' })

    // execFile captures stdout through a pipe — the exact path Claude Code uses.
    const out = await run(process.execPath, [BRIDGE, 'review', '--dry-run'], {
      env: { ...process.env, KIRO_BRIDGE_HOME: home },
    })
    assert.ok(out.length > 65536, `expected >64KiB of output, got ${out.length} bytes`)
    // The payload JSON must be complete, not cut mid-structure.
    assert.ok(out.trimEnd().length > 65536)
    assert.ok(out.includes('[dry-run] payload relative to'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

// --- High: session reuse must never silently fall back to the one-shot path ---

test('transport.run: sessionId on the subprocess transport fails loudly', async () => {
  await assert.rejects(
    () => transport.run({ kind: 'task', goal: 'x' }, {
      transport: transport.TRANSPORTS.SUBPROCESS,
      sessionId: 'sess-123',
    }),
    (err) => {
      assert.equal(err.code, 'PROTOCOL')
      assert.match(err.details.reason, /session reuse requires the ACP transport/)
      return true
    },
  )
})

test('transport.run: without a sessionId the subprocess transport is still dispatched to', async () => {
  // The guard must not intercept an ordinary one-shot call. Dispatching with a
  // binary that cannot exist proves we reached subprocess.run (SPAWN_FAILED)
  // rather than being rejected by the session-reuse guard (PROTOCOL).
  await assert.rejects(
    () => transport.run({ kind: 'task', goal: 'x' }, {
      transport: transport.TRANSPORTS.SUBPROCESS,
      bin: join(tmpdir(), 'kiro-cli-does-not-exist'),
    }),
    (err) => {
      assert.equal(err.code, 'SPAWN_FAILED')
      return true
    },
  )
})

// --- Medium: background task must carry the same constraints as foreground ---

test('runWorker: a background task sends the foreground constraint set', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-bg-'))
    try {
      const { jobId } = jobs.createJob({
        cwd,
        command: 'task',
        payloadOptions: { goal: 'investigate x', write: false },
      })
      let seen = null
      const runFn = async (payload) => {
        seen = payload
        return { transport: 'subprocess', sessionId: null, result: '{"findings":[]}', metadata: null }
      }
      await runWorker(jobId, { cwd, runFn })
      assert.deepEqual(seen.constraints, ['Do not claim anything you could not confirm by reading it.'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// --- Medium: subprocess metadata must be bounded like the ACP path ---

test('normalizeStreamJsonLine: _meta keeps only a valid contextUsagePercentage', () => {
  const event = normalizeStreamJsonLine(JSON.stringify({
    _meta: { contextUsagePercentage: 42, secretToken: 'leak-me', nested: { a: 1 } },
  }))
  assert.equal(event.type, EVENT_TYPES.METADATA)
  assert.equal(event.contextUsagePercentage, 42)
  assert.equal(event.secretToken, undefined)
  assert.equal(event.meta, undefined)
})

test('normalizeStreamJsonLine: a metadata line with no valid percentage degrades to RAW', () => {
  const event = normalizeStreamJsonLine(JSON.stringify({ _meta: { secretToken: 'leak-me' } }))
  assert.equal(event.type, EVENT_TYPES.RAW)
  assert.equal(event.contextUsagePercentage, undefined)
})

test('normalizeStreamJsonLine: an out-of-range percentage is rejected', () => {
  const event = normalizeStreamJsonLine(JSON.stringify({ type: 'metadata', contextUsagePercentage: 250 }))
  assert.equal(event.type, EVENT_TYPES.RAW)
})

// --- Low: JSON-RPC id type tolerance ---

test('JsonRpcClient: a response echoing the id as a string still resolves', async () => {
  const sent = []
  const client = new JsonRpcClient({ write: (s) => sent.push(JSON.parse(s)) })
  const pending = client.request('initialize', {})
  const id = sent[0].id
  client.feed(`${JSON.stringify({ jsonrpc: '2.0', id: String(id), result: { ok: true } })}\n`)
  assert.deepEqual(await pending, { ok: true })
  assert.equal(client.pendingCount, 0)
})

// --- Low: deny must be enforced, not decorative ---

test('renderAgent: a denied tool present in trust is rejected', () => {
  assert.throws(
    () => renderAgent({ ...AGENT_DEFS.reviewer, trust: ['read', 'write'], deny: ['write'] }, 'short'),
    /trusts denied tool\(s\): write/,
  )
})

test('renderAgent: the shipped catalog satisfies its own deny lists', () => {
  for (const def of Object.values(AGENT_DEFS)) {
    for (const toolSet of ['short', 'prefixed']) {
      assert.doesNotThrow(() => renderAgent(def, toolSet), `${def.name}/${toolSet}`)
    }
  }
})

// --- Low: the usage log is bounded ---

test('pruneUsage: drops records past retention and enforces the record cap', () => {
  withTempHome(() => {
    const now = Date.UTC(2026, 0, 31)
    const day = 24 * 60 * 60 * 1000
    const rec = (daysAgo, command) => JSON.stringify({
      at: new Date(now - daysAgo * day).toISOString(), command,
    })
    const target = usagePath()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, [rec(90, 'old'), rec(1, 'fresh-a'), rec(0, 'fresh-b')].join('\n') + '\n')

    const removed = pruneUsage({ retentionDays: 30, now })
    assert.equal(removed, 1)
    const kept = readFileSync(target, 'utf8').trim().split('\n').map((l) => JSON.parse(l).command)
    assert.deepEqual(kept, ['fresh-a', 'fresh-b'])

    // The count cap drops the oldest survivors.
    assert.equal(pruneUsage({ retentionDays: 30, maxRecords: 1, now }), 1)
    const capped = readFileSync(target, 'utf8').trim().split('\n').map((l) => JSON.parse(l).command)
    assert.deepEqual(capped, ['fresh-b'])
  })
})

test('pruneUsage: a missing log is a no-op', () => {
  withTempHome(() => {
    assert.equal(pruneUsage(), 0)
  })
})

// --- transfer: hand a recorded session back to Kiro's own CLI ---

import { transfer, formatTransfer } from '../scripts/lib/transfer.mjs'
import { registerSession } from '../scripts/lib/sessions.mjs'

function seedRecord(cwd, overrides = {}) {
  return registerSession({
    sessionId: '98767b58-4f97-4262-aa62-457eed96cc94',
    agent: 'kiro-bridge-reviewer',
    source: { kind: 'review', command: 'review' },
    write: false,
    transport: 'acp',
    ...overrides,
  }, { cwd })
}

test('transfer: renders a kiro-cli resume command for the latest session', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-transfer-'))
    try {
      const rec = seedRecord(cwd)
      const out = transfer({ cwd })
      assert.equal(out.sessionId, '98767b58-4f97-4262-aa62-457eed96cc94')
      assert.equal(out.recordId, rec.recordId)
      assert.equal(out.command, 'kiro-cli chat --resume-id 98767b58-4f97-4262-aa62-457eed96cc94')
      const text = formatTransfer(out)
      assert.match(text, /kiro-cli chat --resume-id 98767b58/)
      assert.match(text, /read-only/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('transfer: resolves an explicit record id and a raw session id', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-transfer2-'))
    try {
      const rec = seedRecord(cwd)
      assert.equal(transfer({ selector: rec.recordId, cwd }).sessionId, rec.sessionId)
      assert.equal(transfer({ selector: rec.sessionId, cwd }).recordId, rec.recordId)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('transfer: a write-scoped session is not labelled read-only', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-transfer3-'))
    try {
      seedRecord(cwd, { agent: 'kiro-bridge-worker', write: true, source: { kind: 'task', command: 'task' } })
      assert.doesNotMatch(formatTransfer(transfer({ cwd })), /read-only/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('transfer: no matching session fails with a clear error', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-transfer4-'))
    try {
      assert.throws(() => transfer({ cwd }), (err) => {
        assert.equal(err.code, 'PROTOCOL')
        assert.match(err.details.reason, /no resumable ACP session found/)
        return true
      })
      seedRecord(cwd)
      // The reason rides in details.reason; bridge.mjs prints it under the
      // generic BridgeError message.
      assert.throws(() => transfer({ selector: 'nope', cwd }), (err) => {
        assert.match(err.details.reason, /no resumable ACP session matches "nope"/)
        return true
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// --- project-level config overlay (.kiro/settings/kiro-bridge.json) ---

import {
  loadConfig, loadUserConfig, saveConfig, applyProjectConfig,
  projectConfigPath, setCachedCapability, CONFIG_DEFAULTS,
} from '../scripts/lib/config.mjs'
import { collectDiff } from '../scripts/lib/git.mjs'

function writeProjectConfig(cwd, obj) {
  mkdirSync(join(cwd, '.kiro', 'settings'), { recursive: true })
  writeFileSync(projectConfigPath(cwd), JSON.stringify(obj))
}

test('project config: redaction patterns are added, defaults preserved', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-proj-'))
    try {
      writeProjectConfig(cwd, {
        redaction: { excludeFiles: ['secrets/**'], privateHosts: ['internal.example.com'] },
      })
      const merged = loadConfig(cwd)
      assert.ok(merged.redaction.excludeFiles.includes('secrets/**'))
      // Union, never replacement — a repo cannot drop a default protection.
      for (const def of CONFIG_DEFAULTS.redaction.excludeFiles) {
        assert.ok(merged.redaction.excludeFiles.includes(def), `lost default ${def}`)
      }
      assert.deepEqual(merged.redaction.privateHosts, ['internal.example.com'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('project config: weakening keys are ignored', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-proj2-'))
    try {
      writeProjectConfig(cwd, {
        redaction: { entropyThreshold: 99, minSecretLength: 9999, excludeFiles: [] },
        envPassthrough: ['AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY'],
        capabilities: { '9.9.9': { transport: 'acp' } },
      })
      const merged = loadConfig(cwd)
      assert.equal(merged.redaction.entropyThreshold, undefined)
      assert.equal(merged.redaction.minSecretLength, undefined)
      assert.deepEqual(merged.envPassthrough, [])
      assert.deepEqual(merged.capabilities, {})
      assert.ok(merged.redaction.excludeFiles.includes('.env'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('project config: a malformed or absent file is a no-op', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-proj3-'))
    try {
      assert.deepEqual(loadConfig(cwd).redaction.excludeFiles, CONFIG_DEFAULTS.redaction.excludeFiles)
      mkdirSync(join(cwd, '.kiro', 'settings'), { recursive: true })
      writeFileSync(projectConfigPath(cwd), 'not json{{')
      assert.deepEqual(loadConfig(cwd).redaction.excludeFiles, CONFIG_DEFAULTS.redaction.excludeFiles)
      writeFileSync(projectConfigPath(cwd), '["an","array"]')
      assert.deepEqual(loadConfig(cwd).redaction.excludeFiles, CONFIG_DEFAULTS.redaction.excludeFiles)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('project config: never promoted into the user-global config by a capability write', async () => {
  await withTempHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kb-proj4-'))
    const prevCwd = process.cwd()
    try {
      writeProjectConfig(cwd, { redaction: { excludeFiles: ['secrets/**'], privateHosts: ['internal.example.com'] } })
      process.chdir(cwd)
      // The capability cache round-trips through saveConfig; it must read the
      // user layer, not the merged view.
      saveConfig(setCachedCapability(loadUserConfig(), '1.2.3', { transport: 'acp' }))
      const persisted = loadUserConfig()
      assert.ok(!persisted.redaction.excludeFiles.includes('secrets/**'))
      assert.deepEqual(persisted.redaction.privateHosts, [])
      assert.equal(persisted.capabilities['1.2.3'].transport, 'acp')
    } finally {
      process.chdir(prevCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('applyProjectConfig: non-string entries are dropped', () => {
  const merged = applyProjectConfig(
    { redaction: { excludeFiles: ['.env'], privateHosts: [] } },
    { redaction: { excludeFiles: ['ok', 42, null, '', '  '], privateHosts: [{ bad: 1 }] } },
  )
  assert.deepEqual(merged.redaction.excludeFiles, ['.env', 'ok'])
  assert.deepEqual(merged.redaction.privateHosts, [])
})

// --- git: a repository with no commits has no HEAD to diff against ---

test('collectDiff: a fresh repo with no commits returns untracked files, not a git error', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'kb-fresh-'))
  try {
    const run = (args) => new Promise((res, rej) => {
      execFile('git', args, { cwd: repo }, (err) => (err ? rej(err) : res()))
    })
    await run(['init', '-q', '.'])
    writeFileSync(join(repo, 'brand-new.js'), 'export const a = 1\n')

    const out = await collectDiff({ cwd: repo, excludeFiles: [] })
    assert.equal(out.diff, '')
    assert.deepEqual(out.untracked, ['brand-new.js'])
    assert.deepEqual(out.files.map((f) => f.path), ['brand-new.js'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// --- --json envelopes ---

import { reviewJson, resultJson, errorJson, JSON_NOTICE } from '../scripts/lib/json-output.mjs'
import { bridgeError, CODES } from '../scripts/lib/errors.mjs'

test('json: a review envelope keeps the trust boundary explicit', () => {
  const env = reviewJson({
    ref: 'HEAD',
    adversarial: false,
    transport: 'acp',
    agent: 'kiro-bridge-reviewer',
    parsed: { ok: true, findings: [{ severity: 'high', file: 'a.js', line: 1, claim: 'c', evidence: 'e', suggestion: 's' }], summary: 'sum', dropped: 0 },
    wrapped: '<<<KIRO_EXTERNAL_DATA ...\n{}\nKIRO_EXTERNAL_DATA>>>',
    redactions: [],
    excludedFiles: [],
    untracked: [],
    sessionRecordId: null,
  })
  assert.equal(env.ok, true)
  assert.equal(env.command, 'review')
  // Agent-produced content must stay marked and must still carry the fence.
  assert.equal(env.external, true)
  assert.equal(env.notice, JSON_NOTICE)
  assert.match(env.wrapped, /KIRO_EXTERNAL_DATA/)
  assert.equal(env.findings.length, 1)
  assert.equal(env.parseOk, true)
})

test('json: a dry-run envelope is not marked external', () => {
  const env = reviewJson({ dryRun: true, ref: 'HEAD', adversarial: false, agent: 'a', payload: { kind: 'review' }, redactions: [], excludedFiles: [], untracked: [] })
  assert.equal(env.dryRun, true)
  assert.equal(env.external, false)
  assert.equal(env.findings, undefined)
})

test('json: a stored job body stays marked external', () => {
  const env = resultJson({ jobId: 'j', status: 'done', meta: { error: null }, body: 'wrapped body' })
  assert.equal(env.external, true)
  assert.equal(env.body, 'wrapped body')
})

test('json: failures use the same envelope with ok:false', () => {
  const env = errorJson('review', bridgeError(CODES.TOOL_DENIED, { reason: 'nope' }))
  assert.equal(env.ok, false)
  assert.equal(env.command, 'review')
  assert.equal(env.error.code, 'TOOL_DENIED')
  assert.equal(env.error.reason, 'nope')
})

test('json: every envelope is serializable and round-trips', () => {
  const env = resultJson({ empty: true, message: 'No jobs in this repository.' })
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env)
})
