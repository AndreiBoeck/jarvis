import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The Android app: the same interface as the desktop, built with
 * `vite build --mode mobile` and wrapped by Capacitor, plus the native link
 * in android/app/src/main/java/app/jarvis/mobile. Build it with `npm run app`.
 */
const config: CapacitorConfig = {
  appId: 'app.jarvis.mobile',
  appName: 'JARVIS',
  webDir: 'dist',
  android: {
    // The interface is served from https://localhost inside the app, so the
    // microphone (a secure-context API) works and the bridge sees one fixed
    // origin.
    allowMixedContent: false,
    backgroundColor: '#01060c',
  },
}

export default config
