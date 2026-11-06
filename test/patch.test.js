import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findRow, parseRows, rowConfig, setRowConfig, setRowDisabled } from '../lib/patch.js'

const SAMPLE = `# comment
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: im-qqbot
  name: "@tencent-connect/dsh-qqbot"
  config: { appId: 1 }
  disabled: true
- id: plugin-sync
  name: "dsh-plugin-sync"
`

test('parses rows with ids, names and disabled flags', () => {
  const rows = parseRows(SAMPLE)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].id, 'agent-default-model')
  assert.equal(rows[1].name, '@tencent-connect/dsh-qqbot')
  assert.equal(rows[1].disabled, true)
  assert.equal(rows[2].disabled, null)
})

test('findRow works by id and by module name', () => {
  const rows = parseRows(SAMPLE)
  assert.equal(findRow(rows, { id: 'im-qqbot' }).name, '@tencent-connect/dsh-qqbot')
  assert.equal(findRow(rows, { moduleName: 'dsh-plugin-sync' }).id, 'plugin-sync')
  assert.equal(findRow(rows, { id: 'nope' }), null)
})

test('rowConfig reads flow mappings', () => {
  const row = findRow(parseRows(SAMPLE), { id: 'im-qqbot' })
  assert.deepEqual(rowConfig(SAMPLE, row), { appId: 1 })
})

test('rowConfig reads block mappings as raw text', () => {
  const row = findRow(parseRows(SAMPLE), { id: 'agent-default-model' })
  const value = rowConfig(SAMPLE, row)
  assert.ok('__raw' in value)
  assert.match(value.__raw, /provider: deepseek-account/)
})

test('setRowDisabled rewrites an existing flag', () => {
  const next = setRowDisabled(SAMPLE, 'im-qqbot', false)
  assert.match(next, /- id: im-qqbot[\s\S]*?disabled: false/)
})

test('setRowDisabled adds a flag when missing', () => {
  const next = setRowDisabled(SAMPLE, 'plugin-sync', true)
  assert.match(next, /- id: plugin-sync\n  name: "dsh-plugin-sync"\n  disabled: true/)
})

test('setRowDisabled appends an unknown row only for disabling', () => {
  assert.equal(setRowDisabled(SAMPLE, 'missing', false), SAMPLE)
  const appended = setRowDisabled(SAMPLE, 'missing', true)
  assert.match(appended, /- id: missing\n  disabled: true\n$/)
})

test('setRowConfig replaces an inline config and preserves other rows', () => {
  const { text, changed } = setRowConfig(SAMPLE, 'plugin-sync', { peerMode: 'ssh', capFiles: true })
  assert.equal(changed, true)
  const rows = parseRows(text)
  assert.equal(rows.length, 3)
  assert.deepEqual(rowConfig(text, findRow(rows, { id: 'plugin-sync' })), { peerMode: 'ssh', capFiles: true })
  assert.match(text, /- id: im-qqbot[\s\S]*?disabled: true/)
})

test('setRowConfig replaces a block config', () => {
  const { text } = setRowConfig(SAMPLE, 'agent-default-model', { model: 'deepseek-v4-pro' })
  assert.match(text, /config: \{"model":"deepseek-v4-pro"\}/)
  assert.equal(text.includes('provider: deepseek-account'), false)
})

test('setRowConfig reports a missing row', () => {
  const { changed } = setRowConfig(SAMPLE, 'nope', {})
  assert.equal(changed, false)
})
