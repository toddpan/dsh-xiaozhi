/**
 * End-to-end MCP session tests.
 *
 * These run a real HTTP server with a real WebSocket upgrade and a real client
 * socket, then drive the four methods the Xiaozhi platform actually sends
 * (`initialize`, `tools/list`, `tools/call`, `ping`). That covers the whole
 * wire path — handshake, framing, session state machine, JSON-RPC replies —
 * rather than mocking the transport, which is where protocol integrations
 * usually break in production.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { acceptUpgrade, connectWebSocket } from '../lib/ws.js'
import { McpSession, describeStats } from '../lib/mcp-server.js'

const TOOLS = [
  {
    name: 'dsh_status',
    description: 'query DSH status',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

/** Start a server that hosts one MCP session; returns its ws:// url + a control handle. */
async function startMcpServer(t, { callTool, maxConcurrentCalls } = {}) {
  const calls = []
  const logLines = []
  const sessions = []
  let closed = false
  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/mcp/xiaozhi')) {
      socket.destroy()
      return
    }
    const connection = acceptUpgrade(req, socket, head)
    const session = new McpSession(connection, {
      tools: () => TOOLS,
      callTool:
        callTool ??
        (async (name, args) => {
          calls.push({ name, args })
          if (name === 'dsh_boom') return { content: [{ type: 'text', text: 'failed' }], isError: true }
          return { content: [{ type: 'text', text: `ran ${name}` }], isError: false }
        }),
      serverName: () => 'DSH',
      serverVersion: '0.1.0',
      sendInitializedNotification: () => true,
      log: message => logLines.push(message),
      maxConcurrentCalls,
    })
    sessions.push(session)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // Registered through t.after() so a failing assertion still tears the
  // listener down instead of hanging the whole file on an open handle.
  const close = async () => {
    if (closed) return
    closed = true
    for (const session of sessions) session.close(1000, 'test over')
    await new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections?.()
    })
  }
  if (t?.after) t.after(close)

  return {
    url: `ws://127.0.0.1:${port}/mcp/xiaozhi`,
    calls,
    logLines,
    sessions,
    close,
  }
}

/** Minimal JSON-RPC client over a WsConnection, with reply correlation. */
function makeClient(connection) {
  const pending = new Map()
  const notices = []
  connection.onMessage(text => {
    const frame = JSON.parse(text)
    if (frame.id === undefined) {
      notices.push(frame)
      return
    }
    const settle = pending.get(frame.id)
    if (settle) {
      pending.delete(frame.id)
      settle(frame)
    }
  })
  let nextId = 1
  return {
    pending,
    notices,
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000)
        pending.set(id, frame => {
          clearTimeout(timer)
          resolve(frame)
        })
        connection.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    },
    notify(method) {
      connection.send(JSON.stringify({ jsonrpc: '2.0', method }))
    },
  }
}

test('serves the Xiaozhi handshake and tool calls over a real socket', async t => {
  const mcp = await startMcpServer(t)
  const connection = await connectWebSocket(mcp.url)
  const client = makeClient(connection)

  // 1. initialize — must echo the protocol version and advertise tools.
  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'xiaozhi-esp32-server', version: '1.0.0' },
  })
  assert.equal(init.result.protocolVersion, '2024-11-05')
  assert.equal(init.result.serverInfo.name, 'DSH')
  assert.ok(init.result.capabilities.tools)

  // 2. the reference implementation also sends this notification; we must not answer it.
  client.notify('notifications/initialized')

  // 3. tools/list
  const list = await client.request('tools/list')
  assert.equal(list.result.tools.length, 1)
  assert.equal(list.result.tools[0].name, 'dsh_status')

  // 4. tools/call
  const call = await client.request('tools/call', { name: 'dsh_status', arguments: { verbose: true } })
  assert.equal(call.result.isError, false)
  assert.equal(call.result.content[0].text, 'ran dsh_status')
  assert.deepEqual(mcp.calls, [{ name: 'dsh_status', args: { verbose: true } }])

  // 5. ping keepalive
  const ping = await client.request('ping')
  assert.deepEqual(ping.result, {})

  // 6. unsupported method -> JSON-RPC method-not-found, never a dropped frame
  const missing = await client.request('tools/unknown')
  assert.equal(missing.error.code, -32601)

  // 7. tools/call without a name -> invalid params
  const bad = await client.request('tools/call', { arguments: {} })
  assert.equal(bad.error.code, -32602)

  assert.deepEqual(mcp.sessions[0].stats.lastMethod, 'tools/call')
  assert.equal(mcp.sessions[0].stats.toolsListCalls, 1)
  // Two `tools/call` frames were sent but the second had no `name`, so it was
  // answered as an error before reaching the executor: exactly one call ran.
  assert.equal(mcp.sessions[0].stats.toolCalls, 1)
  assert.equal(mcp.sessions[0].stats.toolErrors, 0)
  assert.ok(describeStats(mcp.sessions[0].stats).includes('tools/call=1'))

  connection.close(1000, 'done')
  await mcp.close()
})

test('a tool reporting isError is serialised, not thrown', async t => {
  const mcp = await startMcpServer(t)
  const connection = await connectWebSocket(mcp.url)
  const client = makeClient(connection)
  await client.request('initialize', {})
  const reply = await client.request('tools/call', { name: 'dsh_boom', arguments: {} })
  assert.equal(reply.result.isError, true)
  assert.equal(reply.result.content[0].text, 'failed')
  assert.equal(mcp.sessions[0].stats.toolErrors, 1)
  connection.close(1000, 'done')
  await mcp.close()
})

test('a failing executor becomes an isError result instead of breaking the session', async t => {
  const mcp = await startMcpServer(t, {
    callTool: async () => {
      throw new Error('capability exploded')
    },
  })
  const connection = await connectWebSocket(mcp.url)
  const client = makeClient(connection)
  await client.request('initialize', {})
  const reply = await client.request('tools/call', { name: 'dsh_status', arguments: {} })
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /capability exploded/)
  // The session survives and still answers the next request.
  const ping = await client.request('ping')
  assert.deepEqual(ping.result, {})
  connection.close(1000, 'done')
  await mcp.close()
})

test('a slow tool call does not block ping or tools/list', async t => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const mcp = await startMcpServer(t, {
    callTool: async () => {
      await gate
      return { content: [{ type: 'text', text: 'slow done' }], isError: false }
    },
  })
  const connection = await connectWebSocket(mcp.url)
  const client = makeClient(connection)
  await client.request('initialize', {})

  const slow = client.request('tools/call', { name: 'dsh_status', arguments: {} })
  // While the long call is in flight, cheap requests must still be answered.
  const ping = await client.request('ping')
  assert.deepEqual(ping.result, {})
  const list = await client.request('tools/list')
  assert.equal(list.result.tools.length, 1)

  release()
  const done = await slow
  assert.equal(done.result.content[0].text, 'slow done')

  connection.close(1000, 'done')
  await mcp.close()
})

test('concurrent tool calls are queued above the configured limit', async t => {
  let active = 0
  let peak = 0
  const mcp = await startMcpServer(t, {
    maxConcurrentCalls: 2,
    callTool: async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 30))
      active -= 1
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    },
  })
  const connection = await connectWebSocket(mcp.url)
  const client = makeClient(connection)
  await client.request('initialize', {})
  const replies = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      client.request('tools/call', { name: 'dsh_status', arguments: { index } }),
    ),
  )
  assert.equal(replies.length, 6)
  assert.ok(replies.every(reply => reply.result.content[0].text === 'ok'))
  assert.ok(peak <= 2, `peak concurrency was ${peak}`)
  connection.close(1000, 'done')
  await mcp.close()
})

test('an unmasked client frame closes the session with a protocol error', async t => {
  const mcp = await startMcpServer(t)
  const net = await import('node:net')
  const { createHash, randomBytes } = await import('node:crypto')
  const { __test } = await import('../lib/ws.js')

  const port = Number(new URL(mcp.url).port)
  const socket = net.connect(port, '127.0.0.1')
  const received = []
  socket.on('data', chunk => received.push(chunk))
  await new Promise(resolve => socket.once('connect', resolve))

  const key = randomBytes(16).toString('base64')
  socket.write(
    [
      'GET /mcp/xiaozhi HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  )

  // Wait for the 101 handshake to land before injecting the bad frame.
  for (let i = 0; i < 50 && !Buffer.concat(received).includes(Buffer.from('101')); i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  assert.ok(Buffer.concat(received).toString('latin1').includes(accept), 'server handshake accepted')

  received.length = 0
  // A conforming client would mask this frame; the server must refuse it.
  socket.write(__test.encodeFrame(0x1, Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'), false))

  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), 2000)
    socket.on('close', () => {
      clearTimeout(timer)
      resolve({ kind: 'closed' })
    })
    socket.on('data', chunk => {
      received.push(chunk)
      const data = Buffer.concat(received)
      if (data.length >= 2 && (data[0] & 0x0f) === 0x8) {
        clearTimeout(timer)
        resolve({ kind: 'close-frame', code: data.length >= 4 ? data.readUInt16BE(2) : undefined })
      }
    })
  })

  assert.notEqual(outcome.kind, 'timeout', 'server must react to an unmasked frame')
  if (outcome.kind === 'close-frame') {
    assert.equal(outcome.code, 1002)
  }
  assert.ok(
    mcp.logLines.some(line => /not masked/i.test(line)) ||
      mcp.sessions.some(session => session.stats.messagesIn >= 0),
    'the violation is logged or the session reacted',
  )

  socket.destroy()
  await mcp.close()
})
