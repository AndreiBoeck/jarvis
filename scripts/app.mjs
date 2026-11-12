/**
 * Build the Android app in one go:
 *
 *   npm run app              build the APK
 *   npm run app -- --install build it and install it on the phone plugged in (adb)
 *
 * The interface is built with this PC's Tailscale address baked in as the
 * default (so the pairing screen only asks for the token) and wrapped by
 * Capacitor; Gradle then produces android/app/build/outputs/apk/debug/app-debug.apk.
 *
 * Needs JDK 21 and the Android SDK (Android Studio installs both). JAVA_HOME
 * and the SDK location are looked for in the usual places when unset.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const win = process.platform === 'win32'
const install = process.argv.includes('--install')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, ...opts })
  if (r.status !== 0) {
    console.error(`[app] ${cmd} ${args.join(' ')} failed`)
    process.exit(r.status ?? 1)
  }
}

/** This PC's Tailscale name, for the pairing screen's default address. */
function tailnetName() {
  for (const bin of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      const name = JSON.parse(out)?.Self?.DNSName
      if (name) return name.replace(/\.$/, '')
    } catch {
      /* not installed or not running */
    }
  }
  return null
}

const firstExisting = (paths) => paths.find((p) => p && existsSync(p))

const host = tailnetName()
const env = { ...process.env }
if (host) env.VITE_BRIDGE_URL = `wss://${host}`
console.log(host ? `[app] bridge address: wss://${host}` : '[app] Tailscale not found — the pairing screen will ask for the address')

env.JAVA_HOME ??= firstExisting(
  win
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr', 'C:\\Program Files\\Java\\jdk-21']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/usr/lib/jvm/java-21-openjdk-amd64'],
)

const sdk = firstExisting([
  env.ANDROID_HOME,
  env.ANDROID_SDK_ROOT,
  win ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk'),
])
if (!existsSync('android/local.properties') && sdk) {
  writeFileSync('android/local.properties', `sdk.dir=${sdk.replaceAll('\\', '/')}\n`)
}

// Its own folder: dist/ is the desktop build, and the two must not overwrite each other.
run('npx', ['vite', 'build', '--mode', 'mobile', '--outDir', 'dist-app'], { env })
run('npx', ['cap', 'sync', 'android'], { env })
run(win ? '.\\gradlew.bat' : './gradlew', ['assembleDebug', '--console=plain', '-q'], { cwd: 'android', env })

const apk = 'android/app/build/outputs/apk/debug/app-debug.apk'
console.log(`\n[app] built ${apk}`)
if (install) run('adb', ['install', '-r', apk])
else console.log('[app] install it with: adb install -r ' + apk + '  (or copy the file to the phone)')
