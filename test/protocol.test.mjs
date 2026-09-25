/**
 * Protocol-level tests: JSON-RPC envelope handling and the Xiaozhi tool-name
 * contract. The tool-name rules are copied from the reference Python server
 * (`core/utils/util.py: sanitize_tool_name`), so a name that is not a fixed
 * point of that sanitiser would be silently renamed on the Xiaozhi side and
 * every `tools/call` would fail with "unknown tool".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MCP_PROTOCOL_VERSION,
  canonicalToolName,
  clip,
  initializeResult,
  parseEnvelope,
  readToolCall,
  rpcError,
  rpcNotification,
  rpcResult,
  toolCallResult,
  toolsListResult,
  xiaozhiSanitizeToolName,
  isXiaozhiStableToolName,
} from '../lib/protocol.js'

test('protocol version matches the Xiaozhi MCP contract', () => {
  assert.equal(MCP_PROTOCOL_VERSION, '2024-11-05')
  const result = initializeResult('DSH', '1.2.3')
  assert.equal(result.protocolVersion, '2024-11-05')
  assert.equal(result.serverInfo.name, 'DSH')
  assert.equal(result.serverInfo.version, '1.2.3')
  // Tools are the only capability DSH actually serves; `listChanged` stays
  // false because the tool list is fixed for the life of a connection.
  assert.deepEqual(result.capabilities.tools, { listChanged: false })
})

test('parseEnvelope classifies requests, notifications and responses', () => {
  const request = parseEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }))
  assert.equal(request.kind, 'request')
  assert.equal(request.id, 7)
  assert.equal(request.method, 'tools/list')

  const notification = parseEnvelope(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  assert.equal(notification.kind, 'notification')
  assert.equal(notification.method, 'notifications/initialized')

  const result = parseEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
  assert.equal(result.kind, 'result')

  const error = parseEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }))
  assert.equal(error.kind, 'error')
})

test('parseEnvelope rejects malformed frames instead of throwing', () => {
  assert.equal(parseEnvelope('not json').kind, 'invalid')
  assert.equal(parseEnvelope('[]').kind, 'invalid')
  assert.equal(parseEnvelope('"a string"').kind, 'invalid')
  assert.equal(parseEnvelope(JSON.stringify({ jsonrpc: '2.0' })).kind, 'invalid')
  assert.equal(parseEnvelope('').kind, 'invalid')
})

test('readToolCall reads name + arguments defensively', () => {
  assert.deepEqual(readToolCall({ name: 'dsh_status', arguments: {} }), { name: 'dsh_status', arguments: {} })
  assert.deepEqual(readToolCall({ name: 'x' }), { name: 'x', arguments: {} })
  // Some clients nest under `params.arguments` with a null prototype object.
  assert.equal(readToolCall({ name: 42 }), null)
  assert.equal(readToolCall({}), null)
  assert.equal(readToolCall(null), null)
  assert.equal(readToolCall('nope'), null)
})

test('rpc builders emit valid JSON-RPC 2.0 frames', () => {
  assert.deepEqual(JSON.parse(rpcResult(3, { a: 1 })), { jsonrpc: '2.0', id: 3, result: { a: 1 } })
  const err = JSON.parse(rpcError(4, -32601, 'missing'))
  assert.equal(err.error.code, -32601)
  assert.equal(err.error.message, 'missing')
  const note = JSON.parse(rpcNotification('notifications/initialized'))
  assert.equal(note.method, 'notifications/initialized')
  assert.equal(note.id, undefined)
})

test('tools/list always reports an empty nextCursor (no pagination)', () => {
  const payload = toolsListResult([])
  assert.deepEqual(payload.tools, [])
  assert.equal(payload.nextCursor, undefined)
})

test('tool results carry one text block and the isError flag', () => {
  const ok = toolCallResult('hello')
  assert.equal(ok.isError, false)
  assert.deepEqual(ok.content, [{ type: 'text', text: 'hello' }])
  const bad = toolCallResult('boom', true)
  assert.equal(bad.isError, true)
  assert.equal(bad.content[0].text, 'boom')
  // Non-strings are JSON-encoded (indented, for LLM legibility) so the voice
  // model always receives text, never a structured payload it cannot speak.
  assert.deepEqual(JSON.parse(toolCallResult({ a: 1 }).content[0].text), { a: 1 })
  assert.equal(toolCallResult(undefined).content[0].text, '')
})

test('canonicalToolName normalises to a legal, idempotent MCP name', () => {
  assert.equal(canonicalToolName('dsh status'), 'dsh_status')
  assert.equal(canonicalToolName('dsh__status'), 'dsh_status')
  assert.equal(canonicalToolName('_dsh_status_'), 'dsh_status')
  assert.equal(canonicalToolName('dsh_status'), canonicalToolName(canonicalToolName('dsh_status')))
  assert.equal(canonicalToolName(''), 'tool')
})

test('the Xiaozhi sanitiser leaves canonical names untouched', () => {
  // Behaviour confirmed against the reference implementation's regex.
  assert.equal(xiaozhiSanitizeToolName('dsh_status'), 'dsh_status')
  assert.equal(xiaozhiSanitizeToolName('dsh-session-watch'), 'dsh-session-watch')
  assert.equal(xiaozhiSanitizeToolName('a b.c'), 'a_b_c')
  assert.equal(xiaozhiSanitizeToolName('中文工具'), '中文工具')
  assert.equal(isXiaozhiStableToolName('dsh_session_history'), true)
  assert.equal(isXiaozhiStableToolName('dsh session history'), false)
})

test('clip keeps short text intact and marks truncation', () => {
  assert.equal(clip('abc', 10), 'abc')
  const clipped = clip('x'.repeat(50), 10)
  assert.ok(clipped.length <= 12)
  assert.ok(clipped.startsWith('xxxxxxxxxx'))
  assert.ok(clipped.endsWith('…'))
})
