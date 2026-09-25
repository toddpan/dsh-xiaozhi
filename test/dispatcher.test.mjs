/**
 * In-process REST shim tests.
 *
 * Capabilities are executed by calling the copied DSH Web router directly
 * instead of looping back over HTTP. That only works if the synthesised
 * request/response pair behaves like a real `IncomingMessage`/`ServerResponse`,
 * including streaming bodies (the file and skill routes `pipe()` into the
 * response), so this file exercises those shapes against a real `HttpRouter`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { HttpRouter, readJsonBody, sendJson } from '../lib/dshapi/router.js'
import { CaptureResponse, InvokeError, LocalInvoker } from '../lib/dispatcher.js'

function makeRouter() {
  const router = new HttpRouter({ cors: false, apiKey: '' })

  router.get('/echo', async (_req, res, _params, query) => {
    sendJson(res, 200, { ok: true, data: { echo: query.q ?? null } })
  })
  router.get('/boom', async (_req, res) => {
    sendJson(res, 500, { ok: false, error: 'exploded' })
  })
  router.get('/missing-data', async (_req, res) => {
    sendJson(res, 200, { ok: true })
  })
  router.post('/submit', async (req, res, _params, _query, body) => {
    // The router already drained the request stream and parsed it: a route that
    // calls readJsonBody() itself would wait forever for an 'end' that already
    // fired. Every copied dshapi route takes the parsed `body` argument.
    sendJson(res, 200, { ok: true, data: { received: body, method: req.method, url: req.url } })
  })
  router.get('/stream', async (_req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream')
    res.writeHead(200)
    Readable.from([Buffer.from('chunk-a'), Buffer.from('chunk-b')]).pipe(res)
  })
  router.get('/slow', async (_req, res) => {
    await new Promise(resolve => setTimeout(resolve, 300))
    sendJson(res, 200, { ok: true, data: 'late' })
  })
  return router
}

test('a GET invocation returns parsed JSON with the ok/data envelope', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/dsh-xiaozhi/api/v1')
  const response = await invoker.invoke({ method: 'GET', path: '/echo', query: { q: 'hello' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.deepEqual(response.json.data, { echo: 'hello' })
  // The copied router stamps every envelope, so callers must tolerate it.
  assert.equal(typeof response.json.timestamp, 'number')
})

test('query values are appended to the synthesised URL', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  const response = await invoker.invoke({
    method: 'GET',
    path: '/echo',
    query: { q: 'a b', skip: undefined, n: 3, flag: true },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.data.echo, 'a b')
})

test('a POST body reaches the route parsed, and the stream is drained once', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  const response = await invoker.invoke({
    method: 'POST',
    path: '/submit',
    body: { prompt: '你好', nested: { a: [1, 2] } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.data.received, { prompt: '你好', nested: { a: [1, 2] } })
  assert.equal(response.json.data.method, 'POST')
  assert.equal(response.json.data.url, '/base/submit')

  // A route that re-reads the already-drained stream hangs forever (the
  // `readJsonBody` helper waits for an 'end' that already fired). That is
  // exactly why every copied route takes the parsed `body` argument: the
  // invoker must surface a 504 instead of stalling the MCP call.
  const stale = new HttpRouter({ cors: false, apiKey: '' })
  stale.post('/stale', async (req, res) => {
    const again = await readJsonBody(req)
    sendJson(res, 200, { ok: true, data: { again } })
  })
  const staleInvoker = new LocalInvoker(stale, '/base')
  await assert.rejects(
    () => staleInvoker.invoke({ method: 'POST', path: '/stale', body: { a: 1 }, timeoutMs: 200 }),
    err => {
      assert.ok(err instanceof InvokeError)
      assert.equal(err.status, 504)
      assert.match(err.message, /timed out/i)
      return true
    },
  )
})

test('a streaming response is fully captured', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  const response = await invoker.invoke({ method: 'GET', path: '/stream' })
  assert.equal(response.status, 200)
  assert.equal(response.text, 'chunk-achunk-b')
  assert.equal(response.raw.length, 14)
})

test('a 4xx/5xx envelope becomes an InvokeError carrying the route error', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  await assert.rejects(
    () => invoker.invoke({ method: 'GET', path: '/boom' }),
    err => {
      assert.ok(err instanceof InvokeError)
      assert.equal(err.status, 500)
      assert.match(err.message, /exploded/)
      return true
    },
  )
})

test('an unrouted path is a 404 InvokeError, not a hang', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  await assert.rejects(
    () => invoker.invoke({ method: 'GET', path: '/nope' }),
    err => {
      assert.equal(err.status, 404)
      assert.match(err.message, /no route/i)
      return true
    },
  )
})

test('a route that never replies trips the timeout and aborts the capture', async () => {
  const router = new HttpRouter({ cors: false, apiKey: '' })
  router.get('/hang', async () => {
    /* deliberately never responds */
  })
  const invoker = new LocalInvoker(router, '/base')
  const before = Date.now()
  await assert.rejects(
    () => invoker.invoke({ method: 'GET', path: '/hang', timeoutMs: 120 }),
    err => {
      assert.equal(err.status, 504)
      return true
    },
  )
  assert.ok(Date.now() - before < 2000, 'the timeout fired promptly')
})

test('invokeData returns the data payload and rejects an ok:false envelope', async () => {
  const invoker = new LocalInvoker(makeRouter(), '/base')
  assert.deepEqual(await invoker.invokeData({ method: 'GET', path: '/echo', query: { q: 'x' } }), { echo: 'x' })
  // A route that answers `{ok:true}` with no `data` key yields undefined, which
  // is why capability handlers must tolerate a missing payload.
  assert.equal(await invoker.invokeData({ method: 'GET', path: '/missing-data' }), undefined)

  const failing = new HttpRouter({ cors: false, apiKey: '' })
  failing.get('/nope', async (_req, res) => {
    sendJson(res, 200, { ok: false, error: 'capability refused' })
  })
  await assert.rejects(
    () => new LocalInvoker(failing, '/base').invokeData({ method: 'GET', path: '/nope' }),
    err => {
      assert.equal(err.status, 200)
      assert.match(err.message, /capability refused/)
      return true
    },
  )
})

test('CaptureResponse mimics the ServerResponse surface the DSH routes use', async () => {
  const capture = new CaptureResponse()
  assert.equal(capture.headersSent, false)
  capture.setHeader('Content-Type', 'application/json; charset=utf-8')
  capture.writeHead(201, { 'X-Extra': 'yes' })
  assert.equal(capture.headersSent, true)
  assert.equal(capture.statusCode, 201)
  assert.equal(capture.getHeader('content-type'), 'application/json; charset=utf-8')
  assert.equal(capture.getHeader('x-extra'), 'yes')
  capture.removeHeader('x-extra')
  assert.equal(capture.getHeader('x-extra'), undefined)
  capture.write('{"a":')
  capture.end('1}')
  const result = await capture.done
  assert.equal(result.status, 201)
  assert.equal(result.raw.toString('utf8'), '{"a":1}')
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(capture.writableEnded, true)
})

test('a capture error rejects done instead of crashing the host', async () => {
  // A stream that fails mid-pipe (an aborted file read) emits 'error' on the
  // response. Without the constructor's listener that would be an unhandled
  // 'error' event and would take the whole DSH host down.
  const capture = new CaptureResponse()
  const settled = capture.done.then(
    () => 'resolved',
    err => err,
  )
  capture.emit('error', new Error('pipe failed'))
  const err = await settled
  assert.ok(err instanceof Error, 'done must reject with the stream error')
  assert.match(err.message, /pipe failed/)
})
