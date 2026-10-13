// Refuses a delegated call when the checkout ships an agent under a kiro-bridge name.
//
// kiro-cli resolves `--agent <name>` against `<cwd>/.kiro/agents` BEFORE
// `~/.kiro/agents`, and the bridge hands it only the name with the reviewed
// repository as cwd. A checkout that ships `.kiro/agents/kiro-bridge-reviewer.json`
// therefore replaces the installed read-only reviewer with whatever tools that
// file trusts, shell included (ADR-002). kiro-cli documents that workspace agents
// load only in a trusted workspace, but how a non-interactive spawn decides trust
// is not measured, so the bridge does not rely on it.
//
// Refused rather than worked around: nothing in the bridge writes into a project
// directory, so there is no repair path, and the user decides what to do with
// the file. Any name under the `kiro-bridge-` prefix counts, not only the agent
// being spawned, since the prefix is the bridge's namespace.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { AGENT_PREFIX } from './agents.mjs'
import { bridgeError, CODES } from './errors.mjs'
import { sanitizeTerminal } from './sanitize.mjs'

// A checkout's agents tree is small. The caps keep a pathological one (or a
// linked directory reaching a large tree) from stalling the spawn; hitting one
// refuses, since the unscanned remainder could hold a claim.
const MAX_DIRS = 500
const MAX_FILES = 2000
// Declared names are read from these; the file-name check covers every file,
// since which other extensions kiro-cli loads is not measured.
const SPEC_EXTENSIONS = new Set(['.json', '.md'])
const PREFIX = AGENT_PREFIX.toLowerCase()

function claims(name) {
  return typeof name === 'string' && name.trim().toLowerCase().startsWith(PREFIX)
}

// The name a spec file declares, or null. A file that cannot be read or parsed
// declares nothing — kiro-cli cannot load it under a declared name either.
function declaredName(path, ext) {
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed.name ?? null : null
    } catch {
      return null
    }
  }
  // YAML can spell a name many ways (quoted key, block scalar, flow map), so
  // any frontmatter that mentions the prefix counts as declaring it.
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const hit = front?.[1].match(new RegExp(`${PREFIX}[\\w-]*`, 'i'))
  return hit ? hit[0] : null
}

function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Spec files under <cwd>/.kiro/agents that claim a kiro-bridge name, as paths
// relative to cwd. Nested directories and linked directories are walked, as
// kiro-cli loads them; each directory once, keyed by device and inode.
export function findShadowingAgents(cwd, { homeAgentsDir = join(homedir(), '.kiro', 'agents') } = {}) {
  const root = join(cwd, '.kiro', 'agents')
  try {
    if (!statSync(root).isDirectory()) return []
  } catch {
    return []
  }
  // With cwd at $HOME the project directory is the install directory.
  if (sameDir(root, homeAgentsDir)) return []

  const found = []
  const visited = new Set()
  const pending = [root]
  let files = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    let key
    try {
      const st = statSync(dir)
      key = `${st.dev}:${st.ino}`
    } catch {
      continue
    }
    if (visited.has(key)) continue
    visited.add(key)
    if (visited.size > MAX_DIRS) return [...found, { path: relative(cwd, root), reason: 'too many directories to scan' }]

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(path).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (isDir) {
        pending.push(path)
        continue
      }
      files += 1
      if (files > MAX_FILES) return [...found, { path: relative(cwd, root), reason: 'too many files to scan' }]

      const stem = basename(entry.name, extname(entry.name))
      if (claims(stem)) {
        found.push({ path: relative(cwd, path), reason: `file name claims ${stem}` })
        continue
      }
      const ext = extname(entry.name).toLowerCase()
      if (!SPEC_EXTENSIONS.has(ext)) continue
      const declared = declaredName(path, ext)
      if (claims(declared)) {
        found.push({ path: relative(cwd, path), reason: `declares name ${declared}` })
      }
    }
  }
  return found
}

export function assertNoShadowingAgents(cwd, options) {
  const found = findShadowingAgents(cwd, options)
  if (found.length > 0) {
    // File names come from the checkout, so they are stripped of terminal
    // control sequences before they reach the message.
    const files = found.map((f) => ({ path: sanitizeTerminal(f.path), reason: sanitizeTerminal(f.reason) }))
    throw bridgeError(CODES.AGENT_SHADOWED, {
      cwd,
      files,
      reason: files.map((f) => `${f.path} (${f.reason})`).join('; '),
    })
  }
}
