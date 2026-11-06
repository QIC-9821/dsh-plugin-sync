import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Tar-based copy of a local `file:` bundle so the peer can install it too. */

export function packDirectory(dir, { maxBytes = 48 * 1024 * 1024, excludes = ['node_modules', '.git'] } = {}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(dir)) {
      reject(new Error(`目录不存在: ${dir}`))
      return
    }
    const parent = dirname(dir)
    const base = basename(dir)
    const args = ['-cf', '-', '-C', parent]
    for (const item of excludes) args.push(`--exclude=${item}`)
    args.push(base)
    const child = spawn(tarExecutable(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks = []
    let size = 0
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        try {
          child.kill()
        } catch {
          // ignore
        }
        reject(new Error(`目录太大（>${Math.round(maxBytes / 1024 / 1024)}MB），已跳过: ${dir}`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => reject(new Error(`tar 不可用: ${error.message}`)))
    child.on('exit', (code) => {
      if (size > maxBytes) return
      if (code !== 0) {
        reject(new Error(`tar 打包失败 (${code}): ${stderr.trim().slice(-300)}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

export function unpackDirectory(buffer, destRoot, name) {
  return new Promise((resolve, reject) => {
    const safe = String(name).replace(/[^A-Za-z0-9._@-]/g, '_')
    const dest = join(destRoot, safe)
    mkdirSync(destRoot, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    const archive = join(destRoot, `${safe}.tar`)
    writeFileSync(archive, buffer)
    const child = spawn(tarExecutable(), ['-xf', archive, '-C', destRoot], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => reject(new Error(`tar 不可用: ${error.message}`)))
    child.on('exit', (code) => {
      try {
        rmSync(archive, { force: true })
      } catch {
        // ignore
      }
      if (code !== 0) {
        reject(new Error(`解包失败 (${code}): ${stderr.trim().slice(-300)}`))
        return
      }
      resolve(dest)
    })
  })
}

function tarExecutable() {
  return process.platform === 'win32' ? 'tar' : 'tar'
}
