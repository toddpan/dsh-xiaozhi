/**
 * Browser-half contract tests.
 *
 * `client/client.js` runs in the browser against the DSH module table, so most
 * of it can only be checked here by loading the module with a stub `window` and
 * a stub `require`, then rendering its sections with `react-dom/server`.
 *
 * The drift this file exists to catch: the two constants the browser half must
 * repeat (it cannot import a Host module), a missing translation key (which
 * would render as a raw dotted string in the UI), and a render crash in a
 * section. Skip-guarded on React so the suite still runs in a checkout without
 * it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

let React
let renderToStaticMarkup
try {
  React = require('react')
  renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
} catch {
  React = undefined
}

/** Load the browser bundle exactly as the DSH module table would. */
function loadClient() {
  const source = readFileSync(path.join(root, 'client/client.js'), 'utf8')
  let registered
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry
      },
    },
  }
  const factory = new Function('window', 'require', `${source}\nreturn window.__ModuleLoader__.__loaded`)
  const stubs = {
    react: React,
    'react/jsx-runtime': React ? require('react/jsx-runtime') : undefined,
  }
  const requireStub = name => {
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name]
    throw new Error(`the browser half required an unexpected module: ${name}`)
  }
  // `__ModuleLoader__.load` captures the entry; run the file, then call it.
  const loader = {
    load(entry) {
      registered = entry
      window.__ModuleLoader__.__loaded = entry
    },
  }
  new Function('window', 'require', source)({ __ModuleLoader__: loader }, requireStub)
  assert.ok(registered, 'client.js did not call window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-xiaozhi', 'the module id must equal the package name')
  const mod = registered.factory(requireStub)
  assert.ok(mod.__test, 'the bundle did not expose __test internals')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  return mod
}

const client = React ? loadClient() : undefined
const skip = React ? false : 'react/react-dom are unavailable in this checkout'

test('the browser half repeats the host constants exactly', () => {
  const shared = readFileSync(path.join(root, 'src/shared.ts'), 'utf8')
  const adminBase = /export const ADMIN_BASE = '([^']+)'/.exec(shared)
  const csrf = /export const ADMIN_CSRF_HEADER = '([^']+)'/.exec(shared)
  assert.ok(adminBase, 'ADMIN_BASE not found in src/shared.ts')
  assert.ok(csrf, 'ADMIN_CSRF_HEADER not found in src/shared.ts')
  assert.equal(client.__test.ADMIN_BASE, adminBase[1], 'ADMIN_BASE drifted from src/shared.ts')
  assert.equal(client.__test.CSRF_HEADER, csrf[1], 'ADMIN_CSRF_HEADER drifted from src/shared.ts')
})

test('the dictionaries are bilingual and complete', { skip }, () => {
  const { zh, en, FIELDS } = client.__test
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en must define the same keys')
  assert.ok(zhKeys.length > 60, 'the dictionaries look truncated')

  // Every key the form renders must exist, or the UI shows a raw dotted key.
  const missing = []
  for (const field of FIELDS) {
    for (const key of [field.label, field.hint].filter(Boolean)) {
      if (!(key in zh)) missing.push(key)
    }
    if (field.kind === 'enum') {
      for (const option of field.options) {
        const key = `connect.opt.${field.key}.${option}`
        if (!(key in zh)) missing.push(key)
      }
    }
  }
  // Tab and table headers are referenced by literal key in the components too.
  for (const key of [
    'nav', 'title', 'subtitle', 'refresh', 'save', 'saving', 'saved', 'reset', 'resetConfirm',
    'loading', 'loadFailed', 'retry', 'unknown', 'none', 'write', 'read',
    'tab.status', 'tab.connect', 'tab.tools', 'tab.caps', 'tab.logs',
    'status.connection', 'status.state', 'status.mode', 'status.endpoint', 'status.clients',
    'status.reconnects', 'status.lastError', 'status.lastConnected', 'status.warnings',
    'status.noWarnings', 'status.paths', 'status.adminApi', 'status.apiBase', 'status.docs',
    'status.openapi', 'status.tools', 'status.covered', 'status.pluginVersion',
    'status.settingsFile', 'status.uptime', 'status.test', 'status.testing',
    'status.reconnect', 'status.groupEnabled', 'status.groupDisabled',
    'connect.basics', 'connect.groups', 'connect.groupsHint', 'connect.advanced',
    'connect.headersInvalid', 'connect.numberInvalid', 'connect.saved', 'connect.resetDone',
    'connect.enabled.hint',
    'tools.title', 'tools.summary', 'tools.name', 'tools.kind', 'tools.groups', 'tools.caps',
    'tools.desc', 'tools.empty',
    'caps.title', 'caps.summary', 'caps.id', 'caps.route', 'caps.kind', 'caps.desc',
    'logs.title', 'logs.lines', 'logs.empty', 'logs.auto',
  ]) {
    if (!(key in zh)) missing.push(key)
  }
  assert.deepEqual([...new Set(missing)], [])
})

test('every translation key the bundle references exists', { skip }, () => {
  const { zh, en, FIELDS } = client.__test
  const source = readFileSync(path.join(root, 'client/client.js'), 'utf8')
  const referenced = new Set()

  // Literal keys: t('a.b'), including the ones only used inside a component.
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) referenced.add(match[1])
  // Keys built at runtime: the badge looks up `state.<transport.state>`, so
  // every state the shared map knows must have a label in both dictionaries.
  for (const state of Object.keys(client.__test.CONNECTION_TONES)) referenced.add(`state.${state}`)

  // Keys reached through a field descriptor.
  for (const field of FIELDS) {
    for (const key of [field.label, field.hint].filter(Boolean)) referenced.add(key)
    if (field.kind === 'enum') {
      for (const option of field.options) referenced.add(`connect.opt.${field.key}.${option}`)
    }
  }

  const missingZh = [...referenced].filter(key => !(key in zh)).sort()
  const missingEn = [...referenced].filter(key => !(key in en)).sort()
  assert.deepEqual(missingZh, [], 'keys referenced but missing from the zh dictionary')
  assert.deepEqual(missingEn, [], 'keys referenced but missing from the en dictionary')
  assert.ok(referenced.size > 60, `only found ${referenced.size} translation keys`)
})

test('a translation is registered for every key in both locales', { skip }, () => {
  const { zh, en } = client.__test
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim().length > 0, `zh.${key} is empty`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim().length > 0, `en.${key} is empty`)
  }
  // An en entry containing CJK is a copy-paste bug; identical zh/en strings are
  // allowed for things like "MCP".
  const cjk = /[\u4e00-\u9fff]/
  const untranslated = Object.entries(en).filter(([, value]) => cjk.test(value)).map(([key]) => key)
  assert.deepEqual(untranslated, [], 'English entries must not contain Chinese text')
})

test('toDraft / toPatch round-trip the live config', { skip }, () => {
  const { toDraft, toPatch } = client.__test
  const config = {
    enabled: true,
    mode: 'endpoint',
    endpointUrl: 'wss://api.xiaozhi.me/mcp/?token=***',
    endpointHeaders: { Authorization: '••••••' },
    toolMode: 'grouped',
    allowWriteTools: false,
    promptTimeoutMs: 120000,
    maxVoiceChars: 700,
    listLimit: 10,
    disabledGroups: ['docs'],
  }
  const draft = toDraft(config)
  assert.equal(draft.promptTimeoutMs, 120000)
  assert.equal(draft.endpointHeaders, '{"Authorization":"••••••"}')
  assert.deepEqual(draft.disabledGroups, ['docs'])

  const t = key => key
  const patch = toPatch(draft, config, t)
  assert.equal(patch.promptTimeoutMs, 120000)
  assert.equal(typeof patch.maxVoiceChars, 'number')
  assert.deepEqual(patch.endpointHeaders, { Authorization: '••••••' })
  assert.deepEqual(patch.disabledGroups, ['docs'])
  assert.equal(patch.endpointUrl, 'wss://api.xiaozhi.me/mcp/?token=***')
})

test('toPatch rejects a malformed header map and a non-numeric number', { skip }, () => {
  const { toDraft, toPatch } = client.__test
  const t = key => key
  const config = { endpointHeaders: {}, listLimit: 10 }

  const badJson = toDraft(config)
  badJson.endpointHeaders = '{not json'
  assert.throws(() => toPatch(badJson, config, t), /connect\.headersInvalid/)

  const badShape = toDraft(config)
  badShape.endpointHeaders = '["a"]'
  assert.throws(() => toPatch(badShape, config, t), /connect\.headersInvalid/)

  const badNumber = toDraft(config)
  badNumber.listLimit = 'ten'
  assert.throws(() => toPatch(badNumber, config, t), /connect\.numberInvalid/)
})

test('isDirty tracks edits without false positives', { skip }, () => {
  const { toDraft, isDirty } = client.__test
  const config = { enabled: true, listLimit: 10, endpointHeaders: { A: '••••••' }, disabledGroups: [] }
  const draft = toDraft(config)
  assert.equal(isDirty(draft, config), false, 'a fresh draft must not look dirty')

  const changed = Object.assign({}, draft, { listLimit: 20 })
  assert.equal(isDirty(changed, config), true)

  const toggled = Object.assign({}, draft, { disabledGroups: ['docs'] })
  assert.equal(isDirty(toggled, config), true)

  const retyped = Object.assign({}, draft, { listLimit: '10' })
  assert.equal(isDirty(retyped, config), false, 'a number retyped as text is not a change')

  const endedHeaders = Object.assign({}, draft, { endpointHeaders: '{"A":"••••••"}' })
  assert.equal(isDirty(endedHeaders, config), false, 're-serialised headers are not a change')
})

test('apply registers the section and its dictionaries', { skip }, () => {
  const injected = []
  const registered = []
  const effects = []
  const dictionaries = []
  const fakeCtx = {
    locale: {
      bind: () => key => key,
      register: (ns, dicts) => {
        dictionaries.push([ns, dicts])
        return () => {}
      },
    },
    slots: {
      // The real service invokes the factory once the slot is available, which
      // is what performs the inner register call.
      inject: (slot, factory) => {
        injected.push(slot)
        factory()
        return () => {}
      },
      register: (options, Component) => {
        registered.push([options, Component])
        return () => {}
      },
    },
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  client.apply(fakeCtx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0][0], 'dsh-xiaozhi')
  assert.ok(dictionaries[0][1].zh && dictionaries[0][1].en, 'both locales must be registered')

  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.length, 1, 'exactly one section must be registered')
  const options = registered[0][0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-xiaozhi')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof options.label(), 'string')
  assert.equal(typeof registered[0][1], 'function', 'the registration needs a component')
  assert.ok(effects.length >= 2)
  assert.ok(effects.every(label => typeof label === 'string' && label.includes('dsh-xiaozhi')))
})

test('the section renders a readable loading state', { skip }, () => {
  // Bind the real dictionary so the assertion sees the text a user would.
  const t = key => client.__test.zh[key] ?? key
  const html = renderToStaticMarkup(React.createElement(client.__test.Section, { t }))
  assert.match(html, /加载中/)
})

test('the status tab renders a live status payload', { skip }, () => {
  const t = key => key
  const status = {
    plugin: { name: 'dsh-xiaozhi', version: '0.1.0' },
    settingsFile: '/tmp/dsh-xiaozhi/settings.json',
    config: { enabled: true, mode: 'endpoint', endpointUrl: 'wss://api.xiaozhi.me/mcp/?token=***' },
    transport: {
      mode: 'endpoint',
      state: 'ready',
      endpoint: 'wss://api.xiaozhi.me/mcp/?token=***',
      clients: 1,
      reconnectAttempts: 2,
      lastConnectedAt: Date.now(),
    },
    tools: { mode: 'grouped', count: 16, names: ['dsh_status', 'dsh_say'] },
    groups: [
      { group: 'system', label: '系统', enabled: true, capabilityCount: 1 },
      { group: 'docs', label: '文档', enabled: false, capabilityCount: 2 },
    ],
    paths: {
      adminBase: '/dsh-xiaozhi/admin',
      apiBase: '/dsh-xiaozhi/api/v1',
      docsUrl: '/dsh-xiaozhi/api/v1/docs',
      openApiUrl: '/dsh-xiaozhi/api/v1/openapi.json',
    },
    warnings: ['未填写小智 MCP 接入点地址。'],
    uptimeSeconds: 42,
  }
  const html = renderToStaticMarkup(
    React.createElement(client.__test.StatusTab, {
      t, status, capabilities: { total: 35 }, busy: false, onRefresh() {}, onReconnect() {}, onTest() {},
    }),
  )
  assert.match(html, /0\.1\.0/)
  assert.match(html, /\/dsh-xiaozhi\/admin/)
  assert.match(html, /未填写小智 MCP 接入点地址/)
  // The badge shows the raw state when the dictionary has no label for it (this
  // test binds an identity `t`), and `ready` is what the Host actually reports.
  assert.match(html, />ready</)
  assert.match(html, /var\(--dsw-alias-state-success-primary\)/, 'a ready transport must render in the success colour')
  // The token must stay masked in the rendered page.
  assert.ok(!/token=[^&"<]*[A-Za-z0-9]{6}/.test(html.replace(/token=\*\*\*/g, 'token=***')))
})

test('the tools, capabilities and logs tabs render their payloads', { skip }, () => {
  const t = key => key
  const tools = {
    mode: 'grouped',
    count: 1,
    coveredCapabilities: ['system.status'],
    tools: [
      {
        name: 'dsh_status',
        description: '查看 DSH 与小智的连接状态。',
        write: false,
        groups: ['system'],
        capabilities: ['system.status'],
      },
    ],
  }
  const capabilities = {
    total: 1,
    groups: [
      {
        group: 'system',
        label: '系统',
        disabled: false,
        capabilities: [{ id: 'system.status', method: 'GET', path: '/system/status', write: false, summary: '连接状态' }],
      },
    ],
  }
  const toolsHtml = renderToStaticMarkup(React.createElement(client.__test.ToolsTab, { t, tools, capabilities }))
  assert.match(toolsHtml, /dsh_status/)
  assert.match(toolsHtml, /查看 DSH 与小智的连接状态/)

  const capsHtml = renderToStaticMarkup(
    React.createElement(client.__test.CapabilitiesTab, { t, capabilities, status: { tools: { names: ['dsh_status'] } } }),
  )
  assert.match(capsHtml, /GET \/system\/status/)

  const logsHtml = renderToStaticMarkup(
    React.createElement(client.__test.LogsTab, { t, logs: ['[dsh-xiaozhi] 启动'], auto: false, onAuto() {}, onRefresh() {} }),
  )
  assert.match(logsHtml, /\[dsh-xiaozhi\] 启动/)
})

test('the tools tab explains an empty tool list instead of rendering a blank table', { skip }, () => {
  const html = renderToStaticMarkup(
    React.createElement(client.__test.ToolsTab, { t: key => key, tools: { count: 0, tools: [], coveredCapabilities: [] }, capabilities: { total: 35 } }),
  )
  assert.match(html, /tools\.empty/)
})

test('the connection vocabulary and badge tones match the Host exactly', () => {
  const { CONNECTION_TONES } = client.__test
  const shared = readFileSync(path.join(root, 'src/shared.ts'), 'utf8')

  // Parse the Host map out of the source: the browser bundle cannot import it,
  // so textual parity is the only contract available.
  const block = shared.slice(shared.indexOf('CONNECTION_TONES'))
  const hostTones = {}
  for (const match of block.matchAll(/^\s{2}(\w+):\s*'(ok|warn|bad|idle)',/gm)) hostTones[match[1]] = match[2]

  assert.ok(Object.keys(hostTones).length >= 5, `parsed only ${Object.keys(hostTones).length} host tones`)
  assert.deepEqual(CONNECTION_TONES, hostTones, 'the page must mirror the Host connection tones')

  // The Host states are the source of truth for the union.
  const { CONNECTION_STATES } = { CONNECTION_STATES: Object.keys(hostTones) }
  for (const state of CONNECTION_STATES) {
    assert.ok(state in CONNECTION_TONES, `state ${state} has no badge tone`)
  }
  // A healthy connection must be green: this is the regression that shipped a
  // red badge for `ready`.
  assert.equal(CONNECTION_TONES.ready, 'ok', 'a ready connection must use the success tone')
})

test('a ready connection renders in the success colour, never the error colour', { skip }, () => {
  const { StatusTab, zh } = client.__test
  const render = transport =>
    renderToStaticMarkup(
      React.createElement(StatusTab, {
        t: key => zh[key] ?? key,
        status: { config: { enabled: true }, transport, tools: { count: 0, names: [] } },
        capabilities: { total: 35 },
      }),
    )

  // The exact regression the user hit: a healthy `ready` transport rendered red.
  const ready = render({ state: 'ready', mode: 'endpoint' })
  assert.match(ready, /state-success-primary/, 'a ready connection must use the success colour')
  assert.ok(!/state-error-primary/.test(ready), 'a ready connection must not use the error colour')
  assert.match(ready, /已连接/, 'the badge must be human readable')
  assert.match(ready, /ready/, 'the raw protocol state must stay visible')

  assert.match(render({ state: 'connecting', mode: 'endpoint' }), /state-warn-primary/)
  assert.match(render({ state: 'error', mode: 'endpoint' }), /state-error-primary/)
  assert.ok(!/state-success-primary/.test(render({ state: 'error', mode: 'endpoint' })))
  assert.match(render({ state: 'idle', mode: 'endpoint' }), /state-idle-primary/)
})

test('the status tab survives a payload that is missing config or transport', { skip }, () => {
  const { StatusTab } = client.__test
  const html = renderToStaticMarkup(
    React.createElement(StatusTab, { t: key => key, status: {}, capabilities: {} }),
  )
  assert.match(html, /status\.state/, 'the status row must still render')
  assert.ok(!/enabled=/.test(html), 'a missing enabled flag must not read as disabled')
  assert.ok(!/state-error-primary/.test(html), 'an empty payload must not claim a fault')
})

test('the browser half never imports a Host or primitives package', () => {
  const source = readFileSync(path.join(root, 'client/client.js'), 'utf8')
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(required)].sort(), ['react'])
  assert.ok(!source.includes('dsh-client-ui-primitives'), 'primitives must not be imported')
  // Styles must use theme tokens, never a hard-coded surface colour.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source.replace(/'#ffffff'/g, '')), 'only the brand-fill foreground may be a literal colour')
  assert.ok(source.includes('var(--dsw-alias-'), 'the page must style itself with theme tokens')
})

test('every theme token the page uses is a real token', () => {
  // The exact list Theme.listTokens reports for this runtime. A typo here is a
  // silently invisible style (an unresolved var() renders as nothing), so the
  // allow-list is pinned rather than merely pattern-checked.
  const LIVE_TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]
  const source = readFileSync(path.join(root, 'client/client.js'), 'utf8')
  const used = [...new Set(
    [...source.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)\s*\)/g)].map(match => match[1]),
  )].sort()

  assert.ok(used.length >= 8, `only found ${used.length} tokens in use`)
  const unknown = used.filter(token => !LIVE_TOKENS.includes(token))
  assert.deepEqual(unknown, [], 'these var() tokens do not exist in the theme')
  for (const token of used) {
    assert.ok(token.startsWith('--dsw-alias-'), `${token} is outside the alias token namespace`)
  }
})

test('the client manifest declares the browser entry and its inject list', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.equal(pkg.exports['./client'], './client/client.js')
})
