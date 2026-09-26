/**
 * Multi-device endpoint tests.
 *
 * Binding several Xiaozhi devices is the feature; these tests pin the three
 * layers it touches: config normalisation and secret handling
 * (`normalizeEndpoints` / `effectiveEndpoints` / `mergeMaskedEndpoints`), and
 * the per-device transport that dials exactly its own URL with its own headers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  hashEndpointId,
  mergeMaskedEndpoints,
  normalizeEndpoints,
  effectiveEndpoints,
  redactConfig,
  resolveConfig,
  SECRET_MASK,
} from '../lib/config.js'
import { EndpointTransport, TransportStatus } from '../lib/transports.js'

const URL_A = 'wss://api.xiaozhi.me/mcp/?token=aaa'
const URL_B = 'wss://api2.xiaozhi.me/mcp/?token=bbb'
const MASKED_A = 'wss://api.xiaozhi.me/mcp/?token=***'

test('normalizeEndpoints assigns stable ids, keeps names and dedupes collisions', () => {
  const devices = normalizeEndpoints([
    { url: URL_A, name: ' 客厅 ', headers: { Authorization: 'Bearer x' } },
    { id: 'mine', url: URL_B },
    'not an object',
    null,
    { url: '' },
    { url: URL_A },
  ])

  assert.deepEqual(
    devices.map(device => device.id),
    [hashEndpointId(URL_A), 'mine', 'ep-new', `${hashEndpointId(URL_A)}-2`],
    'ids must be deterministic, and a repeated URL must not collide',
  )
  assert.equal(devices[0].name, '客厅', 'names are trimmed')
  assert.deepEqual(devices[0].headers, { Authorization: 'Bearer x' })
  assert.equal(devices[1].name, undefined, 'an absent name stays absent')
  assert.equal(devices[2].url, '')
})

test('effectiveEndpoints prefers the device list and synthesises one from the legacy URL', () => {
  const fromList = effectiveEndpoints(
    resolveConfig({ endpoints: [{ url: URL_A }], endpointUrl: URL_B, homeDir: '/tmp/dsh-xiaozhi-test' }),
  )
  assert.deepEqual(fromList.map(device => device.url), [URL_A], 'a non-empty list wins over the legacy key')

  const fromLegacy = effectiveEndpoints(
    resolveConfig({ endpointUrl: URL_B, endpointHeaders: { Authorization: 'Bearer y' }, homeDir: '/tmp/dsh-xiaozhi-test' }),
  )
  assert.deepEqual(fromLegacy, [{ id: hashEndpointId(URL_B), url: URL_B, headers: { Authorization: 'Bearer y' } }])

  assert.deepEqual(effectiveEndpoints(resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' })), [])
})

test('redactConfig masks every device URL and header, including the legacy device', () => {
  const resolved = resolveConfig({
    endpoints: [
      { id: 'ep-1', name: '客厅', url: URL_A, headers: { Authorization: 'Bearer x' } },
      { id: 'ep-2', url: URL_B },
    ],
    homeDir: '/tmp/dsh-xiaozhi-test',
  })
  const redacted = redactConfig(resolved)
  assert.deepEqual(
    redacted.endpoints,
    [
      { id: 'ep-1', name: '客厅', url: MASKED_A, headers: { Authorization: SECRET_MASK } },
      { id: 'ep-2', url: 'wss://api2.xiaozhi.me/mcp/?token=***' },
    ],
    'no real token may survive redaction',
  )

  const legacy = redactConfig(resolveConfig({ endpointUrl: URL_A, homeDir: '/tmp/dsh-xiaozhi-test' }))
  assert.deepEqual(
    legacy.endpoints.map(device => device.url),
    [MASKED_A],
    'the legacy single-URL config must surface as a redacted device',
  )
})

test('mergeMaskedEndpoints restores masked URLs and headers from the stored config', () => {
  // `mergeMaskedEndpoints` reads the stored overrides from disk, so stage them.
  const storeDir = '/tmp/dsh-xiaozhi-endpoints-test'
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(
    path.join(storeDir, 'settings.json'),
    `${JSON.stringify({
      endpoints: [{ id: 'ep-1', name: '客厅', url: URL_A, headers: { Authorization: 'Bearer x', 'X-Old': 'keep' } }],
    }, null, 2)}\n`,
  )
  try {
    const rowConfig = { homeDir: storeDir }

    const byId = mergeMaskedEndpoints(rowConfig, {
      endpoints: [{
        id: 'ep-1', name: '客厅', url: MASKED_A,
        headers: { Authorization: SECRET_MASK, 'X-New': 'n' },
      }],
    })
    assert.deepEqual(byId.endpoints, [
      // An absent header key means "remove it"; only a masked value restores.
      { id: 'ep-1', name: '客厅', url: URL_A, headers: { Authorization: 'Bearer x', 'X-New': 'n' } },
    ])
    assert.equal(byId.dropped, 0)

    // No id (config written before ids existed): the masked URL identifies the row.
    const byMaskedUrl = mergeMaskedEndpoints(rowConfig, { endpoints: [{ url: MASKED_A }] })
    assert.deepEqual(byMaskedUrl.endpoints.map(device => device.url), [URL_A])

    // An unmasked URL replaces the stored one; masked headers then restore from
    // the same stored device.
    const edited = mergeMaskedEndpoints(rowConfig, {
      endpoints: [{ id: 'ep-1', url: URL_B, headers: { Authorization: SECRET_MASK } }],
    })
    assert.deepEqual(edited.endpoints[0].url, URL_B)
    assert.deepEqual(edited.endpoints[0].headers, { Authorization: 'Bearer x' })

    // A masked URL matching nothing stored cannot be restored - drop it rather
    // than persisting a literal "***" token that could never connect.
    const unrestorable = mergeMaskedEndpoints(rowConfig, {
      endpoints: [{ url: 'wss://unknown.host/mcp/?token=***' }],
    })
    assert.deepEqual(unrestorable.endpoints, [])
    assert.equal(unrestorable.dropped, 1)
  } finally {
    rmSync(storeDir, { recursive: true, force: true })
  }
})

test('mergeMaskedEndpoints ignores a patch without an endpoints array', () => {
  const result = mergeMaskedEndpoints({ homeDir: '/tmp/dsh-xiaozhi-endpoints-test' }, { serverName: 'DSH' })
  assert.deepEqual(result, { dropped: 0 })
  assert.equal('endpoints' in result, false)
})

test('each device transport dials its own URL with merged headers and reports its own state', async () => {
  const dials = []
  const fakeConnect = async (url, options) => {
    dials.push({ url, headers: options.headers })
    return {
      send: () => true,
      ping: () => true,
      close: () => {},
      closed: false,
      bufferedAmount: 0,
      onMessage() {},
      onClose() {},
      onError() {},
      onPong() {},
    }
  }
  const resolved = resolveConfig({
    endpoints: [
      { id: 'ep-1', name: '客厅', url: URL_A, headers: { Authorization: 'Bearer device' } },
      { url: URL_B },
    ],
    endpointHeaders: { 'X-Global': 'g' },
    homeDir: '/tmp/dsh-xiaozhi-test',
  })
  const devices = effectiveEndpoints(resolved)
  assert.equal(devices.length, 2)

  const transports = devices.map(device => {
    const status = new TransportStatus()
    const live = () => effectiveEndpoints(resolved).find(candidate => candidate.id === device.id)
    return new EndpointTransport({
      config: () => resolved,
      url: () => live()?.url ?? device.url,
      headers: () => ({ ...resolved.endpointHeaders, ...(live()?.headers ?? device.headers ?? {}) }),
      describe: { id: device.id, name: device.name },
      status,
      // The transport only needs a close-able handle for stop/reconnect.
      createSession: () => ({ close() {} }),
      log: () => {},
      connect: fakeConnect,
    })
  })

  transports[0].start()
  transports[1].start()
  await new Promise(resolve => setTimeout(resolve, 20))
  // Read the snapshots while the transports are still alive: stop() resets to idle.
  const snapshots = transports.map(transport => transport.snapshot())
  for (const transport of transports) transport.stop()

  assert.deepEqual(dials, [
    { url: URL_A, headers: { 'X-Global': 'g', Authorization: 'Bearer device' } },
    { url: URL_B, headers: { 'X-Global': 'g' } },
  ], 'every device dials its own access point, with device headers overriding the global ones')

  assert.equal(snapshots[0].state, 'ready')
  assert.equal(snapshots[0].id, 'ep-1')
  assert.equal(snapshots[0].name, '客厅')
  assert.equal(snapshots[0].endpointUrl, MASKED_A)
  assert.equal(snapshots[1].name, undefined, 'an unnamed device stays unnamed')
})

test('a device without a URL stays idle with a readable error', async () => {
  const status = new TransportStatus()
  const transport = new EndpointTransport({
    config: () => resolveConfig({ homeDir: '/tmp/dsh-xiaozhi-test' }),
    url: () => '',
    status,
    createSession: () => ({ close() {} }),
    log: () => {},
  })
  transport.start()
  await new Promise(resolve => setTimeout(resolve, 5))
  transport.stop()
  assert.equal(status.state, 'idle')
  assert.match(status.lastError ?? '', /未配置/)
})
