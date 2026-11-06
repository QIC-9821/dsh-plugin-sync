import { backupPatch, readPatchText, setRowConfig, writePatchText } from './patch.js'

/**
 * Executes merge ops against the *local* machine through the pluginManager
 * service, so pnpm, the profile manifest and the loader stay authoritative.
 * One failing op never aborts the rest; every result is reported.
 */
export async function applyPlan({ ctx, ops = [], cfg = {}, profileDir = null, log = () => {} }) {
  const results = []
  const pm = ctx?.get?.('pluginManager')
  let patchBackedUp = false

  for (const op of ops) {
    const started = Date.now()
    try {
      if (op.kind === 'config') {
        if (!cfg.capConfig) throw new Error('配置同步权限未开启')
        if (!profileDir) throw new Error('找不到 profile 目录')
        if (!patchBackedUp) {
          const backup = backupPatch(profileDir, `${cfg.__backupDir || ''}`)
          patchBackedUp = true
          if (backup) log(`patch backup: ${backup}`)
        }
        const text = readPatchText(profileDir)
        const rowId = op.rowId || op.name
        const next = setRowConfig(text, rowId, op.config)
        if (!next.changed) throw new Error(`cordis.patch.yml 里没有 ${rowId} 这一行`)
        writePatchText(profileDir, next.text)
        results.push(ok(op, '重启后生效'))
        continue
      }

      if (!pm) throw new Error('pluginManager 服务不可用')

      if (op.kind === 'install') {
        if (!cfg.capInstall) throw new Error('安装/升级权限未开启')
        const result = await pm.installBundle(op.spec, { enabled: op.enabled !== false })
        results.push(fromChange(op, result))
        continue
      }
      if (op.kind === 'upgrade') {
        if (!cfg.capInstall) throw new Error('安装/升级权限未开启')
        const result = await pm.updateBundle(op.name, op.version || undefined)
        results.push(fromChange(op, result))
        continue
      }
      if (op.kind === 'remove') {
        if (!cfg.capInstall) throw new Error('卸载权限未开启')
        const result = await pm.removeBundle(op.name)
        results.push(fromChange(op, result))
        continue
      }
      if (op.kind === 'enable' || op.kind === 'disable') {
        if (!cfg.capPlugins) throw new Error('插件启停权限未开启')
        const result = await pm.setBundleEnabled(op.name, op.kind === 'enable')
        results.push(fromChange(op, result))
        continue
      }
      if (op.kind === 'plugin-enable' || op.kind === 'plugin-disable') {
        if (!cfg.capPlugins) throw new Error('插件启停权限未开启')
        const result = await pm.setPluginEnabled(op.entryId, op.kind === 'plugin-enable')
        results.push(fromChange(op, result))
        continue
      }
      results.push({ ...fail(op, `未知操作: ${op.kind}`), ms: Date.now() - started })
    } catch (error) {
      results.push({ ...fail(op, describeError(error)), ms: Date.now() - started })
    }
  }

  const failed = results.filter((item) => !item.ok)
  return {
    ok: failed.length === 0,
    applied: results.filter((item) => item.ok).length,
    failed: failed.length,
    results,
    restartRequired: results.some((item) => item.application === 'restart-required'),
  }
}

function ok(op, note = null) {
  return { ok: true, op: pick(op), application: 'applied', note }
}

function fail(op, error) {
  return { ok: false, op: pick(op), error }
}

function pick(op) {
  return { kind: op.kind, name: op.name ?? null, entryId: op.entryId ?? null, version: op.version ?? null }
}

/** pluginManager rejects with plain `{ code }` objects, so String() is useless. */
export function describeError(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || error.name
  if (typeof error.message === 'string' && error.message) return error.message
  if (typeof error.code === 'string') return error.code
  try {
    const text = JSON.stringify(error)
    return text && text !== '{}' ? (text.length > 300 ? `${text.slice(0, 300)}…` : text) : String(error)
  } catch {
    return String(error)
  }
}

function fromChange(op, result) {
  const r = result && typeof result === 'object' ? result : {}
  return {
    ok: r.application !== 'failed' && r.application !== 'cancelled',
    op: pick(op),
    application: r.application ?? 'applied',
    restartReason: r.restartReason ?? null,
    error: r.error ? describeError(r.error) : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
    pendingBuilds: Array.isArray(r.pendingBuilds) ? r.pendingBuilds : [],
    changed: r.changed !== false,
  }
}
