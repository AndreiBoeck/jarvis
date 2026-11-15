import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LiveBrowser,
  MAX_TABS,
  browserCandidates,
  findBrowser,
  keyEventParams,
  virtualKey,
  liveUrlProblem,
  viewportFor,
} from '../bridge/livebrowser.mjs'

test('only web pages open, and never the bridge itself', () => {
  assert.equal(liveUrlProblem('https://www.google.com/maps/dir/a/b'), null)
  assert.equal(liveUrlProblem('http://localhost:5173/'), null, 'a dev server is fine')
  assert.match(liveUrlProblem('file:///etc/passwd'), /only http/)
  assert.match(liveUrlProblem('chrome://settings'), /only http/)
  assert.match(liveUrlProblem('javascript:alert(1)'), /only http/)
  assert.match(liveUrlProblem('not a url'), /not a URL/)
  assert.match(liveUrlProblem('http://127.0.0.1:8787/file?path=/x', { bridgePort: 8787 }), /bridge/)
  assert.match(liveUrlProblem('http://localhost:9000/', { bridgePort: 9000 }), /bridge/)
})

test('finds an installed Chrome, Edge or Chromium on each platform', () => {
  const mac = browserCandidates('darwin', { HOME: '/Users/me' })
  assert.equal(mac[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  assert.ok(mac.some((p) => p.includes('Microsoft Edge')))
  const win = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' })
  assert.ok(win.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'))
  const linux = browserCandidates('linux', { PATH: '/usr/bin:/snap/bin' })
  assert.ok(linux.includes('/usr/bin/chromium'))
  assert.deepEqual(browserCandidates('linux', { JARVIS_LIVE_BROWSER: '/opt/x' }), ['/opt/x'])
  assert.equal(
    findBrowser({ platform: 'win32', env: { PROGRAMFILES: 'P' }, exists: (p) => p.endsWith('msedge.exe') }),
    'P\\Microsoft\\Edge\\Application\\msedge.exe',
  )
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '' }, exists: () => true }), null)
})

test('keys: a printable key types, a command key does not, Enter submits', () => {
  assert.deepEqual(keyEventParams({ event: 'down', key: 'a', code: 'KeyA', keyCode: 65 }), {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 0,
    text: 'a',
    unmodifiedText: 'a',
  })
  assert.equal(keyEventParams({ event: 'down', key: 'Backspace', keyCode: 8 }).type, 'rawKeyDown')
  assert.equal(keyEventParams({ event: 'down', key: 'c', mods: 4 }).type, 'rawKeyDown', '⌘C types nothing')
  assert.equal(keyEventParams({ event: 'down', key: 'A', mods: 8 }).text, 'A', 'shift still types')
  assert.equal(keyEventParams({ event: 'down', key: 'Enter', keyCode: 13 }).text, '\r')
  assert.equal(keyEventParams({ event: 'up', key: 'a' }).type, 'keyUp')
})

test('a missing or phone-keyboard key code is filled in, so Enter submits', () => {
  assert.equal(virtualKey('Enter', 0), 13)
  assert.equal(virtualKey('Enter', 229), 13, 'Android IMEs report 229')
  assert.equal(virtualKey('a', 0), 65)
  assert.equal(virtualKey('7', undefined), 55)
  assert.equal(virtualKey('ArrowDown', 0), 40)
  assert.equal(virtualKey('é', 0), 0)
  assert.equal(virtualKey('a', 65), 65, 'a real code is kept')
  assert.equal(keyEventParams({ event: 'down', key: 'Enter' }).windowsVirtualKeyCode, 13)
})

test('a blade size becomes a sane viewport', () => {
  assert.deepEqual(viewportFor({ w: 812.4, h: 500, mobile: false }), { width: 812, height: 500, mobile: false })
  assert.deepEqual(viewportFor({ w: 10, h: 99999 }), { width: 320, height: 1400, mobile: false })
  assert.deepEqual(viewportFor({}), { width: 1280, height: 800, mobile: false })
})

test('messages for a tab another screen owns are ignored; unknown tabs report closed', async () => {
  const lb = new LiveBrowser({ log: () => {} })
  const sent = []
  const a = { send: (m) => sent.push(['a', m]), buffered: () => 0 }
  const b = { send: (m) => sent.push(['b', m]), buffered: () => 0 }
  lb.tabs.set('t1', { id: 't1', owner: a, sessionId: 's', viewport: viewportFor() })
  lb.call = async () => {
    throw new Error('should not reach the browser')
  }
  await lb.handle(b, { op: 'mouse', id: 't1', event: 'down', x: 1, y: 1 })
  assert.deepEqual(sent, [])
  await lb.handle(b, { op: 'nav', id: 'nope', action: 'reload' })
  assert.deepEqual(sent, [['b', { type: 'live', op: 'closed', id: 'nope' }]])
})

// The real thing, when a browser is installed: open a page that only exists
// once its script has run, see a frame, click it, and watch the click land.
const bin = findBrowser()
test('a real browser: the page script runs, frames arrive, a click lands', { skip: !bin && 'no Chrome/Edge/Chromium here', timeout: 40_000 }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'jarvis-live-'))
  const lb = new LiveBrowser({ profileDir, log: () => {} })
  const got = []
  const owner = { send: (m) => got.push(m), buffered: () => 0 }
  const wait = async (pred, ms = 15_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const hit = got.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('timed out waiting')
  }
  // A data: URL cannot be opened from a blade, so serve the page locally.
  const http = await import('node:http')
  const page =
    '<!doctype html><body style="margin:0"><script>document.body.innerHTML=' +
    '\'<button id=b style="width:100vw;height:100vh">drawn by script</button>\';' +
    'b.onclick=()=>{document.title="clicked"}</script>'
  const server = http.createServer((_, res) => res.end(page)).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  try {
    await lb.handle(owner, { op: 'open', id: 'blade-1', url, w: 400, h: 300 })
    const frame = await wait((m) => m.op === 'frame' && m.data)
    assert.equal(frame.w, 400)
    await lb.handle(owner, { op: 'mouse', id: 'blade-1', event: 'down', x: 200, y: 150, button: 'left', clicks: 1 })
    await lb.handle(owner, { op: 'mouse', id: 'blade-1', event: 'up', x: 200, y: 150, button: 'left', clicks: 1 })
    await wait((m) => m.op === 'state' && m.title === 'clicked')
    // The tab limit holds: opening more closes the oldest and says so.
    for (let i = 2; i <= MAX_TABS + 1; i++) await lb.handle(owner, { op: 'open', id: `blade-${i}`, url, w: 320, h: 240 })
    assert.equal(lb.tabs.size, MAX_TABS)
    assert.ok(got.some((m) => m.op === 'closed' && m.id === 'blade-1'))
    await lb.handle(owner, { op: 'close', id: 'blade-2' })
    assert.equal(lb.tabs.has('blade-2'), false)
  } finally {
    lb.shutdown()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    rmSync(profileDir, { recursive: true, force: true })
  }
})
