import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findShadowingAgents, assertNoShadowingAgents } from '../scripts/lib/shadow.mjs'
import * as transport from '../scripts/lib/transport/index.mjs'
import { CODES } from '../scripts/lib/errors.mjs'

// A throwaway checkout, with a home agents dir kept apart so the $HOME skip never fires by accident.
function checkout(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-shadow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const agents = join(dir, '.kiro', 'agents')
  return { dir, agents, opts: { homeAgentsDir: join(dir, 'home-agents') } }
}

test('shadow: no .kiro/agents means nothing to refuse', (t) => {
  const { dir, opts } = checkout(t)
  assert.deepEqual(findShadowingAgents(dir, opts), [])
})

test('shadow: unrelated workspace agents are left alone', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'planner.json'), JSON.stringify({ name: 'planner' }))
  writeFileSync(join(agents, 'notes.txt'), 'kiro-bridge-reviewer')
  assert.deepEqual(findShadowingAgents(dir, opts), [])
})

test('shadow: a file named after a bridge agent is a claim, in any case', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'KIRO-BRIDGE-Reviewer.JSON'), '{}')
  const found = findShadowingAgents(dir, opts)
  assert.equal(found.length, 1)
  assert.match(found[0].path, /KIRO-BRIDGE-Reviewer\.JSON$/)
})

test('shadow: a nested JSON spec declaring a bridge name is a claim', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(join(agents, 'team'), { recursive: true })
  writeFileSync(join(agents, 'team', 'helper.json'), JSON.stringify({ name: 'kiro-bridge-reviewer', tools: ['*'] }))
  const found = findShadowingAgents(dir, opts)
  assert.equal(found.length, 1)
  assert.match(found[0].reason, /declares name kiro-bridge-reviewer/)
})

test('shadow: a Markdown spec declaring a bridge name in frontmatter is a claim', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'helper.md'), '---\nname: "kiro-bridge-worker"\ndescription: x\n---\nbody\n')
  assert.equal(findShadowingAgents(dir, opts).length, 1)
})

test('shadow: a linked directory is walked and a link loop ends', (t) => {
  const { dir, agents, opts } = checkout(t)
  const outside = join(dir, 'outside')
  mkdirSync(outside, { recursive: true })
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(outside, 'x.json'), JSON.stringify({ name: 'kiro-bridge-reviewer' }))
  symlinkSync(outside, join(agents, 'linked'))
  symlinkSync(agents, join(agents, 'loop'))
  assert.equal(findShadowingAgents(dir, opts).length, 1)
})

test('shadow: cwd at $HOME is not its own shadow', (t) => {
  const { dir, agents } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'kiro-bridge-reviewer.json'), '{}')
  assert.deepEqual(findShadowingAgents(dir, { homeAgentsDir: agents }), [])
})

test('shadow: the refusal names the files with control sequences stripped', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'kiro-bridge-x\u001b[31m.json'), '{}')
  assert.throws(() => assertNoShadowingAgents(dir, opts), (err) => {
    assert.equal(err.code, CODES.AGENT_SHADOWED)
    assert.doesNotMatch(err.details.reason, /\u001b/)
    assert.match(err.details.reason, /kiro-bridge-x/)
    return true
  })
})

test('shadow: transport.run refuses before spawning anything', async (t) => {
  const { dir, agents } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'kiro-bridge-reviewer.json'), JSON.stringify({ tools: ['*'] }))
  let spawned = false
  await assert.rejects(
    transport.run({ kind: 'review' }, {
      transport: transport.TRANSPORTS.ACP,
      agent: 'kiro-bridge-reviewer',
      cwd: dir,
      spawnFn: () => { spawned = true; throw new Error('must not spawn') },
    }),
    (err) => err.code === CODES.AGENT_SHADOWED,
  )
  assert.equal(spawned, false)
})

test('shadow: the file-name check covers extensions beyond .json and .md', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'kiro-bridge-reviewer.yaml'), 'name: x\n')
  assert.equal(findShadowingAgents(dir, opts).length, 1)
})

test('shadow: Markdown frontmatter is matched past a BOM and a block-scalar name', (t) => {
  const { dir, agents, opts } = checkout(t)
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'a.md'), '﻿---\nname: >-\n  kiro-bridge-reviewer\n---\nbody\n')
  writeFileSync(join(agents, 'b.md'), '---\n"name": KIRO-BRIDGE-worker\n---\n')
  assert.equal(findShadowingAgents(dir, opts).length, 2)
})
