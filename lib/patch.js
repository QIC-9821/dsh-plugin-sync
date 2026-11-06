import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Minimal reader/writer for the top-level rows of a DSH `cordis.patch.yml`.
 *
 * Only the top-level `- id: <row>` rows are touched; nested `- insert:` blocks
 * and comments are carried through byte for byte. Values are written as YAML
 * flow mappings (`config: {"a":1}`), which is valid YAML and keeps the writer
 * free of a yaml dependency.
 */

const ROW_START = /^-\s+id:\s*(.+?)\s*$/
const NAME_LINE = /^\s+name:\s*(.+?)\s*$/
const DISABLED_LINE = /^\s+disabled:\s*(true|false)\s*$/
const CONFIG_LINE = /^\s+config:\s*(.*)$/

export function parseRows(text) {
  const lines = String(text ?? '').split('\n')
  const rows = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const start = ROW_START.exec(line)
    if (start) {
      current = { id: unquote(start[1]), name: null, disabled: null, startLine: index, endLine: index, configLines: null }
      rows.push(current)
      continue
    }
    if (!current) continue
    if (line.trim().length === 0) {
      // blank lines inside a row block: keep the block alive only if the next
      // non-blank line is still indented
      current.endLine = index
      continue
    }
    if (!/^\s/.test(line)) {
      current.endLine = index - 1
      current = null
      continue
    }
    const name = NAME_LINE.exec(line)
    if (name && current.name === null) current.name = unquote(name[1])
    const disabled = DISABLED_LINE.exec(line)
    if (disabled) current.disabled = disabled[1] === 'true'
    current.endLine = index
  }
  return rows
}

export function findRow(rows, { id, moduleName }) {
  if (id) {
    const byId = rows.find((row) => row.id === id)
    if (byId) return byId
  }
  if (moduleName) return rows.find((row) => row.name === moduleName) || null
  return null
}

export function rowConfig(text, row) {
  const lines = String(text ?? '').split('\n')
  const match = CONFIG_LINE.exec(lines[row.startLine] ?? '')
  void match
  for (let index = row.startLine; index <= row.endLine; index += 1) {
    const hit = CONFIG_LINE.exec(lines[index])
    if (!hit) continue
    const inline = hit[1].trim()
    if (inline && inline !== '|' && inline !== '>') {
      try {
        return JSON.parse(inline)
      } catch {
        const relaxed = parseFlowMapping(inline)
        if (relaxed !== null) return relaxed
        // Anything we cannot read stays opaque: config sync must never invent a value.
        return { __raw: inline }
      }
    }
    const block = []
    for (let cursor = index + 1; cursor <= row.endLine; cursor += 1) {
      const line = lines[cursor]
      if (!/^\s{3,}/.test(line)) break
      block.push(line.replace(/^\s{0,4}/, ''))
    }
    return block.length > 0 ? { __raw: block.join('\n') } : null
  }
  return null
}

export function setRowDisabled(text, rowId, disabled) {
  const source = String(text ?? '')
  const rows = parseRows(source)
  const row = findRow(rows, { id: rowId })
  const lines = source.split('\n')
  if (!row) {
    if (!disabled) return source
    const tail = source.endsWith('\n') || source.length === 0 ? '' : '\n'
    return `${source}${tail}- id: ${rowId}\n  disabled: true\n`
  }
  const value = disabled ? 'true' : 'false'
  for (let index = row.startLine; index <= row.endLine; index += 1) {
    if (DISABLED_LINE.test(lines[index])) {
      lines[index] = `  disabled: ${value}`
      return lines.join('\n')
    }
  }
  // insert after the name line, else right after the id line
  let anchor = row.startLine
  for (let index = row.startLine; index <= row.endLine; index += 1) {
    if (NAME_LINE.test(lines[index])) {
      anchor = index
      break
    }
  }
  lines.splice(anchor + 1, 0, `  disabled: ${value}`)
  return lines.join('\n')
}

export function setRowConfig(text, rowId, config) {
  const source = String(text ?? '')
  const rows = parseRows(source)
  const row = findRow(rows, { id: rowId })
  if (!row) return { text: source, changed: false, reason: 'row-not-found' }
  const lines = source.split('\n')
  let configStart = -1
  for (let index = row.startLine; index <= row.endLine; index += 1) {
    if (CONFIG_LINE.test(lines[index])) {
      configStart = index
      break
    }
  }
  const block = `  config: ${JSON.stringify(config ?? {})}`
  if (configStart === -1) {
    lines.splice(row.endLine + 1, 0, block)
    return { text: lines.join('\n'), changed: true }
  }
  let configEnd = configStart
  for (let cursor = configStart + 1; cursor <= row.endLine; cursor += 1) {
    if (!/^\s{3,}/.test(lines[cursor])) break
    configEnd = cursor
  }
  lines.splice(configStart, configEnd - configStart + 1, block)
  return { text: lines.join('\n'), changed: true }
}

export function readPatchText(profileDir) {
  if (!profileDir) return ''
  const path = `${profileDir}/cordis.patch.yml`
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function backupPatch(profileDir, backupRoot, stamp = new Date()) {
  if (!profileDir) return null
  const path = `${profileDir}/cordis.patch.yml`
  if (!existsSync(path)) return null
  mkdirSync(backupRoot, { recursive: true })
  const tag = stamp.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const target = `${backupRoot}/cordis.patch.yml.${tag}.bak`
  copyFileSync(path, target)
  return target
}

export function writePatchText(profileDir, text) {
  const path = `${profileDir}/cordis.patch.yml`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** Read `{ appId: 1, nested: { a: 'b' } }` — JSON once bare keys are quoted. */
function parseFlowMapping(text) {
  const quotedKeys = String(text).replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
  for (const candidate of [quotedKeys, String(text).replace(/'/g, '"')]) {
    try {
      const value = JSON.parse(candidate)
      return value && typeof value === 'object' ? value : null
    } catch {
      // try next form
    }
  }
  return null
}

function unquote(value) {  const trimmed = String(value ?? '').trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
