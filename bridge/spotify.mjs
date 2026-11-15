import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The user's Spotify, through the Spotify Web API.
 *
 * What the System Media Transport Controls (media.mjs) cannot do: search,
 * start a particular song, album or playlist, pick the device through Spotify
 * Connect (the PC, the phone, a speaker), queue. Playback control needs a
 * Premium account; search works on any.
 *
 * Sign-in is OAuth's authorization code flow with PKCE, so there is no client
 * secret anywhere — only the app's Client ID, from developer.spotify.com, in
 * SPOTIFY_CLIENT_ID. The redirect lands on the bridge itself:
 *
 *   http://127.0.0.1:8787/spotify/callback
 *
 * (Spotify accepts http only for a loopback IP literal, and no longer accepts
 * "localhost".) `npm run spotify:login` opens that flow in the browser. The
 * refresh token is kept in ~/.jarvis/spotify.json, readable by the user only,
 * and the access token is renewed from it as it expires.
 */

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-private',
  'playlist-read-private',
  'user-library-read',
]

const ACCOUNTS = () => (process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com').replace(/\/+$/, '')
const API = () => (process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1').replace(/\/+$/, '')

export const defaultTokenFile = () => process.env.SPOTIFY_TOKEN_FILE || join(homedir(), '.jarvis', 'spotify.json')
export const defaultRedirect = (port = 8787) => `http://127.0.0.1:${port}/spotify/callback`

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** RFC 7636: the challenge is base64url(sha256(verifier)). */
export const challengeOf = (verifier) => b64url(createHash('sha256').update(verifier).digest())

export function pkcePair() {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: challengeOf(verifier) }
}

export class SpotifyError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

/**
 * Sign-in and tokens.
 * @param {object} o
 * @param {string} o.clientId
 * @param {string} o.redirectUri
 */
export function spotifyAuth({
  clientId,
  redirectUri,
  tokenFile = defaultTokenFile(),
  fetchFn = fetch,
  now = Date.now,
}) {
  const pending = new Map() // state -> { verifier, at }

  const load = () => {
    try {
      return JSON.parse(readFileSync(tokenFile, 'utf8'))
    } catch {
      return null
    }
  }
  const save = (tokens) => {
    mkdirSync(dirname(tokenFile), { recursive: true })
    const tmp = `${tokenFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(tokens, null, 1), { mode: 0o600 })
    renameSync(tmp, tokenFile)
    try {
      chmodSync(tokenFile, 0o600)
    } catch {
      /* Windows: the home folder is the user's own */
    }
  }

  const tokenRequest = async (form) => {
    const res = await fetchFn(`${ACCOUNTS()}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new SpotifyError(`Spotify refused the sign-in: ${body.error_description || body.error || res.status}`, {
        status: res.status,
        reason: body.error || '',
      })
    }
    return body
  }

  const store = (body, previous = null) => {
    const tokens = {
      access_token: body.access_token,
      // Spotify may or may not rotate the refresh token; keep the old one if not.
      refresh_token: body.refresh_token || previous?.refresh_token,
      expires_at: now() + (Number(body.expires_in) || 3600) * 1000,
      scope: body.scope || previous?.scope || '',
    }
    save(tokens)
    return tokens
  }

  let refreshing = null

  return {
    configured: Boolean(clientId),
    redirectUri,
    tokenFile,

    /** The page to send the browser to. Each call is a fresh state + verifier. */
    authorizeUrl() {
      if (!clientId) throw new SpotifyError('SPOTIFY_CLIENT_ID is not set')
      for (const [s, p] of pending) if (now() - p.at > 10 * 60_000) pending.delete(s)
      const state = b64url(randomBytes(16))
      const { verifier, challenge } = pkcePair()
      pending.set(state, { verifier, at: now() })
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: SPOTIFY_SCOPES.join(' '),
        redirect_uri: redirectUri,
        state,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      })
      return `${ACCOUNTS()}/authorize?${q}`
    },

    /** The redirect back. Refuses an unknown or reused state. */
    async callback({ code, state, error }) {
      if (error) throw new SpotifyError(`Spotify sign-in was cancelled (${error})`)
      const p = pending.get(String(state ?? ''))
      if (!p) throw new SpotifyError('This sign-in link is unknown or has expired; start again.')
      pending.delete(String(state))
      if (!code) throw new SpotifyError('Spotify sent no code.')
      const body = await tokenRequest({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
        code_verifier: p.verifier,
      })
      return store(body)
    },

    connected: () => Boolean(load()?.refresh_token),

    /** A valid access token, renewed when within a minute of expiring. */
    async accessToken({ force = false } = {}) {
      const tokens = load()
      if (!tokens?.refresh_token) {
        throw new SpotifyError('Spotify is not connected yet: run npm run spotify:login on the PC.', { status: 401 })
      }
      if (!force && tokens.access_token && tokens.expires_at - now() > 60_000) return tokens.access_token
      refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
        .then((body) => store(body, tokens).access_token)
        .finally(() => {
          refreshing = null
        })
      return refreshing
    },
  }
}

/** Spotify's error, in a sentence the model can say. */
function explain(status, body) {
  const reason = body?.error?.reason || ''
  const msg = body?.error?.message || ''
  if (status === 401) return 'Spotify is not connected (the sign-in expired): run npm run spotify:login on the PC.'
  if (status === 403 && (reason === 'PREMIUM_REQUIRED' || /premium/i.test(msg))) return 'That needs Spotify Premium.'
  if (status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /device/i.test(msg))) {
    return 'No Spotify device is active: open Spotify on the PC or phone, or name a device.'
  }
  if (status === 429) return 'Spotify is rate limiting; try again in a moment.'
  return `Spotify said ${status}${msg ? `: ${msg}` : ''}`
}

export function spotifyClient({ auth, fetchFn = fetch }) {
  async function api(method, path, { query, body } = {}) {
    const url = `${API()}${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))}` : ''}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.accessToken({ force: attempt > 0 })
      const res = await fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (res.status === 401 && attempt === 0) continue // a token revoked early: renew once
      if (res.status === 204 || res.status === 202) return null
      const text = await res.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      if (!res.ok) {
        throw new SpotifyError(explain(res.status, parsed), { status: res.status, reason: parsed?.error?.reason || '' })
      }
      return parsed
    }
    throw new SpotifyError(explain(401))
  }
  return { api }
}

const smallest = (images) => {
  const list = Array.isArray(images) ? images.filter((i) => i?.url) : []
  if (!list.length) return null
  return [...list].sort((a, b) => (a.width ?? 999) - (b.width ?? 999))[0].url
}
const largest = (images) => (Array.isArray(images) && images[0]?.url) || null

/** One search hit, in the few fields anyone needs. */
export function simplify(item, type) {
  if (!item) return null
  const artists = (item.artists ?? []).map((a) => a.name).join(', ')
  const images = item.album?.images ?? item.images
  return {
    type,
    uri: item.uri,
    name: item.name,
    ...(artists ? { artists } : {}),
    ...(item.album?.name ? { album: item.album.name } : {}),
    ...(type === 'playlist' && item.owner?.display_name ? { owner: item.owner.display_name } : {}),
    image: smallest(images),
  }
}

const DEVICE_KINDS = [
  [/^(phone|cell|mobile|celular|telefone|smartphone)/, 'smartphone'],
  [/^(pc|computer|computador|desktop|laptop|notebook|mac)/, 'computer'],
  [/^(speaker|caixa|alexa|echo)/, 'speaker'],
  [/^(tv|televis)/, 'tv'],
]

const URI = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{10,40}$/

/**
 * The Spotify actions. `fetchArt` turns a cover URL into a data: URL for a
 * screen (which can load nothing else); the model gets the URLs as they are.
 */
export function registerSpotifyActions(registry, spotify, z, { fetchArt = async () => null } = {}) {
  const { api } = spotify.client
  const type = z.enum(['track', 'album', 'playlist', 'artist']).optional().catch(undefined)
  const device = z.string().max(80).optional().catch(undefined).describe('A device by name ("desktop", "iPhone") or id. Leave out for the active one.')

  const devices = async () => ((await api('GET', '/me/player/devices'))?.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    active: Boolean(d.is_active),
    volume: d.volume_percent ?? null,
  }))
  const deviceId = async (name) => {
    if (!name) return undefined
    const list = await devices()
    const want = name.toLowerCase().replace(/^(my|meu|minha|o|a)\s+/, '').trim()
    // "phone", "pc", "speaker" — what people call a device, by its type.
    const kind = DEVICE_KINDS.find(([re]) => re.test(want))?.[1]
    const hit =
      list.find((d) => d.id === name) ??
      list.find((d) => d.name.toLowerCase() === want) ??
      list.find((d) => d.name.toLowerCase().includes(want)) ??
      list.find((d) => d.type.toLowerCase() === want || (kind && d.type.toLowerCase() === kind))
    if (!hit) {
      throw new SpotifyError(`No Spotify device called "${name}". Open: ${list.map((d) => d.name).join(', ') || 'none'}.`)
    }
    return hit.id
  }
  const search = async (query, kind = 'track', limit = 5) => {
    const r = await api('GET', '/search', { query: { q: query, type: kind, limit } })
    return (r?.[`${kind}s`]?.items ?? []).filter(Boolean).map((i) => simplify(i, kind))
  }
  const withArt = async (items, ctx) =>
    ctx?.from === 'screen' ? Promise.all(items.map(async (i) => ({ ...i, image: await fetchArt(i.image) }))) : items

  registry.register('spotify.status', {
    label: 'Ver a conta do Spotify',
    description: 'Whether Spotify is connected, and the account (Premium or not).',
    run: async () => {
      if (!spotify.auth.connected()) return { connected: false, how: 'Run npm run spotify:login on the PC.' }
      const me = await api('GET', '/me')
      return { connected: true, name: me?.display_name ?? null, product: me?.product ?? null }
    },
  })
  registry.register('spotify.search', {
    label: 'Buscar no Spotify',
    description: 'Search Spotify for tracks, albums, playlists or artists. Returns their spotify: URIs for play and queue.',
    shape: {
      query: z.string().min(1).max(200),
      type,
      limit: z.number().int().min(1).max(10).optional().catch(undefined),
    },
    run: async ({ query, type: kind, limit }, ctx) => withArt(await search(query, kind ?? 'track', limit ?? 5), ctx),
  })
  registry.register('spotify.play', {
    label: 'Tocar no Spotify',
    description:
      'Play on Spotify (Premium): a `uri` from search (track, album, playlist, artist), or a `query` to search and play the top track; nothing to resume. `device` picks where.',
    shape: {
      uri: z.string().max(80).optional().catch(undefined),
      query: z.string().max(200).optional().catch(undefined),
      type,
      device,
    },
    run: async ({ uri, query, type: kind, device: dev }) => {
      let target = uri
      let picked = null
      if (!target && query) {
        picked = (await search(query, kind ?? 'track', 1))[0]
        if (!picked) throw new SpotifyError(`Nothing on Spotify for "${query}".`)
        target = picked.uri
      }
      if (target && !URI.test(target)) throw new SpotifyError('That is not a spotify: URI.')
      const body = !target ? undefined : /^spotify:(track|episode):/.test(target) ? { uris: [target] } : { context_uri: target }
      await api('PUT', '/me/player/play', { query: { device_id: await deviceId(dev) }, body })
      return { playing: picked ?? (target ? { uri: target } : 'resumed') }
    },
  })
  for (const [op, method, path, label, description] of [
    ['pause', 'PUT', '/me/player/pause', 'Pausar o Spotify', 'Pause Spotify, on whichever device is playing.'],
    ['next', 'POST', '/me/player/next', 'Próxima no Spotify', 'Skip to the next track on Spotify.'],
    ['previous', 'POST', '/me/player/previous', 'Anterior no Spotify', 'Back to the previous track on Spotify.'],
  ]) {
    registry.register(`spotify.${op}`, {
      label,
      description,
      shape: { device },
      run: async ({ device: dev }) => {
        await api(method, path, { query: { device_id: await deviceId(dev) } })
        return { done: op }
      },
    })
  }
  registry.register('spotify.now_playing', {
    label: 'Ver o que toca no Spotify',
    description: 'What Spotify is playing, on which device, and whether it is playing.',
    run: async (_args, ctx) => {
      const p = await api('GET', '/me/player')
      if (!p?.item) return { playing: null, device: p?.device?.name ?? null }
      const t = p.item
      const image = largest(t.album?.images)
      return {
        title: t.name,
        artists: (t.artists ?? []).map((a) => a.name).join(', '),
        album: t.album?.name ?? '',
        uri: t.uri,
        isPlaying: Boolean(p.is_playing),
        progress: Math.round((p.progress_ms ?? 0) / 1000),
        duration: Math.round((t.duration_ms ?? 0) / 1000),
        device: p.device?.name ?? null,
        image: ctx?.from === 'screen' ? await fetchArt(smallest(t.album?.images)) : image,
      }
    },
  })
  registry.register('spotify.devices', {
    label: 'Ver os aparelhos do Spotify',
    description: 'The devices Spotify Connect can play on right now.',
    run: () => devices(),
  })
  registry.register('spotify.transfer', {
    label: 'Mudar o aparelho do Spotify',
    description: 'Move Spotify playback to another device (Premium), by name or id.',
    shape: { device: z.string().min(1).max(80), play: z.boolean().optional().catch(undefined) },
    run: async ({ device: dev, play }) => {
      const id = await deviceId(dev)
      await api('PUT', '/me/player', { body: { device_ids: [id], play: play ?? true } })
      return { moved: dev }
    },
  })
  registry.register('spotify.queue', {
    label: 'Pôr na fila do Spotify',
    description: 'Add a track to the Spotify queue (Premium): a track `uri`, or a `query` for the top hit.',
    shape: { uri: z.string().max(80).optional().catch(undefined), query: z.string().max(200).optional().catch(undefined), device },
    run: async ({ uri, query, device: dev }) => {
      let target = uri
      let picked = null
      if (!target && query) {
        picked = (await search(query, 'track', 1))[0]
        if (!picked) throw new SpotifyError(`Nothing on Spotify for "${query}".`)
        target = picked.uri
      }
      if (!target || !/^spotify:(track|episode):/.test(target)) throw new SpotifyError('Queue takes a track.')
      await api('POST', '/me/player/queue', { query: { uri: target, device_id: await deviceId(dev) } })
      return { queued: picked ?? { uri: target } }
    },
  })
  registry.register('spotify.playlists', {
    label: 'Ver as playlists',
    description: "The user's own and followed playlists, with their URIs.",
    shape: { limit: z.number().int().min(1).max(50).optional().catch(undefined) },
    run: async ({ limit }, ctx) => {
      const r = await api('GET', '/me/playlists', { query: { limit: limit ?? 20 } })
      return withArt((r?.items ?? []).filter(Boolean).map((i) => simplify(i, 'playlist')), ctx)
    },
  })
  registry.register('spotify.volume', {
    label: 'Volume do Spotify',
    description: "Set the volume of the device Spotify is playing on, 0–100 (Premium).",
    shape: { level: z.number().min(0).max(100), device },
    run: async ({ level, device: dev }) => {
      await api('PUT', '/me/player/volume', { query: { volume_percent: Math.round(level), device_id: await deviceId(dev) } })
      return { level: Math.round(level) }
    },
  })
  return registry
}

/** Everything the bridge needs, or null when no Client ID is configured. */
export function spotifyFromEnv({ port = 8787, env = process.env, fetchFn = fetch } = {}) {
  const clientId = env.SPOTIFY_CLIENT_ID?.trim()
  if (!clientId) return null
  const auth = spotifyAuth({
    clientId,
    redirectUri: env.SPOTIFY_REDIRECT_URI?.trim() || defaultRedirect(port),
    fetchFn,
  })
  return { auth, client: spotifyClient({ auth, fetchFn }) }
}

const PAGE = (title, line) =>
  `<!doctype html><meta charset="utf-8"><title>JARVIS · Spotify</title><style>
   body{margin:0;min-height:100vh;display:grid;place-items:center;background:#03090c;color:#7fe8ff;
        font:400 14px/1.6 ui-monospace,Menlo,Consolas,monospace}
   div{max-width:460px;padding:28px;border:1px solid rgba(127,232,255,.3)}
   b{display:block;color:#dff9ff;font-weight:500;margin-bottom:6px}
 </style><div><b>${title}</b>${String(line).replace(/[<&]/g, '')}</div>`

/**
 * The two sign-in routes, for the bridge and for the standalone login script
 * alike. Returns true when it answered the request.
 */
export async function handleSpotifyRoute(req, res, auth) {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method !== 'GET' || !url.pathname.startsWith('/spotify/')) return false
  const page = (status, title, line) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(PAGE(title, line))
  }
  if (url.pathname === '/spotify/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ configured: Boolean(auth?.configured), connected: Boolean(auth?.connected()) }))
    return true
  }
  if (!auth) {
    page(404, 'Spotify não configurado.', 'Defina SPOTIFY_CLIENT_ID no .env.local da bridge e reinicie.')
    return true
  }
  if (url.pathname === '/spotify/login') {
    res.writeHead(302, { location: auth.authorizeUrl(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end()
    return true
  }
  if (url.pathname === '/spotify/callback') {
    try {
      await auth.callback(Object.fromEntries(url.searchParams))
      page(200, 'Spotify conectado.', 'O JARVIS já pode buscar e tocar. Pode fechar esta aba.')
    } catch (err) {
      page(400, 'Não deu para conectar o Spotify.', err?.message ?? String(err))
    }
    return true
  }
  return false
}
