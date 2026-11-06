import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

/**
 * Talks to the peer's `/plugin-sync/peer/*` namespace.
 * Two drivers, one wire protocol:
 *  - http: talk to the peer's web server directly
 *  - ssh:  open a local forward (`ssh -N -L`) and then talk HTTP through it
 * That keeps merge/apply logic identical on both machines.
 */
export class PeerLink {
  constructor(cfg, { log = () => {} } = {}) {
    // Callers normally hand over a normalized config; stand-alone callers
    // (scripts, tests) may hand over a raw state file, so fill the two ports.
    this.cfg = {
      ...cfg,
      peerPort: Number(cfg?.peerPort) || 22,
      peerHttpPort: Number(cfg?.peerHttpPort) || 18777,
    }
    this.log = log
    this.child = null
    this.baseUrl = null
    this.localPort = null
  }

  get configured() {
    if (this.cfg.peerMode === 'http') return Boolean(this.cfg.peerUrl)
    if (this.cfg.peerMode === 'ssh') return Boolean(this.cfg.peerHost && this.cfg.peerUser)
    return false
  }

  describe() {
    if (this.cfg.peerMode === 'http') return this.cfg.peerUrl || '(未设置地址)'
    if (this.cfg.peerMode === 'ssh') return `${this.cfg.peerUser}@${this.cfg.peerHost}:${this.cfg.peerPort} → 127.0.0.1:${this.cfg.peerHttpPort}`
    return '(未配置对端)'
  }

  async ensure() {
    if (this.baseUrl) return this.baseUrl
    if (this.cfg.peerMode === 'http') {
      if (!this.cfg.peerUrl) throw new Error('对端地址为空')
      this.baseUrl = this.cfg.peerUrl.replace(/\/+$/, '')
      return this.baseUrl
    }
    if (this.cfg.peerMode === 'ssh') return this.ensureTunnel()
    throw new Error('未配置对端（设置里选择 http 或 ssh）')
  }

  async ensureTunnel() {
    if (this.child && this.baseUrl) return this.baseUrl
    const port = await freePort()
    const args = [
      '-N',
      '-L',
      `127.0.0.1:${port}:127.0.0.1:${this.cfg.peerHttpPort}`,
      `${this.cfg.peerUser}@${this.cfg.peerHost}`,
      '-p',
      String(this.cfg.peerPort),
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
    ]
    if (this.cfg.peerKey) args.push('-i', this.cfg.peerKey)
    this.log(`ssh tunnel: 127.0.0.1:${port} → ${this.cfg.peerHost}:${this.cfg.peerHttpPort}`)
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    this.localPort = port
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('exit', (code) => {
      if (this.child === child && code !== 0) {
        this.log(`ssh tunnel exited (${code}): ${stderr.trim().slice(-400)}`)
      }
      if (this.child === child) {
        this.child = null
        this.baseUrl = null
      }
    })
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      await sleep(500)
      try {
        await this.call('/plugin-sync/peer/ping', { timeoutMs: 3000, baseUrl: base })
        this.baseUrl = base
        return base
      } catch {
        if (!this.child) break
      }
    }
    this.dispose()
    throw new Error(`ssh 隧道未就绪${stderr ? `：${stderr.trim().slice(-300)}` : ''}`)
  }

  async call(path, options = {}) {
    const baseUrl = options.baseUrl || (await this.ensure())
    const headers = { accept: 'application/json', ...(options.headers || {}) }
    if (this.cfg.peerToken) headers['x-plugin-sync-token'] = this.cfg.peerToken
    let body
    if (options.raw !== undefined) {
      body = options.raw
      headers['content-type'] = headers['content-type'] || 'application/octet-stream'
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    const timeout = options.timeoutMs ?? this.cfg.timeoutMs
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(Math.max(1000, timeout)),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      const error = new Error(`${path} 返回的不是 JSON`)
      error.raw = text.slice(0, 300)
      throw error
    }
  }

  dispose() {
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        // ignore
      }
      this.child = null
    }
    this.baseUrl = null
    this.localPort = null
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
