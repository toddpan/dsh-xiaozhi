/**
 * RFC 6455 tests for the hand-rolled WebSocket layer.
 *
 * Framing is where a dependency-free implementation usually breaks, so the
 * cases below cover the three length encodings (7-bit, 16-bit, 64-bit), both
 * masking directions, fragmentation, control frames interleaved with a
 * fragmented message, and the payload cap.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../lib/ws.js'

const { encodeFrame, acceptKey, FrameDecoder, OP_CONT, OP_TEXT, OP_PING, OP_PONG, OP_CLOSE } = __test

/** Collect decoder callbacks into plain arrays for assertions. */
function makeDecoder({ maxPayloadBytes = 1024 * 1024, expectMasked = undefined } = {}) {
  const log = { messages: [], pings: [], pongs: [], closes: [], errors: [] }
  const decoder = new FrameDecoder(
    {
      onText: text => log.messages.push(text),
      onPing: payload => log.pings.push(payload.toString('utf8')),
      onPong: payload => log.pongs.push(payload.toString('utf8')),
      onClose: (code, reason) => log.closes.push({ code, reason }),
      onProtocolError: message => log.errors.push(message),
    },
    maxPayloadBytes,
    expectMasked,
  )
  return { decoder, log }
}

test('acceptKey matches the RFC 6455 example vector', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('round-trips small, medium and large payloads', () => {
  for (const size of [0, 5, 125, 126, 1000, 65535, 65536, 200_000]) {
    const payload = Buffer.from('a'.repeat(size))
    const { decoder, log } = makeDecoder()
    decoder.push(encodeFrame(OP_TEXT, payload, false))
    assert.equal(log.messages.length, 1, `size ${size} produced one message`)
    assert.equal(log.messages[0].length, size, `size ${size} round-tripped intact`)
    assert.deepEqual(log.errors, [])
  }
})

test('decodes a masked client frame', () => {
  const { decoder, log } = makeDecoder({ expectMasked: true })
  decoder.push(encodeFrame(OP_TEXT, Buffer.from('masked'), true))
  assert.deepEqual(log.messages, ['masked'])
})

test('mask direction is enforced in both directions', () => {
  // Server side: inbound must be masked.
  const server = makeDecoder({ expectMasked: true })
  server.decoder.push(encodeFrame(OP_TEXT, Buffer.from('unmasked!'), false))
  assert.deepEqual(server.log.messages, [])
  assert.equal(server.log.errors.length, 1)
  assert.match(server.log.errors[0], /not masked/i)

  // Client side: inbound must not be masked.
  const client = makeDecoder({ expectMasked: false })
  client.decoder.push(encodeFrame(OP_TEXT, Buffer.from('masked!'), true))
  assert.deepEqual(client.log.messages, [])
  assert.equal(client.log.errors.length, 1)
  assert.match(client.log.errors[0], /must not be masked/i)
})

test('reassembles a fragmented message with continuation frames', () => {
  const { decoder, log } = makeDecoder()
  decoder.push(encodeFrame(OP_TEXT, Buffer.from('Hel'), false, false))
  decoder.push(encodeFrame(OP_CONT, Buffer.from('lo '), false, false))
  decoder.push(encodeFrame(OP_CONT, Buffer.from('world'), false))
  assert.deepEqual(log.messages, ['Hello world'])
  assert.deepEqual(log.errors, [])
})

test('a control frame may interleave a fragmented message', () => {
  const { decoder, log } = makeDecoder()
  // Non-final frames stay buffered; the ping between them must not disturb it.
  decoder.push(encodeFrame(OP_TEXT, Buffer.from('part1'), false, false))
  decoder.push(encodeFrame(OP_PING, Buffer.from('ka'), false))
  decoder.push(encodeFrame(OP_CONT, Buffer.from('part2'), false))
  assert.deepEqual(log.messages, ['part1part2'])
  assert.deepEqual(log.pings, ['ka'])
})

test('splitting a frame across arbitrary byte boundaries is invisible', () => {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  const frame = encodeFrame(OP_TEXT, payload, true)
  const { decoder, log } = makeDecoder()
  for (const byte of frame) decoder.push(Buffer.from([byte]))
  assert.equal(log.messages.length, 1)
  assert.deepEqual(JSON.parse(log.messages[0]), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
})

test('multi-byte UTF-8 survives a split across frames boundaries', () => {
  const { decoder, log } = makeDecoder()
  const text = '你好，小智 👋'
  const bytes = Buffer.from(text, 'utf8')
  const frame = encodeFrame(OP_TEXT, bytes, true)
  const half = Math.floor(frame.length / 2)
  decoder.push(frame.subarray(0, half))
  decoder.push(frame.subarray(half))
  assert.deepEqual(log.messages, [text])
})

test('ping and close frames are surfaced with their payloads', () => {
  const { decoder, log } = makeDecoder()
  decoder.push(encodeFrame(OP_PING, Buffer.from('hb'), false))
  decoder.push(encodeFrame(OP_PONG, Buffer.from('hb2'), false))
  const body = Buffer.alloc(2)
  body.writeUInt16BE(1000, 0)
  decoder.push(encodeFrame(OP_CLOSE, Buffer.concat([body, Buffer.from('bye')]), false))
  assert.deepEqual(log.pings, ['hb'])
  assert.deepEqual(log.pongs, ['hb2'])
  assert.deepEqual(log.closes, [{ code: 1000, reason: 'bye' }])
})

test('the payload cap is enforced before a frame is buffered', () => {
  const { decoder, log } = makeDecoder({ maxPayloadBytes: 1024 })
  decoder.push(encodeFrame(OP_TEXT, Buffer.from('x'.repeat(4096)), false))
  assert.deepEqual(log.messages, [])
  assert.equal(log.errors.length, 1)
  assert.match(log.errors[0], /too large/i)
})

test('a fragmented message is also capped in total size', () => {
  const { decoder, log } = makeDecoder({ maxPayloadBytes: 1024 })
  decoder.push(encodeFrame(OP_TEXT, Buffer.from('x'.repeat(800)), false, false))
  decoder.push(encodeFrame(OP_CONT, Buffer.from('x'.repeat(800)), false))
  assert.deepEqual(log.messages, [])
  assert.equal(log.errors.length, 1)
  assert.match(log.errors[0], /too large/i)
})

test('a non-final control frame is a protocol error', () => {
  const { decoder, log } = makeDecoder()
  // RFC 6455: control frames must not be fragmented (FIN must be set).
  decoder.push(encodeFrame(OP_PING, Buffer.from('hb'), false, false))
  assert.deepEqual(log.pings, [])
  assert.equal(log.errors.length, 1)
  assert.match(log.errors[0], /control frame/i)
})

test('reserved bits are rejected', () => {
  const { decoder, log } = makeDecoder()
  const frame = encodeFrame(OP_TEXT, Buffer.from('x'), false)
  frame[0] |= 0x40 // RSV1 -> a compressed frame we never negotiated
  decoder.push(frame)
  assert.equal(log.errors.length, 1)
  assert.deepEqual(log.messages, [])
})

test('an unknown opcode is a protocol error', () => {
  const { decoder, log } = makeDecoder()
  decoder.push(encodeFrame(0x3, Buffer.from('x'), false))
  assert.equal(log.errors.length, 1)
})

test('a continuation frame without a start is a protocol error', () => {
  const { decoder, log } = makeDecoder()
  decoder.push(encodeFrame(OP_CONT, Buffer.from('orphan'), false))
  assert.equal(log.errors.length, 1)
})
