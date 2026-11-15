import { sendScreen, watchScreenConfirm, watchScreenMsgs } from './bridge'

/**
 * The interface's half of the screen action channel (bridge/actions.mjs).
 *
 * A saved app screen runs in a sandboxed iframe with an opaque origin and no
 * network. When it calls JARVIS.action(name, args) the request arrives here by
 * postMessage — from ScreenView, which has already checked it came from its
 * own iframe and attaches the screen id from the blade, never from the
 * message. This file carries it over the socket and the answer back.
 */

export type ActionAnswer = { ok: boolean; result?: unknown; error?: string; code?: string }

export type ConfirmRequest = {
  screen: string
  title: string
  action: string
  label: string
  args: Record<string, unknown>
}

const pending = new Map<string, (a: ActionAnswer) => void>()
const approvals = new Map<string, (ok: boolean) => void>()
const confirmers = new Map<string, (req: ConfirmRequest) => Promise<boolean>>()
let seq = 0

watchScreenMsgs((m) => {
  if (m.type === 'screen_action' && typeof m.reqId === 'string') {
    const done = pending.get(m.reqId)
    if (!done) return
    pending.delete(m.reqId)
    done({
      ok: m.ok === true,
      result: m.result,
      error: typeof m.error === 'string' ? m.error : undefined,
      code: typeof m.code === 'string' ? m.code : undefined,
    })
  } else if (m.type === 'screen_approved' && typeof m.screen === 'string') {
    const key = `${m.screen}:${m.hash}`
    approvals.get(key)?.(m.ok === true)
    approvals.delete(key)
  }
})

// A confirmation goes to the blade showing that screen; with none, it is no.
watchScreenConfirm((raw) => {
  const req: ConfirmRequest = {
    screen: String(raw.screen ?? ''),
    title: String(raw.title ?? ''),
    action: String(raw.action ?? ''),
    label: String(raw.label ?? ''),
    args: raw.args && typeof raw.args === 'object' ? (raw.args as Record<string, unknown>) : {},
  }
  const ask = confirmers.get(req.screen)
  return ask ? ask(req) : Promise.resolve(false)
})

/** Ask the bridge to run an action for a screen. Always resolves. */
export function screenAction(screen: string, name: string, args: unknown): Promise<ActionAnswer> {
  const reqId = `sa${Date.now().toString(36)}-${++seq}`
  return new Promise((resolve) => {
    // Longer than the bridge's own 90s wait on a confirmation card.
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve({ ok: false, code: 'timeout', error: 'The bridge did not answer.' })
    }, 120_000)
    pending.set(reqId, (a) => {
      clearTimeout(timer)
      resolve(a)
    })
    const sent = sendScreen({
      type: 'screen_action',
      reqId,
      screen,
      name,
      args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    })
    if (!sent) {
      pending.delete(reqId)
      clearTimeout(timer)
      resolve({ ok: false, code: 'offline', error: 'The bridge is not connected.' })
    }
  })
}

/** The user's click on an approval card: true once the bridge has recorded it. */
export function approveScreen(screen: string, hash: string): Promise<boolean> {
  return new Promise((resolve) => {
    const key = `${screen}:${hash}`
    const timer = setTimeout(() => {
      approvals.delete(key)
      resolve(false)
    }, 10_000)
    approvals.set(key, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    if (!sendScreen({ type: 'screen_approve', screen, hash })) {
      approvals.delete(key)
      clearTimeout(timer)
      resolve(false)
    }
  })
}

export function subscribeConfirm(screen: string, fn: (req: ConfirmRequest) => Promise<boolean>): () => void {
  confirmers.set(screen, fn)
  return () => {
    if (confirmers.get(screen) === fn) confirmers.delete(screen)
  }
}

/** A confirmation's arguments in a few words, for the card. */
export function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
    .slice(0, 200)
}
