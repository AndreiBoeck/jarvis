import type { AskHandlers } from './anthropic'
import type { Blade, Panel } from '../store'
import {
  BRIDGE_HTTP_URL,
  BRIDGE_WS_URL,
  IS_APP,
  IS_REMOTE,
  bridgeHeaders,
  bridgeProtocols,
  setMediaKey,
} from '../config'
import { reconnectDelay, shouldReconnect } from './backoff'

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  /** On 'ready', for a paired phone: the key for loading media by URL. */
  mediaKey?: string
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  from?: string
  servers?: Array<string | { name?: string }>
  alert?: WatchAlert
}

/**
 * The live browser blade's traffic: frames and page state out of the bridge,
 * clicks, keys and navigation back. Out of band, like blades, and passed
 * through untyped — src/lib/live.ts owns the shape.
 */
let onLive: ((msg: Record<string, unknown>) => void) | null = null
export function watchLive(fn: (msg: Record<string, unknown>) => void) {
  onLive = fn
}
/**
 * Cameras across devices (bridge/camfeed.mjs): this screen as a viewer of
 * another device's camera, and as a source others are watching. Untyped here;
 * src/lib/camfeed.ts owns the shape.
 */
let onCam: ((msg: Record<string, unknown>) => void) | null = null
export function watchCam(fn: (msg: Record<string, unknown>) => void) {
  onCam = fn
}
export function sendCam(msg: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ ...msg, type: 'cam' }))
  return true
}

/** Send one live-browser message, if the socket is up. False if it is not. */
export function sendLive(msg: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ ...msg, type: 'live' }))
  return true
}

/**
 * Saved screens' traffic (bridge/actions.mjs): answers to the actions a screen
 * asked for, approvals, and the bridge asking the user to confirm one. Passed
 * through untyped — src/lib/screens.ts owns the shape.
 */
let onScreenMsg: ((msg: Record<string, unknown>) => void) | null = null
export function watchScreenMsgs(fn: (msg: Record<string, unknown>) => void) {
  onScreenMsg = fn
}
let onScreenConfirm: ((req: Record<string, unknown>) => Promise<boolean>) | null = null
export function watchScreenConfirm(fn: (req: Record<string, unknown>) => Promise<boolean>) {
  onScreenConfirm = fn
}
/** Send one screen message, if the socket is up. False if it is not. */
export function sendScreen(msg: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  return true
}

/**
 * A watch speaking up on its own — a condition the user asked to hear about
 * has come true. Nobody asked a question, so it arrives outside any turn.
 */
export type WatchAlert = {
  id: string
  watchId: string
  task: string
  /** mail-morning: the briefing is ready, read it on the next wake.
   *  mail-report: the afternoon mail report, read as soon as he is free. */
  kind: 'alert' | 'paused' | 'mail-morning' | 'mail-report'
  message: string
  at: number
}

let onAlert: ((alert: WatchAlert) => void) | null = null
export function watchAlerts(fn: (alert: WatchAlert) => void) {
  onAlert = fn
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
  /** Set when another device is looking through this one's camera. */
  from?: string
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/**
 * The automatic re-dial: from half a second up to every ten, for as long as it
 * takes, and back to half a second once connected (backoff.ts).
 *
 * It used to give up after six tries — and in fact after one, because a dial
 * that failed never scheduled the next. Restart the bridge and the interface
 * stayed dark until the next question, and a live browser blade never got its
 * tab back. It stops only when stopping is right: the interface closed the
 * socket itself, the bridge closed it on purpose, or the bridge has refused
 * this device's token.
 */
let attempt = 0
let reconnectTimer = 0
let intentional = false

/** A failed dial from a paired device: is it the token that was refused? */
async function refused(): Promise<boolean> {
  if (!IS_REMOTE) return false
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, { headers: bridgeHeaders() })
    return res.status === 401 || res.status === 403
  } catch {
    return false // unreachable is not refused: keep trying
  }
}

function scheduleReconnect() {
  if (!shouldReconnect({ intentional })) return
  const delay = reconnectDelay(attempt)
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    void connect().catch(async () => {
      if (await refused()) {
        console.warn('[jarvis] the bridge refused this device — not reconnecting')
        return
      }
      scheduleReconnect()
    })
  }, delay)
}

/** Close the link on purpose, and stay closed. */
export function disconnect(): void {
  intentional = true
  clearTimeout(reconnectTimer)
  socket?.close(1000, 'closed by the interface')
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  // Once per socket: open live-browser blades claim their tabs on it.
  let liveClaimed = false
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      // A paired phone is handed a key for loading images and pages by URL.
      setMediaKey(msg.mediaKey)
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
      if (!liveClaimed) {
        liveClaimed = true
        onLive?.({ op: 'ready' })
        onCam?.({ op: 'ready' })
      }
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'alert' && typeof msg.alert?.message === 'string') {
      onAlert?.(msg.alert)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
          ...(typeof msg.from === 'string' && msg.from ? { from: msg.from.slice(0, 60) } : {}),
        })
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'cam' && msg.op) {
      onCam?.(msg as unknown as Record<string, unknown>)
    } else if (msg.type === 'live' && msg.op) {
      onLive?.(msg as unknown as Record<string, unknown>)
    } else if (msg.type === 'screen_action' || msg.type === 'screen_approved') {
      onScreenMsg?.(msg as unknown as Record<string, unknown>)
    } else if (msg.type === 'screen_confirm' && msg.id) {
      const id = msg.id
      // Always answered: the bridge holds the screen's action open until then.
      const answer = (allow: boolean) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reply', id, allow }))
      }
      if (!onScreenConfirm) answer(false)
      else
        onScreenConfirm(msg as unknown as Record<string, unknown>)
          .then((allow) => answer(allow === true))
          .catch(() => answer(false))
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL, bridgeProtocols())
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      socket = ws
      attempt = 0
      // Dialled again on purpose (a question after disconnect()): back to
      // re-dialling on its own if this one drops.
      intentional = false
      clearTimeout(reconnectTimer)
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          IS_REMOTE
            ? 'Cannot reach JARVIS at home. Check that Tailscale is on, the PC is ' +
              `awake with the bridge running, and this ${IS_APP ? 'phone' : 'Mac'} is still paired.`
            :
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = (ev: CloseEvent) => {
      // A close before open is just a failed dial (the timer that made it
      // schedules the next); after open it's a lost session.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        onConnection?.('lost')
        if (shouldReconnect({ intentional, closeCode: ev.code })) scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
  kind?: 'briefing',
): Promise<{ text: string; tools: string[] }> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error('The bridge went quiet — that turn was lost, sir.'))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer — that session is gone.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id, ...(kind ? { kind } : {}) }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
