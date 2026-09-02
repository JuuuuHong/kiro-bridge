// Terminal output sanitizer (design §7 hardening, ADR-004).
//
// Model output and process diagnostics are untrusted data. If written verbatim
// to a TTY they can carry escape sequences that move the cursor, clear the
// screen, relabel the window title, or — via OSC 52 — write to the user's
// clipboard. This module strips terminal control sequences so external text
// can only ever *print*, never *control*.
//
import { StringDecoder } from 'node:string_decoder'

// Preserved: normal printable text, newline (\n = \u000A) and tab (\t =
// \u0009). Everything else in the control range, plus ANSI/OSC/ESC sequences,
// is removed.

// ANSI CSI: ESC [ ... final-byte (0x40-0x7E). Covers colours, cursor moves,
// erase-line/screen, etc. Parameter/intermediate bytes are 0x20-0x3F.
const CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g

// OSC: ESC ] ... terminated by BEL (\u0007) or ST (ESC \). Includes OSC 52
// (clipboard) and window-title sequences. The body may span content bytes, so
// match lazily up to the terminator.
const OSC = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g

// DCS / PM / APC / SOS: ESC P|X|^|_ ... ST (ESC \). String-type sequences.
const STRING_SEQ = /\u001B[PX^_][\s\S]*?\u001B\\/g

// A bare C1 CSI/OSC introducer without the ESC prefix (0x9B / 0x9D) can also
// start a control sequence on some terminals. Strip the introducer bytes; the
// remaining payload becomes inert text once the introducer is gone. We remove
// the whole C1 range (0x80-0x9F) as unsafe below, which covers these.

// Any remaining ESC sequence that was not matched above. ANSI escape
// sequences may contain zero or more intermediate bytes (0x20-0x2F) followed
// by a final byte (0x30-0x7E): this covers ESC c (reset), ESC 7/8
// (save/restore cursor), charset selection, and similar two-byte controls.
// The final byte is optional so a truncated/lone ESC is removed as well.
const LONE_ESC = /\u001B[ -/]*[0-~]?/g

// Unsafe C0 controls and C1 range. Explicitly KEEP \t (\u0009) and \n
// (\u000A). Everything else 0x00-0x1F, plus DEL (0x7F) and C1 (0x80-0x9F), is
// removed. \r (\u000D) is dropped: it enables line-overwrite tricks and is not
// needed for display.
const UNSAFE_C0_C1 = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

// Strip terminal control sequences from a string. Non-string input is coerced
// via String(); null/undefined become ''.
export function sanitizeTerminal(input) {
  if (input == null) return ''
  let text = typeof input === 'string' ? input : String(input)
  // Order matters: remove structured sequences first (while their ESC
  // introducer is intact), then sweep any lone ESC, then the raw control bytes.
  text = text.replace(OSC, '')
  text = text.replace(STRING_SEQ, '')
  text = text.replace(CSI, '')
  text = text.replace(LONE_ESC, '')
  text = text.replace(UNSAFE_C0_C1, '')
  return text
}

// Guarantee the returned string ends with exactly one trailing newline. Useful
// for stdout/stderr write boundaries where we always terminate a record.
export function sanitizeLine(input) {
  const cleaned = sanitizeTerminal(input)
  return cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`
}

// Wrap a writable stream's write() so all outgoing text is sanitized. Buffers
// (from process byte writes) are decoded as utf8, sanitized, and re-emitted.
// Returns a function that restores the original write().
//
// Byte writes are decoded through a stateful StringDecoder, not a per-chunk
// Buffer.toString(): a multi-byte character split across two write() calls
// would otherwise decode to U+FFFD on both sides, corrupting any non-ASCII
// output (e.g. Korean findings text) at chunk boundaries. The decoder holds the
// incomplete tail until the continuation bytes arrive.
//
// NOTE: currently unused — bridge.mjs sanitizes complete strings at its own
// write edge (trackedWrite), which has no boundary problem. Kept as the guard
// for any future byte-level stream piping.
export function guardStream(stream) {
  if (!stream || typeof stream.write !== 'function') return () => {}
  const original = stream.write.bind(stream)
  const decoder = new StringDecoder('utf8')
  stream.write = (chunk, encoding, callback) => {
    let text
    if (typeof chunk === 'string') {
      text = chunk
    } else if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
      text = decoder.write(Buffer.from(chunk))
    } else {
      return original(chunk, encoding, callback)
    }
    // Callback/encoding argument juggling mirrors stream.write's overloads.
    if (typeof encoding === 'function') return original(sanitizeTerminal(text), encoding)
    return original(sanitizeTerminal(text), encoding, callback)
  }
  return () => { stream.write = original }
}
