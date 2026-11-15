import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MAC_SCRIPT,
  PowerShellHost,
  appName,
  hostPlatform,
  hostScriptText,
  mediaHost,
  parsePlayerctl,
  registerMediaActions,
  toTrack,
  trackForModel,
  trackForScreen,
} from '../bridge/media.mjs'
import { actionRegistry } from '../bridge/actions.mjs'

/** A stand-in for powershell.exe: answers each JSON line with `reply(req)`. */
function fakeSpawn(reply, seen = []) {
  return (cmd, args) => {
    seen.push({ cmd, args })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => child.emit('exit', null)
    let buf = ''
    child.stdin.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        const out = reply(req)
        if (out === undefined) continue // never answers
        // Split across chunks on purpose: the reader must reassemble lines.
        const line = JSON.stringify({ id: req.id, ...out }) + '\n'
        child.stdout.write(line.slice(0, 7))
        setImmediate(() => child.stdout.write(line.slice(7)))
      }
    })
    return child
  }
}

const SPOTIFY = {
  appId: 'Spotify.exe',
  title: 'Até Que Durou',
  artist: 'Péricles',
  album: 'Feito Pra Durar',
  status: 'playing',
  position: 61.4,
  duration: 215,
  artKey: 'Spotify.exe|Até Que Durou|Péricles|Feito Pra Durar',
  art: 'data:image/png;base64,iVBORw0KGgo=',
}

test('platforms: native Windows, WSL, Mac, Linux', () => {
  assert.equal(hostPlatform('win32', {}), 'windows')
  assert.equal(hostPlatform('darwin', {}), 'mac')
  assert.equal(hostPlatform('linux', { WSL_DISTRO_NAME: 'Ubuntu' }), 'wsl')
  assert.equal(hostPlatform('freebsd', {}), 'other')
})

test('app ids become names to say', () => {
  assert.equal(appName('Spotify.exe'), 'Spotify')
  assert.equal(appName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), 'Spotify')
  assert.equal(appName('MSEdge'), 'Edge')
  assert.equal(appName('Chrome'), 'Chrome')
  assert.equal(appName('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'), 'VLC')
  assert.equal(appName(''), '')
})

test('the Windows helper: one process, JSON lines both ways, accents intact', async () => {
  const seen = []
  const host = new PowerShellHost({
    spawnFn: fakeSpawn((req) => (req.op === 'now_playing' ? { ok: true, result: SPOTIFY } : { ok: true, result: { ok: true, via: 'smtc', appId: 'Spotify.exe' } }), seen),
  })
  const media = mediaHost({ platform: 'windows', host })
  try {
    const track = await media.nowPlaying()
    assert.equal(track.app, 'Spotify')
    assert.equal(track.title, 'Até Que Durou')
    assert.equal(track.status, 'playing')
    assert.equal(track.art, SPOTIFY.art)
    assert.deepEqual(await media.command('next'), { done: 'next', via: 'smtc', app: 'Spotify' })
    await media.nowPlaying()
    assert.equal(seen.length, 1, 'the helper is reused, not respawned')
    assert.equal(seen[0].cmd, 'powershell.exe', 'Windows PowerShell 5.1, the one that projects WinRT')
    assert.deepEqual(seen[0].args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    assert.match(seen[0].args[5], /host\.ps1$/)
  } finally {
    media.stop()
  }
})

test('the Windows helper: errors, timeouts and a crash reject instead of hanging', async () => {
  const host = new PowerShellHost({
    timeoutMs: 50,
    spawnFn: fakeSpawn((req) => (req.op === 'next' ? { ok: false, error: 'No media session from vlc' } : undefined)),
  })
  try {
    await assert.rejects(host.request('next', { app: 'vlc' }), /No media session from vlc/)
    await assert.rejects(host.request('now_playing'), /did not answer in time/)
    const p = host.request('now_playing')
    host.child.emit('exit', 1)
    await assert.rejects(p, /stopped/)
    assert.equal(host.child, null, 'restarted on the next request')
  } finally {
    host.stop()
  }
})

test('a player that refuses the command is reported as refused', async () => {
  const media = mediaHost({
    platform: 'windows',
    host: new PowerShellHost({ spawnFn: fakeSpawn(() => ({ ok: true, result: { ok: false, via: 'smtc' } })) }),
  })
  try {
    await assert.rejects(media.command('pause'), /refused/)
    await assert.rejects(media.command('format'), /unknown media command/)
  } finally {
    media.stop()
  }
})

test('WSL hands PowerShell a Windows path', () => {
  assert.equal(new PowerShellHost({ wsl: true, script: '/mnt/c/Users/me/jarvis/bridge/win/host.ps1' }).scriptPath(), 'C:\\Users\\me\\jarvis\\bridge\\win\\host.ps1')
  assert.match(new PowerShellHost({ wsl: true, script: '/home/me/jarvis/bridge/win/host.ps1' }).scriptPath(), /^\\\\wsl\.localhost\\.+\\home\\me\\jarvis/)
})

test('the helper script is shipped with every operation the bridge sends', () => {
  const ps = hostScriptText()
  for (const op of ["'ping'", "'now_playing'", "'sessions'", 'TryTogglePlayPauseAsync', 'TrySkipNextAsync', 'TrySkipPreviousAsync', 'TryPlayAsync', 'TryPauseAsync']) {
    assert.ok(ps.includes(op), op)
  }
  assert.match(ps, /GlobalSystemMediaTransportControlsSessionManager/)
  assert.match(ps, /keybd_event/, 'media keys when nothing reports')
})

test('Mac: JXA for Spotify, the cover fetched once and turned into a data URL', async () => {
  const runs = []
  const run = async (cmd, args) => {
    runs.push([cmd, ...args.filter((a) => a !== MAC_SCRIPT)])
    if (args[4] === 'now_playing') {
      return JSON.stringify({ app: 'Spotify', appId: 'Spotify', status: 'playing', title: 'Song', artist: 'Band', album: 'LP', duration: 200, position: 3, artUrl: 'https://i.scdn.co/image/abc', artKey: 'spotify:track:1' })
    }
    return JSON.stringify({ ok: true, via: 'applescript', appId: 'Spotify' })
  }
  const fetched = []
  const fetchArt = async (url) => (fetched.push(url), 'data:image/jpeg;base64,/9j/')
  const media = mediaHost({ platform: 'mac', run, fetchArt })
  const t = await media.nowPlaying()
  assert.deepEqual(fetched, ['https://i.scdn.co/image/abc'])
  assert.equal(t.art, 'data:image/jpeg;base64,/9j/')
  assert.deepEqual(runs[0], ['osascript', '-l', 'JavaScript', '-e', 'now_playing', ''])
  assert.equal(t.title, 'Song')
  assert.equal(t.artKey, 'spotify:track:1')
  assert.deepEqual(await media.command('play_pause', { app: 'spotify' }), { done: 'play_pause', via: 'applescript', app: 'Spotify' })
  assert.deepEqual(runs.at(-1), ['osascript', '-l', 'JavaScript', '-e', 'play_pause', 'spotify'])
  assert.match(MAC_SCRIPT, /running\(\)/, 'asking never launches the app')
})

test('Linux: playerctl output parsed', () => {
  const t = parsePlayerctl('spotify\tPlaying\tSong\tBand\tLP\t61000000\t215000000\thttps://x/y.jpg')
  assert.equal(t.app, 'spotify')
  assert.equal(t.status, 'playing')
  assert.equal(t.position, 61)
  assert.equal(t.duration, 215)
  assert.equal(parsePlayerctl(''), null)
})

test('tracks: normalised, art only as an image data URL, nothing playing is null', () => {
  assert.equal(toTrack(null), null)
  assert.equal(toTrack({}), null)
  assert.equal(toTrack({ ...SPOTIFY, art: 'javascript:alert(1)' }).art, null)
  assert.equal(toTrack({ ...SPOTIFY, position: -3 }).position, 0)
})

test('the screen gets the cover only when it changed; the model gets a file', () => {
  const t = toTrack(SPOTIFY)
  assert.equal(trackForScreen(t, '').art, SPOTIFY.art)
  const same = trackForScreen(t, t.artKey)
  assert.equal(same.art, undefined)
  assert.equal(same.artSame, true)

  const dir = mkdtempSync(join(tmpdir(), 'jarvis-art-'))
  try {
    const m = trackForModel(t, dir)
    assert.equal(m.art, undefined, 'no base64 for the model')
    assert.ok(existsSync(m.artFile))
    assert.deepEqual(readFileSync(m.artFile), Buffer.from('iVBORw0KGgo=', 'base64'))
    assert.match(trackForModel(null).note, /Nothing is playing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the media actions register under the policy names, screen and model views differ', async () => {
  const backend = {
    nowPlaying: async () => toTrack(SPOTIFY),
    sessions: async () => [toTrack(SPOTIFY)],
    command: async (op) => ({ ok: true, via: 'test', appId: 'Spotify.exe', op }),
  }
  const reg = registerMediaActions(actionRegistry(), mediaHost({ platform: 'test', backend }), z)
  assert.deepEqual(
    reg.list().map((a) => a.name).sort(),
    ['media.next', 'media.now_playing', 'media.pause', 'media.play', 'media.play_pause', 'media.previous', 'media.sessions'],
  )
  const np = reg.get('media.now_playing')
  const forScreen = await np.run({ have: SPOTIFY.artKey }, { from: 'screen' })
  assert.equal(forScreen.artSame, true)
  const sessions = await reg.get('media.sessions').run({})
  assert.equal(sessions[0].art, undefined)
  assert.deepEqual(await reg.get('media.next').run({}), { done: 'next', via: 'test', app: 'Spotify' })
})

test('no backend: a clear error, not a crash', async () => {
  const media = mediaHost({ platform: 'other' })
  assert.equal(media.available, false)
  await assert.rejects(media.nowPlaying(), /not available on this system/)
})

test('cover by URL: one fetch per URL, images only, a size cap', async () => {
  const { artFetcher } = await import('../bridge/media.mjs')
  const opened = []
  const reply = (type, body) => async (url) => {
    opened.push(url)
    const stream = new PassThrough()
    stream.headers = { 'content-type': type }
    stream.statusCode = 200
    stream.end(body)
    return { res: stream, url }
  }
  const art = artFetcher({ open: reply('image/jpeg', Buffer.from([1, 2, 3])) })
  assert.equal(await art('https://i.scdn.co/image/x'), 'data:image/jpeg;base64,AQID')
  await art('https://i.scdn.co/image/x')
  assert.equal(opened.length, 1, 'cached')
  assert.equal(await artFetcher({ open: reply('text/html', '<html>') })('https://e.com/a'), null)
  assert.equal(await artFetcher({ open: reply('image/png', Buffer.alloc(20)), maxBytes: 10 })('https://e.com/b'), null)
  assert.equal(await artFetcher()('http://127.0.0.1/cover.png'), null, 'SSRF guard: no loopback')
})
