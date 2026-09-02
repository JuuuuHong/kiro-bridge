// Collects git diffs. The input source for review context.
//
// Principle: use only execFile, never assemble a shell string (design §3). ref
// is user input, so it must only be passed as an argument array — `--` also blocks option injection.
import { execFile } from 'node:child_process'
import { bridgeError, CODES } from './errors.mjs'
import { isExcludedPath } from './context.mjs'

const MAX_BUFFER = 64 * 1024 * 1024

function run(args, { cwd, execFileFn = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileFn('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }))
      resolve(String(stdout))
    })
  })
}

export async function isGitRepo(options = {}) {
  try {
    const out = await run(['rev-parse', '--is-inside-work-tree'], options)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

// Confirm the ref actually exists first, so a typo comes back as a clear
// error rather than a diff failure.
export async function resolveRef(ref, options = {}) {
  if (!ref) return null
  try {
    await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options)
    return ref
  } catch {
    throw bridgeError(CODES.PROTOCOL, { reason: `unknown git ref: ${ref}` })
  }
}

function diffArgs(ref, nameOnly, paths = null) {
  const base = ['diff']
  if (nameOnly) base.push('--name-only')
  // Compare against ref if given, otherwise against HEAD (staged + unstaged).
  base.push(ref || 'HEAD')
  base.push('--')
  // Use literal pathspecs so a repository path beginning with ':' cannot be
  // interpreted as pathspec magic. An empty path list is handled by the caller.
  if (paths) base.push(...paths.map((path) => `:(literal)${path}`))
  return base
}

// New files that haven't been added yet. These never show up in `git diff`,
// so without collecting them separately, a review of "only new files created" would silently come back empty.
// .gitignore is respected (--exclude-standard).
export async function listUntracked(options = {}) {
  try {
    const out = await run(['ls-files', '--others', '--exclude-standard'], options)
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// Collects the diff under review and the list of changed files.
// The file list becomes input to payload.files, and no excerpt is attached —
// it's better for Kiro to read it itself via read/grep (ADR-003 decision 5).
// Untracked files pass only their path for the same reason, no content.
// A repository with no commits has no HEAD, so every `git diff HEAD` fails with
// a raw exit-128 error. That is a normal state for a fresh repo whose files are
// all untracked — exactly the "only new files created" case reviews must still
// handle — so detect it and fall through to the untracked-only path.
async function headExists(options = {}) {
  try {
    await run(['rev-parse', '--verify', '--quiet', 'HEAD'], options)
    return true
  } catch {
    return false
  }
}

export async function collectDiff(options = {}) {
  const { ref = null, excludeFiles = [] } = options

  if (!(await isGitRepo(options))) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'not a git repository' })
  }
  await resolveRef(ref, options)

  // Without an explicit ref, comparing requires a HEAD to compare against.
  const hasBase = ref ? true : await headExists(options)

  // Resolve names before content so excluded paths never enter the outbound
  // diff buffer at all. The full file list is retained for the exclusion audit.
  const [nameOnly, untracked] = await Promise.all([
    hasBase ? run(diffArgs(ref, true), options) : Promise.resolve(''),
    // If ref was given, this is a comparison against that point, so working-tree state is not mixed in.
    ref ? Promise.resolve([]) : listUntracked(options),
  ])

  const tracked = nameOnly
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const allowedTracked = tracked.filter((path) => !isExcludedPath(path, excludeFiles))
  const allowedUntracked = untracked.filter((path) => !isExcludedPath(path, excludeFiles))
  const excludedFiles = [...tracked, ...untracked]
    .filter((path) => isExcludedPath(path, excludeFiles))
  const diff = allowedTracked.length > 0
    ? await run(diffArgs(ref, false, allowedTracked), options)
    : ''

  const files = allowedTracked.map((path) => ({ path, reason: 'changed in diff' }))

  for (const path of allowedUntracked) {
    files.push({ path, reason: 'untracked new file — not in diff, read it directly to review' })
  }

  return { diff, files, excludedFiles, untracked: allowedUntracked, ref: ref || 'HEAD' }
}

export async function currentBranch(options = {}) {
  try {
    return (await run(['rev-parse', '--abbrev-ref', 'HEAD'], options)).trim()
  } catch {
    return null
  }
}
