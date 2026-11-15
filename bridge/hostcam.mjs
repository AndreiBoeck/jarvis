import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { findBrowser } from './livebrowser.mjs'

/**
 * The webcam of the machine the bridge runs on, with nobody at that machine.
 *
 * "Show me the PC's camera" from the phone, with the PC's interface closed:
 * there is no browser tab over there to call getUserMedia. The bridge starts
 * one — the same installed Chrome or Edge the live browser uses, headless, its
 * own profile — and reads frames out of a page whose only job is to hold the
 * camera. Nothing to download: no ffmpeg, no native module. A webcam name
 * differs on every machine; JARVIS_CAMERA_DEVICE picks one by any part of its
 * label (or its deviceId) when the default is the wrong one.
 *
 * The browser is started when a feed or a look needs the camera and killed the
 * moment it does not, so the camera light is on exactly while frames are being
 * taken. The page is served once, from a throwaway loopback server — getUserMedia
 * needs a secure context and http://127.0.0.1 is one — that closes as soon as
 * the page has loaded. --use-fake-ui-for-media-stream answers the permission
 * prompt nobody is there to answer; the operating system's own camera
 * permission still applies.
 */

/**
 * Pick the webcam. Runs inside the page (it is injected by toString), and is
 * exported so it can be tested here. `want` matches a deviceId exactly or any
 * part of a label, ignoring case; no match, or no `want`, is the default.
 */
export function pickDevice(devices, want) {
  const cams = (devices || []).filter((d) => d.kind === 'videoinput')
  const w = String(want || '').trim().toLowerCase()
  if (!w) return null
  const hit = cams.find((d) => d.deviceId === want) || cams.find((d) => (d.label || '').toLowerCase().includes(w))
  return hit ? hit.deviceId : null
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>JARVIS camera</title>
<video id="v" autoplay muted playsinline></video><canvas id="c"></canvas>
<script>
const pickDevice = ${pickDevice.toString()};
let stream = null;
window.openCam = async (want) => {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let s = await navigator.mediaDevices.getUserMedia({ video: base });
  const id = pickDevice(await navigator.mediaDevices.enumerateDevices(), want);
  if (id && s.getVideoTracks()[0].getSettings().deviceId !== id) {
    s.getTracks().forEach((t) => t.stop());
    s = await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: id } } });
  }
  stream = s;
  v.srcObject = s;
  await v.play();
  await new Promise((r) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : setTimeout(r, 500)));
  return { label: s.getVideoTracks()[0].label, w: v.videoWidth, h: v.videoHeight };
};
window.grab = (w, q) => {
  const scale = Math.min(1, w / v.videoWidth);
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', q);
  return { data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height };
};
window.sheet = async (seconds, n) => {
  const cw = 426, ch = 240, cols = 3, rows = Math.ceil(n / cols), shots = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const at = (seconds * 1000 * i) / Math.max(1, n - 1);
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + at - performance.now())));
    const cell = document.createElement('canvas');
    cell.width = cw; cell.height = ch;
    cell.getContext('2d').drawImage(v, 0, 0, cw, ch);
    shots.push({ cell, t: (performance.now() - t0) / 1000 });
  }
  c.width = cw * cols; c.height = ch * rows;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  shots.forEach((s, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    g.drawImage(s.cell, x, y);
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x + 6, y + 6, 64, 26);
    g.fillStyle = '#fff'; g.font = 'bold 18px sans-serif'; g.fillText('+' + s.t.toFixed(1) + 's', x + 12, y + 26);
  });
  const url = c.toDataURL('image/jpeg', 0.8);
  return { data: url.slice(url.indexOf(',') + 1) };
};
window.closeCam = () => { stream && stream.getTracks().forEach((t) => t.stop()); stream = null; };
</script>`

export class HostCamera {
  constructor({
    profileDir = join(homedir(), '.jarvis', 'host-camera'),
    device = process.env.JARVIS_CAMERA_DEVICE ?? '',
    browser = findBrowser,
    log = (...a) => console.log('[jarvis] camera:', ...a),
  } = {}) {
    this.profileDir = profileDir
    this.device = device
    this.browser = browser
    this.log = log
    this.proc = null
    this.ws = null
    this.opening = null
    this.users = 0
    this.nextId = 0
    this.pending = new Map()
  }

  /** Whether there is a browser to capture with at all. */
  available() {
    return Boolean(this.browser())
  }

  /** A feed starts: the camera opens (or is already open). */
  start() {
    this.users++
    return this.ensure().catch((err) => {
      this.release()
      throw err
    })
  }

  /** A feed stopped. The camera closes when the last user goes. */
  stop() {
    this.release()
  }

  release() {
    this.users = Math.max(0, this.users - 1)
    if (!this.users) this.kill()
  }

  async frame({ w = 640, q = 0.6 } = {}) {
    await this.ensure()
    return this.evaluate(`grab(${Number(w) || 640}, ${Number(q) || 0.6})`)
  }

  /** One still or a contact sheet, for look and watch, opening and closing around it. */
  async capture({ mode = 'look', seconds = 6 } = {}) {
    this.users++
    try {
      await this.ensure()
      if (mode === 'watch') {
        const s = Math.max(2, Math.min(15, Number(seconds) || 6))
        const out = await this.evaluate(`sheet(${s}, 9)`, (s + 10) * 1000)
        return { data: out.data, mimeType: 'image/jpeg' }
      }
      const out = await this.evaluate('grab(1280, 0.82)')
      return { data: out.data, mimeType: 'image/jpeg' }
    } finally {
      this.release()
    }
  }

  ensure() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    this.opening ??= this.launch().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  async launch() {
    const bin = this.browser()
    if (!bin) throw new Error('there is no Chrome, Edge or Chromium on this machine to capture with (JARVIS_LIVE_BROWSER points at one)')
    mkdirSync(this.profileDir, { recursive: true })
    const portFile = join(this.profileDir, 'DevToolsActivePort')
    rmSync(portFile, { force: true })

    const server = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const pageUrl = `http://127.0.0.1:${server.address().port}/`

    try {
      const proc = spawn(
        bin,
        [
          '--headless=new',
          '--remote-debugging-port=0',
          `--user-data-dir=${this.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--use-mock-keychain',
          '--password-store=basic',
          '--mute-audio',
          // Nobody is there to click Allow; the OS camera permission still applies.
          '--use-fake-ui-for-media-stream',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          pageUrl,
        ],
        { stdio: 'ignore' },
      )
      this.proc = proc
      proc.on('exit', () => {
        if (this.proc === proc) {
          this.proc = null
          this.ws?.terminate()
          this.ws = null
        }
      })

      let port = null
      for (let i = 0; i < 100 && !port; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (this.proc !== proc) throw new Error('the browser exited while starting')
        try {
          port = readFileSync(portFile, 'utf8').split('\n')[0].trim() || null
        } catch {
          // not yet
        }
      }
      if (!port) throw new Error('the browser did not open its debugging port')

      let target = null
      for (let i = 0; i < 50 && !target; i++) {
        const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => [])
        target = list.find((t) => t.type === 'page' && t.url.startsWith(pageUrl))
        if (!target) await new Promise((r) => setTimeout(r, 100))
      }
      if (!target) throw new Error('the camera page did not load')

      const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.on('message', (raw) => {
        let m
        try {
          m = JSON.parse(raw.toString())
        } catch {
          return
        }
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        p(m)
      })
      ws.on('close', () => {
        for (const p of this.pending.values()) p({ error: { message: 'browser connection closed' } })
        this.pending.clear()
      })
      this.ws = ws
      // The page may still be loading when its target appears.
      for (let i = 0; i < 50; i++) {
        if (await this.evaluate('typeof openCam === "function"').catch(() => false)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const cam = await this.evaluate(`openCam(${JSON.stringify(this.device)})`, 15_000)
      this.log(`opened ${cam.label || 'the webcam'} ${cam.w}x${cam.h}`)
      if (this.users === 0) this.kill()
    } catch (err) {
      this.kill()
      throw err
    } finally {
      server.close()
    }
  }

  evaluate(expression, timeoutMs = 8000) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the camera is not open'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the camera did not answer'))
      }, timeoutMs)
      this.pending.set(id, (m) => {
        clearTimeout(timer)
        const r = m.result
        if (m.error) return reject(new Error(m.error.message))
        if (r?.exceptionDetails) {
          const d = r.exceptionDetails
          return reject(new Error(d.exception?.description?.split('\n')[0] ?? d.text ?? 'camera error'))
        }
        resolve(r?.result?.value)
      })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  }

  /** Close the camera and the browser. The light goes out with the process. */
  kill() {
    const proc = this.proc
    this.proc = null
    try {
      this.ws?.send(JSON.stringify({ id: ++this.nextId, method: 'Runtime.evaluate', params: { expression: 'closeCam()' } }))
    } catch {
      // closing anyway
    }
    this.ws?.close()
    this.ws = null
    if (proc) {
      proc.kill()
      this.log('closed')
    }
  }

  shutdown() {
    this.users = 0
    this.kill()
  }
}

