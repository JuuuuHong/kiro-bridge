// /kiro:review 플로우. git diff → 페이로드 → transport → findings → 래핑.
//
// 이 파일은 조립만 한다. redaction 은 context.mjs, 신뢰 경계는 findings.mjs,
// 실패 분류는 errors.mjs 가 각각 책임진다.
import { collectDiff } from './git.mjs'
import { buildPayload } from './context.mjs'
import { parseResponse, wrapForClaude } from './findings.mjs'
import { loadConfig } from './config.mjs'
import * as transport from './transport/index.mjs'
import { AGENT_PREFIX } from './agents.mjs'

export const DEFAULT_TIMEOUT_MS = 180_000 // 설계 §8 실패 모드 표

const DEFAULT_CONSTRAINTS = [
  '파일을 수정하지 말 것 — 리뷰만 한다.',
  '읽어서 확인하지 못한 내용은 주장하지 말 것.',
]

export async function review(options = {}) {
  const {
    cwd = process.cwd(),
    ref = null,
    goal = '이 diff 를 리뷰하고 결함을 findings JSON 으로 보고하라.',
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    onPermissionRequest,
    signal,
    runFn = transport.run,
    collectDiffFn = collectDiff,
    config = loadConfig(),
  } = options

  const { diff, files, untracked = [], ref: usedRef } = await collectDiffFn({ cwd, ref })

  // untracked 만 있는 경우도 리뷰 대상이다 — diff 가 비었다고 빈손으로 끝내면
  // "새 파일만 만든 상태"에서 조용히 아무것도 리뷰하지 않는다.
  if (!diff.trim() && files.length === 0) {
    return { empty: true, ref: usedRef, message: `${usedRef} 대비 변경 사항이 없습니다.` }
  }

  const { payload, redactions, excludedFiles } = buildPayload(
    { kind: 'review', goal, diff, files, constraints: DEFAULT_CONSTRAINTS },
    { redaction: config.redaction },
  )

  // 전송 직전 페이로드를 사람이 확인하는 경로 (설계 §7).
  if (dryRun) {
    return { dryRun: true, payload, redactions, excludedFiles, untracked, ref: usedRef }
  }

  const agent = `${AGENT_PREFIX}reviewer`
  const res = await runFn(payload, {
    cwd,
    agent,
    timeoutMs,
    onEvent,
    onPermissionRequest,
    signal,
  })

  const parsed = parseResponse(res.result)

  return {
    ref: usedRef,
    untracked,
    transport: res.transport,
    sessionId: res.sessionId,
    parsed,
    // Claude 컨텍스트에 넣을 최종 문자열. 항상 신뢰 경계로 감싸여 있다 (ADR-004).
    wrapped: wrapForClaude(parsed, { agent }),
    redactions,
    excludedFiles,
    metadata: res.metadata,
  }
}

// 사람이 읽는 요약. 자동 적용 경로는 만들지 않는다 (ADR-004 결정 1).
export function formatSummary(result) {
  if (result.empty) return result.message
  if (result.dryRun) {
    const lines = [
      `[dry-run] ${result.ref} 대비 페이로드 (전송하지 않음)`,
      JSON.stringify(result.payload, null, 2),
    ]
    if (result.redactions.length > 0) {
      lines.push('', `가려진 항목: ${result.redactions.map((r) => `${r.where}:${r.kind}×${r.count}`).join(', ')}`)
    }
    if (result.excludedFiles.length > 0) {
      lines.push(`제외된 파일: ${result.excludedFiles.join(', ')}`)
    }
    if (result.untracked?.length > 0) {
      lines.push(`untracked(경로만 전달): ${result.untracked.join(', ')}`)
    }
    return lines.join('\n')
  }

  const head = [`transport: ${result.transport}`, `ref: ${result.ref}`]
  if (result.redactions.length > 0) {
    head.push(`redaction: ${result.redactions.length}건`)
  }
  if (result.excludedFiles.length > 0) {
    head.push(`제외 파일: ${result.excludedFiles.length}개`)
  }
  if (result.untracked?.length > 0) {
    head.push(`untracked ${result.untracked.length}개`)
  }
  if (!result.parsed.ok) {
    head.push('구조화 실패 — 원문 첨부')
  } else {
    const bySeverity = { high: 0, medium: 0, low: 0 }
    for (const f of result.parsed.findings) bySeverity[f.severity] += 1
    head.push(`findings: high ${bySeverity.high} / medium ${bySeverity.medium} / low ${bySeverity.low}`)
  }
  return `${head.join(' | ')}\n\n${result.wrapped}`
}
