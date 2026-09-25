/**
 * Documentation consistency tests.
 *
 * The tool and capability tables in docs/TOOLS.md are hand-written prose about
 * generated data, which is exactly the kind of thing that drifts silently: a new
 * capability would ship documented nowhere. These tests fail when a name or a
 * count in the documentation stops matching the code.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPABILITIES, TOOL_GROUP_LABELS } from '../lib/capabilities.js'
import { buildTools } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const read = name => readFileSync(path.join(root, name), 'utf8')

const grouped = buildTools(resolveConfig({ toolMode: 'grouped', homeDir: '/tmp/dsh-xiaozhi-docs' })).tools
const flat = buildTools(resolveConfig({ toolMode: 'flat', homeDir: '/tmp/dsh-xiaozhi-docs' })).tools

test('docs/TOOLS.md documents every capability and both weavings', () => {
  const doc = read('docs/TOOLS.md')

  const missingCapabilities = CAPABILITIES.filter(spec => !doc.includes(spec.id)).map(spec => spec.id)
  assert.deepEqual(missingCapabilities, [], 'capabilities missing from docs/TOOLS.md')

  const missingRoutes = CAPABILITIES.filter(spec => !doc.includes(`${spec.method} ${spec.path}`)).map(spec => spec.id)
  assert.deepEqual(missingRoutes, [], 'endpoint paths missing from docs/TOOLS.md')

  const missingGrouped = grouped.filter(tool => !doc.includes(tool.name)).map(tool => tool.name)
  assert.deepEqual(missingGrouped, [], 'grouped tools missing from docs/TOOLS.md')

  const missingFlat = flat.filter(tool => !doc.includes(tool.name)).map(tool => tool.name)
  assert.deepEqual(missingFlat, [], 'flat tools missing from docs/TOOLS.md')

  const missingGroups = Object.values(TOOL_GROUP_LABELS).filter(label => !doc.includes(label))
  assert.deepEqual(missingGroups, [], 'capability area labels missing from docs/TOOLS.md')
})

test('docs/TOOLS.md states the real tool and capability counts', () => {
  const doc = read('docs/TOOLS.md')
  assert.ok(doc.includes(`**${CAPABILITIES.length}**`), `docs/TOOLS.md must state ${CAPABILITIES.length} capabilities`)
  assert.ok(doc.includes(`**${grouped.length}**`), `docs/TOOLS.md must state ${grouped.length} grouped tools`)
  assert.ok(doc.includes(`**${flat.length}**`), `docs/TOOLS.md must state ${flat.length} flat tools`)
})

test('both READMEs describe the degradation contract and the real counts', () => {
  for (const name of ['README.md', 'README.zh.md']) {
    const doc = read(name)
    assert.ok(doc.length > 4000, `${name} looks truncated`)
    // The four degraded capabilities must each be named.
    for (const capability of ['conversation.promptStream', 'sessions.events', 'files.download', 'docs.openapi']) {
      assert.ok(doc.includes(capability), `${name} must mention the ${capability} degradation`)
    }
    assert.ok(doc.includes(String(CAPABILITIES.length)), `${name} must state the capability count`)
    assert.ok(doc.includes(String(grouped.length)), `${name} must state the grouped tool count`)
    assert.ok(doc.includes(String(flat.length)), `${name} must state the flat tool count`)
    assert.ok(doc.includes('dsh-xiaozhi/admin'), `${name} must document the fixed settings API path`)
    assert.ok(doc.includes('allowWriteTools'), `${name} must document the write switch`)
    assert.ok(doc.includes('homeDir'), `${name} must document the homeDir caveat`)
  }
})

test('INSTALL.md keeps the verification checklist and the CSRF header', () => {
  const doc = read('INSTALL.md')
  assert.ok(doc.includes('x-dsh-xiaozhi-admin: 1'), 'INSTALL.md must show the CSRF header for curl')
  assert.ok(doc.includes('dsh-xiaozhi/api/v1'), 'INSTALL.md must show the bundled REST path')
  assert.ok(doc.includes('settings.json'), 'INSTALL.md must document the override file')
})

test('NOTICE attributes every copied module', () => {
  const notice = read('NOTICE')
  assert.ok(notice.includes('BSD-3-Clause'), 'NOTICE must state the license')
  assert.ok(notice.includes('toddpan'), 'NOTICE must name the original copyright holder')
  assert.ok(notice.includes('0.1.11'), 'NOTICE must pin the upstream version')
  const copied = readFileSync(path.join(root, 'src/dshapi/service.ts'), 'utf8')
  assert.ok(copied.includes('createDshApiRouter'), 'service.ts must remain the assembly seam')
})

test('the design proposals are marked as proposals, not shipped behaviour', () => {
  // These were written before the code existed and disagree with it in places;
  // shipping them unlabelled would misrepresent the plugin.
  const readme = read('docs/design/README.md')
  assert.ok(readme.includes('实施前的设计提案'), 'the design index must say these are proposals')
  assert.ok(readme.includes('不是对已发布插件行为的描述'), 'the design index must disclaim shipped behaviour')
  for (const name of ['architecture-adr.md', 'architecture-review-v2.md', 'settings-ux-walkthrough.md']) {
    const doc = readFileSync(path.join(root, 'docs/design', name), 'utf8')
    assert.ok(doc.length > 5000, `docs/design/${name} looks truncated`)
  }
  // The main docs must not present an unmaterialised design as shipped.
  for (const name of ['README.md', 'README.zh.md']) {
    assert.ok(!read(name).includes('DSH_XZ_1005'), `${name} must not quote the unbuilt error-code design`)
  }
})

test('the documented test count matches the suite', () => {
  // Discover the files instead of listing them: a hardcoded list silently
  // stopped counting a newly added test file.
  const files = readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
  assert.ok(files.length >= 9, `only found ${files.length} test files`)
  let cases = 0
  for (const name of files) {
    const source = readFileSync(path.join(root, 'test', name), 'utf8')
    cases += [...source.matchAll(/^test\(/gm)].length
  }
  assert.ok(cases > 50, `only counted ${cases} test cases`)

  // Every document that quotes a test count must quote this one.
  for (const name of ['README.md', 'README.zh.md', 'INSTALL.md']) {
    const doc = read(name)
    const quoted = [...doc.matchAll(/(\d+) (?:test cases|个用例)/g)].map(match => Number(match[1]))
    assert.ok(quoted.length > 0, `${name} never states the test count`)
    for (const value of quoted) {
      assert.equal(value, cases, `${name} says ${value} tests but the suite has ${cases}`)
    }
  }
})
