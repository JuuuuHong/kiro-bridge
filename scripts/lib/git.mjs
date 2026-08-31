// git diff 수집. 리뷰 컨텍스트의 입력원이다.
//
// 원칙: execFile 만 쓰고 셸 문자열은 조립하지 않는다 (설계 §3). ref 는
// 사용자 입력이므로 인자 배열로만 넘어가야 한다 — `--` 로 옵션 주입도 막는다.
import { execFile } from 'node:child_process'
import { bridgeError, CODES } from './errors.mjs'

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

// ref 가 실제로 존재하는지 먼저 확인한다. 오타를 diff 실패가 아니라
// 명확한 오류로 돌려주기 위해서다.
export async function resolveRef(ref, options = {}) {
  if (!ref) return null
  try {
    await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options)
    return ref
  } catch {
    throw bridgeError(CODES.PROTOCOL, { reason: `unknown git ref: ${ref}` })
  }
}

function diffArgs(ref, nameOnly) {
  const base = ['diff']
  if (nameOnly) base.push('--name-only')
  // ref 가 있으면 그 지점과 비교, 없으면 HEAD 대비 (staged + unstaged).
  base.push(ref || 'HEAD')
  base.push('--')
  return base
}

// 아직 add 되지 않은 새 파일. `git diff` 에는 절대 나타나지 않으므로
// 따로 모으지 않으면 "새 파일만 만든 상태"의 리뷰가 조용히 빈손이 된다.
// .gitignore 는 존중한다 (--exclude-standard).
export async function listUntracked(options = {}) {
  try {
    const out = await run(['ls-files', '--others', '--exclude-standard'], options)
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// 리뷰 대상 diff 와 변경 파일 목록을 모은다.
// 파일 목록은 payload.files 의 입력이 되며, excerpt 는 붙이지 않는다 —
// Kiro 가 read/grep 으로 스스로 읽는 편이 낫다 (ADR-003 결정 5).
// untracked 파일도 같은 이유로 내용을 싣지 않고 경로만 넘긴다.
export async function collectDiff(options = {}) {
  const { ref = null } = options

  if (!(await isGitRepo(options))) {
    throw bridgeError(CODES.PROTOCOL, { reason: 'not a git repository' })
  }
  await resolveRef(ref, options)

  const [diff, nameOnly, untracked] = await Promise.all([
    run(diffArgs(ref, false), options),
    run(diffArgs(ref, true), options),
    // ref 를 명시했으면 그 지점과의 비교이므로 작업물 상태는 섞지 않는다.
    ref ? Promise.resolve([]) : listUntracked(options),
  ])

  const files = nameOnly
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ path, reason: 'changed in diff' }))

  for (const path of untracked) {
    files.push({ path, reason: 'untracked new file — diff 에 없으니 직접 읽어 리뷰할 것' })
  }

  return { diff, files, untracked, ref: ref || 'HEAD' }
}

export async function currentBranch(options = {}) {
  try {
    return (await run(['rev-parse', '--abbrev-ref', 'HEAD'], options)).trim()
  } catch {
    return null
  }
}
