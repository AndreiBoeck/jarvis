/**
 * Pair a phone or a Mac with this JARVIS, list paired devices, or unpair one.
 *
 *   npm run pair -- "Pixel"              pair a new phone and print its token
 *   npm run pair:mac "MacBook"           pair a new Mac (the JARVIS app for macOS)
 *   npm run pair -- --list               show paired devices
 *   npm run pair -- --revoke Pixel       unpair (takes effect immediately)
 *
 * The token is printed once and never again — only its hash is kept. Lose it
 * and the fix is to revoke and pair again.
 *
 * `--json` prints { name, kind, token, url } on one line instead of the
 * explanation. The Mac app uses it in local mode to pair itself with the
 * bridge on the same Mac, so nobody has to copy a token from one window to
 * another on the same machine. `--replace` revokes a device of the same name
 * first, for exactly that case: the app re-pairing after its token was lost.
 */

import { execFileSync } from 'node:child_process'
import { createDevice, devicesFile, listDevices, revokeDevice } from '../bridge/devices.mjs'

const argv = process.argv.slice(2)

/**
 * In Windows PowerShell, `npm run pair -- --list` loses its `--` (PowerShell
 * eats it on the way into npm.ps1), so npm takes the flag as its own config
 * and the script sees only npm_config_list=true. Put --list and --revoke
 * back, so the documented commands work in every shell. (--mac cannot be
 * rescued this way — npm reads it as -m -a -c — which is why the Mac has its
 * own script, `npm run pair:mac "MacBook"`.)
 */
for (const name of ['revoke', 'list']) {
  if (process.env[`npm_config_${name}`] === 'true' && !argv.includes(`--${name}`)) argv.unshift(`--${name}`)
}

const flag = (f) => {
  const i = argv.indexOf(f)
  if (i === -1) return false
  argv.splice(i, 1)
  return true
}
const json = flag('--json')
const replace = flag('--replace')
const kind = flag('--mac') ? 'mac' : 'phone'
const args = argv
const what = kind === 'mac' ? 'Mac' : 'phone'

/**
 * This machine's name on the tailnet, if Tailscale is installed and up — the
 * address the device will use. Purely a convenience for the printout.
 */
function tailnetName() {
  const candidates = [
    'tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ]
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['status', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      })
      const name = JSON.parse(out)?.Self?.DNSName
      if (name) return name.replace(/\.$/, '')
    } catch {
      /* not installed, not running, or not this path */
    }
  }
  return null
}

try {
  if (args[0] === '--list') {
    const devices = listDevices()
    if (json) console.log(JSON.stringify(devices))
    else if (!devices.length) console.log('No devices paired.')
    else for (const d of devices) console.log(`- ${d.name}  [${d.kind}]  (paired ${d.created.slice(0, 10)})`)
  } else if (args[0] === '--revoke') {
    const name = args.slice(1).join(' ')
    console.log(revokeDevice(name) ? `Unpaired "${name}".` : `No device called "${name}".`)
  } else if (args.length && !args[0].startsWith('--')) {
    const requested = args.join(' ')
    if (replace) revokeDevice(requested)
    const { name, token } = createDevice(requested, undefined, { kind })
    const host = json ? null : tailnetName()
    const url = host ? `wss://${host}` : 'wss://<this-pc>.<your-tailnet>.ts.net'
    if (json) {
      console.log(JSON.stringify({ name, kind, token }))
    } else {
      console.log(`
Paired "${name}" (${what}). Its token, shown only this once:

  ${token}

In the JARVIS app on the ${what}, enter:
  Address  ${url}
  Token    (the line above)
${host ? '' : `
Tailscale was not found on this computer. Install it here and on the ${what},
sign in to the same account on both, then run the command below.
`}
To make the bridge reachable from the ${what} (tailnet only, never the internet):

  tailscale serve --bg 8787

Saved in ${devicesFile()}. Unpair with: npm run pair -- --revoke "${name}"
`)
    }
  } else {
    console.log('Usage: npm run pair "<phone name>" | npm run pair:mac "<Mac name>" | npm run pair -- --list | npm run pair -- --revoke "<device name>"')
    process.exitCode = 1
  }
} catch (err) {
  console.error(`[pair] ${err.message}`)
  process.exitCode = 1
}
