// Paired devices: tokens, the device hub, and the bridge's door for phones.
//
//   node --test test/
//
// The bridge tests start the real server with its own devices file. None of
// them opens an agent socket, so nothing here talks to Claude.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  DeviceHub,
  PROTOCOL,
  chooseProtocol,
  createDevice,
  deviceForToken,
  listDevices,
  revokeDevice,
  tokenFromRequest,
} from '../bridge/devices.mjs'
import { decideTool } from '../bridge/policy.mjs'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-devices-'))
const file = join(dir, 'devices.json')
after(() => rmSync(dir, { recursive: true, force: true }))

// --- tokens ----------------------------------------------------------------

test('a paired token is recognised, and only its hash is stored', () => {
  const { token, name } = createDevice('Pixel', file)
  assert.equal(name, 'Pixel')
  assert.match(token, /^jv_[A-Za-z0-9_-]{40,}$/)
  assert.equal(deviceForToken(token, file)?.name, 'Pixel')
  assert.ok(!readFileSync(file, 'utf8').includes(token))
  assert.equal(deviceForToken(token.slice(0, -1) + 'x', file), null)
  assert.equal(deviceForToken('', file), null)
  assert.equal(deviceForToken(undefined, file), null)
})

test('names are unique and revoking takes effect at once', () => {
  assert.throws(() => createDevice('pixel', file), /already paired/)
  const { token } = createDevice('Tablet', file)
  const names = listDevices(file).map((d) => d.name)
  assert.ok(names.includes('Pixel') && names.includes('Tablet'))
  assert.ok(listDevices(file).every((d) => !('hash' in d)))
  assert.equal(revokeDevice('tablet', file), true)
  assert.equal(deviceForToken(token, file), null)
  assert.equal(revokeDevice('tablet', file), false)
})

test('the token is read from a bearer header or a websocket subprotocol', () => {
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer jv_abc' } }), 'jv_abc')
  assert.equal(
    tokenFromRequest({ headers: { 'sec-websocket-protocol': 'jarvis.v1, jarvis.token.jv_xyz' } }),
    'jv_xyz',
  )
  assert.equal(tokenFromRequest({ headers: {} }), null)
})

test('the handshake answers jarvis.v1 and never echoes the token', () => {
  assert.equal(chooseProtocol(new Set(['jarvis.token.jv_x', 'jarvis.v1'])), PROTOCOL)
  assert.equal(chooseProtocol(new Set(['jarvis.token.jv_x'])), false)
  assert.equal(chooseProtocol(new Set()), false)
})

// --- policy ----------------------------------------------------------------

test('phone reads run freely; phone actions need write access', () => {
  for (const t of ['status', 'read_screen', 'screenshot', 'read_notifications', 'get_location', 'list_apps']) {
    assert.equal(decideTool(`mcp__jarvis_phone__${t}`), true, t)
  }
  for (const t of ['open_app', 'navigate', 'flashlight', 'tap', 'type_text', 'call', 'send_sms', 'reply_notification']) {
    assert.equal(decideTool(`mcp__jarvis_phone__${t}`), false, t)
    assert.equal(decideTool(`mcp__jarvis_phone__${t}`, true), true, t)
  }
})

// --- the hub ---------------------------------------------------------------

/** Enough of a ws socket for the hub: it records what was sent to the phone. */
function fakeSocket() {
  const s = new EventEmitter()
  s.readyState = 1
  s.sent = []
  s.send = (m) => s.sent.push(JSON.parse(m))
  s.close = () => {
    s.readyState = 3
    s.emit('close')
  }
  return s
}

test('a command reaches the phone and its answer comes back', async () => {
  const hub = new DeviceHub({ pingMs: 60_000 })
  const phone = fakeSocket()
  hub.attach(phone, { id: 'a', name: 'Pixel' })
  phone.emit('message', JSON.stringify({ type: 'device_hello', capabilities: ['open_app'], model: 'Pixel 9' }))
  assert.equal(hub.connected()[0].model, 'Pixel 9')

  const pending = hub.call('open_app', { app: 'Spotify' })
  const sent = phone.sent.at(-1)
  assert.deepEqual([sent.type, sent.tool, sent.args.app], ['device_call', 'open_app', 'Spotify'])
  phone.emit('message', JSON.stringify({ type: 'device_result', id: sent.id, ok: true, text: 'opened' }))
  assert.equal((await pending).text, 'opened')
  phone.close()
})

test('no phone, a dropped phone and a silent phone all fail plainly', async () => {
  const hub = new DeviceHub({ pingMs: 60_000 })
  await assert.rejects(hub.call('status'), /no phone is connected/)

  const phone = fakeSocket()
  hub.attach(phone, { id: 'a', name: 'Pixel' })
  const dropped = hub.call('status')
  phone.close()
  await assert.rejects(dropped, /disconnected/)
  assert.equal(hub.connected().length, 0)

  const quiet = fakeSocket()
  hub.attach(quiet, { id: 'b', name: 'Pixel' })
  await assert.rejects(hub.call('status', {}, { timeoutMs: 20 }), /did not answer/)
  await assert.rejects(hub.call('status', {}, { device: 'Tablet' }), /no phone called "Tablet"/)
  quiet.close()
})

test('a phone that reconnects replaces its old link', () => {
  const hub = new DeviceHub({ pingMs: 60_000 })
  const first = fakeSocket()
  const second = fakeSocket()
  hub.attach(first, { id: 'a', name: 'Pixel' })
  hub.attach(second, { id: 'a', name: 'Pixel' })
  assert.equal(first.readyState, 3)
  assert.equal(hub.connected().length, 1)
  void hub.call('status').catch(() => {})
  assert.equal(second.sent.length, 1)
  second.close()
})

// --- the real bridge ---------------------------------------------------------

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
let bridge
let token

before(async () => {
  token = createDevice('Bridge test phone', file).token
  bridge = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, JARVIS_BRIDGE_PORT: '0', JARVIS_DEVICES_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bridge did not start: ${log}`))
    }, 15_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[1]) })
      }
    })
    child.stderr.on('data', (d) => (log += d))
  })
})
after(() => bridge?.child.kill())

function http(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: bridge.port, method, path, headers, timeout: 3000 },
      (res) => {
        res.resume()
        resolve(res)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Open a socket and resolve 'open' (with its protocol) or the refusal status. */
function ws(path, protocols, headers = {}) {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${bridge.port}${path}`, protocols, { headers })
    s.on('open', () => {
      resolve({ status: 'open', protocol: s.protocol, socket: s })
    })
    s.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    s.on('error', () => resolve({ status: 'error' }))
  })
}

const TAILNET = { host: 'pc.example-tailnet.ts.net', origin: 'https://localhost' }

test('a paired token gets past the host and origin checks over HTTP; nothing else does', async () => {
  assert.equal((await http('GET', '/health', TAILNET)).statusCode, 403)
  assert.equal(
    (await http('GET', '/health', { ...TAILNET, authorization: `Bearer ${token}` })).statusCode,
    200,
  )
  assert.equal(
    (await http('GET', '/health', { ...TAILNET, authorization: 'Bearer jv_wrong' })).statusCode,
    403,
  )
})

test('a preflight that asks to send a token is answered, and grants nothing by itself', async () => {
  const res = await http('OPTIONS', '/health', {
    ...TAILNET,
    'access-control-request-method': 'GET',
    'access-control-request-headers': 'authorization',
  })
  assert.equal(res.statusCode, 204)
  assert.match(res.headers['access-control-allow-headers'], /authorization/)
})

test('the device link needs a token, even from this machine', async () => {
  assert.equal((await ws('/device', [PROTOCOL])).status, 401)
  assert.equal((await ws('/device', [PROTOCOL, 'jarvis.token.jv_wrong'])).status, 401)
  const ok = await ws('/device', [PROTOCOL, `jarvis.token.${token}`], TAILNET)
  assert.equal(ok.status, 'open')
  assert.equal(ok.protocol, PROTOCOL)
  ok.socket.close()
})

test('the HUD socket still refuses a foreign origin without a token', async () => {
  assert.equal((await ws('/ws', [PROTOCOL], TAILNET)).status, 403)
})
