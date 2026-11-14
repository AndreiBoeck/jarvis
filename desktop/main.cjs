/**
 * J.A.R.V.I.S. for Windows.
 *
 * A thin shell around the two halves that already exist. Nothing about how
 * JARVIS thinks or speaks changes here; what changes is what keeps him alive:
 *
 *   - the brain (bridge/server.mjs) runs as a child of the app and is started
 *     again if it dies, instead of living in a console window someone closes;
 *   - the face is served from the built page and shown in a window Chrome
 *     cannot throttle, discard or forget about while it is minimised;
 *   - if that window's renderer crashes anyway, it is reloaded on the spot and
 *     boots straight back up, rather than sitting on "Aw, Snap!" until noticed;
 *   - closing the window sends him to the tray, where the microphone can be
 *     muted, and Ctrl+Alt+M mutes him from anywhere.
 *
 * Flags: --writes lets him act (as `npm start -- --writes` does), --read-only
 * forbids it even if the shell says otherwise, --hidden starts in the tray
 * (used when he starts with Windows), --dev uses the Vite dev server instead
 * of the built page.
 */
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
// JARVIS_DESKTOP_DIST points at another build — used to test the app beside a
// running JARVIS, with a page built to talk to a bridge on another port.
const DIST = process.env.JARVIS_DESKTOP_DIST
  ? path.resolve(process.env.JARVIS_DESKTOP_DIST)
  : path.join(ROOT, 'dist')
const ICON = path.join(__dirname, 'icon.png')
const argv = process.argv.slice(1)
const WRITES = argv.includes('--writes')
const READ_ONLY = argv.includes('--read-only')
const HIDDEN = argv.includes('--hidden')
const DEV = argv.includes('--dev')

app.setName('J.A.R.V.I.S.')
app.setAppUserModelId('com.jarvis.desktop')

// He speaks the moment he is up — after a crash there is nobody to click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// A hidden or covered window must keep running at full speed: the voice loop
// lives in it. These are the switches behind Chrome's background throttling.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}

// -- logs ---------------------------------------------------------------------

const LOGS = path.join(app.getPath('userData'), 'logs')
fs.mkdirSync(LOGS, { recursive: true })

function openLog(name) {
  const file = path.join(LOGS, name)
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`)
  } catch {
    /* no log yet */
  }
  return fs.createWriteStream(file, { flags: 'a' })
}
const appLog = openLog('app.log')
const bridgeLog = openLog('bridge.log')
const stamp = () => new Date().toISOString()
const log = (...parts) => {
  const line = `${stamp()} ${parts.join(' ')}\n`
  appLog.write(line)
  process.stdout.write(line)
}

// -- the brain ----------------------------------------------------------------

let bridge = null
let bridgeStarts = []
let quitting = false

function startBridge() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (WRITES) env.JARVIS_ALLOW_WRITES = '1'
  if (READ_ONLY) env.JARVIS_ALLOW_WRITES = '0'
  const startedAt = Date.now()
  bridgeStarts = bridgeStarts.filter((t) => startedAt - t < 5 * 60_000).concat(startedAt)

  log('starting bridge', WRITES ? '(writes on)' : READ_ONLY ? '(read-only)' : '')
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
    cwd: ROOT,
    env,
    windowsHide: true,
  })
  bridge = child
  let tail = ''
  const sink = (d) => {
    bridgeLog.write(d)
    tail = (tail + d.toString()).slice(-4000)
  }
  child.stdout.on('data', sink)
  child.stderr.on('data', sink)
  child.on('exit', (code, signal) => {
    if (bridge === child) bridge = null
    bridgeLog.write(`${stamp()} bridge exited (${code ?? signal})\n`)
    log(`bridge exited (${code ?? signal})`)
    if (quitting) return

    if (/EADDRINUSE/.test(tail)) {
      dialog.showErrorBox(
        'J.A.R.V.I.S.',
        'Another JARVIS is already running — port 8787 is taken.\n\n' +
          'Close the other one (the console window or `npm start`), then use ' +
          '"Restart brain" in the tray menu.',
      )
      return
    }
    // Restart, but not in a tight loop: five deaths in five minutes means
    // something is properly wrong, and the log says what.
    if (bridgeStarts.length >= 5) {
      dialog.showErrorBox(
        'J.A.R.V.I.S.',
        `The brain keeps stopping. The last thing it said:\n\n${tail.slice(-1200)}\n\n` +
          `Full log: ${path.join(LOGS, 'bridge.log')}`,
      )
      return
    }
    setTimeout(startBridge, 2000)
  })
}

/** Resolves once the bridge answers /health, or after 30s regardless. */
async function waitForBridge() {
  const port = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((r) =>
      http
        .get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
          res.resume()
          r(res.statusCode === 200)
        })
        .on('error', () => r(false))
        .on('timeout', function () {
          this.destroy()
          r(false)
        }),
    )
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  log('bridge did not answer within 30s — opening the window anyway')
}

function stopBridge() {
  const child = bridge
  bridge = null
  if (!child || child.exitCode !== null) return
  // The bridge runs Claude Code as its own children; take the whole tree.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else child.kill('SIGTERM')
}

function restartBridge() {
  bridgeStarts = []
  const child = bridge
  if (child) {
    // Its exit handler would restart it too; take it off the books first.
    child.removeAllListeners('exit')
    child.on('exit', () => startBridge())
    stopBridge()
  } else startBridge()
}

// -- the face -----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * The built page, on loopback, on a port the bridge already trusts (it accepts
 * sockets from localhost:4173-4199, where `vite preview` lives).
 */
function serveFace() {
  const server = http.createServer((req, res) => {
    let rel
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    let file = path.join(DIST, path.normalize(rel))
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      res.writeHead(403).end()
      return
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(DIST, 'index.html') // single-page app
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    let port = 4180
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < 4199) server.listen(++port, '127.0.0.1')
      else reject(err)
    })
    server.on('listening', () => resolve(`http://127.0.0.1:${port}`))
    server.listen(port, '127.0.0.1')
  })
}

let devServer = null
async function startDevFace() {
  devServer = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'],
    { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JARVIS_NO_HMR: '1' }, windowsHide: true },
  )
  devServer.stdout.on('data', (d) => process.stdout.write(d))
  devServer.stderr.on('data', (d) => process.stderr.write(d))
  const url = 'http://localhost:5173'
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((r) => http.get(url, (res) => r(res.statusCode === 200)).on('error', () => r(false)))
    if (ok) return url
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the Vite dev server did not start')
}

// -- the window ---------------------------------------------------------------

let win = null
let tray = null
let faceUrl = ''
let muted = false
let crashes = []
let hangTimer = null
let toldAboutTray = false

const ALLOWED_PERMISSIONS = new Set([
  'media', // microphone, and the camera for hand tracking (which asks first)
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write',
  'speaker-selection',
])
const isOurs = (url) => {
  try {
    return new URL(url).origin === new URL(faceUrl).origin
  } catch {
    return false
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#02080c',
    title: 'J.A.R.V.I.S.',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The whole point: hidden or minimised, the voice loop keeps running.
      backgroundThrottling: false,
    },
  })
  win.setMenu(null)

  win.once('ready-to-show', () => {
    if (!HIDDEN) win.show()
  })

  // F11 for full screen, F5 to reload, Ctrl+Shift+I for the developer tools.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen())
      e.preventDefault()
    } else if (input.key === 'F5') {
      win.reload()
      e.preventDefault()
    } else if (input.key === 'I' && input.control && input.shift) {
      win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })

  // Links JARVIS puts on screen open in the real browser, never in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url)) return
    e.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  // -- staying alive --

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (quitting || details.reason === 'clean-exit') return
    const now = Date.now()
    crashes = crashes.filter((t) => now - t < 5 * 60_000).concat(now)
    if (crashes.length > 4) {
      // Crashing on every load: reloading forever would just spin. Say so.
      const choice = dialog.showMessageBoxSync(win, {
        type: 'error',
        title: 'J.A.R.V.I.S.',
        message: 'The interface keeps crashing.',
        detail: `Reason: ${details.reason}. Log: ${path.join(LOGS, 'app.log')}`,
        buttons: ['Reload', 'Quit'],
      })
      if (choice === 1) return quit()
      crashes = []
    }
    setTimeout(() => win && !win.isDestroyed() && win.loadURL(faceUrl), 1500)
  })

  // A page that stops answering for 20s is not coming back by itself.
  win.on('unresponsive', () => {
    log('renderer unresponsive')
    clearTimeout(hangTimer)
    hangTimer = setTimeout(() => {
      log('renderer still hung after 20s — restarting it')
      win.webContents.forcefullyCrashRenderer()
    }, 20_000)
  })
  win.on('responsive', () => clearTimeout(hangTimer))

  // Closing sends him to the tray; he keeps listening there.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    if (!toldAboutTray && tray) {
      toldAboutTray = true
      tray.displayBalloon({
        title: 'J.A.R.V.I.S. is still running',
        content: 'He is in the tray and still listening. Right-click the icon to mute or quit.',
        iconType: 'info',
      })
    }
  })

  void win.loadURL(faceUrl)
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

// -- mute, the tray and shortcuts ---------------------------------------------

function sendMute(on) {
  win?.webContents.send('jarvis:mute', on)
}

const loginArgs = () =>
  [...(app.isPackaged ? [] : [ROOT]), '--hidden', ...(WRITES ? ['--writes'] : []), ...(READ_ONLY ? ['--read-only'] : [])]

const startsWithWindows = () =>
  app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin

function buildTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.on('double-click', showWindow)
  tray.on('click', showWindow)
  refreshTray()
}

function refreshTray() {
  if (!tray) return
  tray.setToolTip(muted ? 'J.A.R.V.I.S. — microphone muted' : 'J.A.R.V.I.S.')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show J.A.R.V.I.S.', accelerator: 'Ctrl+Alt+J', click: showWindow },
      {
        label: 'Mute microphone',
        type: 'checkbox',
        checked: muted,
        accelerator: 'Ctrl+Alt+M',
        click: (item) => sendMute(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startsWithWindows(),
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: process.execPath,
            args: loginArgs(),
          })
        },
      },
      { label: 'Reload interface', click: () => win?.loadURL(faceUrl) },
      { label: 'Restart brain', click: restartBridge },
      { label: 'Open logs folder', click: () => void shell.openPath(LOGS) },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]),
  )
}

ipcMain.on('jarvis:muted', (e, on) => {
  if (!win || e.sender !== win.webContents) return
  muted = Boolean(on)
  refreshTray()
})

function quit() {
  quitting = true
  app.quit()
}

// -- memory, written down -----------------------------------------------------

/**
 * Every ten minutes, what the interface is using. If the page is leaking
 * again, this is the record that shows it — and roughly when it started.
 */
function watchMemory() {
  setInterval(() => {
    const parts = app
      .getAppMetrics()
      .map((m) => `${m.type}:${Math.round((m.memory?.workingSetSize ?? 0) / 1024)}MB`)
    log('memory', parts.join(' '))
  }, 10 * 60_000).unref()
}

// -- start and stop -----------------------------------------------------------

app.on('second-instance', showWindow)

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopBridge()
  if (devServer && devServer.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(devServer.pid), '/T', '/F'], { windowsHide: true })
    } else devServer.kill()
  }
})

// Hidden in the tray is still running; only Quit ends him.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  log(`starting${DEV ? ' (dev)' : ''}${HIDDEN ? ' (hidden)' : ''}`)

  if (!DEV && !fs.existsSync(path.join(DIST, 'index.html'))) {
    dialog.showErrorBox(
      'J.A.R.V.I.S.',
      'The interface has not been built yet.\n\nRun `npm run desktop:build` in the JARVIS folder, then start the app again.',
    )
    return quit()
  }

  startBridge()
  try {
    faceUrl = DEV ? await startDevFace() : await serveFace()
  } catch (err) {
    dialog.showErrorBox('J.A.R.V.I.S.', `Could not serve the interface: ${err.message}`)
    return quit()
  }
  log(`face on ${faceUrl}`)

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isOurs(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => isOurs(origin) && ALLOWED_PERMISSIONS.has(permission))

  buildTray()
  // The page dials the bridge the moment it loads. The bridge needs a few
  // seconds to read its config first, so a window opened straight away met a
  // closed port and showed "Cannot reach the bridge" for the rest of the run.
  await waitForBridge()
  createWindow()
  watchMemory()

  // Ctrl+Alt rather than Ctrl+Shift: Ctrl+Shift+M is Teams' own mute, and a
  // global shortcut would take it away from Teams.
  if (!globalShortcut.register('Control+Alt+M', () => sendMute(null))) {
    log('could not register Ctrl+Alt+M — another app has it')
  }
  if (!globalShortcut.register('Control+Alt+J', toggleWindow)) {
    log('could not register Ctrl+Alt+J — another app has it')
  }
})
