#!/usr/bin/env node
/**
 * Verify a Xiaozhi MCP access point for real: validate the URL, dial it, and let
 * this plugin's own `McpSession` answer the broker over the live socket.
 *
 * The access point token is a bearer credential for the whole tool surface, so
 * it is never printed - only redacted.
 *
 * Usage:
 *   node scripts/probe-endpoint.mjs                       # use the saved settings.json
 *   node scripts/probe-endpoint.mjs 'wss://.../?token=...' # or pass one explicitly
 *   DSH_XIAOZHI_ENDPOINT_URL='wss://...' node scripts/probe-endpoint.mjs
 *
 * Exit code 0 means the broker completed the MCP handshake and pulled the tool
 * list; 1 means it did not, with the reason on stderr.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { resolveConfig } from '../lib/config.js'
import { connectWebSocket } from '../lib/ws.js'
import { McpSession } from '../lib/mcp-server.js'
import { toolCallResult } from '../lib/protocol.js'
import { buildTools } from '../lib/tools.js'
import { validateEndpointUrl } from '../lib/index.js'

const redact = value => String(value).replace(/([?&]token=)[^&#]*/gi, '$1<redacted>')
const say = message => process.stdout.write(`${message}\n`)
const fail = message => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** The endpoint from argv, the environment, or the plugin's saved settings. */
function resolveUrl() {
  const explicit = process.argv[2] || process.env.DSH_XIAOZHI_ENDPOINT_URL
  if (explicit) return { url: explicit, from: 'argument' }

  const home = process.env.DSH_XIAOZHI_HOME
    || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'dsh-xiaozhi')
  try {
    const saved = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'))
    if (saved?.endpointUrl) return { url: String(saved.endpointUrl), from: `${home}/settings.json` }
  } catch {
    /* no saved settings yet */
  }
  return undefined
}

const target = resolveUrl()
if (!target) {
  fail('No endpoint. Pass one as an argument, set DSH_XIAOZHI_ENDPOINT_URL, or save one in the settings page.')
}

const verdict = validateEndpointUrl(target.url)
if (verdict) fail(`The access point is not acceptable: ${verdict}`)
say(`1) URL accepted (${target.from}): ${redact(target.url)}`)

const config = resolveConfig({ homeDir: process.env.DSH_XIAOZHI_HOME || undefined })
const tools = buildTools(config).tools
say(`2) tool surface: ${tools.length} tools (${config.toolMode} mode)`)

let connection
try {
  connection = await connectWebSocket(target.url, { headers: {} })
} catch (err) {
  fail(`2) dialing failed: ${err?.message ?? String(err)}`)
}

const stats = { initialize: 0, toolsList: 0, other: 0 }
const session = new McpSession(connection, {
  tools: () => tools,
  callTool: async (name, args) => {
    say(`   broker called ${name} ${JSON.stringify(args)}`)
    return toolCallResult([{ type: 'text', text: 'probe stub: reached the tool runner' }])
  },
  serverName: () => config.serverName,
  serverVersion: '0.1.0',
  sendInitializedNotification: () => true,
  log: message => say(`   log: ${message}`),
})

const originalSend = connection.send.bind(connection)
connection.send = text => {
  try {
    const frame = JSON.parse(text)
    say(`   -> ${frame.method ?? 'response'}${frame.id !== undefined ? ` (id ${frame.id})` : ''}`)
    if (frame.method === 'notifications/initialized') stats.initialize += 1
  } catch {
    /* not JSON, ignore */
  }
  return originalSend(text)
}

say('3) dialing and waiting for the broker to open the handshake...')
const deadline = Date.now() + 20_000
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 500))
  const snapshot = session.stats
  if (snapshot.initializeCalls > 0 && snapshot.toolsListCalls > 0) {
    stats.toolsList = snapshot.toolsListCalls
    break
  }
  if (connection.closed) break
}

const final = session.stats
say('')
say(`   initialize seen: ${final.initializeCalls}`)
say(`   tools/list seen:  ${final.toolsListCalls}`)
say(`   frames in/out:    ${final.messagesIn}/${final.messagesOut}`)
say(`   tool errors:      ${final.toolErrors}`)
say(`   socket open:      ${!connection.closed}`)

connection.close()
await new Promise(resolve => setTimeout(resolve, 300))

if (final.initializeCalls === 0) {
  fail('\nFAILED: the broker never completed the MCP handshake. Check the token and that the endpoint is enabled in the Xiaozhi app.')
}
if (final.toolsListCalls === 0) {
  fail('\nFAILED: the handshake succeeded but the broker never requested the tool list.')
}
say('\nOK: the access point completed the MCP handshake and pulled the tool list.')
