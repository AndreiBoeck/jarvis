/**
 * The Windows app's half of the page (desktop/preload.cjs).
 *
 * In the Electron window the preload script puts a small bridge on `window`:
 * the tray menu and the global shortcut can mute the microphone, and the page
 * tells the tray what state it is in so the menu tick stays honest. In a plain
 * browser tab none of it exists and every call here is a no-op.
 */

type DesktopBridge = {
  /** Tray or global shortcut asked to mute (true), unmute (false) or toggle (null). */
  onMute(cb: (on: boolean | null) => void): void
  /** Tell the tray the microphone's real state. */
  reportMuted(on: boolean): void
}

const bridge = (globalThis as unknown as { jarvisDesktop?: DesktopBridge }).jarvisDesktop

/** Running inside the Windows app rather than a browser tab. */
export const IS_DESKTOP = Boolean(bridge)

export function onDesktopMute(cb: (on: boolean | null) => void): void {
  bridge?.onMute(cb)
}

export function reportMuted(on: boolean): void {
  bridge?.reportMuted(on)
}

/**
 * Mute survives a reload — including the automatic one the app does when the
 * page crashes. Someone who muted him for a meeting does not want a crash to
 * quietly switch the microphone back on.
 */
const KEY = 'jarvis.muted'

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function saveMuted(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    /* private window or blocked storage: mute just won't persist */
  }
}
