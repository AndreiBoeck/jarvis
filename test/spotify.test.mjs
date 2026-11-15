import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  SPOTIFY_SCOPES,
  challengeOf,
  handleSpotifyRoute,
  registerSpotifyActions,
  simplify,
  spotifyAuth,
  spotifyClient,
} from '../bridge/spotify.mjs'
import { actionRegistry } from '../bridge/actions.mjs'
import { decideTool } from '../bridge/policy.mjs'

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
})

/** A fake Spotify: records every call, answers from `routes`. */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = new URL(url)
    const key = `${init.method ?? 'GET'} ${u.pathname}`
    calls.push({ key, url: u, init, form: init.body && /urlencoded/.test(init.headers?.['content-type'] ?? '') ? Object.fromEntries(new URLSearchParams(init.body)) : null, body: init.body && /json/.test(init.headers?.['content-type'] ?? '') ? JSON.parse(init.body) : null })
    const r = routes[key]
    if (!r) return json(404, { error: { status: 404, message: `no route ${key}` } })
    return typeof r === 'function' ? r(u, init, calls) : r
  }
  fn.calls = calls
  return fn
}

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-spotify-'))
  return { file: join(dir, 'spotify.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('PKCE: the RFC 7636 test vector', () => {
  assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('sign-in: authorize URL, the code exchanged with its verifier, tokens kept private', async () => {
  const { file, done } = tmp()
  try {
    const fetchFn = fakeFetch({ 'POST /api/token': json(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600, scope: 'x' }) })
    const auth = spotifyAuth({ clientId: 'cid', redirectUri: 'http://127.0.0.1:8787/spotify/callback', tokenFile: file, fetchFn })
    const url = new URL(auth.authorizeUrl())
    assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize')
    const q = Object.fromEntries(url.searchParams)
    assert.equal(q.client_id, 'cid')
    assert.equal(q.response_type, 'code')
    assert.equal(q.redirect_uri, 'http://127.0.0.1:8787/spotify/callback')
    assert.equal(q.code_challenge_method, 'S256')
    assert.equal(q.scope, SPOTIFY_SCOPES.join(' '))
    assert.ok(q.state && q.code_challenge)

    await assert.rejects(auth.callback({ code: 'c', state: 'forged' }), /unknown or has expired/)
    await assert.rejects(auth.callback({ error: 'access_denied', state: q.state }), /cancelled/)

    await auth.callback({ code: 'THE-CODE', state: q.state })
    const form = fetchFn.calls.at(-1).form
    assert.equal(form.grant_type, 'authorization_code')
    assert.equal(form.code, 'THE-CODE')
    assert.equal(form.client_id, 'cid')
    assert.equal(form.client_secret, undefined, 'PKCE: no secret')
    assert.equal(challengeOf(form.code_verifier), q.code_challenge, 'the verifier matches the challenge sent')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refresh_token, 'R1')
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(auth.connected(), true)
    await assert.rejects(auth.callback({ code: 'again', state: q.state }), /unknown/, 'a state works once')
  } finally {
    done()
  }
})

test('tokens: reused while fresh, refreshed near expiry, the refresh token kept if not rotated', async () => {
  const { file, done } = tmp()
  try {
    let t = 1_000_000
    writeFileSync(file, JSON.stringify({ access_token: 'OLD', refresh_token: 'R1', expires_at: t + 10 * 60_000 }))
    const fetchFn = fakeFetch({ 'POST /api/token': json(200, { access_token: 'NEW', expires_in: 3600 }) })
    const auth = spotifyAuth({ clientId: 'cid', redirectUri: 'r', tokenFile: file, fetchFn, now: () => t })
    assert.equal(await auth.accessToken(), 'OLD')
    assert.equal(fetchFn.calls.length, 0)
    t += 9.5 * 60_000
    assert.equal(await auth.accessToken(), 'NEW')
    assert.equal(fetchFn.calls[0].form.grant_type, 'refresh_token')
    assert.equal(fetchFn.calls[0].form.refresh_token, 'R1')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refresh_token, 'R1')
  } finally {
    done()
  }
})

test('not signed in: a sentence telling the user what to run', async () => {
  const { file, done } = tmp()
  try {
    const auth = spotifyAuth({ clientId: 'cid', redirectUri: 'r', tokenFile: file, fetchFn: fakeFetch({}) })
    assert.equal(auth.connected(), false)
    await assert.rejects(auth.accessToken(), /npm run spotify:login/)
  } finally {
    done()
  }
})

const signedIn = (routes) => {
  let n = 0
  const auth = { accessToken: async ({ force } = {}) => (force ? `T${++n}` : 'T0'), connected: () => true }
  const fetchFn = fakeFetch(routes)
  return { auth, fetchFn, client: spotifyClient({ auth, fetchFn }) }
}

test('the API client: one retry on 401, Premium and device errors said plainly, 204 is null', async () => {
  let first = true
  const { client, fetchFn } = signedIn({
    'GET /v1/me': () => (first ? ((first = false), json(401, {})) : json(200, { product: 'premium' })),
    'PUT /v1/me/player/play': json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }),
    'POST /v1/me/player/next': json(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }),
    'PUT /v1/me/player/pause': { ok: true, status: 204, text: async () => '' },
  })
  assert.deepEqual(await client.api('GET', '/me'), { product: 'premium' })
  assert.equal(fetchFn.calls[1].init.headers.authorization, 'Bearer T1', 'retried with a fresh token')
  await assert.rejects(client.api('PUT', '/me/player/play'), /needs Spotify Premium/)
  await assert.rejects(client.api('POST', '/me/player/next'), /No Spotify device is active/)
  assert.equal(await client.api('PUT', '/me/player/pause'), null)
})

const TRACK = {
  uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  name: 'Never Gonna Give You Up',
  artists: [{ name: 'Rick Astley' }],
  album: { name: 'Whenever You Need Somebody', images: [{ url: 'https://i.scdn.co/big', width: 640 }, { url: 'https://i.scdn.co/small', width: 64 }] },
  duration_ms: 213000,
}
const DEVICES = { devices: [{ id: 'pc1', name: 'DESKTOP-ISKR520', type: 'Computer', is_active: true, volume_percent: 60 }, { id: 'ph1', name: 'Pixel 9', type: 'Smartphone', is_active: false }] }

function actions(extra = {}) {
  const s = signedIn({
    'GET /v1/search': (u) => json(200, { [`${u.searchParams.get('type')}s`]: { items: u.searchParams.get('type') === 'track' ? [TRACK] : [{ uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', name: 'Top Hits', owner: { display_name: 'Spotify' }, images: [{ url: 'https://i.scdn.co/pl' }] }] } }),
    'GET /v1/me/player/devices': json(200, DEVICES),
    'PUT /v1/me/player/play': { ok: true, status: 204, text: async () => '' },
    'POST /v1/me/player/queue': { ok: true, status: 204, text: async () => '' },
    'PUT /v1/me/player': { ok: true, status: 204, text: async () => '' },
    'GET /v1/me/player': json(200, { is_playing: true, progress_ms: 5000, device: { name: 'DESKTOP-ISKR520' }, item: TRACK }),
    ...extra,
  })
  const arts = []
  const reg = registerSpotifyActions(actionRegistry(), { auth: s.auth, client: s.client }, z, {
    fetchArt: async (url) => (arts.push(url), url ? `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}` : null),
  })
  return { reg, fetchFn: s.fetchFn, arts }
}

test('play: a query searches and plays the top track, on a device chosen by name', async () => {
  const { reg, fetchFn } = actions()
  const r = await reg.get('spotify.play').run({ query: 'never gonna give you up', device: 'pixel' })
  assert.equal(r.playing.uri, TRACK.uri)
  const play = fetchFn.calls.find((c) => c.key === 'PUT /v1/me/player/play')
  assert.deepEqual(play.body, { uris: [TRACK.uri] })
  assert.equal(play.url.searchParams.get('device_id'), 'ph1')
})

test('play: albums and playlists as a context, bad URIs and unknown devices refused', async () => {
  const { reg, fetchFn } = actions()
  await reg.get('spotify.play').run({ uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' })
  assert.deepEqual(fetchFn.calls.at(-1).body, { context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' })
  await reg.get('spotify.play').run({})
  assert.equal(fetchFn.calls.at(-1).body, null, 'nothing = resume')
  await assert.rejects(reg.get('spotify.play').run({ uri: 'https://evil.example/x' }), /spotify: URI/)
  await assert.rejects(reg.get('spotify.play').run({ uri: TRACK.uri, device: 'toaster' }), /No Spotify device called "toaster". Open: DESKTOP-ISKR520, Pixel 9/)
  await assert.rejects(reg.get('spotify.queue').run({ uri: 'spotify:album:1234567890abcdef' }), /Queue takes a track/)
})

test('search: the model gets URLs, a screen gets data: images', async () => {
  const { reg, arts } = actions()
  const forModel = await reg.get('spotify.search').run({ query: 'rick' })
  assert.deepEqual(forModel[0], { type: 'track', uri: TRACK.uri, name: TRACK.name, artists: 'Rick Astley', album: 'Whenever You Need Somebody', image: 'https://i.scdn.co/small' })
  const forScreen = await reg.get('spotify.search').run({ query: 'rick' }, { from: 'screen' })
  assert.match(forScreen[0].image, /^data:image\/jpeg;base64,/)
  assert.deepEqual(arts, ['https://i.scdn.co/small'])
  const pl = await reg.get('spotify.search').run({ query: 'top', type: 'playlist' })
  assert.equal(pl[0].owner, 'Spotify')
  assert.deepEqual(simplify(null), null)
})

test('now playing, devices and transfer', async () => {
  const { reg, fetchFn } = actions()
  const np = await reg.get('spotify.now_playing').run({})
  assert.deepEqual([np.title, np.artists, np.isPlaying, np.progress, np.duration, np.device], [TRACK.name, 'Rick Astley', true, 5, 213, 'DESKTOP-ISKR520'])
  assert.equal((await reg.get('spotify.devices').run({})).length, 2)
  await reg.get('spotify.transfer').run({ device: 'desktop' })
  assert.deepEqual(fetchFn.calls.at(-1).body, { device_ids: ['pc1'], play: true })
  for (const [said, id] of [['my phone', 'ph1'], ['celular', 'ph1'], ['the PC', 'pc1'], ['computador', 'pc1'], ['pixel', 'ph1']]) {
    await reg.get('spotify.transfer').run({ device: said.replace(/^the /, '') })
    assert.deepEqual(fetchFn.calls.at(-1).body.device_ids, [id], said)
  }
})

test('policy: every Spotify action runs without writes, and only registered ones exist', () => {
  const { reg } = actions()
  for (const a of reg.list()) assert.equal(decideTool(`mcp__jarvis_spotify__${a.name.split('.')[1]}`), true, a.name)
  assert.equal(decideTool('mcp__jarvis_spotify__delete_playlist', true), false)
})

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' }
  res.writeHead = (s, h = {}) => ((res.status = s), (res.headers = h))
  res.end = (b = '') => (res.body += b)
  return res
}

test('routes: status, login redirects to Spotify, the callback finishes the sign-in', async () => {
  const { file, done } = tmp()
  try {
    const auth = spotifyAuth({
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:8787/spotify/callback',
      tokenFile: file,
      fetchFn: fakeFetch({ 'POST /api/token': json(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 }) }),
    })
    let res = fakeRes()
    assert.equal(await handleSpotifyRoute({ method: 'GET', url: '/spotify/status' }, res, auth), true)
    assert.deepEqual(JSON.parse(res.body), { configured: true, connected: false })

    res = fakeRes()
    await handleSpotifyRoute({ method: 'GET', url: '/spotify/login' }, res, auth)
    assert.equal(res.status, 302)
    const state = new URL(res.headers.location).searchParams.get('state')

    res = fakeRes()
    await handleSpotifyRoute({ method: 'GET', url: `/spotify/callback?code=C&state=${state}` }, res, auth)
    assert.equal(res.status, 200)
    assert.match(res.body, /Spotify conectado/)
    assert.equal(auth.connected(), true)

    res = fakeRes()
    await handleSpotifyRoute({ method: 'GET', url: '/spotify/callback?code=C&state=<script>' }, res, auth)
    assert.equal(res.status, 400)
    assert.doesNotMatch(res.body, /<script>/)

    res = fakeRes()
    await handleSpotifyRoute({ method: 'GET', url: '/spotify/login' }, res, null)
    assert.equal(res.status, 404)
    assert.match(res.body, /SPOTIFY_CLIENT_ID/)
    assert.equal(await handleSpotifyRoute({ method: 'GET', url: '/other' }, fakeRes(), auth), false)
  } finally {
    done()
  }
})
