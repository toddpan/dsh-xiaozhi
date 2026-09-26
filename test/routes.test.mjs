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
    {
      // Production session ids carry the `session-` prefix; keep one here so
      // the short-id rendering and resolution cover the real shape.
      sessionId: 'session-deadbeef-1234-5678-9abc-def012345678',
      title: '性能排查',
      running: false,
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 1_800_000,
      lastActivityAt: Date.now() - 900_000,
    },
  ]
  const services = {
    workspaceRegistry: {
      list: () => workspaces,
      get: id => workspaces.find(item => item.id === id),
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      // The real controller throws for unknown sessions (the route turns that
      // into 404); a permissive inspect would mask the "silent empty history"
      // regression this suite pins.
      inspect: async id => {
        if (!sessions.some(item => item.sessionId === id)) {
          throw new Error(`Session '${id}' not found`)
        }
        return { meta: sessions.find(item => item.sessionId === id), events: [] }
      },
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

// ---------------------------------------------------------------------------
// Id resolution: the voice model only ever sees what the tool results showed
// it. These tests pin the shapes that flow is built on.
// ---------------------------------------------------------------------------

function makeResolvingRunner() {
  const config = resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })
  const runtime = new CapabilityRuntime({
    ctx: makeFakeContext(),
    invoker: makeInvoker(),
    config: () => config,
    apiBase: () => API_BASE,
    mcpStatus: () => ({}),
    log: () => {},
  })
  return new ToolRunner({ runtime, config: () => config })
}

test('session rows strip the `session-` prefix so short ids stay distinct', async () => {
  const runner = makeResolvingRunner()
  const listed = await runner.call('dsh_sessions', { action: 'list' })
  assert.equal(listed.isError, false)
  // `session-deadbeef-…` must render as `[deadbeef]`, not the useless
  // shared prefix `[session-]` that every production session used to show.
  assert.match(listed.content[0].text, /\[deadbeef\]/)
  assert.match(listed.content[0].text, /\[sess-123\]/)
  assert.doesNotMatch(listed.content[0].text, /\[session-\]/)
})

test('short ids, titles and full ids all resolve to the same session', async () => {
  const runner = makeResolvingRunner()

  const byShort = await runner.call('dsh_sessions', { action: 'get', id: 'deadbeef' })
  assert.equal(byShort.isError, false)
  assert.match(byShort.content[0].text, /性能排查/)

  const byTitle = await runner.call('dsh_sessions', { action: 'get', id: '性能排查' })
  assert.equal(byTitle.isError, false)
  assert.match(byTitle.content[0].text, /性能排查/)

  const byFull = await runner.call('dsh_sessions', { action: 'get', id: 'session-deadbeef-1234-5678-9abc-def012345678' })
  assert.equal(byFull.isError, false)
  assert.match(byFull.content[0].text, /性能排查/)
})

test('an ambiguous reference fails with the candidates, not a wrong session', async () => {
  const runner = makeResolvingRunner()
  // Both ids contain an `s`, so the fragment alone cannot pick one.
  const ambiguous = await runner.call('dsh_session_history', { id: 's' })
  assert.equal(ambiguous.isError, true)
  assert.match(ambiguous.content[0].text, /匹配到 2 个/)
  assert.match(ambiguous.content[0].text, /deadbeef/)
  assert.match(ambiguous.content[0].text, /sess-123/)
})

test('a missing session never answers “还没有历史消息”', async () => {
  const runner = makeResolvingRunner()
  const missing = await runner.call('dsh_session_history', { id: 'nosuchid' })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /找不到会话/)
  assert.doesNotMatch(missing.content[0].text, /还没有历史消息/)

  // Same for the progress tool: no confident "空闲" for a session that
  // does not exist.
  const progress = await runner.call('dsh_session_progress', { id: 'nosuchid' })
  assert.equal(progress.isError, true)
  assert.match(progress.content[0].text, /找不到会话/)
})

test('an existing-but-empty session still says it has no history', async () => {
  const runner = makeResolvingRunner()
  const empty = await runner.call('dsh_session_history', { id: '性能排查' })
  assert.equal(empty.isError, false)
  assert.match(empty.content[0].text, /还没有历史消息/)
})

test('workspace sessions matches controller items keyed by sessionId', async () => {
  const runner = makeResolvingRunner()
  // The controller list payload uses `sessionId`; the route must read that
  // spelling or every workspace would answer "没有会话".
  const listed = await runner.call('dsh_workspaces', { action: 'sessions', id: 'ws-abcdefgh' })
  assert.equal(listed.isError, false)
  assert.match(listed.content[0].text, /修复构建失败/)
  // The projection must map the controller's `sessionId` onto `id`, so the
  // row carries a usable short id instead of a literal "undefined".
  assert.match(listed.content[0].text, /\[sess-123\]/)
  assert.doesNotMatch(listed.content[0].text, /undefined/)
})

test('history skips text-less tool turns instead of reading “（无文本内容）”', async () => {
  const runner = makeResolvingRunner()
  // The copied history route projects only user/assistant text; with the fake
  // host returning none, the tool must not invent rows for empty content.
  const empty = await runner.call('dsh_session_history', { id: 'sess-1234abcd-5678' })
  assert.equal(empty.isError, false)
  assert.doesNotMatch(empty.content[0].text, /无文本内容/)
})
