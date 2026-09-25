/**
 * Route-mapping and tool-dispatch integration tests.
 *
 * The capability table was derived by reading the copied `dshapi/*` route
 * registrations, which makes a typo in a path the single most likely way to
 * ship a tool that silently 404s in production. So instead of stubbing the
 * REST layer, these tests build the **real** copied router over a fake host
 * context and assert that every capability reaches a matched route.
 *
 * The second half drives real grouped tools through the real capability
 * runtime, which covers the whole chain a voice request takes:
 *   tool name -> action -> capability id -> REST route -> voice-shaped text.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CAPABILITIES, CapabilityRuntime } from '../lib/capabilities.js'
import { createDshApiRouter } from '../lib/dshapi/service.js'
import { LocalInvoker, InvokeError } from '../lib/dispatcher.js'
import { ToolRunner } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

/** Capabilities with bespoke handlers that never touch a REST route. */
const BESPOKE = new Set(['system.status', 'sessions.events', 'docs.info', 'session.inspect'])

const API_BASE = '/dsh-xiaozhi/api/v1'

/** A host context with just enough shape for the copied routes to run. */
function makeFakeContext() {
  const workspaces = [
    { id: 'ws-abcdefgh-1234', path: '/tmp/demo-project', title: '演示项目', sessionIds: ['sess-1234abcd-5678'] },
  ]
  const sessions = [
    {
      sessionId: 'sess-1234abcd-5678',
      title: '修复构建失败',
      running: true,
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 120_000,
      lastActivityAt: Date.now() - 60_000,
    },
  ]
  const services = {
    workspaceRegistry: {
      list: () => workspaces,
      get: id => workspaces.find(item => item.id === id),
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async id => ({
        meta: sessions.find(item => item.sessionId === id) ?? { sessionId: id },
        events: [],
      }),
      listEvents: () => [],
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official', displayName: 'DeepSeek 官方' }],
    },
  }
  return {
    get: name => services[name],
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeInvoker() {
  const ctx = makeFakeContext()
  const router = createDshApiRouter(ctx, {
    pathPrefix: API_BASE,
    apiKey: '',
    cors: false,
    defaultCwd: '/tmp',
    maxUploadBytes: 1024 * 1024,
  })
  return new LocalInvoker(router, API_BASE)
}

/** Fill `:params` with plausible values so the path can be matched. */
function fillPath(spec) {
  return spec.path.replace(/:([a-zA-Z0-9_]+)/g, (_match, name) =>
    name === 'id' || name === 'sessionId' ? 'sess-1234abcd-5678' : 'demo-namespace',
  )
}

function sampleQuery(spec) {
  const query = {}
  for (const name of spec.queryParams) {
    if (name === 'seconds') query[name] = 1
    else if (name === 'path') query[name] = 'README.md'
    else if (name === 'filename') query[name] = 'note.txt'
  }
  return query
}

function sampleBody(spec) {
  if (spec.body !== 'json' && spec.body !== 'passthrough') return undefined
  const body = {}
  for (const field of spec.bodyFields) {
    if (field === 'prompt') body[field] = '你好'
    else if (field === 'answers') body[field] = []
    else if (field === 'patch') body[field] = {}
    else if (field === 'messages') body[field] = [{ role: 'user', content: '你好' }]
    else if (field === 'path') body[field] = '/tmp'
  }
  return body
}

test('every capability resolves to a registered route in the real router', async () => {
  const invoker = makeInvoker()
  const unmatched = []

  for (const spec of CAPABILITIES) {
    if (BESPOKE.has(spec.id)) continue
    const request = {
      method: spec.method,
      path: fillPath(spec),
      query: sampleQuery(spec),
      body: sampleBody(spec),
      // `sessions.events` is an SSE route that never ends on its own.
      timeoutMs: spec.id === 'sessions.events' ? 400 : 3000,
    }
    try {
      await invoker.invoke(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof InvokeError && err.status === 404 && /no route/i.test(message)) {
        unmatched.push(`${spec.id} -> ${spec.method} ${spec.path}`)
      }
      // Any other failure (missing host service, 500) still proves the route
      // exists and was reached, which is what this test is about.
    }
  }

  assert.deepEqual(unmatched, [], `capabilities without a route: ${unmatched.join(', ')}`)
})

test('the bundled REST layer answers its own docs and openapi routes', async () => {
  const invoker = makeInvoker()
  const docs = await invoker.invoke({ method: 'GET', path: '/docs' })
  assert.equal(docs.status, 200)
  assert.match(docs.headers['content-type'] ?? '', /text\/html/)

  const spec = await invoker.invoke({ method: 'GET', path: '/openapi.json' })
  assert.equal(spec.status, 200)
  const parsed = JSON.parse(spec.text)
  assert.equal(parsed.openapi, '3.0.0')
  assert.ok(Object.keys(parsed.paths).length > 10, 'the spec documents the route surface')
})

test('the bundled REST layer also serves the bespoke system status route', async () => {
  // The reference plugin answers `GET /system/status` from its own code, not
  // from the copied route modules, so the mirror has to add it back. Without
  // this the REST layer served 34 of the 35 endpoints - and the smoke-test curl
  // in INSTALL.md returned 404.
  const invoker = makeInvoker()
  const status = await invoker.invoke({ method: 'GET', path: '/system/status' })
  assert.equal(status.status, 200)
  const parsed = JSON.parse(status.text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.name, 'dsh-xiaozhi')
  assert.equal(parsed.data.status, 'running')
  assert.ok(Array.isArray(parsed.data.providers), 'the payload lists the providers')
  assert.equal(typeof parsed.data.workspacesCount, 'number')
  assert.equal(typeof parsed.timestamp, 'number', 'sendJson stamps the envelope')
})

test('a read-only tool refuses write actions and stays usable for reads', async () => {
  const config = resolveConfig({ allowWriteTools: false, homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({ mode: 'endpoint', state: 'ready' }),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config })

  const listed = await runner.call('dsh_workspaces', { action: 'list' })
  assert.equal(listed.isError, false)
  assert.match(listed.content[0].text, /演示项目/)

  const created = await runner.call('dsh_workspaces', { action: 'create', path: '/tmp/x' })
  assert.equal(created.isError, true)
  assert.match(created.content[0].text, /写入类工具已关闭/)
})

test('grouped tools render voice-shaped text from the live host services', async () => {
  const config = resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({ mode: 'endpoint', state: 'ready', toolCount: 16 }),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config })

  // Every tool the grouped weaving exposes must at least answer its list action
  // without an internal error, so a speech model never gets "unknown failure".
  const sessions = await runner.call('dsh_sessions', { action: 'list' })
  assert.equal(sessions.isError, false)
  assert.match(sessions.content[0].text, /修复构建失败/)
  assert.match(sessions.content[0].text, /运行中/)
  // Ids are shortened so the model can echo them back reliably.
  assert.match(sessions.content[0].text, /\[sess-123\]/)

  const workspaces = await runner.call('dsh_workspaces', { action: 'list' })
  assert.equal(workspaces.isError, false)
  assert.match(workspaces.content[0].text, /演示项目/)
  assert.match(workspaces.content[0].text, /1 个会话/)

  const status = await runner.call('dsh_status', {})
  assert.equal(status.isError, false)
  assert.match(status.content[0].text, /小智 MCP/)
})

test('tool results are always single text blocks clipped for speech', async () => {
  const config = resolveConfig({ maxVoiceChars: 120, homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config })

  for (const tool of runner.list()) {
    const result = await runner.call(tool.name, { action: 'list' })
    assert.equal(result.content.length, 1, `${tool.name} returned multiple content blocks`)
    assert.equal(result.content[0].type, 'text')
    assert.ok(result.content[0].text.length > 0, `${tool.name} returned empty text`)
    assert.ok(
      result.content[0].text.length <= 140,
      `${tool.name} text was not clipped to the voice budget (${result.content[0].text.length} chars)`,
    )
  }
})

test('an unknown tool name answers with the available list instead of failing hard', async () => {
  const config = resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config })
  const result = await runner.call('dsh_does_not_exist', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /没有名为 dsh_does_not_exist 的工具/)
  assert.match(result.content[0].text, /dsh_status/)
})

test('the Xiaozhi-sanitised spelling of a tool name still resolves', async () => {
  const config = resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })
  const logs = []
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config, log: message => logs.push(message) })

  // A platform that mangles punctuation must still reach the same tool.
  const result = await runner.call('dsh.session.history', { id: 'sess-1234abcd-5678' })
  assert.equal(result.isError, false)
  assert.ok(logs.some(line => line.includes('tool dsh_session_history')), 'the canonical tool ran')
})

test('tool call logging records the outcome and duration', async () => {
  const config = resolveConfig({ logToolCalls: true, homeDir: '/tmp/dsh-xiaozhi-test' })
  const logs = []
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config, log: message => logs.push(message) })
  await runner.call('dsh_status', {})
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^tool dsh_status ok in \d+ms args=\{\}/)
})

test('refresh() re-weaves the tool list after a config change', async () => {
  let config = resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  const runner = new ToolRunner({ runtime, config: () => config })
  const before = runner.list().length

  config = resolveConfig({ disabledGroups: ['workspaces', 'models'], homeDir: '/tmp/dsh-xiaozhi-test' })
  runner.refresh()
  const after = runner.list()

  assert.ok(after.length < before, 'disabling groups must shrink the tool list')
  assert.ok(after.every(tool => !tool.groups.includes('workspaces')))
})
