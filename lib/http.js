import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { applyPlan } from './apply.js'
import {
  CAPABILITY_LABELS,
  DIRECTION_LABELS,
  ensureStateDirs,
  readState,
} from './config.js'
import { isExcluded } from './merge.js'
import { buildSnapshot, localDirOf } from './snapshot.js'
import { packDirectory, unpackDirectory } from './transfer.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function createRoutes({ engine, ctx, origin = '' }) {
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    const cfg = engine.cfg()
    const peerRequest = isPeerCall(req, cfg)
    const localOk = isLocalCall(req, origin)

    try {
      if (path === '/plugin-sync' || path === '/plugin-sync/') {
        if (!localOk) return send(res, 403, { error: 'forbidden' })
        return sendHtml(res, PAGE)
      }

      if (path.startsWith('/plugin-sync/api/')) {
        if (!localOk && !peerRequest) return send(res, 403, { error: 'forbidden' })
        const action = path.slice('/plugin-sync/api/'.length)
        if (action === 'state' && req.method === 'GET') {
          return send(res, 200, await statePayload(engine, cfg))
        }
        if (action === 'config' && req.method === 'POST') {
          const body = await readJson(req)
          return send(res, 200, await saveConfig(engine, body))
        }
        if (action === 'sync' && req.method === 'POST') {
          const body = await readJson(req)
          const result = await engine.sync({
            trigger: 'manual',
            direction: typeof body.direction === 'string' ? body.direction : null,
            dryRun: Boolean(body.dryRun),
          })
          return send(res, 200, { ...result, status: await engine.status() })
        }
        if (action === 'plan' && req.method === 'GET') {
          return send(res, 200, await engine.plan({ direction: url.searchParams.get('direction') || null }))
        }
        if (action === 'snapshot' && req.method === 'GET') {
          return send(res, 200, await engine.localSnapshot({ includeSources: cfg.capFiles }))
        }
        if (action === 'logs' && req.method === 'GET') {
          return send(res, 200, { lines: engine.logs(Number(url.searchParams.get('limit')) || 80) })
        }
        return send(res, 404, { error: `unknown api: ${action}` })
      }

      if (path.startsWith('/plugin-sync/peer/')) {
        if (!peerRequest) return send(res, 403, { error: 'forbidden: peer token required' })
        const action = path.slice('/plugin-sync/peer/'.length)
        return await handlePeer({ action, req, res, engine, ctx, cfg })
      }

      return send(res, 404, { error: 'not found' })
    } catch (error) {
      return send(res, 500, { error: error?.message || String(error) })
    }
  }

  return { handle }
}

async function handlePeer({ action, req, res, engine, ctx, cfg }) {
  if (action === 'ping') {
    return send(res, 200, { ok: true, node: engine.cfg().peerName || null, at: new Date().toISOString() })
  }
  if (action === 'snapshot') {
    if (!cfg.capRemoteApply) return send(res, 403, { error: '本机未允许对端读取（允许对端改动本机未开启）' })
    const body = req.method === 'POST' ? await readJson(req) : {}
    const snapshot = await engine.localSnapshot({
      includeConfig: body.includeConfig === undefined ? cfg.capConfig : Boolean(body.includeConfig),
      includeSources: Boolean(body.includeSources),
    })
    return send(res, 200, snapshot)
  }
  if (action === 'apply') {
    if (!cfg.capRemoteApply) return send(res, 403, { error: '本机未允许对端改动（允许对端改动本机未开启）' })
    const body = await readJson(req)
    const ops = engine.sanitizeOps(body.ops, cfg)
    const result = await applyPlan({
      ctx,
      ops,
      cfg,
      profileDir: engine.profileDir(cfg),
      log: (line) => engine.log(line),
    })
    engine.log(`peer applied ${result.applied}/${ops.length} ops (failed ${result.failed})`)
    return send(res, 200, { ...result, received: Array.isArray(body.ops) ? body.ops.length : 0 })
  }
  if (action === 'transfer') {
    if (!cfg.capFiles) return send(res, 403, { error: '本机未开启复制插件二进制' })
    const bundle = decodeURIComponent(String(req.headers['x-sync-bundle'] || 'bundle'))
    const buffer = await readBody(req, cfg.maxBundleBytes)
    const incoming = join(ensureStateDirs(), 'incoming')
    const path = await unpackDirectory(buffer, incoming, bundle)
    engine.log(`peer transfer received ${bundle} (${buffer.length}B) → ${path}`)
    return send(res, 200, { ok: true, path, bundle })
  }
  if (action === 'source') {
    if (!cfg.capFiles) return send(res, 403, { error: '本机未开启复制插件二进制' })
    const body = await readJson(req)
    const snapshot = await engine.localSnapshot({ includeSources: true })
    const bundle = String(body.bundle || '')
    const dir = snapshot.sources?.[bundle]?.path || localDirOf(body.spec)
    if (!dir || !existsSync(dir)) return send(res, 200, { error: `本机找不到 ${bundle} 的源码目录` })
    const buffer = await packDirectory(dir, { maxBytes: Math.min(cfg.maxBundleBytes, 16 * 1024 * 1024) })
    return send(res, 200, { name: bundle, tarball: buffer.toString('base64') })
  }
  return send(res, 404, { error: `unknown peer api: ${action}` })
}

export async function statePayload(engine, cfg) {
  const status = await engine.status()
  return {
    status,
    config: {
      enabled: cfg.enabled,
      autoStart: cfg.autoStart,
      autoRestart: cfg.autoRestart,
      intervalMinutes: cfg.intervalMinutes,
      startupDelaySec: cfg.startupDelaySec,
      direction: cfg.direction,
      conflict: cfg.conflict,
      peerMode: cfg.peerMode,
      peerUrl: cfg.peerUrl,
      peerName: cfg.peerName,
      localName: cfg.localName,
      peerHost: cfg.peerHost,
      peerUser: cfg.peerUser,
      peerPort: cfg.peerPort,
      peerHttpPort: cfg.peerHttpPort,
      peerKey: cfg.peerKey,
      peerTokenSet: Boolean(cfg.peerToken),
      capabilities: Object.fromEntries(
        Object.keys(CAPABILITY_LABELS).map((key) => [key, Boolean(cfg[key])]),
      ),
      include: cfg.include,
      exclude: cfg.exclude,
    },
    capabilityCatalog: Object.entries(CAPABILITY_LABELS).map(([key, [label, desc, en]]) => ({
      key,
      label,
      desc,
      en,
      on: Boolean(cfg[key]),
    })),
    directionCatalog: Object.entries(DIRECTION_LABELS).map(([key, [label, en]]) => ({ key, label, en })),
    updatedAt: readState().updatedAt ?? null,
  }
}

export async function saveConfig(engine, body = {}) {
  const patch = {}
  const bools = ['enabled', 'autoStart', 'autoRestart', 'capPlugins', 'capConfig', 'capInstall', 'capFiles', 'capRemoteApply', 'capSecrets']
  for (const key of bools) if (typeof body[key] === 'boolean') patch[key] = body[key]
  for (const [key, value] of Object.entries(body.capabilities || {})) {
    if (key in CAPABILITY_LABELS && typeof value === 'boolean') patch[key] = value
  }
  const numbers = ['intervalMinutes', 'startupDelaySec', 'peerPort', 'peerHttpPort']
  for (const key of numbers) {
    if (body[key] !== undefined && Number.isFinite(Number(body[key]))) patch[key] = Number(body[key])
  }
  const strings = ['direction', 'conflict', 'peerMode', 'peerUrl', 'peerName', 'localName', 'peerHost', 'peerUser', 'peerKey']
  for (const key of strings) if (typeof body[key] === 'string') patch[key] = body[key].trim()
  if (typeof body.peerToken === 'string' && body.peerToken.length > 0) patch.peerToken = body.peerToken
  if (body.clearPeerToken === true) patch.peerToken = ''
  if (Array.isArray(body.include)) patch.include = body.include.map(String).filter(Boolean)
  if (Array.isArray(body.exclude)) patch.exclude = body.exclude.map(String).filter(Boolean)
  engine.updateState(patch)
  engine.schedule()
  const cfg = engine.cfg()
  return statePayload(engine, cfg)
}

export function isPeerCall(req, cfg) {
  const token = req.headers['x-plugin-sync-token']
  if (!cfg.peerToken || typeof token !== 'string') return false
  return token === cfg.peerToken
}

export function isLocalCall(req, origin) {
  const requestOrigin = req.headers.origin
  if (!requestOrigin) return true
  if (origin && requestOrigin === origin) return true
  try {
    const host = req.headers.host
    return new URL(requestOrigin).host === host
  } catch {
    return false
  }
}

function send(res, status, body) {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sendHtml(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

async function readJson(req) {
  const buffer = await readBody(req, 32 * 1024 * 1024)
  if (!buffer.length) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return {}
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit * 1.5) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Standalone panel: same data as the settings section, opened at /plugin-sync. */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件同步 · dsh-plugin-sync</title>
<style>
  :root{color-scheme:light dark;--fg:#1c1c1e;--muted:#6b6b70;--bg:#f6f6f7;--card:#fff;--line:#e3e3e6;--accent:#3b82f6;--ok:#10a37f;--bad:#d9534f}
  @media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#9a9aa2;--bg:#17171a;--card:#1f1f23;--line:#303036}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:18px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:18px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:1180px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .card.wide{grid-column:span 2}
  @media (max-width:760px){.card.wide{grid-column:1/-1}}
  .card h2{font-size:14px;margin:0 0 12px;font-weight:600}
  .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--line)}
  .row:last-child{border-bottom:none}
  .k{color:var(--muted)}.v{text-align:right;word-break:break-all}
  button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.5;cursor:default}
  input,select{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);width:100%}
  input[type=checkbox]{width:auto;flex:0 0 auto}
  label.swap{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line);cursor:pointer}
  label.swap span{flex:1}
  label.swap:last-child{border-bottom:none}
  .muted{color:var(--muted);font-size:12.5px}
  .ok{color:var(--ok)}.bad{color:var(--bad)}
  pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.1);padding:10px;border-radius:8px;max-height:260px;overflow:auto;font-size:12px}
</style></head><body>
<h1>插件同步</h1>
<div class="sub">把插件清单、配置、启停状态、包安装与本地插件目录在两台机器之间对齐。设置页里也能改这里的一切。</div>
<div class="grid">
  <div class="card"><h2>状态</h2><div id="status">读取中…</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="primary" id="sync">立即同步</button>
      <button id="plan">只看计划</button>
      <button id="reload">刷新</button>
    </div></div>
  <div class="card"><h2>对端</h2>
    <label class="muted">方式</label><select id="peerMode">
      <option value="off">未配置</option><option value="http">HTTP</option><option value="ssh">SSH 隧道</option></select>
    <div class="muted" style="margin-top:8px">HTTP 地址</div><input id="peerUrl" placeholder="http://127.0.0.1:18777">
    <div class="muted" style="margin-top:8px">SSH 主机 / 用户 / 端口</div>
    <div style="display:grid;grid-template-columns:2fr 1fr 80px;gap:6px"><input id="peerHost" placeholder="114.55.146.70"><input id="peerUser" placeholder="dsh"><input id="peerPort" placeholder="22"></div>
    <div class="muted" style="margin-top:8px">对端 Web 端口 / 私钥 / 令牌</div>
    <div style="display:grid;grid-template-columns:100px 1fr;gap:6px"><input id="peerHttpPort" placeholder="18777"><input id="peerKey" placeholder="C:\\Users\\QIC\\.ssh\\dsh_cloud_ed25519"></div>
    <input id="peerToken" placeholder="对端令牌（留空不改）" style="margin-top:6px">
  </div>
  <div class="card"><h2>同步方式</h2>
    <label class="muted">方向</label><select id="direction"></select>
    <div class="muted" style="margin-top:8px">冲突策略（启停状态 / 版本）</div>
    <select id="conflict"><option value="local">以发起方为准</option><option value="peer">以接收方为准</option><option value="newest">版本新者优先</option></select>
    <div class="muted" style="margin-top:8px">时机</div>
    <label class="swap"><input type="checkbox" id="autoStart"> 软件启动时同步</label>
    <label class="swap"><input type="checkbox" id="autoRestart"> 服务器重启后同步</label>
    <label class="swap"><input type="checkbox" id="enabled"> 总开关</label>
    <div class="muted" style="margin-top:8px">每隔多少分钟（0 = 不按间隔）</div><input id="intervalMinutes" type="number" min="0" max="1440">
  </div>
  <div class="card wide"><h2>权限</h2><div id="caps"></div></div>
  <div class="card" style="grid-column:1/-1"><h2>计划 / 日志</h2><pre id="out">—</pre></div>
</div>
<script>
const $ = (id) => document.getElementById(id)
let state = null
async function api(path, options) {
  const res = await fetch('/plugin-sync/api/' + path, options)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { error: text } }
}
function render() {
  if (!state) return
  const s = state.status
  $('status').innerHTML = [
    ['本机', s.local ? (s.local.node || '?') + ' · ' + (s.local.profile || '') + ' · ' + s.local.bundles + ' 包 / ' + s.local.plugins + ' 条目' : '读取失败'],
    ['profile', s.profileDir || '?'],
    ['对端', s.peer.describe],
    ['上次同步', s.lastRun ? (s.lastRun.at + ' · ' + (s.lastRun.ok ? '成功' : '失败：' + (s.lastRun.error || ''))) : '还没跑过'],
    ['当前', s.running ? '同步中…' : '空闲'],
  ].map(([k, v]) => '<div class="row"><span class="k">' + k + '</span><span class="v">' + escapeHtml(String(v)) + '</span></div>').join('')
  const c = state.config
  $('peerMode').value = c.peerMode
  $('peerUrl').value = c.peerUrl || ''
  $('peerHost').value = c.peerHost || ''
  $('peerUser').value = c.peerUser || ''
  $('peerPort').value = c.peerPort
  $('peerHttpPort').value = c.peerHttpPort
  $('peerKey').value = c.peerKey || ''
  $('peerToken').placeholder = c.peerTokenSet ? '令牌已设置（留空不改）' : '对端令牌'
  $('autoStart').checked = !!c.autoStart
  $('autoRestart').checked = !!c.autoRestart
  $('enabled').checked = !!c.enabled
  $('intervalMinutes').value = c.intervalMinutes
  $('conflict').value = c.conflict
  $('direction').innerHTML = state.directionCatalog.map((d) => '<option value="' + d.key + '"' + (d.key === c.direction ? ' selected' : '') + '>' + d.label + '</option>').join('')
  $('caps').innerHTML = state.capabilityCatalog.map((cap) =>
    '<label class="swap"><input type="checkbox" data-cap="' + cap.key + '"' + (cap.on ? ' checked' : '') + '>' +
    '<span><b>' + cap.label + '</b><br><span class="muted">' + cap.desc + '</span></span></label>').join('')
}
async function load() {
  state = await api('state')
  render()
}
async function save(patch) {
  state = await api('config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  render()
}
function collect() {
  const caps = {}
  document.querySelectorAll('[data-cap]').forEach((el) => { caps[el.dataset.cap] = el.checked })
  return {
    peerMode: $('peerMode').value, peerUrl: $('peerUrl').value, peerHost: $('peerHost').value,
    peerUser: $('peerUser').value, peerPort: Number($('peerPort').value) || 22,
    peerHttpPort: Number($('peerHttpPort').value) || 18777, peerKey: $('peerKey').value,
    peerToken: $('peerToken').value, autoStart: $('autoStart').checked, autoRestart: $('autoRestart').checked,
    enabled: $('enabled').checked, intervalMinutes: Number($('intervalMinutes').value) || 0,
    conflict: $('conflict').value, direction: $('direction').value, capabilities: caps,
  }
}
document.addEventListener('change', (event) => {
  const target = event.target
  if (target.id === 'peerToken') return
  if (target.matches('input,select')) void save(collect())
})
$('peerToken').addEventListener('blur', () => { if ($('peerToken').value) { void save(collect()); $('peerToken').value = '' } })
$('sync').addEventListener('click', async () => { $('out').textContent = '同步中…'; const r = await api('sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); $('out').textContent = JSON.stringify(r, null, 2); state.status = r.status || state.status; render() })
$('plan').addEventListener('click', async () => { $('out').textContent = '计算中…'; $('out').textContent = JSON.stringify(await api('plan'), null, 2) })
$('reload').addEventListener('click', () => { void load() })
function escapeHtml(text) { return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])) }
void load()
</script>
</body></html>`
