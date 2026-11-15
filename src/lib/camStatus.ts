/**
 * Small, pure helpers for the camera blades and banner — no imports, so the
 * tests can load this under plain Node.
 */

/** Whole minutes left on the bridge's own capture, rounded up; null if unknown. */
export function minutesLeft(until: number | undefined, now: number): number | null {
  if (!until || !Number.isFinite(until)) return null
  return Math.max(0, Math.ceil((until - now) / 60_000))
}

/** The source's banner: "PHONE (PIXEL) AND MAC", or null when nobody watches. */
export function watchersText(camOut: Record<string, string[]>): string | null {
  const all = [...new Set(Object.values(camOut).flat())]
  if (!all.length) return null
  const names = all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0]
  return names.toUpperCase()
}
