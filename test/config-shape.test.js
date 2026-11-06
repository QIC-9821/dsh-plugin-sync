import test from 'node:test'
import assert from 'node:assert/strict'

import { statePayload, saveConfig } from '../lib/http.js'
import { CAPABILITY_LABELS, DEFAULTS, normalizeConfig } from '../lib/config.js'

const CAP_KEYS = Object.keys(CAPABILITY_LABELS)

function fakeEngine(cfg) {
  const updates = []
  return {
    updates,
    cfg: () => cfg,
    status: async () => ({ local: null, peer: { describe: 'none' } }),
    schedule: () => {},
    updateState: (patch) => {
      updates.push(patch)
      Object.assign(cfg, patch)
    },
  }
}

test('statePayload exposes capabilities both nested and flat', async () => {
  const cfg = normalizeConfig({ ...DEFAULTS, capPlugins: true, capInstall: false })
  const engine = fakeEngine(cfg)
  const payload = await statePayload(engine, cfg)

  assert.ok(payload.config.capabilities, 'nested capabilities must exist')
  for (const key of CAP_KEYS) {
    assert.equal(typeof payload.config.capabilities[key], 'boolean', `capabilities.${key}`)
    assert.equal(payload.config[key], payload.config.capabilities[key], `flat ${key} mirrors nested`)
  }
  assert.equal(payload.config.capPlugins, true)
  assert.equal(payload.config.capInstall, false)
})

test('capability catalog matches the flat keys', async () => {
  const cfg = normalizeConfig({ ...DEFAULTS })
  const engine = fakeEngine(cfg)
  const payload = await statePayload(engine, cfg)

  assert.deepEqual(
    payload.capabilityCatalog.map((cap) => cap.key),
    CAP_KEYS,
  )
  for (const cap of payload.capabilityCatalog) {
    assert.equal(cap.on, payload.config[cap.key], `${cap.key} catalog.on equals flat value`)
  }
})

test('saving capabilities is reflected back by the payload', async () => {
  const cfg = normalizeConfig({ ...DEFAULTS, capPlugins: false, capInstall: false })
  const engine = fakeEngine(cfg)
  const payload = await saveConfig(engine, { capabilities: { capPlugins: true, capInstall: true } })

  assert.equal(payload.config.capPlugins, true)
  assert.equal(payload.config.capabilities.capPlugins, true)
  assert.equal(payload.config.capInstall, true)
  assert.equal(payload.config.capabilities.capInstall, true)
})
