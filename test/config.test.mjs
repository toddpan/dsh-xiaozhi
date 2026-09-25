/**
 * Config-layering and secret-redaction tests.
 *
 * The settings page writes an override document that must merge over the
 * cordis row without ever losing a default, and nothing that leaves the process
 * (admin API, DSH log) may contain a token or API key.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULTS,
  SECRET_MASK,
  clearOverrides,
  isMaskedEndpoint,
  maskEndpoint,
  readOverrides,
  redactConfig,
  resolveConfig,
  resolveHomeDir,
  resolveSettingsFile,
  writeOverrides,
} from '../lib/config.js'

function withTempHome(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xiaozhi-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('defaults describe a loopback-free, endpoint-mode plugin', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'endpoint')
  assert.equal(config.toolMode, 'grouped')
  assert.equal(config.serverPath, '/mcp/xiaozhi')
  assert.equal(config.serverPort, 0)
  assert.equal(config.apiPathPrefix, '/dsh-xiaozhi/api')
  assert.equal(config.allowWriteTools, true)
  assert.equal(config.cors, false)
  assert.deepEqual(config.disabledGroups, [])
  // The sync prompt budget must stay below the streaming route's own timeout.
  assert.ok(config.promptTimeoutMs < 180_000)
})

test('row config overrides defaults, overrides override the row', () => {
  const row = { mode: 'server', serverPort: 8790, toolMode: 'flat' }
  const overrides = { serverPort: 9000, listLimit: 3 }
  const config = resolveConfig(row, overrides)
  assert.equal(config.mode, 'server')
  assert.equal(config.toolMode, 'flat')
  assert.equal(config.serverPort, 9000)
  assert.equal(config.listLimit, 3)
  // Untouched keys still come from the defaults.
  assert.equal(config.maxVoiceChars, DEFAULTS.maxVoiceChars)
})

test('endpointHeaders merge instead of replacing', () => {
  const config = resolveConfig(
    { endpointHeaders: { Authorization: 'Bearer a' } },
    { endpointHeaders: { 'X-Trace': 'b' } },
  )
  assert.deepEqual(config.endpointHeaders, { Authorization: 'Bearer a', 'X-Trace': 'b' })
})

test('invalid enum values fall back to the safe default', () => {
  const config = resolveConfig({ mode: 'nonsense', toolMode: 'sideways' })
  assert.equal(config.mode, 'endpoint')
  assert.equal(config.toolMode, 'grouped')
})

test('numeric fields are clamped to sane ranges', () => {
  const config = resolveConfig({
    promptTimeoutMs: -5,
    maxVoiceChars: 10,
    listLimit: 100000,
    reconnectMinMs: 5000,
    reconnectMaxMs: 100,
    heartbeatMs: 10,
  })
  assert.ok(config.promptTimeoutMs >= 5000)
  assert.ok(config.maxVoiceChars >= 100)
  assert.ok(config.listLimit <= 50)
  assert.ok(config.reconnectMaxMs >= config.reconnectMinMs)
  assert.ok(config.heartbeatMs >= 5000)
})

test('redactConfig masks every secret-shaped field', () => {
  const config = resolveConfig({
    apiKey: 'super-secret-key',
    serverToken: 'join-token',
    endpointUrl: 'wss://api.xiaozhi.me/mcp/?token=abc123&x=1',
    endpointHeaders: { Authorization: 'Bearer zzz', 'X-Trace': 'opaque-value' },
  })
  const redacted = redactConfig(config)
  assert.equal(redacted.apiKey, SECRET_MASK)
  assert.equal(redacted.serverToken, SECRET_MASK)
  // Every header VALUE is masked (we cannot know which names carry a secret),
  // but the names stay visible so the settings page can show what is configured.
  assert.deepEqual(Object.keys(redacted.endpointHeaders).sort(), ['Authorization', 'X-Trace'])
  assert.ok(Object.values(redacted.endpointHeaders).every(value => value === SECRET_MASK))
  // The URL keeps every other byte, so support can still see what was pasted.
  assert.equal(redacted.endpointUrl, 'wss://api.xiaozhi.me/mcp/?token=***&x=1')
  assert.ok(!redacted.endpointUrl.includes('abc123'), 'access-point token must be masked')
  assert.equal(isMaskedEndpoint(redacted.endpointUrl), true)
  assert.equal(isMaskedEndpoint('wss://api.xiaozhi.me/mcp/?token=real'), false)

  const serialised = JSON.stringify(redacted)
  for (const secret of ['super-secret-key', 'join-token', 'abc123', 'opaque-value']) {
    assert.ok(!serialised.includes(secret), `${secret} leaked into the admin payload`)
  }

  // A redacted config must never round-trip a sentinel back over the real value.
  assert.equal(isMaskedEndpoint(maskEndpoint(config.endpointUrl)), true)
})

test('overrides round-trip through the plugin home directory', () => {
  withTempHome(dir => {
    const row = { homeDir: dir }
    assert.deepEqual(readOverrides(row), {})
    assert.equal(resolveSettingsFile(row), join(dir, 'settings.json'))
    assert.equal(resolveHomeDir(row), dir)

    writeOverrides(row, { mode: 'server', serverPort: 8700 })
    assert.deepEqual(readOverrides(row), { mode: 'server', serverPort: 8700 })

    // A second write merges rather than clobbering.
    writeOverrides(row, { listLimit: 5 })
    assert.deepEqual(readOverrides(row), { mode: 'server', serverPort: 8700, listLimit: 5 })

    clearOverrides(row)
    assert.deepEqual(readOverrides(row), {})
  })
})

test('homeDir resolution honours DSH_HOME and the explicit override', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-test'
  try {
    assert.equal(resolveHomeDir({}), '/tmp/dsh-home-test/dsh-xiaozhi')
    assert.equal(resolveHomeDir({ homeDir: '/tmp/explicit' }), '/tmp/explicit')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
