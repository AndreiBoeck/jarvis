import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Android app's build (`vite build --mode mobile`) reaches the bridge
 * through Tailscale rather than on localhost, so the page CSP has to let that
 * one origin serve images, media and framed pages too. Everything else in the
 * policy — and the reasoning in index.html for keeping img-src closed — is
 * unchanged: the phone still only ever loads bytes from its own bridge.
 *
 * The bridge address is baked in from VITE_BRIDGE_URL when known (that is what
 * `npm run app` in jarvis-android passes); without it, any *.ts.net host is allowed, so pairing
 * with an address typed by hand still shows pictures.
 */
function appCsp(bridgeUrl: string | undefined): Plugin {
  let origin = 'https://*.ts.net'
  if (bridgeUrl) {
    try {
      origin = new URL(bridgeUrl.replace(/^ws/, 'http')).origin
    } catch {
      /* keep the wildcard */
    }
  }
  return {
    name: 'jarvis-app-csp',
    transformIndexHtml(html) {
      return html.replaceAll('http://127.0.0.1:8787;', `http://127.0.0.1:8787 ${origin};`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    // The Mac app's paired build (`npm run mac` in jarvis-mac) reaches the bridge the same
    // way the phone does, so it gets the same policy.
    plugins: [react(), ...(mode === 'mobile' || mode === 'mac' ? [appCsp(env.VITE_BRIDGE_URL)] : [])],
    server: {
      // Honour PORT so a second instance can run alongside the first. The bridge
      // only accepts sockets from localhost:5173-5199, so stay inside that range
      // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
      // `npm start` runs the long-lived JARVIS, where hot reload does harm: a
      // module swapped into the running page splits the voice loop from the
      // screen it reports to. `npm run dev` keeps it.
      hmr: process.env.JARVIS_NO_HMR === '1' ? false : undefined,
    },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
