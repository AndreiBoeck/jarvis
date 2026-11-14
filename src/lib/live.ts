import { sendLive, watchLive } from './bridge'

/**
 * The live browser's messages, sorted by blade.
 *
 * The bridge sends every live message down the one socket; each blade only
 * wants its own. `ready` (a fresh connection) goes to every blade, because a
 * reconnected socket is a new owner as far as the bridge is concerned and each
 * open blade has to claim its tab again.
 */
export type LiveMsg = {
  op: string
  id?: string
  data?: string
  w?: number
  h?: number
  url?: string
  title?: string
  canBack?: boolean
  canForward?: boolean
  loading?: boolean
  message?: string
}

const views = new Map<string, (m: LiveMsg) => void>()

watchLive((raw) => {
  const m = raw as unknown as LiveMsg
  if (m.op === 'ready') {
    for (const fn of views.values()) fn(m)
    return
  }
  if (typeof m.id === 'string') views.get(m.id)?.(m)
})

export function subscribeLive(id: string, fn: (m: LiveMsg) => void): () => void {
  views.set(id, fn)
  return () => {
    if (views.get(id) === fn) views.delete(id)
  }
}

export { sendLive }
