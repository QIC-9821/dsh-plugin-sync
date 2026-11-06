import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyPlan } from '../lib/apply.js'

function ctxWith(calls, overrides = {}) {
  const change = (target, extra = {}) => ({
    changed: true,
    application: 'applied',
    stage: 'enable',
    target,
    ...extra,
  })
  return {
    calls,
    get(name) {
      if (name !== 'pluginManager') return undefined
      return {
        async setBundleEnabled(target, enabled) {
          calls.push(['setBundleEnabled', target, enabled])
          return change(target, { enabled })
        },
        async setPluginEnabled(target, enabled) {
          calls.push(['setPluginEnabled', target, enabled])
          return change(target, { enabled })
        },
        async installBundle(spec, options) {
          calls.push(['installBundle', spec, options])
          return change(spec, { stage: 'install' })
        },
        async removeBundle(target) {
          calls.push(['removeBundle', target])
          return change(target, { stage: 'remove' })
        },
        async updateBundle(target, version) {
          calls.push(['updateBundle', target, version])
          return change(target, { version })
        },
        ...overrides,
      }
    },
  }
}

const cfg = { capPlugins: true, capInstall: true, capConfig: true, __backupDir: '' }

test('bundle and row toggles reach pluginManager', async () => {
  const calls = []
  const out = await applyPlan({
    ctx: ctxWith(calls),
    cfg,
    ops: [
      { kind: 'disable', name: 'dsh-wechat-pad' },
      { kind: 'plugin-enable', entryId: 'include:plugin-sync' },
    ],
  })
  assert.equal(out.ok, true)
  assert.equal(out.applied, 2)
  assert.deepEqual(calls, [
    ['setBundleEnabled', 'dsh-wechat-pad', false],
    ['setPluginEnabled', 'include:plugin-sync', true],
  ])
})

test('a failed change is reported, not thrown', async () => {
  const out = await applyPlan({
    ctx: ctxWith([], {
      async setBundleEnabled() {
        return { changed: false, application: 'failed', target: 'x', error: { code: 'unknown-plugin' } }
      },
    }),
    cfg,
    ops: [{ kind: 'disable', name: 'x' }],
  })
  assert.equal(out.ok, false)
  assert.equal(out.failed, 1)
  assert.equal(out.results[0].error, 'unknown-plugin')
})

test('one failure does not stop the rest of the plan', async () => {
  const calls = []
  const out = await applyPlan({
    ctx: ctxWith(calls, {
      async installBundle() {
        throw new Error('boom')
      },
    }),
    cfg,
    ops: [
      { kind: 'install', name: 'a', spec: 'a@1.0.0' },
      { kind: 'enable', name: 'b' },
    ],
  })
  assert.equal(out.applied, 1)
  assert.equal(out.failed, 1)
  assert.equal(out.results[0].error, 'boom')
  assert.deepEqual(calls, [['setBundleEnabled', 'b', true]])
})

test('capability switches gate work at apply time too', async () => {
  const calls = []
  const out = await applyPlan({
    ctx: ctxWith(calls),
    cfg: { ...cfg, capInstall: false },
    ops: [{ kind: 'install', name: 'a', spec: 'a@1.0.0' }],
  })
  assert.equal(out.ok, false)
  assert.equal(calls.length, 0)
  assert.match(out.results[0].error, /权限/)
})

test('restart-required results surface a restart flag', async () => {
  const out = await applyPlan({
    ctx: ctxWith([], {
      async setBundleEnabled(target) {
        return { changed: true, application: 'restart-required', restartReason: 'loader', target }
      },
    }),
    cfg,
    ops: [{ kind: 'disable', name: 'x' }],
  })
  assert.equal(out.restartRequired, true)
})
