// Kiro custom agent definitions — single source of truth for the permission spec (ADR-002, design §6).
//
// The canonical tool names are unresolved: the `--trust-tools` help example uses
// `fs_read,fs_write`, but the built-in list in the session/new response is
// `read, write, grep...` (OQ4). Rather than picking one, we probe both at
// install time with `agent validate` and let whichever passes win — the
// ambiguity resolves itself at runtime instead of being hardcoded.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'

export const AGENT_PREFIX = 'kiro-bridge-'
export const AGENT_VERSION = '0.1.0'

// Candidate naming conventions. Order is try order.
// Web/AWS tool names were unchanged across both generations, so they're the same in both.
export const TOOL_NAME_SETS = {
  short: {
    read: 'read', grep: 'grep', glob: 'glob', write: 'write', shell: 'shell',
    web_search: 'web_search', web_fetch: 'web_fetch', use_aws: 'use_aws',
  },
  prefixed: {
    read: 'fs_read', grep: 'grep', glob: 'glob', write: 'fs_write', shell: 'execute_bash',
    web_search: 'web_search', web_fetch: 'web_fetch', use_aws: 'use_aws',
  },
}

const REVIEWER_PROMPT = [
  'You are a code-review-only agent. Read the JSON payload from stdin and review it.',
  '',
  'Rules:',
  '- Only claim what you confirmed by reading the file directly. If you could not read it, say so in summary.',
  '- Do not modify files. The write tool is not trusted.',
  '- Output only the JSON schema below as your response. Do not add prose explanation.',
  '',
  '{"findings":[{"severity":"low|medium|high","file":"path","line":0,',
  '"claim":"one-sentence defect statement","evidence":"evidence","suggestion":"fix direction"}],',
  '"summary":"overall assessment"}',
].join('\n')

const RESEARCHER_PROMPT = [
  'You are an investigation/debugging-only agent. Perform the goal from the JSON payload received on stdin.',
  '',
  'Rules:',
  '- Only claim what you confirmed by reading files and the web. If it is a guess, say it is a guess.',
  '- Do not modify files. The write tool is not trusted.',
  '- When citing web search results, include the source URL.',
  '- Report in the order: conclusion -> evidence -> how to verify.',
].join('\n')

const WORKER_PROMPT = [
  'You are a delegated-task execution agent. Perform the goal from the JSON payload received on stdin.',
  '',
  'Rules:',
  '- Never touch the no-modify areas listed in constraints.',
  '- The shell execution tool is not trusted. Work only through file read/write.',
  '- After the work, report what changed and how, per file.',
].join('\n')

const SPEC_WRITER_PROMPT = [
  'You are a spec-writing-only agent. Refine the goal from the JSON payload received on stdin',
  'into EARS-notation requirements and an architecture design.',
  '',
  'Rules:',
  '- Save output as `.kiro/specs/<feature-slug>/requirements.md` and `design.md`.',
  '  Do not write any file to any other path.',
  '- Write requirements in the EARS pattern (WHEN/WHILE/WHERE/IF ... THE SYSTEM SHALL ...).',
  '- Read the existing code and do not create requirements that contradict the current structure.',
  '- Report the list of saved file paths at the end.',
].join('\n')

const AWS_ADVISOR_PROMPT = [
  'You are an AWS infrastructure-advisory-only agent. Read the JSON payload from stdin and answer.',
  '',
  'Rules:',
  '- use_aws may only use query (read-only) operations. Create/update/delete calls are forbidden.',
  '- Read the infrastructure code (CDK/Terraform/IAM) and cross-check it against actual resource state.',
  '- State cost/security impact explicitly for any suggestion that has one.',
].join('\n')

// Definitions are written independently of tool names; the naming convention is injected at render time.
export const AGENT_DEFS = {
  reviewer: {
    name: `${AGENT_PREFIX}reviewer`,
    description: 'Read-only code reviewer that returns structured findings JSON.',
    prompt: REVIEWER_PROMPT,
    // Only pre-trust the read family explicitly. Write/execute are untrusted (ADR-002).
    trust: ['read', 'grep', 'glob'],
    deny: ['write', 'shell'],
  },
  researcher: {
    name: `${AGENT_PREFIX}researcher`,
    description: 'Read-only researcher with web access for investigation and debugging.',
    prompt: RESEARCHER_PROMPT,
    trust: ['read', 'grep', 'glob', 'web_search', 'web_fetch'],
    deny: ['write', 'shell'],
    // Web-derived content may be mixed in, so add an extra warning when wrapping (ADR-004).
    webDerived: true,
  },
  worker: {
    name: `${AGENT_PREFIX}worker`,
    description: 'Delegated task executor that may write files but never runs shell.',
    prompt: WORKER_PROMPT,
    // For task --write only. Trust extends to write, but shell is never trusted (ADR-002 decision 4).
    trust: ['read', 'grep', 'glob', 'write'],
    deny: ['shell'],
  },
  specWriter: {
    name: `${AGENT_PREFIX}spec-writer`,
    description: 'Writes EARS requirements and design docs under .kiro/specs/ only.',
    prompt: SPEC_WRITER_PROMPT,
    trust: ['read', 'grep', 'glob', 'write'],
    deny: ['shell'],
    // Path scoping is doubled up: prompt + this hint. Even if the Kiro schema
    // ignores this key, the prompt constraint still holds (design §6, tool schema unresolved).
    allowedPaths: ['.kiro/specs/**'],
  },
  awsAdvisor: {
    name: `${AGENT_PREFIX}aws-advisor`,
    description: 'Read-only AWS infrastructure advisor (query operations only).',
    prompt: AWS_ADVISOR_PROMPT,
    trust: ['read', 'grep', 'glob', 'use_aws'],
    deny: ['write', 'shell'],
  },
}

export function renderAgent(def, toolSet) {
  const names = TOOL_NAME_SETS[toolSet]
  if (!names) throw new Error(`unknown tool name set: ${toolSet}`)
  const rendered = {
    name: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.trust.map((t) => names[t]),
    allowedTools: def.trust.map((t) => names[t]),
    toolAliases: {},
    _kiroBridge: { version: AGENT_VERSION, toolSet },
  }
  if (def.allowedPaths) rendered.allowedPaths = def.allowedPaths
  return rendered
}

// Hash of the body excluding the stamp. Used to detect whether the user has edited the file.
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

// Probes which naming convention actually passes (OQ4 resolution path).
// Resolves once validateFn(path) passes; if all fail, returns with the last error attempt recorded.
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

// Install. A file the user has modified is not overwritten, only warned about (design §6).
export function installAgent(rendered, { dir = agentsDir(), force = false } = {}) {
  const target = join(dir, `${rendered.name}.json`)
  const existed = existsSync(target)

  if (existed && !force) {
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
      return { target, action: 'skipped', reason: 'user-modified — not overwritten' }
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
  return { target, action: existed ? 'updated' : 'installed' }
}
