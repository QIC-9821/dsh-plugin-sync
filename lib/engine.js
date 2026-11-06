import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyPlan } from './apply.js'
import {
  CAPABILITY_KEYS,
  PACKAGE_NAME,
  backupDir,
  effectiveConfig,
  ensureStateDirs,
  readState,
  resolveProfileDir,
  saveStatePatch,
  writeState,
} from './config.js'
import { describeOps, isExcluded, planMerge } from './merge.js'
import { buildSnapshot, localDirOf, summarizeSnapshot } from './snapshot.js'
import { PeerLink } from './transport.js'
import { packDirectory } from './transfer.js'

const MAX_LOG = 200

/** Loader rows a peer is never allowed to switch off on this machine. */
const PROTECTED_ENTRIES = ['include:plugin-sync', 'include:plugin-manager', 'include:loader', 'include:hmr', 'include:web-server']

export class Engine {
  constructor({ ctx, config = {}, env = process.env, logger = console } = {}) {
    this.ctx = ctx
    this.rawConfig = config
    this.env = env
    this.logger = logger
    this.lines = []
    this.timers = []
    this.running = null
    this.link = null
    this.version = null
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}`
    this.lines.push(line)
    if (this.lines.length > MAX_LOG) this.lines.splice(0, this.lines.length - MAX_LOG)
    try {
      this.logger.info?.(`[plugin-sync] ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  logs(limit = 80) {
    return this.lines.slice(-limit)
  }

  cfg() {
    const dir = ensureStateDirs(this.env)
    const cfg = effectiveConfig({ ...this.rawConfig, __version: this.version }, this.env)
    cfg.__backupDir = join(dir, 'backups')
    cfg.__stateDir = dir
    cfg.__incoming = join(dir, 'incoming')
    return cfg
  }

  profileDir(cfg = this.cfg()) {
    if (cfg.profileDir && existsSync(cfg.profileDir)) return cfg.profileDir
    return resolveProfileDir(cfg, this.env)
  }

  get lastRun() {
    return readState(this.env).lastRun ?? null
  }

  async status() {
    const cfg = this.cfg()
    const profileDir = this.profileDir(cfg)
    let local = null
    let localError = null
    try {
      local = summarizeSnapshot(await buildSnapshot({ ctx: this.ctx, cfg, profileDir, includeConfig: cfg.capConfig }))
    } catch (error) {
      localError = error?.message || String(error)
    }
    return {
      enabled: cfg.enabled,
      profileDir,
      peer: { mode: cfg.peerMode, describe: new PeerLink(cfg).describe(), configured: new PeerLink(cfg).configured },
      schedule: {
        autoStart: cfg.autoStart,
        autoRestart: cfg.autoRestart,
        intervalMinutes: cfg.intervalMinutes,
      },
      direction: cfg.direction,
      conflict: cfg.conflict,
      capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, Boolean(cfg[key])])),
      local,
      localError,
      lastRun: this.lastRun,
      running: Boolean(this.running),
    }
  }

  async localSnapshot({ includeConfig = null, includeSources = false } = {}) {
    const cfg = this.cfg()
    return buildSnapshot({
      ctx: this.ctx,
      cfg,
      profileDir: this.profileDir(cfg),
      includeConfig: includeConfig === null ? cfg.capConfig : includeConfig,
      includeSources,
    })
  }

  linkFor(cfg) {
    if (!this.link || this.link.cfg !== cfg) {
      this.link?.dispose()
      this.link = new PeerLink(cfg, { log: (line) => this.log(line) })
    }
    return this.link
  }

  async peerSnapshot({ includeConfig = null, includeSources = false } = {}) {
    const cfg = this.cfg()
    const link = this.linkFor(cfg)
    if (!link.configured) throw new Error('对端未配置')
    return link.call('/plugin-sync/peer/snapshot', {
      method: 'POST',
      body: {
        includeConfig: includeConfig === null ? cfg.capConfig : includeConfig,
        includeSources,
      },
    })
  }

  optionsFor(cfg) {
    return {
      conflict: cfg.conflict,
      capPlugins: cfg.capPlugins,
      capInstall: cfg.capInstall,
      capConfig: cfg.capConfig,
      capFiles: cfg.capFiles,
      include: cfg.include,
      exclude: cfg.exclude,
      mirror: false,
      selfName: PACKAGE_NAME,
    }
  }

  async plan({ direction = null, peer = null } = {}) {
    const cfg = this.cfg()
    const want = direction || cfg.direction
    const local = await this.localSnapshot({ includeSources: cfg.capFiles })
    const remote = peer || (await this.peerSnapshot({ includeSources: cfg.capFiles }))
    const options = this.optionsFor(cfg)
    const out = { direction: want, local: summarizeSnapshot(local), peer: summarizeSnapshot(remote), pushes: null, pulls: null }
    if (want === 'push' || want === 'both') {
      out.pushes = labelPlan(planMerge(local, remote, options))
    }
    if (want === 'pull' || want === 'both') {
      out.pulls = labelPlan(planMerge(remote, local, options))
    }
    return out
  }

  async sync({ trigger = 'manual', direction = null, dryRun = false } = {}) {
    if (this.running) return { ok: false, error: '已有一轮同步在跑', trigger }
    this.running = this.runSync({ trigger, direction, dryRun })
    try {
      return await this.running
    } finally {
      this.running = null
    }
  }

  async runSync({ trigger, direction, dryRun }) {
    const started = Date.now()
    const cfg = this.cfg()
    const result = { trigger, direction: direction || cfg.direction, dryRun, at: new Date().toISOString(), steps: [] }
    if (!cfg.enabled) {
      this.log(`skip (${trigger}): 插件同步已关闭`)
      return { ...result, ok: true, skipped: 'disabled' }
    }
    const want = direction || cfg.direction
    if (want === 'off') {
      this.log(`skip (${trigger}): 只比较不改`)
      return { ...result, ok: true, skipped: 'compare-only' }
    }
    try {
      if (!this.linkFor(cfg).configured) throw new Error('对端未配置（设置 → 插件同步 → 对端）')
      const local = await this.localSnapshot({ includeSources: cfg.capFiles })
      let remote = await this.peerSnapshot({ includeSources: cfg.capFiles })
      const options = this.optionsFor(cfg)

      if (want === 'push' || want === 'both') {
        const plan = planMerge(local, remote, options)
        this.log(`push plan: ${plan.ops.length} ops (${describeOps(plan.ops).join(', ') || '无'})`)
        if (!dryRun && plan.ops.length > 0) {
          const ready = await this.prepareCopies(cfg, plan.ops, local)
          const applied = await this.linkFor(cfg).call('/plugin-sync/peer/apply', {
            method: 'POST',
            body: { ops: ready, conflict: cfg.conflict, requestedBy: local.node.name },
          })
          result.steps.push({ step: 'push', plan: { ops: plan.ops.length, notes: plan.notes }, applied })
        } else {
          result.steps.push({ step: 'push', plan: { ops: plan.ops.length, notes: plan.notes }, applied: null })
        }
        if (!dryRun && plan.ops.length > 0) remote = await this.peerSnapshot({ includeSources: cfg.capFiles })
      }

      if (want === 'pull' || want === 'both') {
        if (!cfg.capRemoteApply && want === 'pull') {
          throw new Error('本机未允许对端改动（同步权限里开启「允许对端改动本机」）')
        }
        const plan = planMerge(remote, local, options)
        this.log(`pull plan: ${plan.ops.length} ops (${describeOps(plan.ops).join(', ') || '无'})`)
        if (!dryRun && plan.ops.length > 0) {
          const ready = await this.prepareCopiesFromPeer(cfg, plan.ops, remote)
          const applied = await applyPlan({
            ctx: this.ctx,
            ops: ready,
            cfg,
            profileDir: this.profileDir(cfg),
            log: (line) => this.log(line),
          })
          result.steps.push({ step: 'pull', plan: { ops: plan.ops.length, notes: plan.notes }, applied })
        } else {
          result.steps.push({ step: 'pull', plan: { ops: plan.ops.length, notes: plan.notes }, applied: null })
        }
      }

      const failedSteps = result.steps.filter((step) => step.applied && step.applied.ok === false)
      const summary = {
        ...result,
        ok: failedSteps.length === 0,
        ms: Date.now() - started,
        restartRequired: result.steps.some((step) => step.applied?.restartRequired),
      }
      this.recordRun(summary, cfg)
      this.log(`done (${trigger}) in ${summary.ms}ms ok=${summary.ok}`)
      return summary
    } catch (error) {
      const summary = {
        ...result,
        ok: false,
        error: error?.message || String(error),
        ms: Date.now() - started,
      }
      this.recordRun(summary, cfg)
      this.log(`failed (${trigger}): ${summary.error}`)
      return summary
    }
  }

  recordRun(summary, cfg) {
    try {
      const state = readState(this.env)
      state.lastRun = {
        at: summary.at,
        trigger: summary.trigger,
        ok: summary.ok,
        error: summary.error ?? null,
        ms: summary.ms ?? null,
        direction: summary.direction,
        steps: (summary.steps || []).map((step) => ({
          step: step.step,
          ops: step.plan?.ops ?? 0,
          applied: step.applied?.applied ?? 0,
          failed: step.applied?.failed ?? 0,
        })),
      }
      state.updatedAt = new Date().toISOString()
      void cfg
      writeState(state, this.env)
    } catch (error) {
      this.log(`record failed: ${error?.message || error}`)
    }
  }

  /** Copy local source dirs to the peer for `file:` installs. */
  async prepareCopies(cfg, ops, local) {
    const out = []
    for (const op of ops) {
      if (op.kind !== 'install' || op.source !== 'copy') {
        out.push(op)
        continue
      }
      if (!cfg.capFiles) {
        out.push({ ...op, error: '复制插件二进制权限未开启，跳过安装' })
        continue
      }
      const sourceDir = local.sources?.[op.name]?.path || localDirOf(op.spec)
      if (!sourceDir) {
        out.push(op)
        continue
      }
      try {
        const buffer = await packDirectory(sourceDir, { maxBytes: cfg.maxBundleBytes })
        const uploaded = await this.linkFor(cfg).call('/plugin-sync/peer/transfer', {
          method: 'POST',
          raw: buffer,
          headers: {
            'content-type': 'application/x-tar',
            'x-sync-bundle': encodeURIComponent(op.name),
          },
          timeoutMs: Math.max(cfg.timeoutMs, 120000),
        })
        if (uploaded?.path) out.push({ ...op, spec: uploaded.path, source: 'copied' })
        else out.push({ ...op, error: uploaded?.error || '对端没有返回解包路径' })
      } catch (error) {
        out.push({ ...op, error: error?.message || String(error) })
      }
    }
    return out
  }

  /** Pull-direction: ask the peer to ship its source dir to us, then install. */
  async prepareCopiesFromPeer(cfg, ops, remote) {
    const out = []
    const link = this.linkFor(cfg)
    for (const op of ops) {
      if (op.kind !== 'install' || op.source !== 'copy') {
        out.push(op)
        continue
      }
      if (!cfg.capFiles) {
        out.push({ ...op, error: '复制插件二进制权限未开启，跳过安装' })
        continue
      }
      try {
        const response = await link.call('/plugin-sync/peer/source', {
          method: 'POST',
          body: { bundle: op.name, spec: op.spec },
          timeoutMs: Math.max(cfg.timeoutMs, 120000),
        })
        if (response?.tarball) {
          const { unpackDirectory } = await import('./transfer.js')
          const path = await unpackDirectory(Buffer.from(response.tarball, 'base64'), cfg.__incoming, op.name)
          out.push({ ...op, spec: path })
        } else if (response?.path) {
          out.push({ ...op, spec: response.path })
        } else {
          out.push({ ...op, error: response?.error || '对端没有返回源码包' })
        }
      } catch (error) {
        out.push({ ...op, error: error?.message || String(error) })
      }
    }
    return out
  }

  updateState(patch) {
    const state = saveStatePatch(patch, this.env)
    this.log(`state updated: ${Object.keys(patch).join(', ')}`)
    return state
  }

  schedule() {
    this.disposeTimers()
    const cfg = this.cfg()
    if (cfg.autoStart) {
      const delay = Math.max(0, cfg.startupDelaySec) * 1000
      const timer = setTimeout(() => {
        void this.sync({ trigger: 'startup' })
      }, delay)
      timer.unref?.()
      this.timers.push(timer)
      this.log(`startup sync armed (+${Math.round(delay / 1000)}s)`)
    }
    if (cfg.autoRestart) {
      // On a server the process restart *is* the startup; a second, later pass
      // catches the case where the peer was still booting during the first one.
      const timer = setTimeout(() => {
        void this.sync({ trigger: 'restart' })
      }, Math.max(120000, Math.max(0, cfg.startupDelaySec) * 1000 + 90000))
      timer.unref?.()
      this.timers.push(timer)
      this.log('restart sync armed (+~2min)')
    }
    if (cfg.intervalMinutes > 0) {
      const every = cfg.intervalMinutes * 60000
      const timer = setInterval(() => {
        void this.sync({ trigger: 'interval' })
      }, every)
      timer.unref?.()
      this.timers.push(timer)
      this.log(`interval sync every ${cfg.intervalMinutes}min`)
    }
  }

  disposeTimers() {
    for (const timer of this.timers) {
      try {
        clearTimeout(timer)
        clearInterval(timer)
      } catch {
        // ignore
      }
    }
    this.timers = []
  }

  dispose() {
    this.disposeTimers()
    this.link?.dispose()
    this.link = null
  }

  /** Validate ops coming from a peer before they touch this machine. */
  sanitizeOps(ops, cfg) {
    const allowed = new Set(['install', 'upgrade', 'remove', 'enable', 'disable', 'plugin-enable', 'plugin-disable', 'config'])
    const out = []
    for (const op of Array.isArray(ops) ? ops.slice(0, 100) : []) {
      if (!op || !allowed.has(op.kind)) continue
      const name = op.name || op.moduleName || ''
      if (name && isExcluded(name, { exclude: cfg.exclude, selfName: PACKAGE_NAME })) continue
      if (op.kind === 'install' && typeof op.spec !== 'string') continue
      if (op.error) continue
      if ((op.kind === 'install' || op.kind === 'upgrade' || op.kind === 'remove') && !cfg.capInstall) continue
      if (op.kind === 'config' && !cfg.capConfig) continue
      if (op.kind === 'plugin-enable' || op.kind === 'plugin-disable') {
        // A peer may not switch off the rows this machine is built on.
        if (typeof op.entryId !== 'string' || !op.entryId) continue
        if (PROTECTED_ENTRIES.some((entry) => op.entryId === entry || op.entryId.startsWith(`${entry}:`))) continue
      }
      if (!cfg.capPlugins && op.kind !== 'install' && op.kind !== 'upgrade' && op.kind !== 'remove' && op.kind !== 'config') continue
      out.push(op)
    }
    return out
  }
}

function labelPlan(plan) {
  return {
    ops: plan.ops.map((op) => ({ ...op, label: describeOp(op) })),
    notes: plan.notes,
    stats: plan.stats,
  }
}

function describeOp(op) {
  const labels = {
    install: '安装',
    upgrade: '升级',
    remove: '卸载',
    enable: '启用',
    disable: '停用',
    'plugin-enable': '启用条目',
    'plugin-disable': '停用条目',
    config: '写配置',
  }
  const name = op.name || op.moduleName || op.entryId || ''
  const extra = op.kind === 'upgrade' ? ` ${op.from ?? ''} → ${op.version ?? ''}` : op.error ? ` ⚠ ${op.error}` : ''
  return `${labels[op.kind] || op.kind} ${name}${extra}`.trim()
}

export function readVersion(url) {
  try {
    const text = readFileSync(new URL(url), 'utf8')
    return JSON.parse(text).version ?? null
  } catch {
    return null
  }
}
