/**
 * Turning what a hand does on the live browser blade into what the page
 * should receive.
 *
 * Pure on purpose — no imports — so the tests can read it under plain Node.
 */

export type Rect = { left: number; top: number; width: number; height: number }

/**
 * A point on the blade as a point in the page.
 *
 * The frame is drawn with object-fit: contain, so between a resize and the next
 * frame it can be letterboxed inside the surface. Mapping through the frame's
 * own size — not the surface's — is what keeps a click on the button it was
 * aimed at. Null for a point in the letterbox.
 */
export function toPage(
  clientX: number,
  clientY: number,
  rect: Rect,
  frameW: number,
  frameH: number,
): { x: number; y: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null
  const fw = frameW > 0 ? frameW : rect.width
  const fh = frameH > 0 ? frameH : rect.height
  const scale = Math.min(rect.width / fw, rect.height / fh)
  const offX = (rect.width - fw * scale) / 2
  const offY = (rect.height - fh * scale) / 2
  const x = (clientX - rect.left - offX) / scale
  const y = (clientY - rect.top - offY) / scale
  if (x < 0 || y < 0 || x > fw || y > fh) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** DevTools modifier bits: alt 1, ctrl 2, meta 4, shift 8. */
export function modsOf(e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** A wheel delta in pixels, whatever unit the device reported it in. */
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 40 // lines
  if (deltaMode === 2) return delta * 800 // pages
  return delta
}

/** How far a finger may travel and still be a tap rather than a drag. */
export const TAP_SLOP_PX = 8

/**
 * A touch, once it has ended or moved: a tap (a click where it started) or a
 * drag (the page scrolls with the finger, as on any phone).
 */
export function touchKind(dx: number, dy: number): 'tap' | 'drag' {
  return Math.hypot(dx, dy) > TAP_SLOP_PX ? 'drag' : 'tap'
}

/** What a typed address should open: a URL as given, a bare domain over https, otherwise a search. */
export function addressToUrl(typed: string): string {
  const t = typed.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  if (/^[^\s/]+\.[^\s]{2,}$/.test(t)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}
