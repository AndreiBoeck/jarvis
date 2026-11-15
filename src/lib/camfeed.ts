import { sendCam, watchCam } from './bridge'
import * as camera from './camera'
import { useStore } from '../store'

/**
 * Cameras across devices, the interface's half (bridge/camfeed.mjs has the
 * other). Two roles, often on the same screen at different times:
 *
 *   viewer — a camera blade showing another device's camera. It claims its
 *            grant with `watch`, draws each frame, and acks it: the ack is what
 *            lets the bridge ask the source for the next one, so a slow link
 *            slows the picture rather than queueing it.
 *   source — this device's camera, being watched from another. It holds the
 *            camera while anyone watches, answers each `pull` with one JPEG,
 *            and shows who is watching (store.camOut → the banner in the HUD),
 *            with a Cut button that ends it from here.
 */

export type CamMsg = {
  op: string
  id?: string
  data?: string
  w?: number
  h?: number
  label?: string
  host?: boolean
  until?: number
  reason?: string
}

const views = new Map<string, (m: CamMsg) => void>()

/** Feeds this device is the source of, each holding the camera once. */
const holding = new Map<string, Promise<unknown>>()

function releaseFeed(feed: string) {
  const hold = holding.get(feed)
  if (!hold) return
  holding.delete(feed)
  // Released once the hold has landed, whether it opened or not.
  void hold.then(
    () => camera.releaseCamera(),
    () => {},
  )
  useStore.getState().setCamOut(feed, null)
}

/** Stop sending, here and now, and tell the bridge: the source's own off switch. */
export function cutCamera() {
  sendCam({ op: 'cut' })
  for (const feed of [...holding.keys()]) releaseFeed(feed)
}

function asSource(raw: Record<string, unknown>) {
  const feed = String(raw.feed ?? '')
  if (!feed) return
  if (raw.op === 'start') {
    const to = Array.isArray(raw.to) ? raw.to.map(String) : []
    useStore.getState().setCamOut(feed, to)
    if (!holding.has(feed)) {
      const hold = camera.holdCamera()
      holding.set(feed, hold)
      hold.catch(() => {
        if (holding.get(feed) === hold) holding.delete(feed)
      })
    }
    return
  }
  if (raw.op === 'stop') return releaseFeed(feed)
  if (raw.op === 'pull') {
    const n = raw.n
    const hold = holding.get(feed)
    if (!hold) return sendCam({ op: 'error', n, message: 'not sending' })
    hold.then(
      () => {
        try {
          const f = camera.grabScaled(Number(raw.w) || 640, Number(raw.q) || 0.6)
          sendCam({ op: 'frame', n, ...f })
        } catch (err) {
          sendCam({ op: 'error', n, message: String((err as Error)?.message ?? err) })
        }
      },
      (err: DOMException) =>
        sendCam({
          op: 'error',
          n,
          message: err?.name === 'NotAllowedError' ? 'the camera is not permitted there' : String(err?.message ?? err),
        }),
    )
  }
}

watchCam((raw) => {
  const m = raw as unknown as CamMsg
  if (m.op === 'ready') {
    // A new socket: the bridge forgot this device as a source with the old one.
    for (const feed of [...holding.keys()]) releaseFeed(feed)
    for (const fn of views.values()) fn(m)
    return
  }
  if (m.op === 'start' || m.op === 'pull' || m.op === 'stop') return asSource(raw)
  if (typeof m.id === 'string') views.get(m.id)?.(m)
})

export function subscribeCam(id: string, fn: (m: CamMsg) => void): () => void {
  views.set(id, fn)
  return () => {
    if (views.get(id) === fn) views.delete(id)
  }
}

export { sendCam }
