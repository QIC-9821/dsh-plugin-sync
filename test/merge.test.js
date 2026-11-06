import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compareVersions, planMerge, PROTECTED_BUNDLES } from '../lib/merge.js'

const local = {
  bundles: [
    { name: 'dsh-meme', version: '0.1.77', enabled: true, spec: null },
    { name: 'dsh-fish', version: '0.8.6', enabled: false, spec: 'github:ssamurias/dsh-fish#v0.8.6' },
    { name: 'dsh-pc-bridge', version: '0.1.0', enabled: true, spec: 'file:D:/dsh-plugins/dsh-pc-bridge' },
  ],
  plugins: [
    { entryId: 'dsh-fish#fish', moduleName: 'dsh-fish', enabled: false },
    { entryId: 'dsh-meme', moduleName: 'dsh-meme', enabled: true },
  ],
  configs: { 'dsh-meme': { rowId: 'dsh-meme', config: { packDir: 'C:/x' } } },
}

const peer = {
  bundles: [
    { name: 'dsh-meme', version: '0.1.70', enabled: true, spec: null },
    { name: 'dsh-wechat-pad', version: '0.1.0', enabled: true, spec: 'file:D:/x' },
  ],
  plugins: [{ entryId: 'dsh-meme', moduleName: 'dsh-meme', enabled: true }],
  configs: {},
}

test('compareVersions', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('v0.9.0', '0.10.0'), -1)
})

test('push plan installs missing bundles and upgrades versions', () => {
  const plan = planMerge(local, peer, { conflict: 'local', capInstall: true, capPlugins: true })
  assert.deepEqual(
    plan.ops.map((op) => `${op.kind}:${op.name}`).sort(),
    ['install:dsh-fish', 'install:dsh-pc-bridge', 'upgrade:dsh-meme'].sort(),
  )
  const copied = plan.ops.find((op) => op.kind === 'install' && op.name === 'dsh-pc-bridge')
  assert.equal(copied.source, 'copy')
  const remote = plan.ops.find((op) => op.kind === 'install' && op.name === 'dsh-fish')
  assert.equal(remote.source, 'remote')
})

test('without install capability, package ops become skipped notes', () => {
  const plan = planMerge(local, peer, { conflict: 'local', capInstall: false, capPlugins: true })
  assert.equal(plan.ops.some((op) => ['install', 'upgrade', 'remove'].includes(op.kind)), false)
  assert.ok(plan.notes.length >= 2)
})

test('conflict peer keeps the receiving side enable state', () => {
  const plan = planMerge(local, peer, { conflict: 'peer', capInstall: false, capPlugins: true })
  assert.equal(plan.ops.some((op) => op.kind === 'disable' || op.kind === 'enable'), false)
})

test('newest conflict skips downgrades', () => {
  const source = { ...local, bundles: [{ name: 'dsh-meme', version: '0.1.60', enabled: true }] }
  const plan = planMerge(source, peer, { conflict: 'newest', capInstall: true })
  assert.equal(plan.ops.some((op) => op.kind === 'upgrade'), false)
})

test('protected and self bundles are never touched', () => {
  const source = {
    bundles: [...PROTECTED_BUNDLES.map((name) => ({ name, version: '1.0.0', enabled: true }))],
    plugins: [],
    configs: {},
  }
  const plan = planMerge(source, { bundles: [], plugins: [], configs: {} }, { conflict: 'local', capInstall: true })
  assert.equal(plan.ops.length, 0)
})

test('exclude patterns filter bundles', () => {
  const plan = planMerge(local, peer, { conflict: 'local', capInstall: true, exclude: ['dsh-pc-*', 'dsh-fish'] })
  assert.equal(plan.ops.some((op) => op.name === 'dsh-pc-bridge' || op.name === 'dsh-fish'), false)
})

test('plugin row state follows the source when enabled differs', () => {
  const source = {
    bundles: [],
    plugins: [{ entryId: 'dsh-fish#fish', moduleName: 'dsh-fish', enabled: false }],
    configs: {},
  }
  const target = {
    bundles: [],
    plugins: [{ entryId: 'dsh-fish#fish', moduleName: 'dsh-fish', enabled: true }],
    configs: {},
  }
  const plan = planMerge(source, target, { conflict: 'local', capPlugins: true, capInstall: false })
  const pluginOps = plan.ops.filter((op) => op.kind.startsWith('plugin-'))
  assert.deepEqual(pluginOps.map((op) => op.kind), ['plugin-disable'])
  assert.equal(pluginOps[0].entryId, 'dsh-fish#fish')
  const ignored = planMerge(source, target, { conflict: 'peer', capPlugins: true })
  assert.equal(ignored.ops.length, 0)
})

test('host rows and bundles stay local unless named in include', () => {
  const source = {
    bundles: [
      { name: '@deepseek-ai/dsh-experimental-auto-review', version: '0.2.2-rc.1', enabled: true },
      { name: 'dsh-meme', version: '0.1.77', enabled: true },
    ],
    plugins: [
      { entryId: 'include:bash-sandbox', moduleName: '@deepseek-ai/dsh-bash-sandbox', enabled: true },
      { entryId: 'include:pwsh-sandbox', moduleName: '@deepseek-ai/dsh-pwsh-sandbox', enabled: false },
    ],
    configs: {},
  }
  const target = {
    bundles: [{ name: '@deepseek-ai/dsh-experimental-auto-review', version: '0.2.1-rc.5', enabled: false }],
    plugins: [
      { entryId: 'include:bash-sandbox', moduleName: '@deepseek-ai/dsh-bash-sandbox', enabled: false },
      { entryId: 'include:pwsh-sandbox', moduleName: '@deepseek-ai/dsh-pwsh-sandbox', enabled: true },
    ],
    configs: {},
  }
  const plan = planMerge(source, target, { conflict: 'local', capPlugins: true, capInstall: true })
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.name ?? op.entryId}`), ['install:dsh-meme'])

  const named = planMerge(source, target, {
    conflict: 'local',
    capPlugins: true,
    capInstall: false,
    include: ['@deepseek-ai/dsh-experimental-auto-review'],
  })
  assert.deepEqual(named.ops.map((op) => op.kind), ['enable'])
  assert.ok(named.notes.some((note) => note.target === '@deepseek-ai/dsh-experimental-auto-review'))
})

test('config ops only appear with config capability', () => {
  const withoutCaps = planMerge(local, peer, { conflict: 'local', capConfig: false })
  assert.equal(withoutCaps.ops.some((op) => op.kind === 'config'), false)
  const withCaps = planMerge(local, peer, { conflict: 'local', capConfig: true })
  assert.equal(withCaps.ops.filter((op) => op.kind === 'config').length, 1)
})
