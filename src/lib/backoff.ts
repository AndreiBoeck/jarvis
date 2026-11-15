/**
 * When the interface dials the bridge again after losing it.
 *
 * Pure on purpose — no imports — so the tests can read it under plain Node.
 */

export const RECONNECT_MIN_MS = 500
export const RECONNECT_MAX_MS = 10_000

/** Doubling from half a second, capped at ten: 0.5, 1, 2, 4, 8, 10, 10, … */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(n, 16))
}

/**
 * Whether to keep trying. Not after the interface closed the socket itself,
 * not when the bridge closed it on purpose (4000–4999 are its own codes), and
 * not when the bridge has said this device's token is no good — an unpaired
 * phone dialling every ten seconds forever helps nobody.
 */
export function shouldReconnect({
  intentional = false,
  closeCode = 1006,
  unauthorized = false,
}: {
  intentional?: boolean
  closeCode?: number
  unauthorized?: boolean
}): boolean {
  if (intentional || unauthorized) return false
  return !(closeCode >= 4000 && closeCode < 5000)
}
