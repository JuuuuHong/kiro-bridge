// stdio JSON-RPC 2.0 client (for ACP).
//
// Framing: newline-delimited JSON (ndjson). Not LSP's Content-Length header.
// Based on the ACP spec and pending empirical verification — if wrong, only this one file changes.
//
// Reverse requests (agent -> client) must be handled. session/request_permission
// is that path, and the agent hangs if it isn't answered.
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

  // Feeds in the stdout chunk as-is. The splitter handles line boundaries.
  feed(chunk) {
    this.splitter.push(String(chunk))
  }

  #handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      // Non-JSON mixed into the protocol stream is ignored. Diagnostics are left to stderr.
      return
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      // Key on the string form: an agent that echoes our numeric id back as a
      // string would otherwise never match, leaving the request hanging until
      // the stream closes.
      const entry = this.#pending.get(String(msg.id))
      if (!entry) return
      this.#pending.delete(String(msg.id))
      if (msg.error) {
        entry.reject(bridgeError(CODES.PROTOCOL, { rpc: msg.error }))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    if (msg.method && msg.id != null) {
      // Reverse request — must be answered.
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
      this.#pending.set(String(id), { resolve, reject })
    })
    this.#send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  // If the process dies, all pending requests are woken up — so they never hang silently.
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
