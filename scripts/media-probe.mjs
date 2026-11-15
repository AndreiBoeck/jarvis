/**
 * npm run media:probe — check, on this machine, what JARVIS's media and
 * system controls see. Read-only: lists the media sessions, what is playing
 * and the volume, and presses nothing. Run it on the PC after setting up, or
 * when "pause the music" does nothing.
 */
import { PowerShellHost, hostPlatform, mediaHost } from '../bridge/media.mjs'
import { systemHost } from '../bridge/system.mjs'

const platform = hostPlatform()
const host = platform === 'windows' || platform === 'wsl' ? new PowerShellHost({ wsl: platform === 'wsl' }) : null
const media = mediaHost({ platform, host })
const system = systemHost({ platform, host })

const step = async (label, fn) => {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`✔ ${label} (${Date.now() - t} ms)`)
    console.log(JSON.stringify(r, (k, v) => (k === 'art' && typeof v === 'string' ? `${v.slice(0, 30)}… (${v.length} chars)` : v), 1))
  } catch (err) {
    console.log(`✘ ${label}: ${err?.message ?? err}`)
  }
}

console.log(`platform: ${platform}`)
if (host) await step('PowerShell helper', () => host.request('ping'))
await step('media sessions', () => media.sessions())
await step('now playing', () => media.nowPlaying())
await step('now playing again (helper warm)', () => media.nowPlaying())
await step('volume', () => system.volume())
media.stop()
process.exit(0)
