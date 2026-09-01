#!/usr/bin/env node
// Fake kiro-cli. Used to verify the transport without a real binary (design §11).
//
// The scenario is chosen via the MOCK_SCENARIO env var. Once real kiro-cli
// has been measured, the responses here can be swapped for recorded fixtures, leaving the transport code untouched.
import { createInterface } from 'node:readline'

const scenario = process.env.MOCK_SCENARIO || 'ok'
const mode = process.argv[2]

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

if (process.argv.includes('--version')) {
  process.stdout.write('kiro-cli 2.20.1\n')
  process.exit(0)
}

// --- ACP mode -------------------------------------------------------------
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

      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
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
          content: { type: 'text', text: '{"findings":[{"severity":"high","claim":"plausible-sounding claim that was never verified"}],"summary":"s"}' },
        })
        return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }

      if (scenario === 'permission') {
        // Reverse request: hangs here if the client doesn't respond.
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
        return // never respond, hangs
      }

      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: { type: 'text', text: 'ok' } })
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"findings":[{"severity":"medium","file":"src/app.mjs","line":10,"claim":"missing null check","evidence":"e","suggestion":"s"}],"summary":"1 finding"}' },
      })
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }

    // Client response to the reverse request -> finalizes the pending prompt
    if (msg.id === 9001 && msg.result !== undefined && pendingPromptId != null) {
      const allowed = msg.result?.outcome === 'selected'
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: allowed ? '{"findings":[],"summary":"granted"}' : '{"findings":[],"summary":"denied"}' },
      })
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } })
      pendingPromptId = null
    }
  })

  process.stdin.on('end', () => process.exit(0))
}

// --- subprocess (stream-json) mode ----------------------------------------
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

    // Echo the goal back so we can confirm the input arrived intact
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
