/**
 * Build the JARVIS app for macOS in one go:
 *
 *   npm run mac              build macos/build/JARVIS.app
 *   npm run mac -- --install build it and copy it to /Applications
 *   npm run mac -- --open    build it and open it
 *
 * The interface is built with the PC's Tailscale address baked in as the
 * default for paired mode (when Tailscale here knows it — pass
 * JARVIS_BRIDGE_URL=wss://pc.tailnet.ts.net to choose), then SwiftPM compiles
 * the app and macos/build.sh wraps both into an app bundle.
 *
 * Runs on a Mac with the Xcode command line tools. Anywhere else it builds
 * only the interface, which is still useful to check that it compiles.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const mac = process.platform === 'darwin'
const install = process.argv.includes('--install')
const open = process.argv.includes('--open')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`[mac] ${cmd} ${args.join(' ')} failed`)
    process.exit(r.status ?? 1)
  }
}

/**
 * The PC's bridge, for paired mode's default. Only an explicit address is
 * used: Tailscale on this Mac knows the Mac's own name, not the PC's.
 */
const bridgeUrl = process.env.JARVIS_BRIDGE_URL ?? ''
const env = { ...process.env }
if (bridgeUrl) env.VITE_BRIDGE_URL = bridgeUrl
console.log(
  bridgeUrl
    ? `[mac] PC bridge address: ${bridgeUrl}`
    : '[mac] no JARVIS_BRIDGE_URL — Configurações will ask for the PC address',
)

// Its own folder: dist/ is the desktop build and dist-app/ the phone's.
const vite = resolve('node_modules/vite/bin/vite.js')
run(process.execPath, [vite, 'build', '--mode', 'mac', '--outDir', 'dist-mac', '--emptyOutDir'], { env })

if (!mac) {
  console.log('\n[mac] interface built in dist-mac/. The app itself can only be compiled on a Mac:')
  console.log('[mac] copy the repository there and run  npm run mac')
  process.exit(0)
}

run('bash', ['macos/build.sh', resolve('dist-mac'), bridgeUrl])

const app = 'macos/build/JARVIS.app'
if (install) {
  const target = '/Applications/JARVIS.app'
  rmSync(target, { recursive: true, force: true })
  cpSync(app, target, { recursive: true, verbatimSymlinks: true })
  console.log(`[mac] installed ${target}`)
  if (open) run('open', [target])
} else if (open) {
  run('open', [app])
} else if (existsSync(app)) {
  console.log(`[mac] open it with:  open ${app}   (or npm run mac -- --install)`)
}
