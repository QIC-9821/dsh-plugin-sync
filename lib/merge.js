/** Pure merge planner: computes the ops that make `target` look like `source`. */

export const PROTECTED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qic-9821/dsh-plugin-sync',
  'dsh-plugin-sync',
]

// Names this very plugin has shipped under; it never syncs (or removes) itself.
export const SELF_NAMES = ['@qic-9821/dsh-plugin-sync', 'dsh-plugin-sync']

// The host's own rows and bundles are platform- and build-specific (a Windows
// desktop and a Linux server legitimately run different sandboxes, telemetry
// and analytics rows). They are never synced unless the user names one in
// `include` on purpose.
export const CORE_PREFIX = '@deepseek-ai/'

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value ?? '')
      .replace(/^v/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export function isExcluded(name, options = {}) {
  const patterns = [...(options.exclude || [])]
  const include = [...(options.include || [])]
  if (include.includes(name)) return false
  const protectedNames = [...PROTECTED_BUNDLES, ...(options.protected || [])]
  if (protectedNames.includes(name)) return true
  if (SELF_NAMES.includes(name)) return true
  if (options.selfName && options.selfName === name) return true
  if (
    String(name || '').startsWith(CORE_PREFIX) &&
    !include.some((pattern) => pattern.endsWith('*') && String(name).startsWith(pattern.slice(0, -1)))
  ) {
    return true
  }
  return patterns.some((pattern) => {
    const raw = String(pattern || '').trim()
    if (!raw) return false
    if (raw.endsWith('*')) return name.startsWith(raw.slice(0, -1))
    return name === raw
  })
}

function isSecretFreeConfig(value) {
  return value && typeof value === 'object' && !('__raw' in value)
}

export function planMerge(source, target, options = {}) {
  const conflict = ['local', 'peer', 'newest'].includes(options.conflict) ? options.conflict : 'local'
  const caps = {
    plugins: options.capPlugins !== false,
    install: options.capInstall === true,
    config: options.capConfig === true,
    files: options.capFiles === true,
  }
  const sourceBundles = new Map((source?.bundles || []).map((bundle) => [bundle.name, bundle]))
  const targetBundles = new Map((target?.bundles || []).map((bundle) => [bundle.name, bundle]))
  const sourcePlugins = new Map((source?.plugins || []).map((plugin) => [plugin.entryId, plugin]))
  const targetPlugins = new Map((target?.plugins || []).map((plugin) => [plugin.entryId, plugin]))
  const ops = []
  const notes = []

  for (const [name, bundle] of sourceBundles) {
    if (isExcluded(name, options)) continue
    if ((options.include || []).length > 0 && !(options.include || []).includes(name)) continue
    const current = targetBundles.get(name)
    if (!current) {
      if (!caps.install) {
        notes.push({ kind: 'skip', target: name, reason: '安装权限未开启（安装/升级/卸载）' })
        continue
      }
      ops.push({
        kind: 'install',
        name,
        spec: bundle.spec,
        version: bundle.version,
        enabled: bundle.enabled,
        source: bundle.spec && bundle.spec.startsWith('file:') ? 'copy' : 'remote',
      })
      continue
    }
    if (bundle.version && current.version && bundle.version !== current.version) {
      if (!caps.install) {
        notes.push({ kind: 'skip', target: name, reason: `版本不同（${current.version} → ${bundle.version}），安装权限未开启` })
      } else if (conflict === 'newest' && compareVersions(bundle.version, current.version) <= 0) {
        notes.push({ kind: 'skip', target: name, reason: `对端版本更新（${current.version}），newest 策略不改` })
      } else {
        ops.push({ kind: 'upgrade', name, version: bundle.version, from: current.version })
      }
    }
    if (Boolean(bundle.enabled) !== Boolean(current.enabled) && conflict !== 'peer') {
      if (!caps.plugins) {
        notes.push({ kind: 'skip', target: name, reason: '插件启停权限未开启' })
      } else {
        ops.push({ kind: bundle.enabled ? 'enable' : 'disable', name })
      }
    }
    if (conflict === 'peer' && targetBundles.has(name)) {
      // keep the receiving side's enable state: nothing to do
    }
  }

  if (options.mirror === true) {
    for (const name of targetBundles.keys()) {
      if (sourceBundles.has(name)) continue
      if (isExcluded(name, options)) continue
      if (!caps.install) {
        notes.push({ kind: 'skip', target: name, reason: '目标端多出的插件未删除（安装权限未开启）' })
        continue
      }
      ops.push({ kind: 'remove', name })
    }
  }

  if (caps.plugins && conflict !== 'peer') {
    for (const [entryId, plugin] of sourcePlugins) {
      const current = targetPlugins.get(entryId)
      if (!current) continue
      if (isExcluded(plugin.moduleName, options)) continue
      if (Boolean(current.enabled) === Boolean(plugin.enabled)) continue
      ops.push({ kind: plugin.enabled ? 'plugin-enable' : 'plugin-disable', entryId, moduleName: plugin.moduleName })
    }
  }

  if (caps.config) {
    const sourceConfigs = source?.configs || {}
    const targetConfigs = target?.configs || {}
    for (const [moduleName, entry] of Object.entries(sourceConfigs)) {
      if (isExcluded(moduleName, options)) continue
      if (!isSecretFreeConfig(entry?.config)) continue
      const current = targetConfigs[moduleName]
      if (current && deepEqual(current.config, entry.config)) continue
      ops.push({ kind: 'config', name: moduleName, rowId: entry.rowId || null, config: entry.config })
    }
  }

  return { ops, notes, stats: summarize(ops, notes) }
}

export function summarize(ops, notes = []) {
  const counts = {}
  for (const op of ops) counts[op.kind] = (counts[op.kind] || 0) + 1
  return { total: ops.length, counts, skipped: notes.length }
}

export function deepEqual(left, right) {
  return stableKey(left) === stableKey(right)
}

export function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function describeOps(ops) {
  const labels = {
    install: '安装',
    upgrade: '升级',
    remove: '卸载',
    enable: '启用',
    disable: '停用',
    'plugin-enable': '启用条目',
    'plugin-disable': '停用条目',
    config: '配置',
  }
  return ops.map((op) => {
    const label = labels[op.kind] || op.kind
    const target = op.name || op.moduleName || op.entryId || ''
    const extra = op.kind === 'upgrade' ? ` ${op.from ?? '?'} → ${op.version ?? '?'}` : ''
    return `${label} ${target}${extra}`.trim()
  })
}
