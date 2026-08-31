#!/usr/bin/env node
// 가짜 kiro-cli. 실제 바이너리 없이 transport 를 검증하기 위한 것 (설계 §11).
//
// 시나리오는 환경변수 MOCK_SCENARIO 로 고른다. 실제 kiro-cli 를 실측한 뒤에는
// 여기 응답을 녹화 픽스처로 교체하면 되고, transport 코드는 그대로 둔다.
import { createInterface } from 'node:readline'

const scenario = process.env.MOCK_SCENARIO || 'ok'
const mode = process.argv[2]

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

if (process.argv.includes('--version')) {
  process.stdout.write('kiro-cli 2.20.1\n')
  process.exit(0)
}

// --- ACP 모드 -------------------------------------------------------------
if (mode === 'acp') {
  if (scenario === 'acp-unavailable') {
    process.stderr.write('unknown subcommand: acp\n')
    process.exit(2)
  }

  const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })

  const rl = createInterface({ input: process.stdin })
  let sessionId = 'sess-mock-1'
  let pendingPromptId = null

  rl.on('line', async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }

    if (msg.method === 'initialize') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    }

    if (msg.method === 'session/new') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } })
    }

    if (msg.method === 'session/load') {
      sessionId = msg.params.sessionId
      return send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }

    if (msg.method === 'session/cancel') {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[cancelled]' } })
      return
    }

    if (msg.method === 'session/prompt') {
      if (scenario === 'unauthenticated') {
        process.stderr.write('Error: not logged in. Please run `kiro-cli login`.\n')
        process.exit(1)
      }
      if (scenario === 'throttled') {
        process.stderr.write('Error: rate limit exceeded\n')
        process.exit(1)
      }

      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '생각 중' } })
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read src/app.mjs', status: 'pending' })

      if (scenario === 'denied') {
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc1',
          status: 'failed',
          content: { type: 'text', text: '[denied] tool permission approval is not supported in non-interactive mode' },
        })
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '{"findings":[{"severity":"high","claim":"확인 못 했지만 그럴듯한 주장"}],"summary":"s"}' },
        })
        return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }

      if (scenario === 'permission') {
        // 역방향 요청: 클라이언트가 응답하지 않으면 여기서 멈춘다.
        pendingPromptId = msg.id
        send({
          jsonrpc: '2.0',
          id: 9001,
          method: 'session/request_permission',
          params: { sessionId, toolCall: { toolCallId: 'tc1', title: 'write file' }, options: [{ optionId: 'allow', name: 'Allow' }] },
        })
        return
      }

      if (scenario === 'timeout') {
        return // 응답하지 않고 매달린다
      }

      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: { type: 'text', text: 'ok' } })
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"findings":[{"severity":"medium","file":"src/app.mjs","line":10,"claim":"널 체크 누락","evidence":"e","suggestion":"s"}],"summary":"1건"}' },
      })
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }

    // 역방향 요청에 대한 클라이언트 응답 → 보류 중이던 prompt 를 마무리한다
    if (msg.id === 9001 && msg.result !== undefined && pendingPromptId != null) {
      const allowed = msg.result?.outcome === 'selected'
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: allowed ? '{"findings":[],"summary":"허가됨"}' : '{"findings":[],"summary":"거부됨"}' },
      })
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } })
      pendingPromptId = null
    }
  })

  process.stdin.on('end', () => process.exit(0))
}

// --- subprocess(stream-json) 모드 ----------------------------------------
else if (mode === 'chat') {
  let input = ''
  process.stdin.on('data', (c) => { input += c })
  process.stdin.on('end', () => {
    if (scenario === 'unauthenticated') {
      process.stderr.write('authentication required\n')
      process.exit(1)
    }
    if (scenario === 'throttled') {
      process.stderr.write('insufficient credits\n')
      process.exit(1)
    }
    if (scenario === 'nonzero-exit') {
      process.stderr.write('boom\n')
      process.exit(3)
    }

    send({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read', status: 'pending' })

    if (scenario === 'denied') {
      send({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'failed',
        content: { type: 'text', text: '[denied] tool permission approval is not supported in non-interactive mode' },
      })
    }

    // 입력을 그대로 받았는지 확인할 수 있게 goal 을 되돌려준다
    let goal = ''
    try { goal = JSON.parse(input).goal || '' } catch {}
    send({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `{"findings":[],"summary":"echo:${goal}"}` },
    })
    process.exit(0)
  })
}

else {
  process.stderr.write(`unknown mode: ${mode}\n`)
  process.exit(2)
}
