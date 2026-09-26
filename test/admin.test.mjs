/**
 * Settings-page API tests.
 *
 * This file exists because the admin router shipped without any test, and two
 * bugs reached the running GUI:
 *
 *   1. the page called `request('/test')` with no method, so the POST-only
 *      route 404d as "Endpoint not found: /dsh-xiaozhi/admin/test";
 *   2. the status badge compared against `connected`/`listening` while the Host
 *      transport reports `ready`, so a healthy connection rendered in the error
 *      colour.
 *
 * The first of those is now structurally impossible to reintroduce: the test
 * extracts the calls the page actually makes and dispatches each one through
 * the real router with the method the page uses.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAdminRouter } from '../lib/admin.js'
import { LocalInvoker } from '../lib/dispatcher.js'
import { ADMIN_BASE, ADMIN_CSRF_HEADER } from '../lib/shared.js'
import { swapRuntime } from '../lib/index.js'
import { SECRET_MASK } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** The routes the Host registers, as (method, path) pairs. */
const ROUTES = [
  ['GET', '/status'],
  ['PATCH', '/config'],
  ['POST', '/config/reset'],
  ['GET', '/tools'],
  ['GET', '/capabilities'],
  ['GET', '/logs'],
  ['POST', '/reconnect'],
  ['POST', '/test'],
]

function makeDeps(overrides = {}) {
  const calls = { patched: [], logged: [] }
  const deps = {
    status: async () => ({ state: 'ready', transport: { state: 'ready', mode: 'endpoint' } }),
    patchConfig: async patch => {
      calls.patched.push(patch)
      return { state: 'ready' }
    },
    resetConfig: async () => ({ state: 'ready' }),
    tools: () => ({ count: 3, tools: [] }),
    capabilities: () => ({ total: 35 }),
    logs: () => ['a log line'],
    reconnect: async () => ({ reconnected: true }),
    test: async () => ({ ok: true, message: 'handshake completed' }),
    log: message => calls.logged.push(message),
    ...overrides,
  }
  return { deps, calls }
}

const invokerFor = deps => new LocalInvoker(createAdminRouter(deps), ADMIN_BASE)
const csrf = { [ADMIN_CSRF_HEADER]: '1' }

/**
 * `LocalInvoker` is a capability invoker: it throws `InvokeError` for any
 * non-2xx answer. These tests assert on statuses deliberately, so normalise the
 * throw back into a response shape.
 */
async function call(invoker, request) {
  try {
    const response = await invoker.invoke(request)
    return { status: response.status, json: response.json, headers: response.headers }
  } catch (err) {
    if (err && typeof err.status === 'number') {
      return { status: err.status, json: err.body, headers: {} }
    }
    throw err
  }
}

/** The (method, path) pairs the browser half actually calls. */
function clientCalls() {
  const source = readFileSync(path.join(root, 'client/client.js'), 'utf8')
  const calls = []
  for (const match of source.matchAll(/request\(\s*'([^']+)'/g)) {
    const start = match.index + match[0].length
    // The first ')' after the path closes this call: no path contains one, and
    // the options object only nests braces, never parentheses.
    const end = source.indexOf(')', start)
    const window = source.slice(start, end === -1 ? source.length : end + 1)
    const method = /method:\s*'(\w+)'/.exec(window)?.[1] ?? 'GET'
    calls.push([method, match[1]])
  }
  return calls
}

test('the page only calls routes that exist, with the method they are registered for', async () => {
  const calls = clientCalls()
  assert.ok(calls.length >= 8, `only found ${calls.length} admin calls in the page`)

  const registered = new Set(ROUTES.map(([method, route]) => `${method} ${route}`))
  const unregistered = calls.filter(([method, route]) => !registered.has(`${method} ${route}`))
  assert.deepEqual(
    unregistered,
    [],
    'the page calls an admin route with a method it is not registered for (this is the /test 404 regression)',
  )

  // And the other direction: a registered route nobody calls is dead weight.
  const called = new Set(calls.map(([method, route]) => `${method} ${route}`))
  const unused = ROUTES.filter(([method, route]) => !called.has(`${method} ${route}`))
  assert.deepEqual(unused, [], 'no admin route may be registered without the page calling it')
})

test('the /test route answers POST and rejects GET', async () => {
  const { deps } = makeDeps()
  const invoker = invokerFor(deps)

  const ok = await call(invoker, { method: 'POST', path: '/test', headers: csrf, body: {} })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.data.message, 'handshake completed')

  // The exact shape of the reported bug: the page sent GET.
  await assert.rejects(
    () => invoker.invoke({ method: 'GET', path: '/test', headers: csrf }),
    err => err.status === 404 && /no route for GET \/test/.test(err.message),
    'a GET on the POST-only route must be a route miss, which is what the page reported',
  )
})

test('every admin route answers with the ok/data envelope', async () => {
  const { deps, calls } = makeDeps()
  const invoker = invokerFor(deps)

  for (const [method, route] of ROUTES) {
    const response = await call(invoker, {
      method,
      path: route,
      headers: csrf,
      body: method === 'PATCH' ? { serverName: 'DSH-test' } : method === 'POST' ? {} : undefined,
    })
    assert.equal(response.status, 200, `${method} ${route} should be 200`)
    assert.equal(response.json.ok, true, `${method} ${route} should report ok`)
    assert.ok('data' in response.json, `${method} ${route} should carry data`)
  }
  assert.equal(calls.patched.length, 1)
})

test('every guard refuses before the handler runs', async () => {
  // Missing CSRF header - reads included, so the API cannot even be enumerated.
  {
    const { deps, calls } = makeDeps()
    const invoker = invokerFor(deps)
    const response = await call(invoker, { method: 'GET', path: '/status' })
    assert.equal(response.status, 403)
    assert.equal(response.json.code, 'FORBIDDEN_CSRF')
    assert.equal(calls.logged.filter(line => line.includes('missing')).length, 1)
  }

  // Cross-site Origin.
  {
    const { deps } = makeDeps()
    const invoker = invokerFor(deps)
    const response = await call(invoker, {
      method: 'GET',
      path: '/status',
      headers: { ...csrf, origin: 'https://evil.example' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.json.code, 'FORBIDDEN_ORIGIN')
  }

  // Same-origin Origin is allowed.
  {
    const { deps } = makeDeps()
    const invoker = invokerFor(deps)
    const response = await call(invoker, {
      method: 'GET',
      path: '/status',
      headers: { ...csrf, host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    })
    assert.equal(response.status, 200)
  }

  // The browser's own site-relationship hint.
  {
    const { deps } = makeDeps()
    const invoker = invokerFor(deps)
    const response = await call(invoker, {
      method: 'GET',
      path: '/status',
      headers: { ...csrf, 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.json.code, 'FORBIDDEN_ORIGIN')
  }
})

test('the host connection fence wins, and a throwing fence never allows', async () => {
  // A rejection from the Host connection service is reported verbatim.
  {
    const { deps } = makeDeps({ connectionRejection: () => 401 })
    const invoker = invokerFor(deps)
    const response = await call(invoker, { method: 'GET', path: '/status', headers: csrf })
    assert.equal(response.status, 401)
    assert.equal(response.json.code, 'FORBIDDEN_HOST')
  }

  // `undefined` means "this fence has no opinion", so the plugin's own guards run.
  {
    const { deps } = makeDeps({ connectionRejection: () => undefined })
    const invoker = invokerFor(deps)
    const response = await call(invoker, { method: 'GET', path: '/status', headers: csrf })
    assert.equal(response.status, 200)
  }

  // A fence that throws cannot vouch for the request: `undefined` is not "allow",
  // it is "cannot judge", so the CSRF layer still has to pass.
  {
    const { deps } = makeDeps({
      connectionRejection: () => {
        throw new Error('connection service unavailable')
      },
    })
    const invoker = invokerFor(deps)
    const refused = await call(invoker, { method: 'GET', path: '/status' })
    assert.equal(refused.status, 403)
    assert.equal(refused.json.code, 'FORBIDDEN_CSRF')

    const allowed = await call(invoker, { method: 'GET', path: '/status', headers: csrf })
    assert.equal(allowed.status, 200)
  }
})

test('PATCH /config drops masked sentinels instead of overwriting real secrets', async () => {
  const { deps, calls } = makeDeps()
  const invoker = invokerFor(deps)

  const response = await call(invoker, {
    method: 'PATCH',
    path: '/config',
    headers: csrf,
    body: {
      apiKey: SECRET_MASK,
      serverToken: SECRET_MASK,
      endpointUrl: 'wss://api.xiaozhi.me/mcp/?token=***',
      endpointHeaders: { Authorization: SECRET_MASK, 'X-Keep': 'kept' },
      serverName: 'renamed',
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls.patched, [{ endpointHeaders: { 'X-Keep': 'kept' }, serverName: 'renamed' }])
})

test('PATCH /config forwards device rows to the config layer untouched', async () => {
  // Masked URLs inside `endpoints` are resolved by the config layer (against
  // the stored overrides), which these mocked deps stand in for; the router
  // must not drop or rewrite the rows on the way through.
  const { deps, calls } = makeDeps()
  const invoker = invokerFor(deps)
  const endpoints = [
    { id: 'ep-1', name: '客厅', url: 'wss://api.xiaozhi.me/mcp/?token=***' },
    { id: 'ep-2', url: 'wss://other.host/mcp/?token=real' },
  ]
  const response = await call(invoker, {
    method: 'PATCH',
    path: '/config',
    headers: csrf,
    body: { endpoints, endpointUrl: '' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.patched, [{ endpoints, endpointUrl: '' }])
})

test('reconnect and test forward the scoping body to the host deps', async () => {
  const seen = { reconnect: [], test: [] }
  const { deps } = makeDeps({
    reconnect: async body => {
      seen.reconnect.push(body)
      return { reconnected: true }
    },
    test: async body => {
      seen.test.push(body)
      return { ok: true, message: 'handshake completed' }
    },
  })
  const invoker = invokerFor(deps)

  await call(invoker, { method: 'POST', path: '/reconnect', headers: csrf, body: { id: 'ep-1' } })
  await call(invoker, { method: 'POST', path: '/reconnect', headers: csrf, body: {} })
  await call(invoker, { method: 'POST', path: '/test', headers: csrf, body: { url: 'wss://x/mcp/?token=t' } })
  await call(invoker, { method: 'POST', path: '/test', headers: csrf, body: {} })

  assert.deepEqual(seen.reconnect, [{ id: 'ep-1' }, {}])
  assert.deepEqual(seen.test, [{ url: 'wss://x/mcp/?token=t' }, {}])
})

test('PATCH /config rejects a non-object body', async () => {
  const cases = [null, [], 'text', 42]
  for (const body of cases) {
    const { deps, calls } = makeDeps()
    const invoker = invokerFor(deps)
    const response = await call(invoker, { method: 'PATCH', path: '/config', headers: csrf, body })
    assert.equal(response.status, 400, `body ${JSON.stringify(body)} should be refused`)
    assert.equal(response.json.code, 'BAD_REQUEST')
    assert.deepEqual(calls.patched, [])
  }
})

test('a throwing handler is reported as ADMIN_ERROR, not as a crash', async () => {
  const { deps, calls } = makeDeps({
    test: async () => {
      throw new Error('handshake exploded')
    },
  })
  const invoker = invokerFor(deps)
  const response = await call(invoker, { method: 'POST', path: '/test', headers: csrf, body: {} })
  assert.equal(response.status, 500)
  assert.equal(response.json.code, 'ADMIN_ERROR')
  assert.equal(response.json.error, 'handshake exploded')
  assert.ok(calls.logged.some(line => line.includes('handshake exploded')))
})

test('no admin response ever carries a permissive CORS header', async () => {
  const { deps } = makeDeps()
  const invoker = invokerFor(deps)
  const response = await call(invoker, { method: 'GET', path: '/status', headers: csrf })
  const headerNames = Object.keys(response.headers).map(name => name.toLowerCase())
  assert.deepEqual(headerNames.filter(name => name.startsWith('access-control-')), [])
})

test('restarting the runtime disposes the old routes before booting new ones', () => {
  // Regression: saving any setting called `restart()`, which booted the new
  // runtime while the old web routes were still mounted. The DSH web server
  // threw `duplicate prefix route "/dsh-xiaozhi/admin"`, the old runtime was
  // then disposed on the way out, and the plugin was left with no transport and
  // no admin API until the Host reloaded it.
  const mounted = new Set()
  const server = {
    register(kind, path) {
      const key = `${kind} ${path}`
      if (mounted.has(key)) throw new Error(`webserver: duplicate prefix route "${path}"`)
      mounted.add(key)
      return () => mounted.delete(key)
    },
  }

  const boot = () => {
    const disposers = [server.register('prefix', ADMIN_BASE)]
    if (true) disposers.push(server.register('prefix', '/dsh-xiaozhi/api/v1'))
    return { dispose: () => disposers.forEach(dispose => dispose()) }
  }

  const logs = []
  const log = message => logs.push(message)

  let runtime = swapRuntime(undefined, boot, log)
  assert.equal(mounted.size, 2)

  // Two saves in a row: the shape that used to throw.
  runtime = swapRuntime(runtime, boot, log)
  assert.equal(mounted.size, 2, 'a restart must not leave two registrations mounted')
  runtime = swapRuntime(runtime, boot, log)
  assert.equal(mounted.size, 2)
  assert.deepEqual(logs, [], 'a successful restart must not log a failure')

  // A runtime that fails to boot is disposed, reported and rethrown so the
  // settings page tells the user instead of pretending the save worked.
  const failing = swapRuntime.bind(null, { dispose: () => mounted.clear() })
  assert.throws(
    () => failing(() => { throw new Error('boom') }, log),
    /boom/,
  )
  assert.equal(mounted.size, 0, 'the failing boot must not leave the old routes mounted')
  assert.ok(logs.some(line => line.includes('boom')), 'the failure must be logged')
})

test('swapping runtimes releases the old routes even when the old one is absent', () => {
  const mounted = new Set()
  const boot = () => {
    const dispose = (() => { if (mounted.has('x')) throw new Error('already mounted'); mounted.add('x'); return () => mounted.delete('x') })()
    return { dispose }
  }
  const runtime = swapRuntime(undefined, boot, () => {})
  assert.equal(mounted.size, 1)
  runtime.dispose()
  assert.equal(mounted.size, 0)
})

test('the MCP transport is started only after the HTTP routes are mounted', () => {
  // Ordering contract. `webServer.register` throws on a duplicate path, so a
  // transport started *before* the routes are mounted would be orphaned with a
  // live socket and no owner - exactly the leak this plugin once had.
  const source = readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  const mounted = source.indexOf('admin API mounted at')
  const start = source.indexOf('serverTransport?.start()')
  assert.ok(mounted > 0, 'the route-mounting block must still exist')
  assert.ok(start > 0, 'the transport must still be started explicitly')
  assert.ok(start > mounted, 'the transports must start after the routes are mounted')
  assert.ok(
    source.includes('for (const device of endpointDevices) device.transport.start()'),
    'every bound device transport must start at that same place',
  )
  assert.equal(
    start,
    source.lastIndexOf('serverTransport?.start()'),
    'there must be exactly one place that starts the transports',
  )
})
