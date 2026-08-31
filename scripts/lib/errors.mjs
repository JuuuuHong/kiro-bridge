// 실패 모드 (설계 §8). 표의 각 행이 여기 코드 하나에 대응한다.
//
// 재시도는 어느 경로에서도 하지 않는다 — 크레딧을 쓰는 호출이라 조용한
// 재시도는 비용을 배로 만든다. 실패는 분류해서 사용자에게 그대로 보인다.

export const CODES = {
  TIMEOUT: 'TIMEOUT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  THROTTLED: 'THROTTLED',
  TOOL_DENIED: 'TOOL_DENIED',
  TRANSPORT_UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
  CANCELLED: 'CANCELLED',
  PROTOCOL: 'PROTOCOL',
  SPAWN_FAILED: 'SPAWN_FAILED',
}

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

// 미신뢰 툴 호출은 non-interactive 에서 묻지 않고 자동 거부되며 대화는
// 계속된다 (설계 §8, ADR-002). 이 문자열을 놓치면 "파일을 못 읽고 만든
// 그럴듯한 findings" 를 성공으로 오인한다.
const DENIAL_PATTERNS = [
  /\[denied\]/i,
  /tool permission approval is not supported in non-interactive mode/i,
  /permission denied for tool/i,
]

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run .*login/i,
  /authentication (?:required|failed|expired)/i,
  /unauthorized/i,
  /ExpiredToken/i,
]

const THROTTLE_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota exceeded/i,
  /insufficient credits?/i,
  /monthly limit/i,
]

export function detectDenial(text) {
  if (typeof text !== 'string' || text === '') return false
  return DENIAL_PATTERNS.some((re) => re.test(text))
}

// 출력 텍스트 → 오류 코드. 해당 없으면 null (정상 경로).
// 우선순위: 인증 > 스로틀 > 툴 거부. 인증 실패는 나머지를 전부 유발하므로 먼저 본다.
export function classifyOutput(text) {
  if (typeof text !== 'string' || text === '') return null
  if (AUTH_PATTERNS.some((re) => re.test(text))) return CODES.UNAUTHENTICATED
  if (THROTTLE_PATTERNS.some((re) => re.test(text))) return CODES.THROTTLED
  if (detectDenial(text)) return CODES.TOOL_DENIED
  return null
}

export const MESSAGES = {
  [CODES.TIMEOUT]: '시간 초과. 부분 출력만 반환합니다 (재시도하지 않음).',
  [CODES.UNAUTHENTICATED]: 'Kiro 인증이 필요합니다. `kiro-cli login` 을 실행하세요.',
  [CODES.THROTTLED]: '크레딧 소진 또는 스로틀. `/kiro:status` 로 사용량을 확인하세요.',
  [CODES.TOOL_DENIED]:
    '툴 권한이 부족해 Kiro 가 필요한 파일을 읽지 못했습니다. findings 를 신뢰할 수 없어 오류로 승격합니다.',
  [CODES.TRANSPORT_UNAVAILABLE]: 'kiro-cli 를 찾을 수 없거나 실행할 수 없습니다.',
  [CODES.CANCELLED]: '취소되었습니다.',
  [CODES.PROTOCOL]: 'kiro-cli 와의 프로토콜 교신이 예상과 다릅니다.',
  [CODES.SPAWN_FAILED]: 'kiro-cli 프로세스를 시작하지 못했습니다.',
}

export function bridgeError(code, details = {}) {
  return new BridgeError(code, MESSAGES[code] || code, details)
}
