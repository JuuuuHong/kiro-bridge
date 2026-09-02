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
