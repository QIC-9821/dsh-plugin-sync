import { homedir } from 'node:os'
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGE_NAME = 'dsh-plugin-sync'

const SECRET_KEY = /(secret|token|passw|apikey|api_key|credential|cookie|private_key|privatekey|authorization|access_key)/i

export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME?.trim()
  return explicit || join(homedir(), '.dsh')
}

export function stateDir(env = process.env) {
  return join(dshHome(env), 'plugin-sync')
}

export function statePath(env = process.env) {
  return join(stateDir(env), 'state.json')
}

export function backupDir(env = process.env) {
  return join(stateDir(env), 'backups')
}

/**
 * The running profile is the one whose package.json depends on this package.
 * (A `file:` install keeps the module inside D:\dsh-plugins, so the module path
 * says nothing about the profile.)
 */
export function resolveProfileDir(config = {}, env = process.env) {
  if (typeof config.profileDir === 'string' && config.profileDir.trim()) return config.profileDir.trim()
  if (env.DSH_PROFILE_DIR?.trim()) return env.DSH_PROFILE_DIR.trim()
  const root = join(dshHome(env), 'profiles')
  if (!existsSync(root)) return null
  const candidates = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }
      const hit = Boolean(deps[PACKAGE_NAME] || deps[PACKAGE_NAME] === '')
      candidates.push({ dir, name, hit, mtime: 0 })
    } catch {
      // ignore unreadable manifests
    }
  }
  const hit = candidates.find((entry) => entry.hit)
  if (hit) return hit.dir
  if (config !== null && candidates.length === 1) return candidates[0].dir
  return candidates.length > 0 ? candidates[candidates.length - 1].dir : null
}

export const DEFAULTS = {
  enabled: true,
  // schedule
  autoStart: true,
  autoRestart: true,
  intervalMinutes: 0,
  startupDelaySec: 25,
  // direction / conflict
  direction: 'push',
  conflict: 'local',
  // peer
  peerMode: 'off',
  peerUrl: '',
  peerToken: '',
  peerName: '',
  localName: '',
  peerHost: '',
  peerUser: '',
  peerPort: 22,
  peerKey: '',
  peerHttpPort: 18777,
  // capabilities
  capPlugins: true,
  capConfig: false,
  capInstall: false,
  capFiles: false,
  capRemoteApply: true,
  capSecrets: false,
  // scope
  include: [],
  exclude: [],
  profileDir: '',
  maxBundleBytes: 48 * 1024 * 1024,
  timeoutMs: 60000,
}

export const CAPABILITY_KEYS = [
  'capPlugins',
  'capConfig',
  'capInstall',
  'capFiles',
  'capRemoteApply',
  'capSecrets',
]

export const CAPABILITY_LABELS = {
  capPlugins: ['插件清单与启停', '同步安装了哪些插件、哪些开着', 'Plugin inventory and enable state'],
  capConfig: ['插件配置', '同步每个插件在 cordis.patch.yml 里的配置项', 'Plugin config in cordis.patch.yml'],
  capInstall: ['安装 / 升级 / 卸载', '在另一端跑 pnpm、改 node_modules、增删插件包', 'Install, upgrade and remove packages (pnpm)'],
  capFiles: ['复制插件二进制', '把本机 file: 插件的源码目录打包传过去', 'Copy local plugin source folders'],
  capRemoteApply: ['允许对端改动本机', '对端推过来的变更可以在本机落地', 'Allow the peer to change this machine'],
  capSecrets: ['同步密钥字段', '（默认关）同步 appSecret / token 之类字段', 'Include secret-looking config fields'],
}

export const DIRECTION_LABELS = {
  push: ['推送到对端', 'Push this machine to the peer'],
  pull: ['从对端拉取', 'Pull the peer to this machine'],
  both: ['双向合并', 'Merge both ways'],
  off: ['只比较不改', 'Compare only'],
}

export function normalizeConfig(config = {}, env = process.env) {
  const cfg = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config || {})) {
    if (value === undefined || value === null) continue
    if (key === 'peer' && typeof value === 'object') {
      Object.assign(cfg, normalizePeer(value))
      continue
    }
    cfg[key] = value
  }
  cfg.direction = ['push', 'pull', 'both', 'off'].includes(cfg.direction) ? cfg.direction : 'push'
  cfg.conflict = ['local', 'peer', 'newest'].includes(cfg.conflict) ? cfg.conflict : 'peer'
  cfg.peerMode = ['off', 'http', 'ssh'].includes(cfg.peerMode) ? cfg.peerMode : 'off'
  cfg.intervalMinutes = clampNumber(cfg.intervalMinutes, 0, 24 * 60, 0)
  cfg.startupDelaySec = clampNumber(cfg.startupDelaySec, 0, 600, 25)
  cfg.peerPort = clampNumber(cfg.peerPort, 1, 65535, 22)
  cfg.peerHttpPort = clampNumber(cfg.peerHttpPort, 1, 65535, 18777)
  cfg.maxBundleBytes = clampNumber(cfg.maxBundleBytes, 1024 * 1024, 512 * 1024 * 1024, 48 * 1024 * 1024)
  cfg.timeoutMs = clampNumber(cfg.timeoutMs, 5000, 600000, 60000)
  cfg.include = Array.isArray(cfg.include) ? cfg.include.map(String).filter(Boolean) : []
  cfg.exclude = Array.isArray(cfg.exclude) ? cfg.exclude.map(String).filter(Boolean) : []
  return cfg
}

function normalizePeer(peer) {
  const out = {}
  if (typeof peer.mode === 'string') out.peerMode = peer.mode
  if (typeof peer.url === 'string') out.peerUrl = peer.url
  if (typeof peer.token === 'string') out.peerToken = peer.token
  if (typeof peer.name === 'string') out.peerName = peer.name
  if (typeof peer.host === 'string') out.peerHost = peer.host
  if (typeof peer.user === 'string') out.peerUser = peer.user
  if (peer.port !== undefined) out.peerPort = peer.port
  if (typeof peer.key === 'string') out.peerKey = peer.key
  if (peer.httpPort !== undefined) out.peerHttpPort = peer.httpPort
  return out
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function isSecretKey(key) {
  return SECRET_KEY.test(String(key))
}

/** Deep-clone a config object, replacing secret-looking leaves unless allowed. */
export function filterConfig(value, { includeSecrets = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => filterConfig(item, { includeSecrets }))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (!includeSecrets && isSecretKey(key)) {
      out[key] = '[redacted]'
      continue
    }
    out[key] = filterConfig(item, { includeSecrets })
  }
  return out
}

export function redactDeep(value) {
  return filterConfig(value, { includeSecrets: false })
}

export function readState(env = process.env) {
  const path = statePath(env)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeState(state, env = process.env) {
  const dir = stateDir(env)
  mkdirSync(dir, { recursive: true })
  const path = statePath(env)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return path
}

export function saveStatePatch(patch, env = process.env) {
  const next = { ...readState(env), ...(patch || {}) }
  writeState(next, env)
  return next
}

export function effectiveConfig(config = {}, env = process.env) {
  const state = readState(env)
  const merged = { ...normalizeConfig(config, env) }
  const allowed = new Set(Object.keys(DEFAULTS))
  for (const [key, value] of Object.entries(state)) {
    if (!allowed.has(key)) continue
    if (typeof value === 'function') continue
    merged[key] = value
  }
  return normalizeConfig(merged, env)
}

export function ensureStateDirs(env = process.env) {
  const dir = stateDir(env)
  mkdirSync(dir, { recursive: true })
  mkdirSync(backupDir(env), { recursive: true })
  return dir
}
