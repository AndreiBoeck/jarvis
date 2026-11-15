import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRemote, vetTarget } from './net.mjs'

/**
 * What is playing on the machine the bridge runs on, and the buttons for it.
 *
 * Not on a paired Mac or phone (mac.mjs and phone.mjs do those over their own
 * links): here, the PC itself — on the user's desktop the bridge runs on
 * Windows, in their logged-in session.
 *
 *   windows — the System Media Transport Controls, through one long-lived
 *             Windows PowerShell process (win/host.ps1). Every player that
 *             shows up in the volume flyout: Spotify, a browser tab, the
 *             Films app. Nothing to install. Media keys when nothing reports.
 *   wsl     — the same helper, reached through WSL's Windows interop.
 *   mac     — AppleScript (JXA) for Spotify and Music; anything else gets the
 *             media key. macOS 15.4 closed the private now-playing API to
 *             other apps, so there is no general "what is playing" here.
 *   linux   — playerctl (MPRIS), if it is installed.
 *
 * Every backend answers in one shape, `Track`:
 *   { app, appId, title, artist, album, status, position, duration, artKey, art }
 * status is playing | paused | stopped | …, times are seconds, art is a data:
 * URL (a saved screen cannot load anything else) or null.
 */

export const MEDIA_OPS = ['play', 'pause', 'play_pause', 'next', 'previous']

const HERE = dirname(fileURLToPath(import.meta.url))
export const HOST_SCRIPT = join(HERE, 'win', 'host.ps1')

export function hostPlatform(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') {
    const wsl = Boolean(env.WSL_DISTRO_NAME) || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
    return wsl ? 'wsl' : 'linux'
  }
  return 'other'
}

/** "Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "MSEdge" → a name to say. */
export function appName(appId) {
  const raw = String(appId ?? '').trim()
  if (!raw) return ''
  let name = raw.includes('!') ? raw.slice(raw.lastIndexOf('!') + 1) : raw
  name = name.replace(/\.exe$/i, '')
  // A packaged app's id is Publisher.Name_hash; a desktop app's can be a path.
  name = name.split(/[\\/]/).pop()
  const known = {
    msedge: 'Edge',
    chrome: 'Chrome',
    firefox: 'Firefox',
    spotify: 'Spotify',
    zunemusic: 'Media Player',
    microsoft: 'Media Player',
    vlc: 'VLC',
  }
  const key = name.toLowerCase()
  for (const [k, v] of Object.entries(known)) if (key === k || key.startsWith(`${k}.`)) return v
  return name
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v) * 10) / 10) : 0)
const str = (v) => (v === undefined || v === null ? '' : String(v))

/** Any backend's raw answer as a Track, or null when nothing is playing. */
export function toTrack(raw) {
  if (!raw || typeof raw !== 'object') return null
  const appId = str(raw.appId)
  const title = str(raw.title)
  if (!appId && !title) return null
  return {
    app: str(raw.app) || appName(appId),
    appId,
    title,
    artist: str(raw.artist),
    album: str(raw.album),
    status: str(raw.status).toLowerCase() || 'unknown',
    position: num(raw.position),
    duration: num(raw.duration),
    artKey: str(raw.artKey) || `${appId}|${title}|${str(raw.artist)}|${str(raw.album)}`,
    art: typeof raw.art === 'string' && raw.art.startsWith('data:image/') ? raw.art : null,
  }
}

// ---------------------------------------------------------------------------
// Windows: one PowerShell for the life of the bridge (or until it idles)
// ---------------------------------------------------------------------------

/**
 * The PowerShell helper, as a request/response channel.
 *
 * Started on first use, stopped after two idle minutes, restarted if it dies.
 * `spawnFn` is injectable so the protocol can be tested without Windows.
 */
export class PowerShellHost {
  constructor({
    spawnFn = spawn,
    command = 'powershell.exe',
    script = HOST_SCRIPT,
    wsl = false,
    idleMs = 120_000,
    timeoutMs = 8_000,
  } = {}) {
    Object.assign(this, { spawnFn, command, script, wsl, idleMs, timeoutMs })
    this.child = null
    this.pending = new Map()
    this.seq = 0
    this.buffer = ''
    this.idle = null
  }

  /** WSL hands powershell.exe a Linux path it cannot open; translate it once. */
  scriptPath() {
    if (!this.wsl) return this.script
    const m = /^\/mnt\/([a-z])\/(.*)$/.exec(this.script)
    if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
    const distro = process.env.WSL_DISTRO_NAME ?? 'Ubuntu'
    return `\\\\wsl.localhost\\${distro}${this.script.replace(/\//g, '\\')}`
  }

  start() {
    const child = this.spawnFn(
      this.command,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath()],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line) console.warn(`[jarvis] media host: ${line.slice(0, 300)}`)
    })
    const fail = (why) => {
      if (this.child !== child) return
      this.child = null
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(why))
      }
      this.pending.clear()
    }
    child.on('error', (err) => fail(`Windows PowerShell could not start: ${err?.message ?? err}`))
    child.on('exit', (code) => fail(`the media helper stopped (code ${code})`))
  }

  onData(chunk) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result ?? null)
      else p.reject(new Error(msg.error || 'the media helper failed'))
    }
  }

  request(op, args = {}) {
    if (!this.child) this.start()
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), this.idleMs)
    this.idle.unref?.()
    const id = `m${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Windows did not answer in time'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  stop() {
    clearTimeout(this.idle)
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

function windowsBackend(host) {
  return {
    async nowPlaying({ app, art = true } = {}) {
      return toTrack(await host.request('now_playing', { app: app ?? '', art }))
    },
    async sessions() {
      const list = await host.request('sessions')
      return (Array.isArray(list) ? list : list ? [list] : []).map(toTrack).filter(Boolean)
    },
    async command(op, { app } = {}) {
      return host.request(op, { app: app ?? '' })
    },
    host,
  }
}

// ---------------------------------------------------------------------------
// Mac: JXA for Spotify and Music, the media key for anything else
// ---------------------------------------------------------------------------

/**
 * One JXA script for every Mac operation: argv is [op, app]. It prints JSON.
 * `Application(name).running()` does not launch the app, which matters:
 * asking what is playing must not open Music.
 */
export const MAC_SCRIPT = `
function app(name) { try { var a = Application(name); return a.running() ? a : null } catch (e) { return null } }
function track(name, a) {
  var out = { app: name, appId: name, status: String(a.playerState()) }
  try {
    var t = a.currentTrack
    out.title = t.name(); out.artist = t.artist(); out.album = t.album()
    var d = t.duration(); out.duration = name === 'Spotify' ? d / 1000 : d
    out.position = a.playerPosition()
    if (name === 'Spotify') { out.artUrl = t.artworkUrl(); out.artKey = t.id() }
  } catch (e) {}
  return out
}
function pick(want) {
  var names = want ? [want] : ['Spotify', 'Music']
  var open = []
  for (var i = 0; i < names.length; i++) { var a = app(names[i]); if (a) open.push([names[i], a]) }
  for (var j = 0; j < open.length; j++) if (String(open[j][1].playerState()) === 'playing') return open[j]
  return open[0] || null
}
function key(code) {
  ObjC.import('AppKit'); ObjC.import('CoreGraphics')
  ;[0xa, 0xb].forEach(function (state) {
    var e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, $.NSMakePoint(0, 0), state << 8, 0, 0, null, 8, (code << 16) | (state << 8), -1)
    $.CGEventPost(0, e.CGEvent)
  })
}
function run(argv) {
  var op = argv[0], want = argv[1] || ''
  if (want) want = /music/i.test(want) ? 'Music' : /spotify/i.test(want) ? 'Spotify' : want
  if (op === 'sessions') {
    return JSON.stringify(['Spotify', 'Music'].map(function (n) { var a = app(n); return a ? track(n, a) : null }).filter(Boolean))
  }
  var hit = pick(want)
  if (op === 'now_playing') return JSON.stringify(hit ? track(hit[0], hit[1]) : null)
  if (!hit) {
    if (want) throw new Error(want + ' is not open')
    key({ next: 17, previous: 18 }[op] || 16)
    return JSON.stringify({ ok: true, via: 'key' })
  }
  var a = hit[1]
  if (op === 'play') a.play(); else if (op === 'pause') a.pause(); else if (op === 'play_pause') a.playpause()
  else if (op === 'next') a.nextTrack(); else if (op === 'previous') a.previousTrack()
  else throw new Error('unknown op ' + op)
  return JSON.stringify({ ok: true, via: 'applescript', appId: hit[0] })
}
`

/** A command's stdout, or a rejection carrying its stderr. */
export function runCommand(cmd, args, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message || err).trim().split('\n').pop()
        return reject(new Error(why.replace(/^.*execution error: /, '').slice(0, 300)))
      }
      resolve(String(stdout))
    })
  })
}

/**
 * Album art by URL (Spotify on the Mac gives one), as a data: URL. Through the
 * same SSRF-guarded fetch as every other remote image, capped, and cached by
 * URL so a player polling every two seconds fetches each cover once.
 */
export function artFetcher({ open = openRemote, maxBytes = 1024 * 1024 } = {}) {
  const cache = new Map()
  return async (url) => {
    if (!url) return null
    if (cache.has(url)) return cache.get(url)
    let data = null
    try {
      const { res } = await open(vetTarget(url), { accept: 'image/*' }, 6_000)
      const type = String(res.headers['content-type'] ?? '').split(';')[0]
      const chunks = []
      let size = 0
      for await (const c of res) {
        size += c.length
        if (size > maxBytes) throw new Error('too big')
        chunks.push(c)
      }
      if (/^image\//.test(type) && (res.statusCode ?? 0) < 300) {
        data = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
      }
    } catch {
      data = null
    }
    if (cache.size > 32) cache.clear()
    cache.set(url, data)
    return data
  }
}

function macBackend({ run = runCommand, fetchArt = artFetcher() } = {}) {
  const jxa = async (op, app = '') => {
    const out = (await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, op, app])).trim()
    return out ? JSON.parse(out) : null
  }
  return {
    async nowPlaying({ app, art = true } = {}) {
      const raw = await jxa('now_playing', app ?? '')
      if (raw && art && raw.artUrl) raw.art = await fetchArt(raw.artUrl)
      return toTrack(raw)
    },
    async sessions() {
      return ((await jxa('sessions')) ?? []).map(toTrack).filter(Boolean)
    },
    command: (op, { app } = {}) => jxa(op, app ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Linux: playerctl
// ---------------------------------------------------------------------------

const PLAYERCTL_FORMAT =
  '{{playerName}}\t{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{position}}\t{{mpris:length}}\t{{mpris:artUrl}}'

export function parsePlayerctl(line) {
  const [player, status, title, artist, album, position, length] = String(line).split('\t')
  if (!player) return null
  return toTrack({
    app: player.split('.')[0],
    appId: player,
    status,
    title,
    artist,
    album,
    position: Number(position) / 1e6,
    duration: Number(length) / 1e6,
  })
}

function linuxBackend({ run = runCommand } = {}) {
  const pc = (args) => run('playerctl', args).catch((err) => {
    if (/ENOENT/.test(err.message)) throw new Error('playerctl is not installed')
    if (/No players found/i.test(err.message)) return ''
    throw err
  })
  const player = (app) => (app ? ['-p', app] : [])
  return {
    async nowPlaying({ app } = {}) {
      const out = await pc([...player(app), 'metadata', '--format', PLAYERCTL_FORMAT])
      return parsePlayerctl(out.trim().split('\n')[0] ?? '')
    },
    async sessions() {
      const out = await pc(['-a', 'metadata', '--format', PLAYERCTL_FORMAT])
      return out.trim().split('\n').map(parsePlayerctl).filter(Boolean)
    },
    async command(op, { app } = {}) {
      const verb = { play: 'play', pause: 'pause', play_pause: 'play-pause', next: 'next', previous: 'previous' }[op]
      await pc([...player(app), verb])
      return { ok: true, via: 'playerctl' }
    },
  }
}

// ---------------------------------------------------------------------------
// The one object the rest of the bridge uses
// ---------------------------------------------------------------------------

/**
 * @param {object} [o]
 * @param {string} [o.platform]  hostPlatform() by default
 * @param {object} [o.backend]   a ready backend, for tests
 */
export function mediaHost({ platform = hostPlatform(), backend, run, host, fetchArt } = {}) {
  const impl =
    backend ??
    (platform === 'windows' || platform === 'wsl'
      ? windowsBackend(host ?? new PowerShellHost({ wsl: platform === 'wsl' }))
      : platform === 'mac'
        ? macBackend({ run, ...(fetchArt ? { fetchArt } : {}) })
        : platform === 'linux'
          ? linuxBackend({ run })
          : null)

  // A player blade polls; several polls a second from two screens should cost
  // one look, not three.
  let last = null
  const CACHE_MS = 800

  const unsupported = () => {
    throw new Error(`media control is not available on this system (${platform})`)
  }

  return {
    platform,
    available: Boolean(impl),
    host: impl?.host ?? null,

    async nowPlaying({ app = '' } = {}) {
      if (!impl) unsupported()
      const key = app.toLowerCase()
      if (last && last.key === key && Date.now() - last.at < CACHE_MS) return last.track
      const track = await impl.nowPlaying({ app, art: true })
      last = { key, at: Date.now(), track }
      return track
    },

    async sessions() {
      if (!impl) unsupported()
      return impl.sessions()
    },

    async command(op, { app = '' } = {}) {
      if (!impl) unsupported()
      if (!MEDIA_OPS.includes(op)) throw new Error(`unknown media command: ${op}`)
      last = null
      const r = await impl.command(op, { app })
      if (r && r.ok === false) throw new Error('the player refused that')
      return { done: op, via: r?.via ?? platform, app: appName(r?.appId ?? app) || null }
    },

    stop() {
      impl?.host?.stop?.()
    },
  }
}

/**
 * The model gets no base64: the cover is written to a temp file it can put on
 * a blade by path, and the rest is said in words.
 */
export function trackForModel(track, dir = tmpdir()) {
  if (!track) return { playing: null, note: 'Nothing is playing (no media session).' }
  const { art, artKey: _k, ...rest } = track
  let artFile = null
  const m = art ? /^data:image\/([\w+.-]+);base64,(.*)$/.exec(art) : null
  if (m) {
    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg'
    artFile = join(dir, `jarvis-now-playing.${ext}`)
    try {
      writeFileSync(artFile, Buffer.from(m[2], 'base64'))
    } catch {
      artFile = null
    }
  }
  return { ...rest, ...(artFile ? { artFile } : {}) }
}

/** For the screen: the cover only when it is not the one it already has. */
export function trackForScreen(track, have = '') {
  if (!track) return null
  if (have && track.artKey === have) {
    const { art: _a, ...rest } = track
    return { ...rest, artSame: true }
  }
  return track
}

/** Read the helper script, for tests that check it is shipped intact. */
export const hostScriptText = () => readFileSync(HOST_SCRIPT, 'utf8')

/**
 * The media actions, for the model (jarvis_media) and for screens alike.
 * `z` is passed in so this file needs no schema library of its own.
 */
export function registerMediaActions(registry, media, z) {
  const app = z
    .string()
    .max(60)
    .optional()
    .catch(undefined)
    .describe('Only this app, e.g. "spotify" or "chrome". Leave out for whatever is playing.')
  registry.register('media.now_playing', {
    label: 'Ver o que está tocando',
    description: 'What is playing on the PC right now: app, title, artist, album, playing or paused, position, and the cover (as a file you can show).',
    shape: {
      app,
      have: z.string().max(400).optional().catch(undefined).describe('Screens only: the artKey already shown.'),
    },
    run: async ({ app: a, have }, ctx) => {
      const track = await media.nowPlaying({ app: a ?? '' })
      return ctx?.from === 'screen' ? trackForScreen(track, have ?? '') : track
    },
    forModel: (track) => trackForModel(track),
  })
  registry.register('media.sessions', {
    label: 'Listar os players abertos',
    description: 'Every app on the PC that is playing or paused media right now.',
    shape: {},
    run: async () => (await media.sessions()).map(({ art: _a, ...t }) => t),
  })
  const labels = {
    play: ['Tocar', 'Resume playback on the PC.'],
    pause: ['Pausar', 'Pause playback on the PC.'],
    play_pause: ['Tocar/pausar', 'Toggle play/pause on the PC.'],
    next: ['Próxima faixa', 'Skip to the next track on the PC.'],
    previous: ['Faixa anterior', 'Go back to the previous track on the PC.'],
  }
  for (const op of MEDIA_OPS) {
    registry.register(`media.${op}`, {
      label: labels[op][0],
      description: labels[op][1],
      shape: { app },
      run: ({ app: a }) => media.command(op, { app: a ?? '' }),
    })
  }
  return registry
}
