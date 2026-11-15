import { runCommand } from './media.mjs'

/**
 * The machine the bridge runs on, beyond what is playing: its volume, locking
 * it, the display, and — confirmed — opening an app or a link, or sleep.
 *
 * Same backends as media.mjs, sharing its Windows PowerShell helper so the PC
 * runs one helper process, not two:
 *
 *   windows / wsl — win/host.ps1: Core Audio for the volume, LockWorkStation,
 *                   SC_MONITORPOWER, the Start menu for apps, SetSuspendState.
 *   mac           — osascript for the volume, pmset for the display and sleep
 *                   (the Mac locks when the display sleeps if it is set to ask
 *                   for the password at once), `open` for apps and links.
 *   linux         — pactl, loginctl, xset, xdg-open, systemctl.
 *
 * Which of these may run unasked is policy.mjs's DEVICE_ACTIONS, not this file.
 */

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))))

/** A link worth opening: http or https, nothing else (no file:, no javascript:). */
export function checkUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('that is not a link')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https links')
  return url.href
}

/** An app name, as typed: no paths, no flags, no shell. */
export function checkApp(raw) {
  const name = String(raw ?? '').trim()
  if (!name || name.length > 60 || /[\\/<>|&;$`"']|^-/.test(name)) throw new Error('that is not an app name')
  return name
}

function windowsSystem(host) {
  return {
    volume: (args) => host.request('volume', args),
    lock: () => host.request('lock'),
    displayOff: () => host.request('display_off'),
    sleep: () => host.request('sleep'),
    openApp: (app) => host.request('open_app', { app }),
    openUrl: (url) => host.request('open_url', { url }),
  }
}

function macSystem(run) {
  const osa = (script) => run('osascript', ['-e', script])
  return {
    async volume({ level, mute }) {
      if (level !== null && level !== undefined) await osa(`set volume output volume ${clamp(level)}`)
      if (mute !== null && mute !== undefined) await osa(`set volume output muted ${mute ? 'true' : 'false'}`)
      const out = (await osa('get {output volume, output muted} of (get volume settings)')).trim()
      const [v, m] = out.split(/,\s*/)
      return { level: Number(v), muted: m === 'true' }
    },
    lock: () => run('pmset', ['displaysleepnow']).then(() => ({ ok: true, note: 'display asleep; locks if the Mac asks for the password at once' })),
    displayOff: () => run('pmset', ['displaysleepnow']).then(() => ({ ok: true })),
    sleep: () => run('pmset', ['sleepnow']).then(() => ({ ok: true })),
    openApp: (app) => run('open', ['-a', app]).then(() => ({ opened: app })),
    openUrl: (url) => run('open', [url]).then(() => ({ opened: url })),
  }
}

function linuxSystem(run) {
  const sink = '@DEFAULT_SINK@'
  return {
    async volume({ level, mute }) {
      if (level !== null && level !== undefined) await run('pactl', ['set-sink-volume', sink, `${clamp(level)}%`])
      if (mute !== null && mute !== undefined) await run('pactl', ['set-sink-mute', sink, mute ? '1' : '0'])
      const v = /(\d+)%/.exec(await run('pactl', ['get-sink-volume', sink]))
      const m = /yes/i.test(await run('pactl', ['get-sink-mute', sink]))
      return { level: v ? Number(v[1]) : null, muted: m }
    },
    lock: () => run('loginctl', ['lock-session']).then(() => ({ ok: true })),
    displayOff: () => run('xset', ['dpms', 'force', 'off']).then(() => ({ ok: true })),
    sleep: () => run('systemctl', ['suspend']).then(() => ({ ok: true })),
    openApp: (app) => run('gtk-launch', [app]).then(() => ({ opened: app })),
    openUrl: (url) => run('xdg-open', [url]).then(() => ({ opened: url })),
  }
}

export function systemHost({ platform, host, run = runCommand, backend } = {}) {
  const impl =
    backend ??
    (platform === 'windows' || platform === 'wsl'
      ? host && windowsSystem(host)
      : platform === 'mac'
        ? macSystem(run)
        : platform === 'linux'
          ? linuxSystem(run)
          : null)
  const need = () => {
    if (!impl) throw new Error(`system control is not available on this system (${platform})`)
    return impl
  }
  return {
    platform,
    available: Boolean(impl),

    /** Read, set, nudge or mute: { level?, change?, mute? } → { level, muted }. */
    async volume({ level, change, mute } = {}) {
      const sys = need()
      let target = level
      if ((target === undefined || target === null) && change) {
        const now = await sys.volume({})
        target = Number(now.level) + Number(change)
      }
      return sys.volume({
        level: target === undefined || target === null ? null : clamp(target),
        mute: mute === undefined ? null : Boolean(mute),
      })
    },
    lock: async () => need().lock(),
    displayOff: async () => need().displayOff(),
    sleep: async () => need().sleep(),
    openApp: async (app) => need().openApp(checkApp(app)),
    openUrl: async (url) => need().openUrl(checkUrl(url)),
  }
}

export function registerSystemActions(registry, system, z) {
  registry.register('system.volume', {
    label: 'Mudar o volume',
    description:
      'The PC’s output volume, 0–100. No arguments reads it; `level` sets it, `change` nudges it (+10, -20), `mute` mutes or unmutes.',
    shape: {
      level: z.number().min(0).max(100).optional().catch(undefined),
      change: z.number().min(-100).max(100).optional().catch(undefined),
      mute: z.boolean().optional().catch(undefined),
    },
    run: (args) => system.volume(args),
  })
  registry.register('system.lock', {
    label: 'Bloquear a tela',
    description: 'Lock the PC (the user signs in again to come back).',
    run: () => system.lock(),
  })
  registry.register('system.display_off', {
    label: 'Desligar o monitor',
    description: 'Turn the PC’s display off; it wakes on the mouse or keyboard.',
    run: () => system.displayOff(),
  })
  registry.register('system.open_app', {
    label: 'Abrir um app',
    description: 'Open an app on the PC by its name in the Start menu, e.g. "Spotify", "Calculator".',
    shape: { app: z.string().min(1).max(60) },
    run: ({ app }) => system.openApp(app),
  })
  registry.register('system.open_url', {
    label: 'Abrir um link',
    description: 'Open an http(s) link in the PC’s default browser.',
    shape: { url: z.string().min(1).max(2000) },
    run: ({ url }) => system.openUrl(url),
  })
  registry.register('system.sleep', {
    label: 'Suspender o PC',
    description: 'Put the PC to sleep.',
    run: () => system.sleep(),
  })
  return registry
}
