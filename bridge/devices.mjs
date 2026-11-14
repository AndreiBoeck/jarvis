/**
 * Paired devices: who may reach the bridge from outside this machine, and the
 * live link to the phones that are connected right now.
 *
 * Everything else in the bridge assumes the client is a browser tab on this
 * same machine, and defends itself accordingly — the Origin check keeps other
 * tabs out, the Host check stops DNS rebinding. A phone on 4G, reaching the
 * bridge through Tailscale, passes neither: its requests are addressed to the
 * tailnet name and it is not a local dev server. So a phone proves itself a
 * different way, with a token it was given once, at pairing.
 *
 * Tokens are stored hashed. The file on disk is enough to recognise a token,
 * not to recover one, so reading ~/.jarvis/devices.json does not hand anybody
 * a working credential. A token is shown exactly once, when it is made.
 *
 * Two ways to present one, because a browser WebSocket cannot set headers:
 *   - `Authorization: Bearer <token>` on ordinary HTTP requests;
 *   - a WebSocket subprotocol `jarvis.token.<token>` beside `jarvis.v1`. The
 *     bridge answers with `jarvis.v1`, so the token is never echoed, and it
 *     stays out of the URL — where it would end up in proxy logs.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PROTOCOL = 'jarvis.v1'
const TOKEN_PROTOCOL_PREFIX = 'jarvis.token.'
const TOKEN_PREFIX = 'jv_'

export const devicesFile = () =>
  process.env.JARVIS_DEVICES_FILE ?? join(homedir(), '.jarvis', 'devices.json')

const hashToken = (token) => createHash('sha256').update(token).digest()

function load(file = devicesFile()) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data?.devices) ? data.devices : []
  } catch {
    return []
  }
}

function save(devices, file = devicesFile()) {
  mkdirSync(dirname(file), { recursive: true })
  // Written aside and renamed into place, so a crash mid-write never leaves a
  // half file that would silently unpair every phone.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows: permissions come from the user profile folder instead */
  }
}

/**
 * What kind of machine a paired device is. Each kind has its own tools —
 * jarvis_phone for a phone, jarvis_mac for a Mac — and a command meant for
 * one must never land on the other just because it connected more recently.
 */
export const KINDS = ['phone', 'mac']
const kindOf = (d) => (KINDS.includes(d?.kind) ? d.kind : 'phone')

/** How a kind is named in a sentence that may be spoken. */
export const KIND_LABEL = { phone: 'phone', mac: 'Mac' }

/** Pair a new device. Returns the token — the only time it is ever visible. */
export function createDevice(name, file = devicesFile(), { kind = 'phone' } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown device kind "${kind}" — use ${KINDS.join(' or ')}`)
  const clean = String(name ?? '').trim().slice(0, 60)
  if (!clean) throw new Error('give the device a name, e.g. "Pixel"')
  const devices = load(file)
  if (devices.some((d) => d.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`a device called "${clean}" is already paired — revoke it first`)
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const device = {
    id: randomUUID(),
    name: clean,
    kind,
    hash: hashToken(token).toString('hex'),
    created: new Date().toISOString(),
  }
  save([...devices, device], file)
  return { id: device.id, name: device.name, kind, token }
}

/** Remove a device by name or id. Returns whether anything was removed. */
export function revokeDevice(nameOrId, file = devicesFile()) {
  const key = String(nameOrId ?? '').trim().toLowerCase()
  const devices = load(file)
  const kept = devices.filter((d) => d.id !== key && d.name.toLowerCase() !== key)
  if (kept.length === devices.length) return false
  save(kept, file)
  return true
}

/** Paired devices, without their hashes. */
export function listDevices(file = devicesFile()) {
  return load(file).map((d) => ({ id: d.id, name: d.name, kind: kindOf(d), created: d.created }))
}

/**
 * The device this token belongs to, or null.
 *
 * Read from disk on every call so a revoke takes effect on the next request,
 * with no restart. Every stored hash is compared, in constant time, so how
 * long a refusal takes says nothing about which device came close.
 */
export function deviceForToken(token, file = devicesFile()) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) {
    return null
  }
  const presented = hashToken(token)
  let found = null
  for (const d of load(file)) {
    let stored
    try {
      stored = Buffer.from(d.hash, 'hex')
    } catch {
      continue
    }
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      found = { id: d.id, name: d.name, kind: kindOf(d) }
    }
  }
  return found
}

/** The token a request carries, from either place it may be, or null. */
export function tokenFromRequest(req) {
  const auth = req.headers?.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim())
    if (m) return m[1]
  }
  const offered = req.headers?.['sec-websocket-protocol']
  if (typeof offered === 'string') {
    for (const p of offered.split(',').map((s) => s.trim())) {
      if (p.startsWith(TOKEN_PROTOCOL_PREFIX)) return p.slice(TOKEN_PROTOCOL_PREFIX.length)
    }
  }
  return null
}

/**
 * Which subprotocol to answer a WebSocket handshake with.
 *
 * A client that offers subprotocols refuses a reply that picks none, so this
 * has to choose one — and it must never be the token.
 */
export function chooseProtocol(protocols) {
  const list = [...(protocols ?? [])]
  if (list.includes(PROTOCOL)) return PROTOCOL
  return list.find((p) => !p.startsWith(TOKEN_PROTOCOL_PREFIX)) ?? false
}

// ---------------------------------------------------------------------------
// Media keys
// ---------------------------------------------------------------------------

/**
 * Keys that open the bridge's media routes for a paired phone.
 *
 * An <img>, <video> or <iframe> cannot send a header, and the panels load
 * screenshots, proxied images and reader pages exactly that way. Putting the
 * pairing token in those URLs would scatter the one credential that unlocks
 * everything across every image request. A media key is narrower on every
 * axis: it opens only the GET media routes (never the agent, speech or the
 * device link), it is minted per connection, and it dies with that connection
 * — or with the device, if it is unpaired first.
 *
 * In memory only: a restart forgets them all, and the phone simply receives a
 * new one when it reconnects.
 */
const mediaKeys = new Map()

export function issueMediaKey(device) {
  const key = randomBytes(24).toString('base64url')
  mediaKeys.set(key, device.id)
  return key
}

export function dropMediaKey(key) {
  mediaKeys.delete(key)
}

/** The routes a media key may open. */
export const MEDIA_ROUTES = ['/file', '/img', '/media', '/page', '/screen']

/** The device behind a media key, if the key is live and the device still paired. */
export function deviceForMediaKey(key, file = devicesFile()) {
  if (typeof key !== 'string' || !key) return null
  const id = mediaKeys.get(key)
  if (!id) return null
  const device = load(file).find((d) => d.id === id)
  return device ? { id: device.id, name: device.name, kind: kindOf(device) } : null
}

// ---------------------------------------------------------------------------
// The live link
// ---------------------------------------------------------------------------

/**
 * Phones connected right now, and the request/reply channel to them.
 *
 * One hub for the whole process, not one per agent session: a phone holds a
 * single quiet socket open in the background, and every session — the HUD on
 * this PC as much as the app on the phone itself — reaches it through here.
 * That is what lets "open Spotify on my phone", said to the PC, land on the
 * phone.
 */
export class DeviceHub {
  constructor({ pingMs = 45_000 } = {}) {
    this.pingMs = pingMs
    /** deviceId -> { socket, device, info, since, pending: Map } */
    this.links = new Map()
    this.calls = 0
  }

  attach(socket, device) {
    // A phone that reconnects (new network, app restarted) replaces its old
    // link rather than leaving a dead one to swallow commands.
    const old = this.links.get(device.id)
    if (old) old.socket.close(4000, 'replaced')

    const link = { socket, device, kind: kindOf(device), info: {}, since: Date.now(), pending: new Map() }
    this.links.set(device.id, link)
    console.log(`[jarvis] device connected: ${device.name} (${link.kind})`)

    // Mobile networks drop sockets without a close. A ping the phone fails to
    // answer is the only way to notice before a command vanishes into it.
    let alive = true
    socket.on?.('pong', () => {
      alive = true
    })
    const timer = setInterval(() => {
      if (!alive) return socket.terminate?.()
      alive = false
      try {
        socket.ping?.()
      } catch {
        /* closing already */
      }
    }, this.pingMs)
    timer.unref?.()

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg?.type === 'device_hello') {
        link.info = {
          capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String).slice(0, 100) : [],
          model: typeof msg.model === 'string' ? msg.model.slice(0, 80) : undefined,
          android: typeof msg.android === 'string' ? msg.android.slice(0, 20) : undefined,
          macos: typeof msg.macos === 'string' ? msg.macos.slice(0, 20) : undefined,
        }
      } else if (msg?.type === 'device_result' && typeof msg.id === 'string') {
        const slot = link.pending.get(msg.id)
        if (!slot) return
        link.pending.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    })

    socket.on('close', () => {
      clearInterval(timer)
      for (const slot of link.pending.values()) {
        clearTimeout(slot.timer)
        slot.reject(new Error(`the ${KIND_LABEL[link.kind]} disconnected`))
      }
      link.pending.clear()
      // Only forget the link if it is still this one — a replacement may
      // already have taken its place.
      if (this.links.get(device.id) === link) {
        this.links.delete(device.id)
        console.log(`[jarvis] device disconnected: ${device.name}`)
      }
    })
  }

  /** Devices connected right now, newest first — only those of `kind` when given. */
  connected(kind) {
    return [...this.links.values()]
      .filter((l) => !kind || l.kind === kind)
      .sort((a, b) => b.since - a.since)
      .map((l) => ({ name: l.device.name, kind: l.kind, since: new Date(l.since).toISOString(), ...l.info }))
  }

  /**
   * The link to use: the named device, or else the one of this kind
   * connected most recently. A name of the wrong kind is no match — "open
   * Safari on Pixel" must not quietly become a command for the Mac.
   */
  pick(name, kind) {
    const links = [...this.links.values()]
      .filter((l) => !kind || l.kind === kind)
      .sort((a, b) => b.since - a.since)
    if (!name) return links[0] ?? null
    const key = String(name).toLowerCase()
    return links.find((l) => l.device.name.toLowerCase() === key) ?? null
  }

  /**
   * Send one command to a phone and wait for its answer.
   *
   * Resolves with the phone's reply object; rejects when no phone is
   * connected, the phone drops, or it does not answer in time. Long timeouts
   * belong to commands that wait on the user — a confirmation on the phone's
   * screen takes as long as it takes.
   */
  call(tool, args = {}, { device, kind = 'phone', timeoutMs = 20_000 } = {}) {
    const label = KIND_LABEL[kind] ?? 'device'
    return new Promise((resolve, reject) => {
      const link = this.pick(device, kind)
      if (!link) {
        return reject(
          new Error(device ? `no ${label} called "${device}" is connected` : `no ${label} is connected`),
        )
      }
      if (link.socket.readyState !== 1) return reject(new Error(`the ${label} is not connected`))
      const id = `d${++this.calls}`
      const timer = setTimeout(() => {
        link.pending.delete(id)
        reject(new Error(`the ${label} did not answer in time`))
      }, timeoutMs)
      link.pending.set(id, { resolve, reject, timer })
      link.socket.send(JSON.stringify({ type: 'device_call', id, tool, args }))
    })
  }
}
