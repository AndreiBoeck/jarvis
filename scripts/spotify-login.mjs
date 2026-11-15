/**
 * npm run spotify:login — connect JARVIS to the user's Spotify account, once.
 *
 * Needs SPOTIFY_CLIENT_ID in .env.local (see the README). If the bridge is
 * running it does the sign-in itself, so this only opens the browser on it and
 * waits; if not, this starts the same two routes on the bridge's port just for
 * the sign-in, then exits. Either way the refresh token ends up in
 * ~/.jarvis/spotify.json and the bridge uses it from then on.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { handleSpotifyRoute, spotifyFromEnv } from '../bridge/spotify.mjs'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* no file: the shell's environment it is */
}

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const base = `http://127.0.0.1:${PORT}`
const spotify = spotifyFromEnv({ port: PORT })

if (!spotify) {
  console.error(`
SPOTIFY_CLIENT_ID is not set. Once, at https://developer.spotify.com/dashboard:
  1. Create app → name "JARVIS", API: Web API.
  2. Redirect URI: ${base}/spotify/callback
  3. Copy the Client ID into .env.local:  SPOTIFY_CLIENT_ID=...
  4. In the app's User Management, add your own Spotify e-mail.
Then run npm run spotify:login again.`)
  process.exit(1)
}

function openBrowser(url) {
  // For a machine with no browser (or a test): print it instead.
  if (process.env.JARVIS_NO_BROWSER === '1') return console.log(`Open: ${url}`)
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
}

const status = async () => {
  try {
    const r = await fetch(`${base}/spotify/status`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

const deadline = Date.now() + 5 * 60_000
const running = await status()

if (running) {
  if (!running.configured) {
    console.error('The bridge is running without SPOTIFY_CLIENT_ID. Restart it after adding it to .env.local.')
    process.exit(1)
  }
  console.log(`Opening ${base}/spotify/login — sign in to Spotify and allow JARVIS.`)
  openBrowser(`${base}/spotify/login`)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    if ((await status())?.connected && spotify.auth.connected()) {
      console.log('Spotify connected. JARVIS can search and play now.')
      process.exit(0)
    }
  }
  console.error('No sign-in within five minutes. Run it again when ready.')
  process.exit(1)
}

// No bridge: serve the two routes ourselves, just for this sign-in.
const server = http.createServer(async (req, res) => {
  const handled = await handleSpotifyRoute(req, res, spotify.auth).catch((err) => {
    res.writeHead(500)
    res.end(String(err?.message ?? err))
    return true
  })
  if (!handled) {
    res.writeHead(404)
    res.end()
  }
  if (req.url?.startsWith('/spotify/callback') && spotify.auth.connected()) {
    console.log('Spotify connected. JARVIS can search and play now.')
    setTimeout(() => process.exit(0), 300)
  }
})
server.on('error', (err) => {
  console.error(`Could not listen on ${base}: ${err.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Opening ${base}/spotify/login — sign in to Spotify and allow JARVIS.`)
  openBrowser(`${base}/spotify/login`)
})
setTimeout(() => {
  console.error('No sign-in within five minutes. Run it again when ready.')
  process.exit(1)
}, deadline - Date.now()).unref()
