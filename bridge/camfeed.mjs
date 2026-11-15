/**
 * Cameras across devices: the PC's webcam on the phone, the phone's on the PC.
 *
 * Every screen connected to this bridge — the interface on this machine, the
 * phone app, the Mac app — has a camera of its own, and until now each could
 * only show its own. This is the exchange between them:
 *
 *   source  — the device whose camera is being watched. A connected interface
 *             captures with the getUserMedia it already has; or, when the
 *             machine the bridge runs on has no interface open, the bridge
 *             captures itself through a headless Chrome (hostcam.mjs).
 *   viewer  — a camera blade on another screen, showing it.
 *   feed    — one source and everyone watching it.
 *
 * Frames are JPEGs over each screen's own, already authenticated socket, and
 * they are PULLED: the bridge asks the source for the next frame only when a
 * viewer has drawn the last one. A slow tailnet link therefore slows the frame
 * rate instead of piling seconds of video into a socket buffer, which is what
 * a push stream does on a phone on mobile data.
 *
 * Privacy, which is the larger half of this file:
 *
 *   - Nothing streams without a grant, and only a tool call makes a grant: the
 *     model opening a camera blade because the user asked. A screen cannot
 *     start watching another device's camera by sending a message.
 *   - The source is told who is watching, and shows it (a banner with a Cut
 *     button), for as long as anyone is. Cut ends every feed from it at once.
 *   - No viewers, no feed: the last blade closing stops the camera.
 *   - The bridge's own capture, having no screen to show a banner on, expires
 *     on its own (JARVIS_CAMERA_HOST_MINUTES, default 10) unless asked again,
 *     and the viewers are told plainly that nobody can see a banner there.
 *   - No frame is kept. Each is forwarded and dropped.
 */

/** Never more often than this, whatever the link can take: ~10 frames a second. */
export const MIN_FRAME_MS = 100
/** A viewer with this much still unsent is skipped for a frame. */
export const VIEWER_BACKLOG_BYTES = 1024 * 1024
/** A source that has not produced a frame in this long is asked again. */
export const PULL_TIMEOUT_MS = 5000
/** Failures in a row before a feed is given up. */
export const MAX_PULL_FAILURES = 3

export const hostMinutes = (env = process.env) => {
  const n = Number(env.JARVIS_CAMERA_HOST_MINUTES)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : 10
}

/**
 * Frame size and quality, adapted to how long the last frame took to be drawn.
 * Starts modest — 640 wide is plenty to see a room on a phone — and moves one
 * step at a time, so a single slow frame does not wreck the picture.
 */
export const QUALITY_STEPS = [
  { w: 320, q: 0.45 },
  { w: 480, q: 0.5 },
  { w: 640, q: 0.6 },
  { w: 800, q: 0.65 },
  { w: 960, q: 0.7 },
]
export const START_STEP = 2

export function adaptStep(step, roundTripMs) {
  if (roundTripMs > 700) return Math.max(0, step - 1)
  if (roundTripMs < 180) return Math.min(QUALITY_STEPS.length - 1, step + 1)
  return step
}

/**
 * Which camera a spoken name means.
 *
 * `screens` are the connected screens, newest last or with `since`; `viewer`
 * is the screen the blade will be on. Returns:
 *   { local: true }                  — the viewer's own camera: no feed at all
 *   { screen }                       — another connected screen captures
 *   { host: true }                   — the bridge captures itself
 *   { error }                        — nothing by that name
 *
 * 'pc' is the machine the bridge runs on (that is what the interface there is
 * called), and prefers the interface open there: on Windows a webcam usually
 * belongs to one application at a time, so if the interface is holding it for
 * hand tracking, the interface is the only thing that can send it.
 */
export function resolveSource(spec, { screens, viewer, hostAvailable = true, home = 'PC' }) {
  const want = String(spec ?? '').trim().toLowerCase()
  if (!want || want === 'here' || want === 'this') return { local: true }
  const newest = (pred) => {
    let best = null
    for (const s of screens) if (pred(s) && (!best || s.since > best.since)) best = s
    return best
  }
  const kinds = { pc: 'pc', phone: 'phone', mac: 'mac', host: 'pc', computer: 'pc' }
  let kind = kinds[want] ?? null
  // The bridge's own machine by its everyday name ("Mac" when it runs on one):
  // a paired Mac app answers to it first, the machine itself otherwise.
  if (want === home.toLowerCase() && kind !== 'pc' && !newest((s) => s.kind === kind)) kind = 'pc'
  let screen = null
  if (kind) screen = newest((s) => s.kind === kind)
  else screen = newest((s) => s.name && s.name.toLowerCase() === want)
  if (screen && viewer && screen.id === viewer.id) return { local: true }
  if (screen) return { screen }
  if (kind === 'pc') {
    if (viewer?.kind === 'pc') return { local: true }
    return hostAvailable
      ? { host: true }
      : { error: `the ${home}'s camera is not available: its JARVIS screen is not open and there is no Chrome or Edge for the bridge to capture with.` }
  }
  if (kind === 'phone' || kind === 'mac') return { error: `the JARVIS app is not open on the ${kind} right now.` }
  return { error: `there is no connected device called "${spec}".` }
}

/** What a screen is called on another screen's banner or blade. */
export function screenLabel(s, home = 'PC') {
  if (!s) return 'another device'
  if (s.kind === 'pc') return home
  const kind = s.kind === 'mac' ? 'Mac' : 'phone'
  return s.name ? `${kind} (${s.name})` : kind
}

export const hostLabel = (home = 'PC') => `${home} — no JARVIS screen open there`

/**
 * The exchange. `hostCamera` is a HostCamera (or anything with its shape);
 * `now` is injectable for the expiry tests.
 */
export class CamHub {
  constructor({ hostCamera = null, home = 'PC', hostMs = hostMinutes() * 60_000, now = () => Date.now(), log = () => {} } = {}) {
    this.host = hostCamera
    this.home = home
    this.hostMs = hostMs
    /** Wall clock, for the host's expiry (injectable for tests). */
    this.now = now
    /** Monotonic clock, for frame pacing and round trips: never injected, so timers always move. */
    this.pace = () => performance.now()
    this.log = log
    /** bladeId -> { source: 'screen:<id>' | 'host', viewerId } */
    this.grants = new Map()
    /** sourceKey -> feed */
    this.feeds = new Map()
    /** screenId -> screen ({ id, kind, name, send, buffered }) */
    this.screens = new Map()
    /** Until when the bridge's own capture may run without being asked again. */
    this.hostUntil = 0
    this.expiryTimer = null
  }

  // --- screens ----------------------------------------------------------------

  addScreen(screen) {
    this.screens.set(screen.id, screen)
  }

  /** A screen went away: as a viewer its blades stop, as a source its feed ends. */
  dropScreen(id) {
    const screen = this.screens.get(id)
    this.screens.delete(id)
    for (const feed of [...this.feeds.values()]) {
      for (const [bladeId, v] of feed.viewers) if (v.screen.id === id) this.removeViewer(feed, bladeId, null)
      if (feed.key === `screen:${id}`) this.endFeed(feed, `${screenLabel(screen, this.home)} disconnected`)
    }
  }

  // --- grants -----------------------------------------------------------------

  /**
   * The model opened a camera blade. Resolved here, against what is connected
   * now, and remembered by blade id so the viewer can claim it (and claim it
   * again after a reconnect). Returns what the blade should carry.
   */
  grant(bladeId, spec, viewerId) {
    const r = this.resolve(spec, viewerId)
    if (r.error || r.local) return r
    const source = r.host ? 'host' : `screen:${r.screen.id}`
    if (r.host) this.renewHost()
    this.grants.set(bladeId, { source, viewerId })
    // Grants accumulate one per blade ever opened; keep the newest few hundred.
    if (this.grants.size > 256) this.grants.delete(this.grants.keys().next().value)
    return {
      source,
      label: r.host ? hostLabel(this.home) : screenLabel(r.screen, this.home),
      host: Boolean(r.host),
    }
  }

  /** Resolve a device name from a screen's point of view (see resolveSource). */
  resolve(spec, viewerId) {
    return resolveSource(spec, {
      screens: [...this.screens.values()],
      viewer: this.screens.get(viewerId) ?? null,
      hostAvailable: Boolean(this.host?.available?.() ?? this.host),
      home: this.home,
    })
  }

  /** A fresh request for the bridge's own camera: the clock starts again. */
  renewHost() {
    this.hostUntil = this.now() + this.hostMs
    const feed = this.feeds.get('host')
    if (feed) for (const v of feed.viewers.values()) this.tellViewer(v, { op: 'state', ...this.feedState(feed) })
  }

  feedState(feed) {
    return {
      label: feed.label,
      host: feed.key === 'host',
      ...(feed.key === 'host' ? { until: this.hostUntil } : {}),
    }
  }

  // --- viewers ----------------------------------------------------------------

  tellViewer(v, msg) {
    v.screen.send({ type: 'cam', id: v.id, ...msg })
  }

  /** One `cam` message from a screen, as viewer or as source. */
  handle(screenId, msg) {
    const screen = this.screens.get(screenId)
    if (!screen || typeof msg?.op !== 'string') return
    const id = typeof msg.id === 'string' ? msg.id : ''
    switch (msg.op) {
      case 'watch':
        return this.watch(screen, id)
      case 'ack': {
        const found = this.viewerOf(id, screen)
        if (found) this.ack(found.feed, found.viewer)
        return
      }
      case 'close': {
        const found = this.viewerOf(id, screen)
        if (found) this.removeViewer(found.feed, id, null)
        return
      }
      case 'frame':
      case 'error':
        return this.fromSource(screen, msg)
      case 'cut':
        return this.cut(screen)
    }
  }

  viewerOf(bladeId, screen) {
    for (const feed of this.feeds.values()) {
      const v = feed.viewers.get(bladeId)
      if (v && v.screen.id === screen.id) return { feed, viewer: v }
    }
    return null
  }

  watch(screen, bladeId) {
    const g = this.grants.get(bladeId)
    const refuse = (message) => screen.send({ type: 'cam', id: bladeId, op: 'ended', reason: message })
    if (!g) return refuse('This camera was not asked for. Ask JARVIS to show it.')
    if (g.viewerId !== screen.id) {
      // The same blade on a reconnected socket: a new screen id, same device kind.
      const before = this.screens.get(g.viewerId)
      if (before) return refuse('This camera is open on another screen.')
      g.viewerId = screen.id
    }
    if (g.source === 'host' && this.now() >= this.hostUntil) {
      return refuse(`Stopped: the ${this.home}'s camera turns itself off after ${Math.round(this.hostMs / 60_000)} minutes. Ask JARVIS again to keep watching.`)
    }
    let feed = this.feeds.get(g.source)
    if (!feed) {
      feed = this.startFeed(g.source)
      if (!feed) return refuse('That device is no longer connected.')
    }
    this.viewerOf(bladeId, screen)?.feed.viewers.delete(bladeId)
    const v = { id: bladeId, screen, waiting: false, sentAt: 0 }
    feed.viewers.set(bladeId, v)
    this.tellViewer(v, { op: 'state', ...this.feedState(feed) })
    this.announce(feed)
    this.pump(feed)
  }

  ack(feed, v) {
    if (!v.waiting) return
    v.waiting = false
    feed.step = adaptStep(feed.step, this.pace() - v.sentAt)
    this.pump(feed)
  }

  removeViewer(feed, bladeId, reason) {
    const v = feed.viewers.get(bladeId)
    if (!v) return
    feed.viewers.delete(bladeId)
    if (reason) this.tellViewer(v, { op: 'ended', reason })
    if (!feed.viewers.size) this.endFeed(feed, null)
    else this.announce(feed)
  }

  // --- feeds ------------------------------------------------------------------

  startFeed(key) {
    let src
    let label
    if (key === 'host') {
      if (!this.host) return null
      src = { kind: 'host' }
      label = hostLabel(this.home)
    } else {
      const screen = this.screens.get(Number(key.slice('screen:'.length)))
      if (!screen) return null
      src = { kind: 'screen', screen }
      label = screenLabel(screen, this.home)
    }
    const feed = {
      key,
      src,
      label,
      viewers: new Map(),
      pulling: null,
      seq: 0,
      step: START_STEP,
      lastPull: -Infinity,
      failures: 0,
      timer: null,
      started: false,
    }
    this.feeds.set(key, feed)
    this.log(`camera feed started: ${label}`)
    if (key === 'host') {
      this.watchExpiry()
      this.host.start().catch((err) => this.endFeed(feed, `The ${this.home}'s camera could not be opened: ${err?.message ?? err}`))
    }
    return feed
  }

  /** The source's banner: who is watching. Sent on every change. */
  announce(feed) {
    const to = [...new Set([...feed.viewers.values()].map((v) => screenLabel(v.screen, this.home)))]
    if (feed.src.kind === 'screen') {
      feed.src.screen.send({ type: 'cam', op: 'start', feed: feed.key, to })
    } else {
      this.log(`camera feed (${this.home}) watched by: ${to.join(', ')}`)
    }
  }

  endFeed(feed, reason) {
    if (this.feeds.get(feed.key) !== feed) return
    this.feeds.delete(feed.key)
    clearTimeout(feed.timer)
    feed.pulling?.reject?.(new Error('ended'))
    for (const v of feed.viewers.values()) this.tellViewer(v, { op: 'ended', reason: reason ?? 'The camera was turned off.' })
    feed.viewers.clear()
    if (feed.src.kind === 'screen') feed.src.screen.send({ type: 'cam', op: 'stop', feed: feed.key })
    else this.host?.stop()
    if (!this.feeds.has('host')) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = null
    }
    this.log(`camera feed stopped: ${feed.label}${reason ? ` (${reason})` : ''}`)
  }

  /** Ask the source for the next frame, if anyone is ready for one. */
  pump(feed) {
    if (this.feeds.get(feed.key) !== feed || feed.pulling || feed.timer) return
    const ready = [...feed.viewers.values()].some((v) => !v.waiting && v.screen.buffered() < VIEWER_BACKLOG_BYTES)
    if (!ready) return
    const wait = Math.max(0, feed.lastPull + MIN_FRAME_MS - this.pace())
    if (wait > 0) {
      feed.timer = setTimeout(() => {
        feed.timer = null
        this.pump(feed)
      }, wait)
      return
    }
    feed.lastPull = this.pace()
    const { w, q } = QUALITY_STEPS[feed.step]
    const n = ++feed.seq
    const pending = {}
    const promise = new Promise((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    pending.n = n
    feed.pulling = pending
    const timer = setTimeout(() => pending.reject(new Error('the camera stopped sending')), PULL_TIMEOUT_MS)
    if (feed.src.kind === 'screen') {
      feed.src.screen.send({ type: 'cam', op: 'pull', feed: feed.key, n, w, q })
    } else {
      this.host.frame({ w, q }).then(pending.resolve, pending.reject)
    }
    promise
      .then((frame) => {
        feed.failures = 0
        this.deliver(feed, frame)
      })
      .catch((err) => {
        if (this.feeds.get(feed.key) !== feed) return
        if (++feed.failures >= MAX_PULL_FAILURES) {
          this.endFeed(feed, `The camera stopped: ${err?.message ?? err}`)
        }
      })
      .finally(() => {
        clearTimeout(timer)
        if (feed.pulling === pending) feed.pulling = null
        this.pump(feed)
      })
  }

  /** A frame from a screen source, matched to the pull that asked for it. */
  fromSource(screen, msg) {
    const feed = this.feeds.get(`screen:${screen.id}`)
    if (!feed?.pulling || msg.n !== feed.pulling.n) return
    if (msg.op === 'error') return feed.pulling.reject(new Error(String(msg.message ?? 'camera error')))
    if (typeof msg.data !== 'string' || !msg.data) return feed.pulling.reject(new Error('empty frame'))
    feed.pulling.resolve({ data: msg.data, w: msg.w, h: msg.h })
  }

  deliver(feed, frame) {
    for (const v of feed.viewers.values()) {
      if (v.waiting || v.screen.buffered() >= VIEWER_BACKLOG_BYTES) continue
      v.waiting = true
      v.sentAt = this.pace()
      this.tellViewer(v, { op: 'frame', data: frame.data, w: frame.w, h: frame.h })
    }
  }

  // --- turning it off ---------------------------------------------------------

  /** Cut at the source: every feed from that screen ends. */
  cut(screen) {
    const feed = this.feeds.get(`screen:${screen.id}`)
    if (feed) this.endFeed(feed, `Cut on the ${screenLabel(screen, this.home)}.`)
  }

  /** "Turn the cameras off": everything, everywhere. Returns how many stopped. */
  stopAll(reason = 'Turned off by voice.') {
    const n = this.feeds.size
    for (const feed of [...this.feeds.values()]) this.endFeed(feed, reason)
    this.hostUntil = 0
    return n
  }

  watchExpiry() {
    if (this.expiryTimer) return
    this.expiryTimer = setInterval(() => this.checkExpiry(), 5000)
    this.expiryTimer.unref?.()
  }

  checkExpiry() {
    const feed = this.feeds.get('host')
    if (feed && this.now() >= this.hostUntil) {
      this.endFeed(feed, `Stopped: the ${this.home}'s camera turns itself off after ${Math.round(this.hostMs / 60_000)} minutes unless asked again.`)
    }
  }

  /** What there is to watch, for the model. */
  list(viewerId) {
    const out = []
    for (const s of this.screens.values()) {
      out.push({ device: s.kind === 'pc' ? 'pc' : s.name || s.kind, label: screenLabel(s, this.home), here: s.id === viewerId })
    }
    if (![...this.screens.values()].some((s) => s.kind === 'pc') && this.host) {
      out.push({ device: 'pc', label: hostLabel(this.home), here: false, bridgeCapture: true })
    }
    return out
  }

  /** Who is watching what, right now. */
  active() {
    return [...this.feeds.values()].map((f) => ({
      source: f.label,
      viewers: [...f.viewers.values()].map((v) => screenLabel(v.screen, this.home)),
    }))
  }

  shutdown() {
    this.stopAll('The bridge is shutting down.')
  }
}
