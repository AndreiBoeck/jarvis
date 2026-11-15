import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Screens JARVIS made, kept so he can open them again.
 *
 * A blade of composed markup lives for one turn. A screen is the same idea with
 * a name and a file: "make me a screen for the house sensors" once, then "open
 * the sensors screen" any day after, with today's numbers in it. They live in
 * ~/.jarvis/screens — an index.json plus one .html per screen — outside the
 * repository and outside the browser, so a rebuild or a cleared cache cannot
 * take them.
 *
 * Two kinds, and the difference is whether anything runs:
 *
 *   template — markup in the .hud-* design system with {{field}} holes. Filled
 *              here, every value HTML-escaped, then shown as an ordinary markup
 *              blade, so the interface's one sanitiser still has the last word.
 *              No JavaScript at all. The default.
 *
 *   app      — a whole document with its own scripts: a calculator, a timer, a
 *              little game. Served at /screen/<id> with a CSP that allows its
 *              inline code and nothing else — no network, no fetch, no frames —
 *              and framed with sandbox="allow-scripts" and no allow-same-origin,
 *              so it runs in an opaque origin that can reach neither the
 *              interface, nor the bridge's socket, nor the token. Its data
 *              arrives by postMessage and only that way.
 */

export const SCREEN_KINDS = ['template', 'app']
export const MAX_SCREENS = 64
export const MAX_SCREEN_BYTES = 100 * 1024

/**
 * What an `app` screen may do. Inline script and style, pictures from data: and
 * blob: URLs, and nothing that leaves the document: connect-src 'none' stops
 * fetch, XHR, WebSocket and EventSource; form-action and frame-src stop the two
 * other ways out. The sandbox on the iframe does the rest.
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export const defaultScreensDir = () => join(homedir(), '.jarvis', 'screens')

/** A name as an id: lowercase, a-z0-9 and dashes. Nothing that walks a path. */
export function screenId(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])

/**
 * Fill a template's {{field}} holes. Every value is escaped — data can carry
 * text, never markup. A hole with no value becomes "—", so a missing reading
 * shows as missing instead of as a literal "{{temp}}".
 */
export function fillTemplate(html, data = {}) {
  return String(html).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = Object.hasOwn(data ?? {}, key) ? data[key] : undefined
    if (v === undefined || v === null || v === '') return '—'
    return escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)
  })
}

/** The holes a template has, in order of first appearance. */
export function templateFields(html) {
  const seen = []
  for (const m of String(html).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    if (!seen.includes(m[1])) seen.push(m[1])
  }
  return seen
}

/**
 * The shim put at the top of every app screen: it turns the interface's
 * postMessage into a `jarvis:data` event and keeps the last value on
 * window.JARVIS_DATA, so a screen can read it whichever arrives first.
 */
/**
 * Dark, declared. The blade's iframe is color-scheme: dark; a document that
 * does not say the same gets an opaque white backdrop painted behind it by the
 * browser, so a screen written with a transparent background turns up white.
 */
const APP_SCHEME = '<meta name="color-scheme" content="dark"><style>:root{color-scheme:dark}</style>'

const APP_SHIM = `<script>(function(){window.JARVIS_DATA=window.JARVIS_DATA||null;addEventListener('message',function(e){var m=e.data;if(!m||m.jarvis!=='data')return;window.JARVIS_DATA=m.data;dispatchEvent(new CustomEvent('jarvis:data',{detail:m.data}))});})();</script>`

/** An app screen as served: shim first, so it is listening before the screen's own code runs. */
export function appDocument(html) {
  const src = String(html)
  const head = /<head[^>]*>/i.exec(src)
  const top = APP_SCHEME + APP_SHIM
  if (head) return src.slice(0, head.index + head[0].length) + top + src.slice(head.index + head[0].length)
  return `<!doctype html><html><head><meta charset="utf-8">${top}</head><body>${src}</body></html>`
}

/**
 * The registry. Synchronous on purpose: it is a few kilobytes on a local disk,
 * touched once per tool call, and a synchronous write cannot interleave with
 * another one halfway through the index.
 */
export function screenStore(dir = defaultScreensDir()) {
  const indexPath = join(dir, 'index.json')
  const fileOf = (id) => join(dir, `${id}.html`)

  /** Write-then-rename, so a crash mid-write leaves the old file, not half of a new one. */
  const atomic = (path, body) => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, path)
  }

  const readIndex = () => {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
      return Array.isArray(parsed?.screens) ? parsed.screens : []
    } catch {
      return []
    }
  }
  const writeIndex = (screens) => atomic(indexPath, JSON.stringify({ screens }, null, 1))

  const validate = ({ kind, html }) => {
    if (!SCREEN_KINDS.includes(kind)) throw new Error(`kind must be one of: ${SCREEN_KINDS.join(', ')}`)
    const body = String(html ?? '')
    if (!body.trim()) throw new Error('a screen needs html')
    if (Buffer.byteLength(body) > MAX_SCREEN_BYTES) {
      throw new Error(`a screen is at most ${MAX_SCREEN_BYTES / 1024} KB`)
    }
    return body
  }

  const find = (nameOrId) => {
    const id = screenId(nameOrId)
    return id ? (readIndex().find((s) => s.id === id) ?? null) : null
  }

  return {
    dir,
    list: () => readIndex(),
    find,

    /** The entry and its html, or null. */
    get(nameOrId) {
      const entry = find(nameOrId)
      if (!entry) return null
      try {
        return { ...entry, html: readFileSync(fileOf(entry.id), 'utf8') }
      } catch {
        return null
      }
    },

    /** A new screen. Refuses a name that is taken: that is what update is for. */
    save({ name, description = '', kind = 'template', html }) {
      const id = screenId(name)
      if (!id) throw new Error('a screen needs a name')
      const body = validate({ kind, html })
      const screens = readIndex()
      if (screens.some((s) => s.id === id)) throw new Error(`there is already a screen called "${id}"`)
      if (screens.length >= MAX_SCREENS) {
        throw new Error(`there are already ${MAX_SCREENS} screens; forget one first`)
      }
      const now = new Date().toISOString()
      const entry = {
        id,
        name: String(name).trim().slice(0, 80),
        description: String(description).trim().slice(0, 300),
        kind,
        fields: kind === 'template' ? templateFields(body) : [],
        created: now,
        updated: now,
      }
      atomic(fileOf(id), body)
      writeIndex([...screens, entry])
      return entry
    },

    update(nameOrId, { description, kind, html } = {}) {
      const screens = readIndex()
      const at = screens.findIndex((s) => s.id === screenId(nameOrId))
      if (at < 0) throw new Error(`no screen called "${nameOrId}"`)
      const entry = { ...screens[at] }
      const nextKind = kind ?? entry.kind
      if (html !== undefined || kind !== undefined) {
        const body = html !== undefined ? html : readFileSync(fileOf(entry.id), 'utf8')
        validate({ kind: nextKind, html: body })
        if (html !== undefined) atomic(fileOf(entry.id), String(html))
        entry.kind = nextKind
        entry.fields = nextKind === 'template' ? templateFields(body) : []
      }
      if (description !== undefined) entry.description = String(description).trim().slice(0, 300)
      entry.updated = new Date().toISOString()
      screens[at] = entry
      writeIndex(screens)
      return entry
    },

    forget(nameOrId) {
      const screens = readIndex()
      const id = screenId(nameOrId)
      const entry = screens.find((s) => s.id === id)
      if (!entry) return false
      writeIndex(screens.filter((s) => s.id !== id))
      rmSync(fileOf(id), { force: true })
      return true
    },
  }
}
