/**
 * Maps and routes on a blade.
 *
 * Google Maps is a JavaScript application: its HTML is an empty shell that
 * draws everything with its own scripts. The article blade fetches pages on the
 * bridge and serves them with every script removed — which is exactly what
 * makes articles safe to frame, and exactly why "route to PUCRS" opened onto a
 * blank blade. So a map is not an article. It gets its own blade kind, framed
 * from Google's embed endpoint, which is built to be put in an iframe and runs
 * on Google's origin, not ours.
 *
 * Two forms:
 *   - keyless (default): maps.google.com/maps?…&output=embed — directions with
 *     saddr/daddr, or a single place with q.
 *   - the official Embed API, when JARVIS_MAPS_EMBED_KEY is set:
 *     www.google.com/maps/embed/v1/{directions|place}?key=…
 *
 * Pure: no I/O, so the tests can call it directly.
 */

export const TRAVEL = ['driving', 'walking', 'transit', 'bicycling']

/** The keyless form's travel flag. Driving is the default and has none. */
const DIRFLG = { walking: 'w', transit: 'r', bicycling: 'b' }

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

/**
 * The embed URL for a place, or a route to it.
 *
 * @param {{destination: string, origin?: string, travel?: string}} where
 * @param {{key?: string, home?: string}} [opts]  home: where a route starts
 *        when no origin was given (JARVIS_LOCATION).
 * @returns {{url: string, route: boolean, origin: string}}
 */
export function mapEmbed(where, { key = '', home = '' } = {}) {
  const destination = clean(where.destination)
  if (!destination) throw new Error('a map needs a destination')
  const origin = clean(where.origin) || clean(home)
  const travel = TRAVEL.includes(where.travel) ? where.travel : 'driving'

  if (key) {
    const p = new URLSearchParams({ key })
    if (origin) {
      p.set('origin', origin)
      p.set('destination', destination)
      p.set('mode', travel)
      return { url: `https://www.google.com/maps/embed/v1/directions?${p}`, route: true, origin }
    }
    p.set('q', destination)
    return { url: `https://www.google.com/maps/embed/v1/place?${p}`, route: false, origin: '' }
  }

  const p = new URLSearchParams()
  if (origin) {
    p.set('saddr', origin)
    p.set('daddr', destination)
    if (DIRFLG[travel]) p.set('dirflg', DIRFLG[travel])
  } else {
    p.set('q', destination)
  }
  p.set('output', 'embed')
  return { url: `https://maps.google.com/maps?${p}`, route: Boolean(origin), origin }
}

const decodeSegment = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s.replace(/\+/g, ' ')
  }
}

const TRAVEL_FROM_PARAM = {
  driving: 'driving',
  walking: 'walking',
  transit: 'transit',
  bicycling: 'bicycling',
  w: 'walking',
  r: 'transit',
  b: 'bicycling',
  d: 'driving',
}

/**
 * Read a Google Maps link — the kind a search or the browser hands back — into
 * a place or a route. null when it is not a Maps link; `{ short: true }` for a
 * shortened maps.app.goo.gl link, which cannot be read without following it.
 */
export function mapFromUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === 'maps.app.goo.gl' || (host === 'goo.gl' && url.pathname.startsWith('/maps'))) {
    return { short: true }
  }
  const google = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)
  if (!google) return null
  const mapsHost = host.startsWith('maps.')
  if (!mapsHost && !/^\/maps(\/|$)/.test(url.pathname)) return null

  const q = url.searchParams
  const travel =
    TRAVEL_FROM_PARAM[q.get('travelmode') ?? ''] ?? TRAVEL_FROM_PARAM[q.get('dirflg') ?? ''] ?? undefined

  const destination = q.get('destination') ?? q.get('daddr')
  if (destination) {
    return {
      destination: clean(destination),
      origin: clean(q.get('origin') ?? q.get('saddr') ?? '') || undefined,
      travel,
    }
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const at = parts.indexOf('maps')
  const after = at >= 0 ? parts.slice(at + 1) : parts
  const verb = after[0]
  const args = after
    .slice(1)
    .filter((s) => !s.startsWith('@') && !s.startsWith('data='))
    .map(decodeSegment)
    .map(clean)

  if (verb === 'dir') {
    const stops = args.filter(Boolean)
    if (!stops.length) return null
    // A blank first stop means "from where I am": no origin, the home one is used.
    const blankStart = /\/dir\/\//.test(url.pathname)
    if (stops.length === 1) return { destination: stops[0], travel }
    return {
      destination: stops[stops.length - 1],
      origin: blankStart ? undefined : stops[0],
      travel,
    }
  }
  if ((verb === 'place' || verb === 'search') && args[0]) {
    return { destination: args[0] }
  }
  const query = q.get('q') ?? q.get('query')
  if (query) return { destination: clean(query) }
  return null
}

/**
 * Only these may be framed as a map. The interface checks the same thing again
 * before it puts the iframe up; the bridge never emits anything else.
 */
export function isMapEmbed(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'maps.google.com' && url.pathname === '/maps') {
    return url.searchParams.get('output') === 'embed'
  }
  return url.hostname === 'www.google.com' && /^\/maps\/embed\/v1\/(directions|place)$/.test(url.pathname)
}
