import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Blade } from '../store'
import { BRIDGE_HTTP_URL, IS_APP, withMediaKey } from '../config'
import { sanitisePanelHtml } from './sanitise'
import { frameSpan, peaceScroll, pinchCount } from '../lib/hands'
import * as camera from '../lib/camera'
import { sendLive, subscribeLive } from '../lib/live'
import { sendCam, subscribeCam } from '../lib/camfeed'
import { minutesLeft } from '../lib/camStatus'
import { addressToUrl, modsOf, toPage, touchKind, wheelPixels } from '../lib/livePointer'

/**
 * The blades.
 *
 * This file used to be six slivers of light raking across the frame while a
 * tool ran — pure atmosphere, nothing you could read. That effect is still
 * here, at the bottom, because it is still the right answer to "something is
 * happening". But the name now belongs to the surface it was decorating.
 *
 * A panel is a card you glance at while listening: a figure, three headlines, a
 * status line. A blade is the thing you actually look at. The distinction is
 * not styling, it is geometry — an article you are meant to READ needs a column
 * of a particular width and a height you can scroll, and no amount of care
 * makes that work inside a 320px card stacked beside the reactor. So blades own
 * their size, they stack instead of replacing one another, and the user can
 * pull an older one forward or throw one to full screen.
 *
 * The hard problem a blade solves is that most of the web refuses to be shown.
 * X-Frame-Options and frame-ancestors stop an article being framed, CORS stops
 * the page fetching it, and hotlink protection stops even its images loading.
 * All three are rules the origin server enforces against the *browser*, so the
 * bridge takes the browser out of it: it fetches server-side and serves the
 * result from localhost, and at that point the document in the iframe is ours.
 *
 * Nothing in this file is a special case for a particular site, and nothing
 * here sniffs a file extension. The model asks `probe_url` what a thing is and
 * says what it wants shown; this only knows how to show it.
 */

/* ------------------------------------------------------------------ sources */

/**
 * Paths that are genuinely on this machine's disk, as opposed to app-relative
 * URLs that happen to start with a slash. Mirrors the test in sanitise.ts and
 * Orbits.tsx — the list of root directories is the sort of thing that should be
 * changed in each place deliberately.
 */
const DISK_PATH =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

/** Route a source through the bridge, which is the only origin that can
 *  actually fetch it — and the only one the page CSP will load from. */
function viaBridge(raw: string, route: 'img' | 'media'): string {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  const path = src.replace(/^file:\/\//, '')
  if (DISK_PATH.test(path)) {
    return withMediaKey(`${BRIDGE_HTTP_URL}/file?path=${encodeURIComponent(path)}`)
  }
  if (!/^https?:\/\//i.test(src)) return src
  if (src.startsWith(`${BRIDGE_HTTP_URL}/`)) return withMediaKey(src)
  return withMediaKey(`${BRIDGE_HTTP_URL}/${route}?url=${encodeURIComponent(src)}`)
}

/** A whole document, rendered by the bridge so it can be framed at all. */
const pageUrl = (url: string, mode: 'reader' | 'live') =>
  withMediaKey(`${BRIDGE_HTTP_URL}/page?mode=${mode}&url=${encodeURIComponent(url)}`)

/**
 * The three embed hosts, and only these.
 *
 * Same closed list as the panel sanitiser, for the same reason: YouTube and
 * Vimeo will not hand over the media file, so an iframe is the only way to play
 * a result inline, and the trade for that is that the host list does not grow.
 */
function embedUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  const id = (s: string) => (/^[\w-]{6,20}$/.test(s) ? s : null)

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const v = id(url.searchParams.get('v') ?? '')
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtu.be') {
    const v = id(url.pathname.slice(1))
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtube-nocookie.com' && /^\/embed\/[\w-]+/.test(url.pathname)) return url.href
  if (host === 'vimeo.com') {
    const v = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return /^\d+$/.test(v) ? `https://player.vimeo.com/video/${v}` : null
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return url.href
  return null
}

/**
 * A Google Maps embed, and only that — the same check as bridge/maps.mjs. The
 * bridge builds these; anything else is refused rather than framed.
 */
function mapUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname === 'maps.google.com' && url.pathname === '/maps') {
    return url.searchParams.get('output') === 'embed' ? url.href : null
  }
  if (url.hostname === 'www.google.com' && /^\/maps\/embed\/v1\/(directions|place)$/.test(url.pathname)) {
    return url.href
  }
  return null
}

/* --------------------------------------------------------------------- body */

/**
 * What goes inside a blade.
 *
 * Every iframe is sandboxed. `allow-same-origin` is deliberately absent from
 * the proxied-page case: that document is served from the bridge's own origin —
 * the one origin permitted to open the agent socket — so granting it
 * same-origin would let a page JARVIS found on the web reach that socket. It
 * does not need it. It is being read, not run.
 */
/**
 * The live camera, on screen.
 *
 * Holding the camera for as long as the blade is open does two jobs. It shows
 * the user what JARVIS can see, which is the honest way to run a camera; and it
 * starts the rolling buffer, which is the only reason "what did I just do" can
 * ever be answered — a question that cannot be satisfied by starting to record
 * at the moment it is asked.
 *
 * Mirrored here and only here. A person expects their own image to behave like
 * a reflection, so the preview is flipped for them; the frames handed to the
 * model are not, because a label held up to the lens has to arrive the right
 * way round.
 */
const CameraView = memo(function CameraView() {
  const el = useRef<HTMLVideoElement>(null)
  const [failed, failed_] = useState<string | null>(null)

  useEffect(() => {
    let held = false
    let gone = false
    void camera
      .holdCamera()
      .then((source) => {
        if (gone) {
          camera.releaseCamera()
          return
        }
        held = true
        camera.startBuffer()
        if (el.current && source.srcObject) el.current.srcObject = source.srcObject
      })
      .catch((err: DOMException) =>
        failed_(
          err?.name === 'NotAllowedError'
            ? 'Camera access is not permitted.'
            : `The camera could not be opened: ${err?.message ?? err}`,
        ),
      )
    return () => {
      gone = true
      if (held) camera.releaseCamera()
    }
  }, [])

  if (failed) return <p className="bl-note">{failed}</p>
  return <video ref={el} className="bl-camera" autoPlay playsInline muted />
})

/**
 * Another device's camera, on this screen (bridge/camfeed.mjs).
 *
 * Claims the grant the bridge made when the blade was opened, draws each JPEG
 * as it comes, and acks it once it has been decoded — the ack is what lets the
 * bridge ask for the next one. Not mirrored: it is not a reflection of whoever
 * is looking at it. Unmounting closes it, so the other device's camera goes off
 * with the blade.
 */
const RemoteCameraView = memo(function RemoteCameraView({ blade }: { blade: Blade }) {
  const img = useRef<HTMLImageElement>(null)
  const [state, state_] = useState<{ label: string; host: boolean; until?: number }>({
    label: blade.sourceLabel ?? 'another device',
    host: blade.source === 'host',
  })
  const [ended, ended_] = useState<string | null>(null)
  const [live, live_] = useState(false)
  const [, tick] = useState(0)

  const watch = useCallback(() => {
    ended_(null)
    sendCam({ op: 'watch', id: blade.id })
  }, [blade.id])

  useEffect(() => {
    let alive = true
    let endedNow = false
    const off = subscribeCam(blade.id, (m) => {
      if (m.op === 'ready') {
        if (!endedNow) sendCam({ op: 'watch', id: blade.id })
      } else if (m.op === 'state') {
        endedNow = false
        state_({ label: m.label ?? blade.sourceLabel ?? 'another device', host: Boolean(m.host), until: m.until })
      } else if (m.op === 'ended') {
        endedNow = true
        live_(false)
        ended_(m.reason ?? 'The camera was turned off.')
      } else if (m.op === 'frame' && m.data && img.current) {
        const el = img.current
        el.src = `data:image/jpeg;base64,${m.data}`
        void el
          .decode()
          .catch(() => {})
          .then(() => {
            if (!alive) return
            live_(true)
            sendCam({ op: 'ack', id: blade.id })
          })
      }
    })
    sendCam({ op: 'watch', id: blade.id })
    // The minutes left on the bridge's own capture, kept current.
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      alive = false
      clearInterval(t)
      off()
      sendCam({ op: 'close', id: blade.id })
    }
  }, [blade.id, blade.sourceLabel])

  const left = state.host ? minutesLeft(state.until, Date.now()) : null
  return (
    <div className="bl-camremote">
      <div className="bl-camremote-bar">
        <span className="bl-camremote-dot" data-live={live && !ended ? '' : undefined} />
        <span className="bl-camremote-label">{state.label}</span>
        {left !== null && !ended && <span className="bl-camremote-left">off in {left} min</span>}
      </div>
      <img ref={img} className="bl-camremote-img" alt={`Camera: ${state.label}`} hidden={Boolean(ended)} />
      {ended && (
        <div className="bl-camremote-ended">
          <p className="bl-note">{ended}</p>
          <button type="button" className="bl-camremote-retry" onClick={watch}>
            TRY AGAIN
          </button>
        </div>
      )}
      {!live && !ended && <p className="bl-note bl-camremote-wait">Connecting to the camera…</p>}
    </div>
  )
})

/**
 * A saved app screen (bridge/screens.mjs): the model's own HTML and JS, served
 * by the bridge under a CSP that lets nothing leave the document, and framed
 * here with allow-scripts and no allow-same-origin — an opaque origin that can
 * reach neither this page, nor the socket, nor the token. Its data goes in by
 * postMessage, the only door it has.
 */
const ScreenView = memo(function ScreenView({ blade }: { blade: Blade }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const post = () => frame.current?.contentWindow?.postMessage({ jarvis: 'data', data: blade.data ?? null }, '*')
  useEffect(post, [blade.data])
  if (!blade.url?.startsWith('/screen?')) return <p className="bl-note">That screen could not be shown.</p>
  return (
    <iframe
      ref={frame}
      className="bl-frame"
      src={withMediaKey(`${BRIDGE_HTTP_URL}${blade.url}`)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={post}
      title={blade.title}
    />
  )
})

type LiveState = {
  url: string
  title: string
  canBack: boolean
  canForward: boolean
  loading: boolean
  error: string
  closed: boolean
  started: boolean
}

/**
 * A real browser tab on the PC, on the blade (bridge/livebrowser.mjs).
 *
 * The page runs in Chrome on the PC with its own scripts and its own origin;
 * what arrives here is a JPEG each time it changes, and what goes back is the
 * user's clicks, wheel and keys, over the interface's own socket. A mouse is a
 * mouse. A finger taps to click and drags to scroll, which is what a phone
 * user expects, and hand gestures arrive as touches and behave the same way.
 *
 * Opening and closing the tab follow the blade, not this component: an
 * unmount (another blade thrown full screen) only pauses the stream, and the
 * tab is closed when the blade leaves the store — see `Blades` below.
 */
const LiveView = memo(function LiveView({ blade }: { blade: Blade }) {
  const id = blade.id
  const surface = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const frameSize = useRef({ w: 0, h: 0 })
  const started = useRef(false)
  const [st, setSt] = useState<LiveState>({
    url: blade.url ?? '',
    title: '',
    canBack: false,
    canForward: false,
    loading: true,
    error: '',
    closed: false,
    started: false,
  })
  const [addr, setAddr] = useState<string | null>(null)

  useEffect(() => {
    const el = surface.current
    if (!el) return
    const size = () => {
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), mobile: IS_APP }
    }
    const open = () => sendLive({ op: 'open', id, url: blade.url, ...size() })
    const off = subscribeLive(id, (m) => {
      if (m.op === 'ready') return void open()
      if (m.op === 'frame' && m.data && img.current) {
        img.current.src = `data:image/jpeg;base64,${m.data}`
        frameSize.current = { w: m.w ?? 0, h: m.h ?? 0 }
        if (!started.current) {
          started.current = true
          setSt((s) => ({ ...s, started: true, closed: false }))
        }
        return
      }
      if (m.op === 'state') {
        setSt((s) => ({
          ...s,
          url: m.url ?? s.url,
          title: m.title ?? s.title,
          canBack: m.canBack ?? s.canBack,
          canForward: m.canForward ?? s.canForward,
          loading: m.loading ?? s.loading,
          error: m.url ? '' : s.error,
        }))
        return
      }
      if (m.op === 'error') return setSt((s) => ({ ...s, error: m.message ?? 'error' }))
      if (m.op === 'closed') return setSt((s) => ({ ...s, closed: true }))
    })
    open()

    // The page is laid out at the surface's size, so a resized blade re-lays
    // the page out rather than scaling a picture of it.
    let timer = 0
    let last = ''
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        const s = size()
        const key = `${s.w}x${s.h}`
        if (key === last || s.w < 50 || s.h < 50) return
        last = key
        sendLive({ op: 'resize', id, ...s })
      }, 220)
    })
    ro.observe(el)

    // Keys go to the page while the surface has focus, and nowhere else:
    // stopped here, on the element, so E, X, M and Space reach the page rather
    // than closing the blade or muting the microphone.
    const key = (event: 'down' | 'up') => (e: KeyboardEvent) => {
      e.stopPropagation()
      // Let the browser keep its own reload/devtools chords on desktop.
      if (e.metaKey && (e.key === 'r' || e.key === 'R')) return
      e.preventDefault()
      sendLive({ op: 'key', id, event, key: e.key, code: e.code, keyCode: e.keyCode, mods: modsOf(e) })
    }
    const down = key('down')
    const up = key('up')
    const paste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      sendLive({ op: 'text', id, text })
    }
    // Native and non-passive, or preventDefault would not stop the blade
    // body (or the page behind it) scrolling as well.
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const p = toPage(e.clientX, e.clientY, el.getBoundingClientRect(), frameSize.current.w, frameSize.current.h)
      if (!p) return
      sendLive({
        op: 'wheel',
        id,
        ...p,
        dx: wheelPixels(e.deltaX, e.deltaMode),
        dy: wheelPixels(e.deltaY, e.deltaMode),
        mods: modsOf(e),
      })
    }
    el.addEventListener('keydown', down)
    el.addEventListener('keyup', up)
    el.addEventListener('paste', paste)
    el.addEventListener('wheel', wheel, { passive: false })

    return () => {
      off()
      ro.disconnect()
      clearTimeout(timer)
      el.removeEventListener('keydown', down)
      el.removeEventListener('keyup', up)
      el.removeEventListener('paste', paste)
      el.removeEventListener('wheel', wheel)
      sendLive({ op: 'pause', id })
    }
    // blade.url is the page it opened on; later navigation is the page's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  /** Where a pointer is on the page, or null in the letterbox. */
  const at = (e: { clientX: number; clientY: number }) => {
    const el = surface.current
    if (!el) return null
    return toPage(e.clientX, e.clientY, el.getBoundingClientRect(), frameSize.current.w, frameSize.current.h)
  }

  const touch = useRef<{ x: number; y: number; lastY: number; lastX: number; drag: boolean } | null>(null)
  const clicks = useRef({ t: 0, x: 0, y: 0, n: 0 })
  const moveQueued = useRef<{ x: number; y: number; held: boolean } | null>(null)
  const moveRaf = useRef(0)

  const onDown = (e: React.PointerEvent) => {
    // Not a grab: on this blade a touch belongs to the page (the header still
    // moves it). A mouse press is never a grab, so it may bubble and focus.
    if (e.pointerType === 'touch') e.stopPropagation()
    surface.current?.focus({ preventScroll: true })
    try {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } catch {
      // synthetic pointers (hand gestures) have nothing to capture
    }
    if (e.pointerType === 'touch') {
      touch.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, drag: false }
      return
    }
    const p = at(e)
    if (!p) return
    const c = clicks.current
    const now = performance.now()
    c.n = now - c.t < 450 && Math.hypot(p.x - c.x, p.y - c.y) < 6 ? Math.min(3, c.n + 1) : 1
    Object.assign(c, { t: now, x: p.x, y: p.y })
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    sendLive({ op: 'mouse', id, event: 'down', ...p, button, clicks: c.n, mods: modsOf(e) })
  }

  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      const t = touch.current
      if (!t) return
      if (!t.drag && touchKind(e.clientX - t.x, e.clientY - t.y) === 'drag') t.drag = true
      if (!t.drag) return
      const p = at({ clientX: t.x, clientY: t.y })
      // The page follows the finger: dragging up scrolls down.
      if (p) sendLive({ op: 'wheel', id, ...p, dx: t.lastX - e.clientX, dy: t.lastY - e.clientY })
      t.lastX = e.clientX
      t.lastY = e.clientY
      return
    }
    const p = at(e)
    if (!p) return
    // One move per frame is plenty, and a hover storm would back the socket up.
    moveQueued.current = { ...p, held: e.buttons > 0 }
    if (moveRaf.current) return
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = 0
      const q = moveQueued.current
      if (q) sendLive({ op: 'mouse', id, event: 'move', ...q })
    })
  }

  const onUp = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.pointerType === 'touch') {
      const t = touch.current
      touch.current = null
      if (!t || t.drag) return
      const p = at({ clientX: t.x, clientY: t.y })
      if (!p) return
      sendLive({ op: 'mouse', id, event: 'down', ...p, button: 'left', clicks: 1 })
      sendLive({ op: 'mouse', id, event: 'up', ...p, button: 'left', clicks: 1 })
      return
    }
    const p = at(e) ?? { x: clicks.current.x, y: clicks.current.y }
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    sendLive({ op: 'mouse', id, event: 'up', ...p, button, clicks: clicks.current.n, mods: modsOf(e) })
  }

  const nav = (action: 'back' | 'forward' | 'reload' | 'go', url?: string) =>
    sendLive({ op: 'nav', id, action, url })

  return (
    <div className="bl-live">
      <div className="bl-live-bar" onPointerDown={(e) => e.stopPropagation()}>
        <button className="bl-btn" disabled={!st.canBack} onClick={() => nav('back')} title="Back">
          ←
        </button>
        <button className="bl-btn" disabled={!st.canForward} onClick={() => nav('forward')} title="Forward">
          →
        </button>
        <button className="bl-btn" onClick={() => nav('reload')} title="Reload">
          {st.loading ? '✕' : '⟳'}
        </button>
        <input
          className="bl-live-url"
          value={addr ?? st.url}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="url"
          onFocus={(e) => {
            setAddr(st.url)
            e.currentTarget.select()
          }}
          onBlur={() => setAddr(null)}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              const url = addressToUrl(addr ?? '')
              if (url) nav('go', url)
              setAddr(null)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setAddr(null)
              e.currentTarget.blur()
            }
          }}
        />
        {IS_APP && (
          // A phone has no keyboard until a text field has focus, and the
          // field that needs it is inside a picture. This one stands in: what
          // is typed here is typed into the page.
          <input
            className="bl-live-type"
            placeholder="type…"
            autoCapitalize="off"
            onChange={(e) => {
              const text = e.target.value
              if (text) sendLive({ op: 'text', id, text })
              e.target.value = ''
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' || (e.key === 'Backspace' && !e.currentTarget.value)) {
                e.preventDefault()
                sendLive({ op: 'key', id, event: 'down', key: e.key, code: e.key, keyCode: e.key === 'Enter' ? 13 : 8 })
                sendLive({ op: 'key', id, event: 'up', key: e.key, code: e.key, keyCode: e.key === 'Enter' ? 13 : 8 })
              }
            }}
          />
        )}
      </div>
      <div
        ref={surface}
        className="bl-live-surface"
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          touch.current = null
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <img ref={img} className="bl-live-frame" alt="" draggable={false} />
        {st.closed ? (
          <p className="bl-note bl-live-over">The browser tab was closed.</p>
        ) : !st.started ? (
          <p className="bl-note bl-live-over">{st.error || 'Opening the page…'}</p>
        ) : st.error ? (
          <p className="bl-live-err">{st.error}</p>
        ) : null}
      </div>
    </div>
  )
})

const Body = memo(function Body({ blade }: { blade: Blade }) {
  if (blade.kind === 'camera') return blade.source ? <RemoteCameraView blade={blade} /> : <CameraView />
  if (blade.kind === 'browser' && blade.url) return <LiveView blade={blade} />
  if (blade.kind === 'screen') return <ScreenView blade={blade} />

  if (blade.kind === 'article' && blade.url) {
    return (
      <iframe
        className="bl-frame"
        src={pageUrl(blade.url, blade.mode ?? 'reader')}
        // allow-scripts WITHOUT allow-same-origin. That combination is the
        // point: the page runs in an opaque origin, so the one script the
        // bridge injects can move the document's own scroll position and can
        // reach nothing of ours — not this origin, not the agent socket. Adding
        // allow-same-origin would hand a page found on the web the keys.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'embed' && blade.url) {
    const embed = embedUrl(blade.url)
    if (!embed) return <p className="bl-note">That video link could not be played.</p>
    return (
      <iframe
        className="bl-frame"
        src={embed}
        // A player genuinely needs scripts and its own origin. Nothing that
        // reaches the room the user is sitting in is granted.
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
        // Not no-referrer: YouTube and Vimeo refuse to play without knowing
        // which site embeds them, and YouTube says so as "Error 153". This
        // sends the origin alone (http://localhost:5173), never the path.
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'map' && blade.url) {
    const map = mapUrl(blade.url)
    if (!map) return <p className="bl-note">That map could not be shown.</p>
    return (
      <iframe
        className="bl-frame"
        src={map}
        // Google's own origin, like a video player: it needs its scripts and
        // its origin to draw. Nothing of ours is granted — no popups, no top
        // navigation, no forms.
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'video' && blade.url) {
    return (
      <video
        className="bl-video"
        src={viaBridge(blade.url, 'media')}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (blade.kind === 'image' && blade.url) {
    return <img className="bl-image" src={viaBridge(blade.url, 'img')} alt={blade.title} />
  }

  if (blade.kind === 'gallery') {
    return (
      <div className="bl-gallery">
        {(blade.images ?? []).map((src, i) => (
          <img key={`${src}-${i}`} className="bl-thumb" src={viaBridge(src, 'img')} alt="" />
        ))}
      </div>
    )
  }

  if (blade.kind === 'markup' && blade.html) {
    // Model-authored markup gets exactly the treatment panel markup gets.
    // There is one sanitiser, and this is it.
    return (
      <div
        className="bl-markup p-body"
        dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(blade.html) }}
      />
    )
  }

  return <p className="bl-note">Nothing to show.</p>
})

/* -------------------------------------------------------------------- card */

function Card({
  blade,
  depth,
  focused,
  expanded,
  onFocus,
  onExpand,
  onClose,
}: {
  blade: Blade
  /** 0 is front-most. Drives the offset and the dimming behind it. */
  depth: number
  focused: boolean
  expanded: boolean
  onFocus: () => void
  onExpand: () => void
  onClose: () => void
}) {
  /** Size the user has dragged this blade to, overriding the class preset. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  /** Where the user has dragged it, relative to its slot. */
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const shell = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  /**
   * Scroll whatever this blade is showing.
   *
   * Two destinations, because a blade holds two different kinds of thing. Its
   * own overflow for markup and galleries; a postMessage for an article, since
   * an iframe is a separate document that the parent cannot scroll directly —
   * see the shim in bridge/page.mjs.
   */
  const scrollContent = (dy: number) => {
    const el = body.current
    if (!el) return
    const frame = el.querySelector('iframe')
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ jarvis: 'scroll', dy }, '*')
    } else {
      el.scrollTop += dy
    }
  }

  /**
   * Drag and resize both listen on `window`, and that is the whole trick.
   *
   * The obvious implementations do not work by hand. framer-motion's own drag
   * tracks the pointer through internals we cannot reach, and the resize grip
   * originally listened on the grip element — but the hand controller aims its
   * synthetic events with elementFromPoint, and one pixel into a drag the
   * element under the cursor is no longer the grip. So resizing by hand died on
   * the first frame, and dragging never started at all.
   *
   * Listening on window fixes both for free: a synthetic event dispatched at
   * whatever is under the cursor still bubbles to window, so these handlers see
   * a hand and a mouse identically. Which is the property the gesture layer was
   * designed around — one interaction, not two implementations of it.
   */
  const grab = (
    e: React.PointerEvent,
    onMove: (dx: number, dy: number) => void,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    let baseX = sx
    let baseY = sy
    let dx = 0
    let dy = 0

    const move = (ev: PointerEvent) => {
      /**
       * Both hands pinching means this is not a drag.
       *
       * One pinch is a grab. Two is somebody doing something two-handed, and
       * whichever hand happened to press first should not be hauling the blade
       * around underneath it — the result is a blade that lurches away while
       * you are trying to do something else with both hands.
       *
       * Suppressed by re-anchoring rather than by returning early. A plain
       * return would leave the origin where the press began, so the moment one
       * hand released, the blade would leap by however far the other hand had
       * travelled in the meantime. Moving the origin with the hand keeps the
       * offset constant, so letting go of one hand simply resumes from here.
       */
      if (ev.pointerType === 'touch' && pinchCount() > 1) {
        baseX = ev.clientX - dx
        baseY = ev.clientY - dy
        return
      }
      dx = ev.clientX - baseX
      dy = ev.clientY - baseY
      onMove(dx, dy)
    }
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }

  const onHeadDown = (e: React.PointerEvent) => {
    // Buttons live in the header too; starting a drag from one would mean the
    // click never lands.
    if ((e.target as HTMLElement).closest('button')) return
    if (!focused) onFocus()
    if (expanded) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }))
  }

  /**
   * Pinch anywhere on a blade to grab it.
   *
   * This used to scroll, and moving a blade was possible only by hitting the
   * header — a strip 31 pixels tall. Asking someone to land a hand cursor on 31
   * pixels is not an interaction, and since a pinch on the body scrolled
   * instead, there was in practice no way to move a blade by hand at all.
   *
   * Grabbing is also what people try first: you see a thing and reach for it.
   * So a pinch anywhere picks the blade up, and scrolling moves to a pose that
   * is deliberate and hard to make by accident — two fingers, see the effect
   * below. Only for 'touch', which is what the gesture layer dispatches; a mouse
   * keeps its wheel and its ability to select text.
   */
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (!focused) onFocus()
    if (expanded) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }))
  }

  /**
   * Two fingers up, moved up or down, scrolls the front blade.
   *
   * Reads a distance from hands.ts and decides here that it means scrolling —
   * the tracker publishes the pose, not the consequence.
   */
  useEffect(() => {
    if (!focused) return
    let raf = 0
    let last: number | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const travelled = peaceScroll()
      if (travelled === null) {
        last = null
        return
      }
      if (last === null) {
        last = travelled
        return
      }
      // Inverted and amplified: pulling your hand up moves you down the page,
      // and a hand does not have the travel a scroll wheel does.
      scrollContent((last - travelled) * 2.4)
      last = travelled
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused])

  /**
   * Frame the blade with both hands to resize it.
   *
   * Index up, thumb out, one hand either side — the rectangle people already
   * mime when they frame a shot. Pull the corners apart and the blade grows;
   * bring them together and it shrinks; lean toward the camera and it grows
   * too, because leaning in enlarges everything about the hands including the
   * gap between them.
   *
   * This replaced a two-handed pinch, which read well on paper and collided
   * badly in practice: a pinch is how you GRAB a blade, so two of them meant
   * two hands each trying to pick something up while also asking to resize it.
   * The framing pose collides with nothing, which is most of why it is right.
   *
   * The measurement arrives as a plain distance; that it means a resize is
   * decided here. Only the focused blade, and never while expanded, where the
   * size is the entire point of the state.
   */
  useEffect(() => {
    if (!focused || expanded) return
    let raf = 0
    let from: { span: number; w: number; h: number } | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const span = frameSpan()
      if (span === null) {
        from = null
        return
      }
      const box = shell.current?.getBoundingClientRect()
      if (!box) return
      if (!from) {
        // Both hands have just closed. Anchor on the size as it is now.
        from = { span, w: box.width, h: box.height }
        return
      }
      // Guard the divisor: hands almost touching would send the scale to
      // infinity and the blade off the screen in one frame.
      const k = span / Math.max(from.span, 40)
      setSize({
        w: Math.max(280, Math.min(window.innerWidth * 0.96, from.w * k)),
        h: Math.max(180, Math.min(window.innerHeight * 0.94, from.h * k)),
      })
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused, expanded])

  const onGrip = (e: React.PointerEvent) => {
    const box = shell.current?.getBoundingClientRect()
    if (!box) return
    const from = { w: box.width, h: box.height }
    grab(e, (dx, dy) =>
      setSize({
        w: Math.max(280, Math.min(window.innerWidth * 0.96, from.w + dx)),
        h: Math.max(180, Math.min(window.innerHeight * 0.94, from.h + dy)),
      }),
    )
  }

  /**
   * Resize from the bottom-right grip.
   *
   * Pointer capture rather than window listeners: the pointer spends most of a
   * resize over an <iframe>, and an iframe swallows mousemove from the parent
   * document entirely. Without capture the blade stops resizing the instant the
   * cursor crosses into the article it is showing, which is precisely where it
   * always crosses.
   */
  return (
    /**
     * Two elements, because two different things want the transform.
     *
     * The outer one carries the depth offset — the small lift and scale that
     * makes the stack read as objects rather than as a list. The inner one is
     * what the user drags. Framer owns `transform` on anything it animates, so
     * with both jobs on one element the drag and the stack animation overwrite
     * each other every frame and the blade jitters back to its slot.
     */
    <motion.div
      className="bl-slot"
      initial={{ opacity: 0, y: 26, scale: 0.96, filter: 'blur(6px)' }}
      animate={{
        opacity: expanded || depth === 0 ? 1 : Math.max(0.3, 1 - depth * 0.24),
        y: expanded ? 0 : depth * -13,
        x: expanded ? 0 : depth * 15,
        scale: expanded ? 1 : 1 - depth * 0.035,
        filter: depth === 0 || expanded ? 'blur(0px)' : `blur(${depth * 0.7}px)`,
      }}
      exit={{ opacity: 0, y: 18, filter: 'blur(8px)', transition: { duration: 0.28 } }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      style={{ zIndex: expanded ? 60 : 40 - depth }}
    >
      <motion.section
        ref={shell}
        className={
          `bl bl-${blade.size}` +
          (expanded ? ' bl-expanded' : '') +
          (focused ? ' bl-front' : '')
        }
        // Position and size are ours rather than framer's — see `grab` above for
        // why. Applied as a plain transform because the depth animation lives on
        // the slot wrapper, so nothing is competing for this element's own one.
        style={{
          ...(size && !expanded ? { width: size.w, height: size.h } : null),
          transform: expanded ? undefined : `translate(${pos.x}px, ${pos.y}px)`,
        }}
        // pointerdown, not mousedown: a hand dispatches PointerEvents, and a
        // mousedown handler simply never hears them. Focusing a blade by pinch
        // was silently impossible until this changed.
        onPointerDown={() => {
          if (!focused) onFocus()
        }}
      >
        <span className="pk pk-tl" />
        <span className="pk pk-tr" />
        <span className="pk pk-bl" />
        <span className="pk pk-br" />

        <header className="bl-head" onPointerDown={onHeadDown}>
          <span className="bl-title">{blade.title}</span>
          <span className="bl-kind">{blade.kind}</span>
          <span className="bl-acts">
            {(size || pos.x || pos.y) && !expanded && (
              <button
                className="bl-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setSize(null)
                  setPos({ x: 0, y: 0 })
                }}
                title="Back where it started"
              >
                ⤾
              </button>
            )}
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onExpand()
              }}
              title={expanded ? 'Shrink (E)' : 'Full screen (E)'}
            >
              {expanded ? '⤡' : '⤢'}
            </button>
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              title="Close (X)"
            >
              ✕
            </button>
          </span>
        </header>

        <div className="bl-body" ref={body} onPointerDown={onBodyDown}>
          <Body blade={blade} />
        </div>

        {/* Resize grip. Absent while expanded, where the size is the point. */}
        {!expanded && <span className="bl-grip" onPointerDown={onGrip} title="Drag to resize" />}
      </motion.section>
    </motion.div>
  )
}

/* ------------------------------------------------------------------- stack */

export function Blades() {
  const blades = useStore((s) => s.blades)
  const focusedBlade = useStore((s) => s.focusedBlade)
  const expandedBlade = useStore((s) => s.expandedBlade)
  const focusBlade = useStore((s) => s.focusBlade)
  const expandBlade = useStore((s) => s.expandBlade)
  const closeBlade = useStore((s) => s.closeBlade)

  /**
   * Newest first, then whichever the user pulled forward lifted to the front.
   *
   * Ordered here rather than in the store because it is a view concern, and the
   * store's array order is the history — which is what makes "the one before
   * that" a meaningful thing to ask for.
   */
  const ordered = useMemo(() => {
    const newestFirst = [...blades].reverse()
    if (!focusedBlade) return newestFirst
    const hit = newestFirst.findIndex((b) => b.id === focusedBlade)
    if (hit <= 0) return newestFirst
    const copy = [...newestFirst]
    const [lifted] = copy.splice(hit, 1)
    return [lifted, ...copy]
  }, [blades, focusedBlade])

  const front = ordered[0]

  /**
   * A live browser blade that leaves the store — closed, cleared, or pushed off
   * the back of the stack — closes its tab on the PC. Watched here rather than
   * on unmount, because a blade is also unmounted while another one is full
   * screen, and that must only pause it.
   */
  const liveIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set(blades.filter((b) => b.kind === 'browser').map((b) => b.id))
    for (const id of liveIds.current) if (!now.has(id)) sendLive({ op: 'close', id })
    liveIds.current = now
  }, [blades])

  const cycle = useCallback(
    (by: number) => {
      if (ordered.length < 2) return
      const at = ordered.findIndex((b) => b.id === front?.id)
      const next = ordered[(at + by + ordered.length) % ordered.length]
      if (next) focusBlade(next.id)
    },
    [ordered, front, focusBlade],
  )

  // Bound here rather than in App, and only while something is open, so E and X
  // are free for anything else the moment the last blade closes.
  const live = useRef(false)
  live.current = blades.length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return

      if (e.key === 'e') {
        e.preventDefault()
        expandBlade(expandedBlade ? null : (front?.id ?? null))
      } else if (e.key === 'x') {
        e.preventDefault()
        if (front) closeBlade(front.id)
      } else if (e.key === ']') {
        e.preventDefault()
        cycle(1)
      } else if (e.key === '[') {
        e.preventDefault()
        cycle(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [front, expandedBlade, expandBlade, closeBlade, cycle])

  if (!blades.length) return null

  return (
    <div className={`blades-stack${expandedBlade ? ' blades-stack-full' : ''}`}>
      <AnimatePresence>
        {ordered.map((blade, i) => {
          const expanded = expandedBlade === blade.id
          // While one is expanded it is the only thing on screen; the rest are
          // unmounted rather than hidden so their iframes stop loading.
          if (expandedBlade && !expanded) return null
          return (
            <Card
              key={blade.id}
              blade={blade}
              depth={expanded ? 0 : i}
              focused={blade.id === front?.id}
              expanded={expanded}
              onFocus={() => focusBlade(blade.id)}
              onExpand={() => expandBlade(expanded ? null : blade.id)}
              onClose={() => closeBlade(blade.id)}
            />
          )
        })}
      </AnimatePresence>

      {blades.length > 1 && !expandedBlade && (
        <div className="bl-hint">
          <kbd>[</kbd> <kbd>]</kbd> cycle · <kbd>E</kbd> full · <kbd>X</kbd> close
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- the sweep */

/**
 * The original blades: slivers of light raking across the frame while a tool
 * runs. Unchanged, because it is still the right answer to "something is
 * happening" — a tool call is the one moment the interface stops being a face
 * and becomes machinery, and the reactor cannot carry that on its own.
 *
 * Deliberately CSS rather than three.js: the scene is bloomed and tone-mapped,
 * which is exactly wrong for a 1px edge. Kept in the DOM it stays a blade.
 */
const SWEEP = [1, 2, 3, 4, 5, 6]

export function BladeSweep() {
  const phase = useStore((s) => s.phase)
  const activeTool = useStore((s) => s.activeTool)

  return (
    <AnimatePresence>
      {phase === 'tooling' && (
        <motion.div
          className="blades"
          // Only opacity is animated here. The sweeps are CSS keyframes on the
          // children, and framer writes `transform` inline on anything it
          // animates — one transform prop in this list and every blade would be
          // sliding inside an element that is itself sliding.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="blade-field">
            {SWEEP.map((n) => (
              <span key={n} className={`blade blade-${n}`} />
            ))}
          </div>

          {activeTool && (
            // Keyed on the name so a chain of tools re-runs the ride-in for
            // each one rather than silently swapping the text mid-sweep.
            <div className="blade-carrier">
              <span key={activeTool} className="blade-tool">
                {activeTool}
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
