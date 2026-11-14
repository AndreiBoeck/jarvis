import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'

/**
 * Persistent, model-authored blade screens.
 *
 * A screen is deliberately only a presentation template. It cannot acquire
 * new permissions, run JavaScript or call tools; the browser still passes the
 * rendered HTML through the same DOMPurify boundary as every other blade.
 * This gives JARVIS memory for useful layouts without turning that memory into
 * executable code.
 */

const DEFAULT_FILE = join(homedir(), '.jarvis', 'blade-screens.json')
const MAX_SCREENS = 64
const MAX_HTML = 100_000
const MAX_RENDERED_HTML = 200_000
const SIZES = new Set(['compact', 'tall', 'wide', 'full'])

// displayServer is created once per connected interface. Consequently several
// ScreenLibrary instances can point at the same persistent file. Serialising
// on the instance would still allow those connections to overwrite each
// other's updates, so the queue belongs to the file instead.
const mutationQueues = new Map()

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function screenId(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = screenId(value.id)
  const html = String(value.html ?? '')
  if (!id || !html || html.length > MAX_HTML) return null
  return {
    id,
    title: String(value.title ?? id).trim().slice(0, 80) || id,
    description: String(value.description ?? '').trim().slice(0, 300),
    html,
    size: SIZES.has(value.size) ? value.size : 'wide',
    updatedAt: String(value.updatedAt ?? new Date(0).toISOString()),
  }
}

export class ScreenLibrary {
  constructor(file = process.env.JARVIS_SCREENS_FILE?.trim() || DEFAULT_FILE) {
    this.file = file
  }

  async read({ strict = false } = {}) {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.screens)) {
        throw new Error('saved screen library has an invalid shape')
      }
      const records = parsed.screens.map(validRecord)
      if (records.some((record) => record === null)) {
        throw new Error('saved screen library contains an invalid record')
      }
      return records.slice(0, MAX_SCREENS)
    } catch (err) {
      if (err?.code === 'ENOENT') return []
      if (strict) throw err
      console.warn('[jarvis] could not read saved blade screens:', err?.message ?? err)
      return []
    }
  }

  async list() {
    return (await this.read()).map(({ id, title, description, size, updatedAt }) => ({
      id,
      title,
      description,
      size,
      updatedAt,
    }))
  }

  async get(name) {
    const id = screenId(name)
    return (await this.read()).find((screen) => screen.id === id) ?? null
  }

  async save(input) {
    const id = screenId(input.name)
    const html = String(input.html ?? '').trim()
    if (!id) throw new Error('A screen needs a short name.')
    if (!html) throw new Error('A screen needs an HTML template.')
    if (html.length > MAX_HTML) throw new Error('The screen template is too large.')

    const record = {
      id,
      title: String(input.title ?? input.name).trim().slice(0, 80) || id,
      description: String(input.description ?? '').trim().slice(0, 300),
      html,
      size: SIZES.has(input.size) ? input.size : 'wide',
      updatedAt: new Date().toISOString(),
    }
    await this.mutate((screens) => {
      const next = screens.filter((screen) => screen.id !== id)
      next.push(record)
      return next.slice(-MAX_SCREENS)
    })
    return record
  }

  async remove(name) {
    const id = screenId(name)
    let removed = false
    await this.mutate((screens) => {
      removed = screens.some((screen) => screen.id === id)
      return screens.filter((screen) => screen.id !== id)
    })
    return removed
  }

  async mutate(change) {
    const previous = mutationQueues.get(this.file) ?? Promise.resolve()
    // A failed write must not poison the queue. The caller still receives its
    // own failure, while the next mutation is allowed to try again.
    const operation = previous.catch(() => {}).then(async () => {
      // Do not turn a parse error into data loss by treating a corrupt library
      // as empty and atomically replacing it with only this new record.
      const screens = change(await this.read({ strict: true }))
      await mkdir(dirname(this.file), { recursive: true })
      // A unique name also avoids collisions with a second JARVIS process.
      // rename remains atomic, so readers see either complete generation.
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, screens }, null, 2) + '\n', {
          mode: 0o600,
        })
        await rename(temporary, this.file)
      } catch (err) {
        await unlink(temporary).catch(() => {})
        throw err
      }
    })
    mutationQueues.set(this.file, operation)
    try {
      return await operation
    } finally {
      if (mutationQueues.get(this.file) === operation) mutationQueues.delete(this.file)
    }
  }
}

/** Replace {{field}} tokens with inert text. Missing fields render as an em dash. */
export function renderScreen(screen, values = {}) {
  const safeValues = values && typeof values === 'object' ? values : {}
  const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g
  const parts = []
  let length = 0
  let cursor = 0
  let match
  const append = (part) => {
    length += part.length
    if (length > MAX_RENDERED_HTML) throw new Error('The rendered screen is too large.')
    parts.push(part)
  }
  while ((match = pattern.exec(screen.html)) !== null) {
    append(screen.html.slice(cursor, match.index))
    append(escapeHtml(Object.hasOwn(safeValues, match[1]) ? safeValues[match[1]] : '—'))
    cursor = pattern.lastIndex
  }
  append(screen.html.slice(cursor))
  return parts.join('')
}

