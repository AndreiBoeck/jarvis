import { registerPlugin } from '@capacitor/core'

/**
 * The native half of the Android app (JarvisDevicePlugin.java, in the jarvis-android repository).
 *
 * The interface is the same web page as on the desktop; what only a native app
 * can do lives behind this plugin: the background link that lets the PC drive
 * the phone, and the system settings that grant it the right to.
 */

export type DeviceStatus = {
  /** The background link is switched on. */
  enabled: boolean
  /** ...and currently connected to the bridge. */
  connected: boolean
  /** Last thing that went wrong with the link, in plain words, or ''. */
  lastError: string
  /** Reading the screen and tapping: the accessibility service is on. */
  accessibility: boolean
  /** Reading and replying to notifications. */
  notifications: boolean
  /** Exempt from battery optimisation, so the link survives Doze. */
  batteryUnrestricted: boolean
  /** Runtime permissions, by short name: mic, calls, sms, contacts, location, notify. */
  permissions: Record<string, boolean>
}

type JarvisDevicePlugin = {
  configure(opts: { url: string; token: string; enabled: boolean }): Promise<void>
  status(): Promise<DeviceStatus>
  /** Asks for whatever runtime permissions are still missing. */
  grantPermissions(): Promise<DeviceStatus>
  openAccessibilitySettings(): Promise<void>
  openNotificationSettings(): Promise<void>
  /** The app's info page, where Android 13+ hides "allow restricted settings". */
  openAppInfo(): Promise<void>
  requestBatteryExemption(): Promise<void>
}

export const Device = registerPlugin<JarvisDevicePlugin>('JarvisDevice')
