// stdio JSON-RPC 2.0 클라이언트 (ACP용).
//
// 프레이밍: 개행 구분 JSON (ndjson). LSP 의 Content-Length 헤더가 아니다.
// ACP 스펙 기준이며 실측 대기 항목이다 — 틀렸다면 이 파일 한 곳만 바뀐다.
//
// 역방향 요청(agent → client)을 반드시 처리해야 한다. session/request_permission
// 이 그 경로이고, 응답하지 않으면 에이전트가 멈춘다.
import { createLineSplitter } from './events.mjs'
import { bridgeError, CODES } from '../errors.mjs'

export class JsonRpcClient {
  #nextId = 1
  #pending = new Map()
  #write
  #handlers
  #closed = false
  #closeReason = null

  constructor({ write, onNotification, onRequest }) {
    this.#write = write
    this.#handlers = { onNotification, onRequest }
    this.splitter = createLineSplitter((line) => this.#handleLine(line))
  }

  // stdout 청크를 그대로 넣는다. 줄 경계는 splitter 가 맞춘다.
  feed(chunk) {
    this.splitter.push(String(chunk))
  }

  #handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      // 프로토콜 스트림에 섞인 비-JSON 은 무시한다. 진단은 stderr 로 남는다.
      return
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      if (msg.error) {
        entry.reject(bridgeError(CODES.PROTOCOL, { rpc: msg.error }))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    if (msg.method && msg.id != null) {
      // 역방향 요청 — 반드시 응답해야 한다.
      this.#respondToRequest(msg)
      return
    }

    if (msg.method) {
      this.#handlers.onNotification?.(msg)
    }
  }

  async #respondToRequest(msg) {
    let response
    try {
      const result = await this.#handlers.onRequest?.(msg)
      response = { jsonrpc: '2.0', id: msg.id, result: result ?? {} }
    } catch (err) {
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: String(err?.message || err) },
      }
    }
    this.#send(response)
  }

  #send(obj) {
    if (this.#closed) return
    this.#write(`${JSON.stringify(obj)}\n`)
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  request(method, params) {
    if (this.#closed) {
      return Promise.reject(this.#closeReason || bridgeError(CODES.PROTOCOL, { method }))
    }
    const id = this.#nextId++
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.#send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  // 프로세스가 죽으면 대기 중인 요청을 전부 깨운다 — 조용히 매달리지 않게.
  close(error) {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = error || bridgeError(CODES.PROTOCOL, { reason: 'stream closed' })
    this.splitter.flush()
    for (const [, entry] of this.#pending) entry.reject(this.#closeReason)
    this.#pending.clear()
  }

  get pendingCount() {
    return this.#pending.size
  }
}
