import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeTerminal, sanitizeLine, guardStream } from '../scripts/lib/sanitize.mjs'

const ESC = '\u001B'
const BEL = '\u0007'

// --- ANSI CSI ---

test('strips SGR colour codes', () => {
  const input = `${ESC}[31mred${ESC}[0m text`
  assert.equal(sanitizeTerminal(input), 'red text')
})

test('strips cursor movement sequences', () => {
  assert.equal(sanitizeTerminal(`a${ESC}[2Ab`), 'ab')
  assert.equal(sanitizeTerminal(`a${ESC}[10;5Hb`), 'ab')
})

test('strips erase-screen and erase-line sequences', () => {
  assert.equal(sanitizeTerminal(`${ESC}[2Jcleared`), 'cleared')
  assert.equal(sanitizeTerminal(`${ESC}[Kline`), 'line')
})

test('strips CSI with private/parameter bytes', () => {
  assert.equal(sanitizeTerminal(`${ESC}[?25lhidden${ESC}[?25h`), 'hidden')
})

// --- OSC including OSC 52 ---

test('strips OSC 52 clipboard write (BEL-terminated)', () => {
  const input = `before${ESC}]52;c;ZXZpbA==${BEL}after`
  assert.equal(sanitizeTerminal(input), 'beforeafter')
})

test('strips OSC 52 clipboard write (ST-terminated)', () => {
  const input = `before${ESC}]52;c;ZXZpbA==${ESC}\\after`
  assert.equal(sanitizeTerminal(input), 'beforeafter')
})

test('strips OSC window-title sequence', () => {
  const input = `${ESC}]0;malicious title${BEL}text`
  assert.equal(sanitizeTerminal(input), 'text')
})

test('strips OSC hyperlink sequence', () => {
  const input = `${ESC}]8;;http://evil.example.com${BEL}click${ESC}]8;;${BEL}`
  assert.equal(sanitizeTerminal(input), 'click')
})

// --- other ESC control sequences ---

test('strips terminal full reset ESC c', () => {
  assert.equal(sanitizeTerminal(`${ESC}creset`), 'reset')
})

test('strips save/restore cursor ESC 7 / ESC 8', () => {
  assert.equal(sanitizeTerminal(`${ESC}7save${ESC}8`), 'save')
})

test('strips DCS string sequence', () => {
  assert.equal(sanitizeTerminal(`${ESC}Pdata${ESC}\\text`), 'text')
})

test('strips APC string sequence', () => {
  assert.equal(sanitizeTerminal(`${ESC}_apc payload${ESC}\\text`), 'text')
})

test('strips a lone/truncated ESC', () => {
  assert.equal(sanitizeTerminal(`text${ESC}`), 'text')
})

// --- C0 / C1 control bytes ---

test('strips unsafe C0 control bytes but preserves \\n and \\t', () => {
  const input = 'a\u0000b\u0007c\td\ne\u001Ff'
  assert.equal(sanitizeTerminal(input), 'abc\td\nef')
})

test('drops carriage return (line-overwrite trick)', () => {
  assert.equal(sanitizeTerminal('safe\rEVIL'), 'safeEVIL')
})

test('strips DEL (0x7F)', () => {
  assert.equal(sanitizeTerminal('a\u007Fb'), 'ab')
})

test('strips C1 range (0x80-0x9F)', () => {
  assert.equal(sanitizeTerminal('a\u009Bb\u009Dc'), 'abc')
})

test('preserves newline and tab exactly', () => {
  const input = 'line1\nline2\tcol'
  assert.equal(sanitizeTerminal(input), 'line1\nline2\tcol')
})

test('preserves ordinary unicode text', () => {
  const input = '한국어 テキスト émojis 🚀'
  assert.equal(sanitizeTerminal(input), input)
})

// --- input handling ---

test('null and undefined become empty string', () => {
  assert.equal(sanitizeTerminal(null), '')
  assert.equal(sanitizeTerminal(undefined), '')
})

test('non-string input is coerced', () => {
  assert.equal(sanitizeTerminal(42), '42')
})

test('clean text passes through unchanged', () => {
  assert.equal(sanitizeTerminal('plain text 123'), 'plain text 123')
})

// --- combined attack payload ---

test('strips a combined multi-sequence attack payload', () => {
  const input = `${ESC}[2J${ESC}]52;c;ZXZpbA==${BEL}${ESC}[31mfindings summary${ESC}[0m\ndetail\ttab${ESC}]0;pwn${BEL}`
  const out = sanitizeTerminal(input)
  assert.equal(out, 'findings summary\ndetail\ttab')
  assert.ok(!out.includes(ESC))
  assert.ok(!out.includes(BEL))
})

// --- sanitizeLine ---

test('sanitizeLine appends a single trailing newline', () => {
  assert.equal(sanitizeLine('text'), 'text\n')
  assert.equal(sanitizeLine('text\n'), 'text\n')
})

test('sanitizeLine strips sequences then terminates', () => {
  assert.equal(sanitizeLine(`${ESC}[31mred${ESC}[0m`), 'red\n')
})

// --- guardStream ---

test('guardStream sanitizes string writes and returns a restore fn', () => {
  const written = []
  const fake = { write: (chunk) => { written.push(chunk); return true } }
  const restore = guardStream(fake)
  fake.write(`${ESC}[31mhi${ESC}[0m`)
  assert.equal(written[0], 'hi')
  restore()
  fake.write(`${ESC}[31mhi${ESC}[0m`)
  assert.equal(written[1], `${ESC}[31mhi${ESC}[0m`)
})

test('guardStream sanitizes Buffer writes decoded as utf8', () => {
  const written = []
  const fake = { write: (chunk) => { written.push(chunk); return true } }
  guardStream(fake)
  fake.write(Buffer.from(`${ESC}]52;c;ZXZpbA==${BEL}payload`, 'utf8'))
  assert.equal(written[0], 'payload')
})

test('guardStream is a no-op for a stream without write', () => {
  const restore = guardStream(null)
  assert.equal(typeof restore, 'function')
  restore() // must not throw
})
