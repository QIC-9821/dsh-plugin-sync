import { existsSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'

import { PACKAGE_NAME, filterConfig } from './config.js'
import { parseRows, readPatchText, rowConfig } from './patch.js'

export const SNAPSHOT_SCHEMA = 1

export function pluginManagerOf(ctx) {
  const pm = ctx?.get?.('pluginManager')
  if (!pm || typeof pm.listBundles !== 'function' || typeof pm.listPlugins !== 'function') {
    throw new Error('pluginManager service unavailable (host too old or plugin not loaded in the app scope)')
  }
  return pm
}

function localSpecOf(bundle) {
  const spec = bundle?.installTarget?.spec || bundle?.source || bundle?.spec || null
  if (typeof spec !== 'string' || !spec.trim()) return null
  return spec.trim()
}

/** Turn `file:D:/x/y`, `file:///D:/x/y` or a bare absolute path into a directory. */
export function localDirOf(spec) {
  if (!spec) return null
  let value = spec.trim()
  if (value.startsWith('file:')) value = value.slice(5)
  if (value.startsWith('//')) value = value.slice(2)
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
  if (!/^([A-Za-z]:[\\/]|\/)/.test(value)) return null
  return value.replace(/\\/g, '/')
}

export async function buildSnapshot({ ctx, cfg, profileDir, includeConfig = false, includeSources = false }) {
  const pm = pluginManagerOf(ctx)
  const rawBundles = await pm.listBundles()
  const rawPlugins = await pm.listPlugins()
  const bundles = Array.isArray(rawBundles) ? rawBundles : []
  const plugins = Array.isArray(rawPlugins) ? rawPlugins : []
  const patchText = readPatchText(profileDir)
  const rows = parseRows(patchText)

  const bundleViews = bundles.map((bundle) => {
    const spec = localSpecOf(bundle)
    return {
      name: String(bundle.name),
      version: bundle.version ?? null,
      spec,
      enabled: bundle.enabled !== false,
      official: Boolean(bundle.official),
      optional: Boolean(bundle.optional),
      availability: bundle.availability ?? null,
      updatable: Boolean(bundle.updatable),
    }
  })

  const configs = {}
  const sources = {}
  if (includeConfig) {
    for (const row of rows) {
      if (!row.name) continue
      const value = rowConfig(patchText, row)
      if (!value || typeof value !== 'object' || '__raw' in value) continue
      configs[row.name] = {
        rowId: row.id,
        config: filterConfig(value, { includeSecrets: Boolean(cfg.capSecrets) }),
      }
    }
  }
  if (includeSources) {
    for (const bundle of bundleViews) {
      const dir = localDirOf(bundle.spec)
      if (dir && existsSync(join(dir, 'package.json'))) {
        sources[bundle.name] = { kind: 'dir', path: dir }
      }
    }
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    at: new Date().toISOString(),
    node: {
      name: cfg.localName || hostname(),
      hostname: hostname(),
      platform: platform(),
      profile: profileDir ? profileDir.replace(/\\/g, '/').split('/').pop() : null,
      plugin: PACKAGE_NAME,
      version: cfg.__version || null,
    },
    bundles: bundleViews,
    plugins: plugins.map((plugin) => ({
      entryId: String(plugin.entryId ?? ''),
      moduleName: String(plugin.moduleName ?? ''),
      enabled: plugin.enabled !== false,
      phase: plugin.fiberPhase ?? null,
    })),
    configs,
    sources,
  }
}

export function summarizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { node: null, bundles: 0, plugins: 0, enabled: 0, configs: 0 }
  }
  const bundles = Array.isArray(snapshot.bundles) ? snapshot.bundles : []
  return {
    node: snapshot.node?.name ?? null,
    profile: snapshot.node?.profile ?? null,
    at: snapshot.at ?? null,
    bundles: bundles.length,
    plugins: Array.isArray(snapshot.plugins) ? snapshot.plugins.length : 0,
    enabled: bundles.filter((bundle) => bundle.enabled).length,
    configs: Object.keys(snapshot.configs || {}).length,
  }
}
