/**
 * Capability-coverage acceptance tests.
 *
 * The requirement was explicit: **every** listed DSH Web endpoint must be
 * callable from Xiaozhi, in both tool weavings. The first test pins the exact
 * `METHOD path` inventory from that requirement so a future edit that drops a
 * route fails here rather than silently reducing voice coverage.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CAPABILITIES, TOOL_GROUPS, getCapability } from '../lib/capabilities.js'
import { buildTools, coveredCapabilityIds } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'
import { xiaozhiSanitizeToolName, canonicalToolName } from '../lib/protocol.js'

/** The endpoint inventory requested for MCP exposure, verbatim. */
const REQUIRED_ENDPOINTS = [
  ['GET', '/system/status'],

  ['GET', '/workspaces'],
  ['POST', '/workspaces'],
  ['GET', '/workspaces/:id'],
  ['PUT', '/workspaces/:id'],
  ['DELETE', '/workspaces/:id'],
  ['GET', '/workspaces/:id/sessions'],

  ['GET', '/sessions'],
  ['POST', '/sessions'],
  ['GET', '/sessions/:id'],
  ['PUT', '/sessions/:id'],
  ['DELETE', '/sessions/:id'],
  ['GET', '/sessions/:id/history'],
  ['GET', '/sessions/:id/stats'],
  ['GET', '/sessions/:id/todos'],
  ['GET', '/sessions/:id/skills'],
  ['GET', '/sessions/:id/questions'],
  ['POST', '/sessions/:id/answers'],
  ['POST', '/sessions/:id/cancel'],
  ['POST', '/sessions/:id/files'],
  ['GET', '/sessions/:id/files'],
  ['GET', '/sessions/:id/files/download'],
  ['POST', '/sessions/:id/prompt-stream'],
  ['GET', '/sessions/:id/events'],
  ['POST', '/sessions/:id/prompt'],

  ['POST', '/chat/completions'],

  ['GET', '/models'],
  ['GET', '/models/default'],
  ['PUT', '/models/default'],
  ['GET', '/providers'],
  ['GET', '/presets'],

  ['GET', '/settings'],
  ['PATCH', '/settings/:namespace'],

  ['GET', '/docs'],
  ['GET', '/openapi.json'],
]

const allCapabilityIds = CAPABILITIES.map(spec => spec.id)

test('every requested endpoint has exactly one capability', () => {
  const covered = new Set(CAPABILITIES.map(spec => `${spec.method} ${spec.path}`))
  const missing = REQUIRED_ENDPOINTS.filter(([method, path]) => !covered.has(`${method} ${path}`))
  assert.deepEqual(missing, [], `missing capabilities: ${JSON.stringify(missing)}`)
})

test('no capability is declared twice', () => {
  assert.equal(new Set(allCapabilityIds).size, allCapabilityIds.length)
  const pairs = CAPABILITIES.map(spec => `${spec.method} ${spec.path}`)
  // GET/POST on the same path are legitimately distinct capabilities.
  const duplicates = pairs.filter((pair, index) => pairs.indexOf(pair) !== index)
  assert.deepEqual([...new Set(duplicates)], [])
})

test('every capability declares a known group, timeout and summary', () => {
  for (const spec of CAPABILITIES) {
    assert.ok(TOOL_GROUPS.includes(spec.group), `${spec.id} has group ${spec.group}`)
    assert.ok(spec.timeoutMs > 0, `${spec.id} needs a positive timeout`)
    assert.ok(spec.summary.length > 0, `${spec.id} needs a summary`)
    assert.equal(typeof spec.write, 'boolean')
    // Path params must appear in the path template, and vice versa.
    const templateParams = [...spec.path.matchAll(/:([a-zA-Z0-9_]+)/g)].map(match => match[1])
    assert.deepEqual([...spec.pathParams].sort(), [...templateParams].sort(), `${spec.id} path params`)
  }
})

test('grouped mode covers the whole capability surface', () => {
  const config = resolveConfig({})
  const built = buildTools(config)
  assert.equal(built.mode, 'grouped')
  const covered = coveredCapabilityIds(built.tools)
  const missing = allCapabilityIds.filter(id => !covered.has(id))
  assert.deepEqual(missing, [], `grouped mode does not cover: ${JSON.stringify(missing)}`)
})

test('flat mode covers the capability surface one-to-one', () => {
  const config = resolveConfig({ toolMode: 'flat' })
  const built = buildTools(config)
  assert.equal(built.mode, 'flat')
  assert.equal(built.tools.length, CAPABILITIES.length)
  const covered = coveredCapabilityIds(built.tools)
  assert.deepEqual([...covered].sort(), [...allCapabilityIds].sort())
})

test('grouped mode stays small enough for a voice model', () => {
  const built = buildTools(resolveConfig({}))
  // Xiaozhi's function-calling LLM degrades past a couple of dozen tools.
  assert.ok(built.tools.length <= 20, `grouped mode exposes ${built.tools.length} tools`)
  assert.ok(built.tools.length >= 12)
})

test('every tool name survives the Xiaozhi sanitiser unchanged', () => {
  for (const mode of ['grouped', 'flat']) {
    for (const tool of buildTools(resolveConfig({ toolMode: mode })).tools) {
      assert.equal(tool.name, canonicalToolName(tool.name), `${tool.name} is not canonical`)
      assert.equal(
        xiaozhiSanitizeToolName(tool.name),
        tool.name,
        `${tool.name} would be renamed by Xiaozhi and all its calls would fail`,
      )
    }
  }
})

test('every tool ships a valid JSON Schema with documented parameters', () => {
  for (const mode of ['grouped', 'flat']) {
    for (const tool of buildTools(resolveConfig({ toolMode: mode })).tools) {
      const schema = tool.inputSchema
      assert.equal(schema.type, 'object', `${tool.name} schema type`)
      assert.equal(typeof schema.properties, 'object')
      assert.ok(Array.isArray(schema.required), `${tool.name} required list`)
      for (const name of schema.required) {
        assert.ok(name in schema.properties, `${tool.name}: required "${name}" is not declared`)
      }
      for (const [name, definition] of Object.entries(schema.properties)) {
        assert.ok(
          ['string', 'number', 'boolean', 'object', 'array'].includes(definition.type),
          `${tool.name}.${name} has type ${definition.type}`,
        )
        assert.ok(
          typeof definition.description === 'string' && definition.description.length > 0,
          `${tool.name}.${name} needs a description for the voice model`,
        )
      }
      assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`)
      assert.ok(tool.capabilities.length > 0, `${tool.name} must declare its coverage`)
      for (const id of tool.capabilities) {
        assert.ok(getCapability(id), `${tool.name} references unknown capability ${id}`)
      }
    }
  }
})

test('allowWriteTools=false removes every mutating capability but keeps read coverage', () => {
  const readOnly = allCapabilityIds.filter(id => getCapability(id)?.write === false)
  for (const mode of ['grouped', 'flat']) {
    const built = buildTools(resolveConfig({ toolMode: mode, allowWriteTools: false }))
    const covered = coveredCapabilityIds(built.tools)
    const leaked = [...covered].filter(id => getCapability(id)?.write)
    assert.deepEqual(leaked, [], `${mode} leaked write capabilities: ${JSON.stringify(leaked)}`)
    // Turning writes off must not cost any read capability: in grouped mode a
    // mixed tool (e.g. workspaces: list + create) stays usable for its reads.
    const missing = readOnly.filter(id => !covered.has(id))
    assert.deepEqual(missing, [], `${mode} lost read capabilities: ${JSON.stringify(missing)}`)
  }
})

test('a disabled group disappears from both weavings', () => {
  for (const mode of ['grouped', 'flat']) {
    const built = buildTools(resolveConfig({ toolMode: mode, disabledGroups: ['workspaces'] }))
    const covered = coveredCapabilityIds(built.tools)
    const leaked = [...covered].filter(id => getCapability(id)?.group === 'workspaces')
    assert.deepEqual(leaked, [], `${mode} still exposes workspaces after disabling it`)
    assert.ok(built.tools.every(tool => !tool.groups.includes('workspaces') || tool.groups.length > 1))
  }
})

test('disabling every group yields no tools rather than a broken list', () => {
  const built = buildTools(resolveConfig({ disabledGroups: [...TOOL_GROUPS] }))
  assert.deepEqual(built.tools, [])
  // The flat weaving has no per-tool group fallback, so it must also be empty.
  const flat = buildTools(resolveConfig({ toolMode: 'flat', disabledGroups: [...TOOL_GROUPS] }))
  assert.deepEqual(flat.tools, [])
})
