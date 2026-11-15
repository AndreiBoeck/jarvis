import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import WebSocket from 'ws'

/**
 * A real browser, on a blade.
 *
 * Some pages are applications: Google Maps, a Grafana board, a web app behind a
 * login. Their HTML is an empty shell and their scripts draw everything, so the
 * article blade — which fetches a page and serves it with every script removed
 * — has nothing to show. Serving them WITH their scripts from the bridge is not
 * an answer either: the document would run on the bridge's own origin, the one
 * origin allowed to open the agent socket, and any page found on the web would
 * be one fetch away from driving JARVIS. And it would not work anyway: the
 * page's own API calls, cookies and service worker all expect its real origin.
 *
 * So the page runs where pages are meant to run — in a browser — and the blade
 * shows a live picture of it and sends the user's hands back:
 *
 *   Chrome/Edge (dedicated profile, headless)
 *        ↕  DevTools protocol over a loopback WebSocket
 *   this file   — Page.startScreencast out, Input.dispatch* in
 *        ↕  the interface's own, already authenticated socket
 *   the blade   — a JPEG stream, and clicks, wheel and keys back
 *
 * Why a dedicated instance rather than the user's own Chrome through the
 * extension (chrome.mjs): the extension speaks in whole tool calls — navigate,
 * screenshot — about one a second. A page you use needs a picture every time it
 * changes and a click that lands in milliseconds, which only the DevTools
 * protocol gives, and Chrome refuses that protocol on the profile you browse
 * with. The cost is a separate profile: sign in once inside the blade and it
 * stays signed in (~/.jarvis/live-browser).
 *
 * Not Playwright: nothing is downloaded. It drives whichever Chrome, Edge or
 * Chromium is already installed.
 */

/** Tabs open at once, across every screen. The oldest goes when a new one opens. */
export const MAX_TABS = 4

/** A browser with no tabs for this long is shut down. */
const IDLE_MS = 5 * 60_000

/** A screen that dropped its socket gets this long to come back for its tabs. */
const ORPHAN_MS = 30_000

/** Frames are held back while the screen's socket has this much unsent. */
const BACKLOG_BYTES = 768 * 1024

const CALL_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// Pure helpers (tested directly)
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/**
 * Why a URL may not be opened in the live browser, or null when it may.
 *
 * Web pages only. Not file:, not chrome:, not devtools: — a page on the
 * blade must not become a way to read the PC's disk or reconfigure the
 * browser. And not the bridge itself on loopback: that is JARVIS's own
 * control surface, and it has no business inside a tab it is streaming.
 */
export function liveUrlProblem(raw, { bridgePort = Number(process.env.JARVIS_BRIDGE_PORT) || 8787 } = {}) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return 'that is not a URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'only http and https pages open in the live browser'
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  if (LOOPBACK.has(url.hostname.toLowerCase()) && port === bridgePort) {
    return 'the bridge itself cannot be opened in the live browser'
  }
  return null
}

/** Where Chrome, Edge and Chromium are installed, in the order to try them. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (env.JARVIS_LIVE_BROWSER) return [env.JARVIS_LIVE_BROWSER]
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    return [
      ...apps.map((a) => `/Applications/${a}`),
      ...apps.map((a) => join(env.HOME ?? homedir(), 'Applications', a)),
    ]
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
    ]
    return roots.flatMap((r) => rel.map((p) => `${r}\\${p}`))
  }
  const names = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
  ]
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  return dirs.flatMap((d) => names.map((n) => join(d, n)))
}

export function findBrowser({ platform, env, exists = existsSync } = {}) {
  return browserCandidates(platform, env).find((p) => exists(p)) ?? null
}

/** CDP modifier bits from the blade's: alt 1, ctrl 2, meta 4, shift 8 — the same. */
const mods = (m) => Number(m) & 15

/**
 * A key from the blade as a DevTools key event.
 *
 * A printable key goes down WITH its text, which is what makes it type; a key
 * that types nothing (arrows, Backspace, a Ctrl shortcut) is a rawKeyDown.
 * Enter carries "\r" so it submits a form, as a real keyboard does.
 */
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
}

/**
 * The Windows virtual key code a page's handlers test (`e.keyCode === 13`).
 * A phone's keyboard reports 229 for everything and a synthetic event reports
 * 0; without a real code, Enter types a newline but submits nothing.
 */
export function virtualKey(key, keyCode) {
  const given = Number(keyCode) || 0
  if (given && given !== 229) return given
  if (Object.hasOwn(VK, key)) return VK[key]
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0)
  return 0
}

export function keyEventParams({ event, key = '', code = '', keyCode = 0, mods: m = 0 }) {
  const modifiers = mods(m)
  const base = { key, code, windowsVirtualKeyCode: virtualKey(key, keyCode), modifiers }
  if (event === 'up') return { type: 'keyUp', ...base }
  const commandHeld = (modifiers & 2) || (modifiers & 4)
  const text = key === 'Enter' ? '\r' : key.length === 1 && !commandHeld ? key : ''
  return text ? { type: 'keyDown', ...base, text, unmodifiedText: text } : { type: 'rawKeyDown', ...base }
}

const clamp = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
}

/** A blade's size as a viewport the page can be laid out in. */
export function viewportFor({ w, h, mobile } = {}) {
  return {
    width: clamp(w, 320, 1920, 1280),
    height: clamp(h, 240, 1400, 800),
    mobile: Boolean(mobile),
  }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

/**
 * One browser process for the whole bridge, started on the first tab and shut
 * down when the last one has been closed for a while.
 *
 * An "owner" is a screen: `{ send(msg), buffered(): number }`, one per
 * interface socket. A tab belongs to the screen showing its blade, and frames
 * go only there.
 */
export class LiveBrowser {
  constructor({
    profileDir = join(homedir(), '.jarvis', 'live-browser'),
    headless = process.env.JARVIS_LIVE_HEADED !== '1',
    bridgePort,
    log = (...a) => console.log('[jarvis] live:', ...a),
  } = {}) {
    this.profileDir = profileDir
    this.headless = headless
    this.bridgePort = bridgePort
    this.log = log
    this.proc = null
    this.ws = null
    this.starting = null
    this.nextId = 0
    this.pending = new Map()
    /** bladeId -> tab */
    this.tabs = new Map()
    this.opening = new Map()
    this.idleTimer = null
  }

  // --- process and connection ----------------------------------------------

  ensure() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    this.starting ??= this.launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async launch() {
    const bin = findBrowser()
    if (!bin) {
      throw new Error(
        'no Chrome, Edge or Chromium found on this PC. Install one, or point JARVIS_LIVE_BROWSER at it.',
      )
    }
    mkdirSync(this.profileDir, { recursive: true })
    const portFile = join(this.profileDir, 'DevToolsActivePort')
    rmSync(portFile, { force: true })
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Its own profile keeps its own secrets: no Keychain or keyring prompt
      // on the PC, which nobody would be sitting there to answer.
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // The sound would come out of the PC's speakers, not the blade.
      '--mute-audio',
      '--window-size=1280,800',
      ...(this.headless ? ['--headless=new'] : []),
      'about:blank',
    ]
    this.log(`starting ${bin}${this.headless ? ' (headless)' : ''}`)
    const proc = spawn(bin, args, { stdio: 'ignore', detached: false })
    this.proc = proc
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.log(`browser exited (${code})`)
      this.proc = null
      this.ws?.terminate()
      this.ws = null
      for (const tab of this.tabs.values()) tab.owner?.send({ type: 'live', op: 'closed', id: tab.id })
      this.tabs.clear()
    })

    // Port 0 lets Chrome pick a free port; it writes it, and the browser
    // endpoint's path, to DevToolsActivePort once it is listening.
    let endpoint = null
    for (let i = 0; i < 100 && !endpoint; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (!this.proc) throw new Error('the browser exited while starting')
      try {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        if (port && path) endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`
      } catch {
        // not written yet
      }
    }
    if (!endpoint) {
      proc.kill()
      throw new Error('the browser did not open its debugging port')
    }

    const ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    this.ws = ws
    ws.on('message', (raw) => this.onMessage(raw))
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      for (const p of this.pending.values()) p.reject(new Error('browser connection closed'))
      this.pending.clear()
    })
    await this.call('Target.setDiscoverTargets', { discover: true })
    // Nothing downloads to the PC from a page on a blade.
    await this.call('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
  }

  call(method, params = {}, sessionId) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser not running'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.id) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {})
    }
    const tab = msg.sessionId ? this.tabBySession(msg.sessionId) : null
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'Page.screencastFrame':
        if (tab) this.onFrame(tab, p)
        break
      case 'Page.frameNavigated':
        if (tab && !p.frame?.parentId) this.onNavigated(tab, p.frame.url)
        break
      // A web app moving between its own views (history.pushState): no load,
      // but the address and the back button change.
      case 'Page.navigatedWithinDocument':
        if (tab && p.frameId === tab.targetId) void this.pushState(tab, { url: p.url })
        break
      // Whichever comes first: a web app that streams forever may never fire
      // `load`, but its own frame does stop loading and its DOM is ready.
      case 'Page.loadEventFired':
      case 'Page.domContentEventFired':
        if (tab) void this.pushState(tab, { loading: false })
        break
      case 'Page.frameStoppedLoading':
        if (tab && p.frameId === tab.targetId) void this.pushState(tab, { loading: false })
        break
      case 'Page.frameStartedLoading':
        // The page's own frame only (its id is the target's): a web app keeps
        // loading iframes long after it has loaded, and the bar would spin forever.
        if (tab && p.frameId === tab.targetId) tab.owner?.send({ type: 'live', op: 'state', id: tab.id, loading: true })
        break
      case 'Page.javascriptDialogOpening':
        // Nobody is at the PC to answer it, and an open dialog freezes the page.
        if (tab) void this.call('Page.handleJavaScriptDialog', { accept: true }, tab.sessionId).catch(() => {})
        break
      case 'Target.targetInfoChanged':
      case 'Target.targetCreated':
        this.onTargetInfo(p.targetInfo)
        break
      case 'Target.targetDestroyed': {
        const gone = [...this.tabs.values()].find((t) => t.targetId === p.targetId)
        if (gone) this.forget(gone, true)
        break
      }
    }
  }

  tabBySession(sessionId) {
    for (const t of this.tabs.values()) if (t.sessionId === sessionId) return t
    return null
  }

  // --- events ---------------------------------------------------------------

  onFrame(tab, { data, metadata, sessionId: ackId }) {
    const ack = () => void this.call('Page.screencastFrameAck', { sessionId: ackId }, tab.sessionId).catch(() => {})
    if (!tab.casting || !tab.owner) return ack()

    tab.owner.send({
      type: 'live',
      op: 'frame',
      id: tab.id,
      data,
      w: metadata?.deviceWidth,
      h: metadata?.deviceHeight,
    })
    // Flow control: Chrome sends the next frame only after the ack. Holding the
    // ack while the screen's socket is backed up keeps a slow phone link at a
    // lower frame rate instead of seconds behind.
    const waitAndAck = (tries = 0) => {
      if ((tab.owner?.buffered() ?? 0) < BACKLOG_BYTES || tries > 40) return ack()
      setTimeout(() => waitAndAck(tries + 1), 50)
    }
    waitAndAck()
  }

  onNavigated(tab, url) {
    if (liveUrlProblem(url, { bridgePort: this.bridgePort }) && !/^(about|data|blob):/.test(url)) {
      // Something on the page tried to go where pages may not go.
      tab.owner?.send({ type: 'live', op: 'error', id: tab.id, message: `Blocked: ${url}` })
      void this.call('Page.navigate', { url: 'about:blank' }, tab.sessionId).catch(() => {})
      return
    }
    void this.pushState(tab, { url })
  }

  /** A popup (target=_blank, window.open) opens in the same blade instead. */
  onTargetInfo(info) {
    if (!info || info.type !== 'page') return
    const own = [...this.tabs.values()].find((t) => t.targetId === info.targetId)
    if (own) {
      own.title = info.title
      own.owner?.send({ type: 'live', op: 'state', id: own.id, title: info.title })
      return
    }
    const opener = [...this.tabs.values()].find((t) => t.targetId === info.openerId)
    if (!opener || !info.url || info.url === 'about:blank') return
    void this.call('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
    if (!liveUrlProblem(info.url, { bridgePort: this.bridgePort })) {
      void this.call('Page.navigate', { url: info.url }, opener.sessionId).catch(() => {})
    }
  }

  async pushState(tab, extra = {}) {
    let canBack = false
    let canForward = false
    try {
      const h = await this.call('Page.getNavigationHistory', {}, tab.sessionId)
      // The about:blank every tab is born on is not somewhere to go back to.
      canBack = h.currentIndex > 0 && h.entries[h.currentIndex - 1]?.url !== 'about:blank'
      canForward = h.currentIndex < h.entries.length - 1
      tab.history = h
      tab.url = h.entries[h.currentIndex]?.url ?? tab.url
    } catch {
      // the tab went away
    }
    tab.owner?.send({
      type: 'live',
      op: 'state',
      id: tab.id,
      url: tab.url,
      title: tab.title,
      canBack,
      canForward,
      ...extra,
    })
  }

  // --- tabs -----------------------------------------------------------------

  /** Two opens for one blade at once (mount and reconnect) make one tab. */
  open(owner, args) {
    const busy = this.opening.get(args.id)
    if (busy) return busy.catch(() => {}).then(() => this.openNow(owner, args))
    const run = this.openNow(owner, args).finally(() => this.opening.delete(args.id))
    this.opening.set(args.id, run)
    return run
  }

  async openNow(owner, { id, url, w, h, mobile }) {
    clearTimeout(this.idleTimer)
    const existing = this.tabs.get(id)
    if (existing) {
      // The blade came back (remounted, or its screen reconnected).
      clearTimeout(existing.orphanTimer)
      existing.owner = owner
      await this.setViewport(existing, viewportFor({ w, h, mobile }))
      await this.cast(existing, true)
      return this.pushState(existing)
    }
    const problem = liveUrlProblem(url, { bridgePort: this.bridgePort })
    if (problem) throw new Error(problem)

    await this.ensure()
    // The limit: the tab opened longest ago goes, and its blade is told.
    while (this.tabs.size >= MAX_TABS) {
      const oldest = [...this.tabs.values()].sort((a, b) => a.opened - b.opened)[0]
      await this.close(oldest.id)
    }

    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true })
    const tab = { id, owner, targetId, sessionId, url, title: '', opened: Date.now(), casting: false }
    this.tabs.set(id, tab)
    await Promise.all([
      this.call('Page.enable', {}, sessionId),
      this.call('Runtime.enable', {}, sessionId).catch(() => {}),
    ])
    await this.setViewport(tab, viewportFor({ w, h, mobile }))
    await this.cast(tab, true)
    await this.call('Page.navigate', { url }, sessionId)
    // No `loading` here: frameStartedLoading and loadEventFired say that, and
    // this reply can land after the load event and leave the bar spinning.
    void this.pushState(tab)
  }

  async setViewport(tab, vp) {
    tab.viewport = vp
    await this.call(
      'Emulation.setDeviceMetricsOverride',
      { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile },
      tab.sessionId,
    )
    await this.call('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile }, tab.sessionId).catch(() => {})
    if (tab.casting) {
      // The screencast keeps its first size; restart it at the new one.
      await this.cast(tab, false)
      await this.cast(tab, true)
    }
  }

  /**
   * A script setting document.title raises no event at all, so while anything
   * is being watched the titles are looked at once a second.
   */
  watchTitles() {
    if (this.titleTimer) return
    this.titleTimer = setInterval(() => {
      const watched = [...this.tabs.values()].filter((t) => t.casting && t.owner)
      if (!watched.length) {
        clearInterval(this.titleTimer)
        this.titleTimer = null
        return
      }
      for (const tab of watched) {
        void this.call('Target.getTargetInfo', { targetId: tab.targetId })
          .then(({ targetInfo }) => {
            if (targetInfo && targetInfo.title !== tab.title) this.onTargetInfo(targetInfo)
          })
          .catch(() => {})
      }
    }, 1000)
    this.titleTimer.unref?.()
  }

  async cast(tab, on) {
    if (on === tab.casting) return
    tab.casting = on
    if (!on) return this.call('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
    this.watchTitles()
    const vp = tab.viewport ?? viewportFor()
    await this.call(
      'Page.startScreencast',
      { format: 'jpeg', quality: 62, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 },
      tab.sessionId,
    )
  }

  async close(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.forget(tab, true)
    await this.call('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
  }

  forget(tab, tell) {
    clearTimeout(tab.orphanTimer)
    this.tabs.delete(tab.id)
    if (tell) tab.owner?.send({ type: 'live', op: 'closed', id: tab.id })
    if (!this.tabs.size) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.shutdown(), IDLE_MS)
      this.idleTimer.unref?.()
    }
  }

  /** A screen's socket closed. Its tabs wait a little, in case it reconnects. */
  dropOwner(owner) {
    for (const tab of this.tabs.values()) {
      if (tab.owner !== owner) continue
      tab.owner = null
      tab.casting = false
      void this.call('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
      tab.orphanTimer = setTimeout(() => void this.close(tab.id), ORPHAN_MS)
      tab.orphanTimer.unref?.()
    }
  }

  shutdown() {
    clearTimeout(this.idleTimer)
    clearInterval(this.titleTimer)
    this.titleTimer = null
    const proc = this.proc
    this.proc = null
    this.ws?.close()
    this.ws = null
    this.tabs.clear()
    if (proc) {
      this.log('browser shut down')
      proc.kill()
    }
  }

  // --- the blade's messages ---------------------------------------------------

  /**
   * One message from a screen. Every reply goes back to that screen only; an
   * op for a tab some other screen owns is ignored, except `open`, which is how
   * a reconnected screen takes its blades back.
   */
  async handle(owner, msg) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 80) : ''
    if (!id) return
    const fail = (err) =>
      owner.send({ type: 'live', op: 'error', id, message: String(err?.message ?? err) })
    try {
      if (msg.op === 'open') return await this.open(owner, { ...msg, id })
      // The blade resizes (or is clicked) while its tab is still opening: wait
      // for it, rather than telling the blade its tab is gone.
      if (!this.tabs.has(id) && this.opening.has(id)) await this.opening.get(id).catch(() => {})
      const tab = this.tabs.get(id)
      if (!tab) {
        if (msg.op !== 'close' && msg.op !== 'pause') owner.send({ type: 'live', op: 'closed', id })
        return
      }
      if (tab.owner !== owner) return
      const s = tab.sessionId
      const vp = tab.viewport ?? viewportFor()
      const x = clamp(msg.x, 0, vp.width, 0)
      const y = clamp(msg.y, 0, vp.height, 0)
      switch (msg.op) {
        case 'close':
          return await this.close(id)
        case 'pause':
          return await this.cast(tab, false)
        case 'resize':
          return await this.setViewport(tab, viewportFor(msg))
        case 'mouse': {
          const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[msg.event]
          if (!type) return
          const button = ['left', 'middle', 'right'].includes(msg.button) ? msg.button : 'left'
          return await this.call(
            'Input.dispatchMouseEvent',
            {
              type,
              x,
              y,
              button: type === 'mouseMoved' && !msg.held ? 'none' : button,
              buttons: msg.held || type === 'mousePressed' ? 1 : 0,
              clickCount: type === 'mouseMoved' ? 0 : clamp(msg.clicks, 1, 3, 1),
              modifiers: mods(msg.mods),
            },
            s,
          )
        }
        case 'wheel':
          return await this.call(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseWheel',
              x,
              y,
              deltaX: clamp(msg.dx, -4000, 4000, 0),
              deltaY: clamp(msg.dy, -4000, 4000, 0),
              modifiers: mods(msg.mods),
            },
            s,
          )
        case 'key':
          return await this.call('Input.dispatchKeyEvent', keyEventParams(msg), s)
        case 'text':
          return await this.call('Input.insertText', { text: String(msg.text ?? '').slice(0, 2000) }, s)
        case 'nav': {
          if (msg.action === 'reload') return await this.call('Page.reload', {}, s)
          if (msg.action === 'back' || msg.action === 'forward') {
            const h = tab.history ?? (await this.call('Page.getNavigationHistory', {}, s))
            const entry = h.entries[h.currentIndex + (msg.action === 'back' ? -1 : 1)]
            if (entry) await this.call('Page.navigateToHistoryEntry', { entryId: entry.id }, s)
            return
          }
          if (msg.action === 'go') {
            let target = String(msg.url ?? '').trim()
            if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
              // Typed into the bar: an address if it looks like one, a search otherwise.
              target = /^[^\s]+\.[^\s]{2,}$/.test(target)
                ? `https://${target}`
                : `https://www.google.com/search?q=${encodeURIComponent(target)}`
            }
            const problem = liveUrlProblem(target, { bridgePort: this.bridgePort })
            if (problem) return fail(problem)
            return await this.call('Page.navigate', { url: target }, s)
          }
          return
        }
      }
    } catch (err) {
      fail(err)
    }
  }
}
