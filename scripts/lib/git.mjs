// Collects git diffs. The input source for review context.
//
// Principle: use only execFile, never assemble a shell string (design §3). ref
// is user input, so it must only be passed as an argument array — `--` also blocks option injection.
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { resolve as resolvePath, relative, isAbsolute } from 'node:path'
import { bridgeError, CODES } from './errors.mjs'
import { isExcludedPath } from './context.mjs'

const MAX_BUFFER = 64 * 1024 * 1024

function run(args, { cwd, execFileFn = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileFn('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        // A diff larger than the buffer arrives as a bare ENOBUFS, which would
        // surface as an unclassified stack trace. Name it instead: the fix is
        // to review a narrower ref, not to retry.
        if (err.code === 'ENOBUFS') {
          return reject(bridgeError(CODES.PROTOCOL, {
            reason: `git output exceeded ${MAX_BUFFER / (1024 * 1024)}MB — review a narrower ref or a subset of the change`,
          }))
        }
        return reject(Object.assign(err, { stderr: String(stderr || '') }))
      }
      resolve(String(stdout))
    })
  })
}

// Why a symlink needs its own check: the exclusion list promises that certain
// files never leave the machine, but it matches on the path git reports. A link
// named `notes.md` pointing at `secrets/real.pem` passes that check, and the
// payload then tells Kiro to read the path directly — its read tool follows the
// link and the excluded file goes out anyway.
//
// So a symlink is judged by where it actually points: excluded if the target is
// excluded, and excluded if the target leaves the repository at all, since a
// review has no business reading outside the tree it was asked to review.
// Returns a reason string when the path must not be handed over, else null.
export function symlinkExclusionReason(path, { cwd = process.cwd(), excludeFiles = [] } = {}) {
  const absolute = resolvePath(cwd, path)
  let stat
  try {
    stat = lstatSync(absolute)
  } catch {
    return null // vanished between listing and inspection; nothing to hand over
  }
  if (!stat.isSymbolicLink()) return null

  let target
  let root
  try {
    target = realpathSync(absolute)
    root = realpathSync(cwd)
  } catch {
    return 'symlink target could not be resolved'
  }

  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return 'symlink points outside the repository'
  }
  if (isExcludedPath(rel, excludeFiles)) {
    return 'symlink target is an excluded file'
  }
  return null
}

// A ref argument may be a single commit-ish or a diff range. `..` cannot appear
// inside a valid git ref name, so its presence unambiguously marks a range —
// `A..B` diffs the endpoints, `A...B` diffs against their merge base, and an
// omitted side means HEAD, exactly as git reads them. An empty spec keeps the
// historical meaning: the given point (or HEAD) against the working tree.
const RANGE_RE = /^(.*?)(\.{2,3})(.*)$/

export function parseRefSpec(ref) {
  if (!ref) return null
  const match = RANGE_RE.exec(ref)
  if (!match) return { kind: 'point', spec: ref, endpoints: [ref] }
  const [, left, , right] = match
  return { kind: 'range', spec: ref, endpoints: [left || 'HEAD', right || 'HEAD'] }
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
// Every endpoint is verified before the spec reaches `git diff`. The spec is
// then passed through verbatim — it is still only ever one element of an argv
// array, so there is nothing to inject into, and `--` continues to separate it
// from pathspecs.
export async function resolveRef(ref, options = {}) {
  const parsed = parseRefSpec(ref)
  if (!parsed) return null
  for (const endpoint of parsed.endpoints) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `${endpoint}^{commit}`], options)
    } catch {
      throw bridgeError(CODES.PROTOCOL, {
        reason: parsed.kind === 'range'
          ? `unknown git ref in range ${ref}: ${endpoint}`
          : `unknown git ref: ${ref}`,
      })
    }
  }
  return parsed
}

// Split a NUL-delimited git path list. `-z` output is the only form that is
// safe to parse: the newline-delimited default C-quotes any path that is not
// plain ASCII (core.quotePath, on by default), so a path like `인증서.pem`
// arrives as the literal 25-character string `"\354\235\270...pem"`. That
// string matches no file on disk and no `*.pem` exclude pattern — the file
// silently drops out of the diff *and* out of the exclusion audit. NUL
// delimiting also removes any ambiguity for paths containing newlines.
function splitZ(out) {
  return String(out).split('\0').filter((path) => path !== '')
}

function diffArgs(spec, { nameOnly = false, staged = false, paths = null } = {}) {
  const base = ['diff']
  // -z implies raw (unquoted) paths, so it must accompany every --name-only read.
  if (nameOnly) base.push('--name-only', '-z')
  // --cached narrows the comparison to the index. Without it the comparison
  // reaches the working tree, which is why untracked files are collected only
  // in that case.
  if (staged) base.push('--cached')
  // A verified spec passes through verbatim: `A..B` and `A...B` are git diff
  // syntax, and it remains one element of an argv array either way.
  if (spec) base.push(spec.spec)
  // Bare `git diff --cached` already means index-vs-HEAD. Naming HEAD here
  // would be redundant, and wrong in a repository that has no HEAD yet.
  else if (!staged) base.push('HEAD')
  base.push('--')
  // Use literal pathspecs so a repository path beginning with ':' cannot be
  // interpreted as pathspec magic. An empty path list is handled by the caller.
  if (paths) base.push(...paths.map((path) => `:(literal)${path}`))
  return base
}

// New files that haven't been added yet. These never show up in `git diff`,
// so without collecting them separately, a review of "only new files created" would silently come back empty.
// .gitignore is respected (--exclude-standard). -z for the same reason as diffArgs.
export async function listUntracked(options = {}) {
  try {
    const out = await run(['ls-files', '--others', '--exclude-standard', '-z'], options)
    return splitZ(out)
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
  const { ref = null, excludeFiles = [], staged = false } = options

  if (!(await isGitRepo(options))) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'not a git repository' })
  }
  const spec = await resolveRef(ref, options)

  // `git diff --cached A..B` is not a thing: --cached compares the index to one
  // commit, so a range leaves nothing for the index to be. Reject it rather
  // than let git emit a less obvious error.
  if (staged && spec?.kind === 'range') {
    throw bridgeError(CODES.PROTOCOL, {
      reason: `--staged compares the index to a single commit, so it cannot take the range ${ref}`,
    })
  }

  // The working tree is only in scope for the default comparison. A range
  // compares two recorded points, and --staged compares the index — in neither
  // case would an untracked file belong in the result.
  const worktreeInScope = !spec && !staged

  // Comparing needs something to compare against. An explicit spec has already
  // been verified, and `git diff --cached` is well defined even before the
  // first commit, so only the default path has to look for HEAD.
  const hasBase = spec || staged ? true : await headExists(options)

  // Resolve names before content so excluded paths never enter the outbound
  // diff buffer at all. The full file list is retained for the exclusion audit.
  const [nameOnly, untracked] = await Promise.all([
    hasBase ? run(diffArgs(spec, { nameOnly: true, staged }), options) : Promise.resolve(''),
    worktreeInScope ? listUntracked(options) : Promise.resolve([]),
  ])

  const tracked = splitZ(nameOnly)
  // A path is withheld either because its own name matches an exclude pattern,
  // or because it is a symlink whose target is excluded / outside the repo.
  const cwd = options.cwd ?? process.cwd()
  const isWithheld = (path) => isExcludedPath(path, excludeFiles)
    || symlinkExclusionReason(path, { cwd, excludeFiles }) !== null
  const allowedTracked = tracked.filter((path) => !isWithheld(path))
  const allowedUntracked = untracked.filter((path) => !isWithheld(path))
  const excludedFiles = [...tracked, ...untracked].filter(isWithheld)
  const diff = allowedTracked.length > 0
    ? await run(diffArgs(spec, { staged, paths: allowedTracked }), options)
    : ''

  const files = allowedTracked.map((path) => ({ path, reason: 'changed in diff' }))

  for (const path of allowedUntracked) {
    files.push({ path, reason: 'untracked new file — not in diff, read it directly to review' })
  }

  // A label for humans and for the result envelope, not a ref to resolve again.
  const label = spec ? spec.spec : (staged ? 'the index (staged)' : 'HEAD')
  return { diff, files, excludedFiles, untracked: allowedUntracked, ref: label, staged }
}

export async function currentBranch(options = {}) {
  try {
    return (await run(['rev-parse', '--abbrev-ref', 'HEAD'], options)).trim()
  } catch {
    return null
  }
}
