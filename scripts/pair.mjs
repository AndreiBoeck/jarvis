/**
 * Pair a phone with this JARVIS, list paired phones, or unpair one.
 *
 *   npm run pair -- "Pixel"          pair a new phone and print its token
 *   npm run pair -- --list           show paired phones
 *   npm run pair -- --revoke Pixel   unpair (takes effect immediately)
 *
 * The token is printed once and never again — only its hash is kept. Lose it
 * and the fix is to revoke and pair again.
 */

import { execFileSync } from 'node:child_process'
import { createDevice, devicesFile, listDevices, revokeDevice } from '../bridge/devices.mjs'

const args = process.argv.slice(2)

/**
 * This machine's name on the tailnet, if Tailscale is installed and up — the
 * address the phone will use. Purely a convenience for the printout.
 */
function tailnetName() {
  const candidates = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
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
    if (!devices.length) console.log('No phones paired.')
    for (const d of devices) console.log(`- ${d.name}  (paired ${d.created.slice(0, 10)})`)
  } else if (args[0] === '--revoke') {
    const name = args.slice(1).join(' ')
    console.log(revokeDevice(name) ? `Unpaired "${name}".` : `No phone called "${name}".`)
  } else if (args.length && !args[0].startsWith('--')) {
    const { name, token } = createDevice(args.join(' '))
    const host = tailnetName()
    const url = host ? `wss://${host}` : 'wss://<this-pc>.<your-tailnet>.ts.net'
    console.log(`
Paired "${name}". Its token, shown only this once:

  ${token}

In the JARVIS app on the phone, enter:
  Address  ${url}
  Token    (the line above)
${host ? '' : `
Tailscale was not found on this PC. Install it on the PC and the phone, sign in
to the same account on both, then run the command below.
`}
To make the bridge reachable from the phone (tailnet only, never the internet):

  tailscale serve --bg 8787

Saved in ${devicesFile()}. Unpair with: npm run pair -- --revoke "${name}"
`)
  } else {
    console.log('Usage: npm run pair -- "<phone name>" | --list | --revoke "<phone name>"')
    process.exitCode = 1
  }
} catch (err) {
  console.error(`[pair] ${err.message}`)
  process.exitCode = 1
}
