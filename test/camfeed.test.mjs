import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CamHub,
  MAX_PULL_FAILURES,
  QUALITY_STEPS,
  START_STEP,
  adaptStep,
  hostLabel,
  hostMinutes,
  resolveSource,
  screenLabel,
} from '../bridge/camfeed.mjs'
import { pickDevice } from '../bridge/hostcam.mjs'

const { minutesLeft, watchersText } = await import('../src/lib/camStatus.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick()
}

/** A screen as the hub sees it, recording what it is sent. */
function fakeScreen(id, kind, name = '', since = id) {
  const sent = []
  return { id, kind, name, since, sent, send: (m) => sent.push(m), buffered: () => 0, of: (op) => sent.filter((m) => m.op === op) }
}

function fakeHost() {
  const h = { started: 0, stopped: 0, frames: 0, fail: false }
  h.available = () => true
  h.start = async () => void h.started++
  h.stop = () => void h.stopped++
  h.frame = async () => {
    if (h.fail) throw new Error('no picture')
    h.frames++
    return { data: 'HOST', w: 640, h: 360 }
  }
  return h
}

function hub(opts = {}) {
  let t = 1_000_000
  const clock = { now: () => t, advance: (ms) => (t += ms) }
  const h = new CamHub({ home: 'PC', hostMs: 10 * 60_000, now: clock.now, ...opts })
  return { h, clock }
}

test('a spoken name finds the right camera', () => {
  const pc = fakeScreen(1, 'pc')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  const mac = fakeScreen(3, 'mac', 'Air')
  const screens = [pc, phone, mac]
  assert.deepEqual(resolveSource(undefined, { screens, viewer: phone }), { local: true })
  assert.deepEqual(resolveSource('here', { screens, viewer: phone }), { local: true })
  assert.equal(resolveSource('pc', { screens, viewer: phone }).screen, pc, 'the PC interface, when open')
  assert.equal(resolveSource('phone', { screens, viewer: pc }).screen, phone)
  assert.equal(resolveSource('Pixel', { screens, viewer: pc }).screen, phone, 'by paired name')
  assert.equal(resolveSource('MAC', { screens, viewer: pc }).screen, mac)
  assert.deepEqual(resolveSource('pc', { screens, viewer: pc }), { local: true }, 'its own camera is not a feed')
  // No interface open on the PC: the bridge captures itself.
  assert.deepEqual(resolveSource('pc', { screens: [phone], viewer: phone }), { host: true })
  assert.match(resolveSource('pc', { screens: [phone], viewer: phone, hostAvailable: false }).error, /no Chrome or Edge/)
  // On a Mac bridge the host is called "Mac" — but a paired Mac app still wins.
  assert.deepEqual(resolveSource('mac', { screens: [phone], viewer: phone, home: 'Mac' }), { host: true })
  assert.match(resolveSource('phone', { screens: [pc], viewer: pc }).error, /not open on the phone/)
  assert.match(resolveSource('toaster', { screens, viewer: pc }).error, /no connected device/)
  // The newest of a kind.
  const phone2 = fakeScreen(4, 'phone', 'Pixel', 99)
  assert.equal(resolveSource('phone', { screens: [...screens, phone2], viewer: pc }).screen, phone2)
})

test('labels say whose camera, and that nobody can see a banner on the host', () => {
  assert.equal(screenLabel({ kind: 'pc' }, 'PC'), 'PC')
  assert.equal(screenLabel({ kind: 'phone', name: 'Pixel' }), 'phone (Pixel)')
  assert.equal(screenLabel({ kind: 'mac', name: '' }), 'Mac')
  assert.match(hostLabel('PC'), /no JARVIS screen open there/)
  assert.equal(hostMinutes({}), 10)
  assert.equal(hostMinutes({ JARVIS_CAMERA_HOST_MINUTES: '3' }), 3)
  assert.equal(hostMinutes({ JARVIS_CAMERA_HOST_MINUTES: 'x' }), 10)
})

test('nothing streams without a grant from a tool call', () => {
  const { h } = hub()
  const pc = fakeScreen(1, 'pc')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  h.addScreen(pc)
  h.addScreen(phone)
  h.handle(pc.id, { op: 'watch', id: 'b-forged' })
  assert.match(pc.of('ended')[0].reason, /not asked for/)
  assert.equal(phone.sent.length, 0, 'the phone camera never heard about it')
  assert.equal(h.feeds.size, 0)
})

test('the PC watches the phone: banner on the phone, frames pulled one at a time, acked', async () => {
  const { h } = hub()
  const pc = fakeScreen(1, 'pc')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  h.addScreen(pc)
  h.addScreen(phone)
  const g = h.grant('b1', 'phone', pc.id)
  assert.deepEqual(g, { source: 'screen:2', label: 'phone (Pixel)', host: false })
  h.handle(pc.id, { op: 'watch', id: 'b1' })
  assert.deepEqual(phone.of('start')[0], { type: 'cam', op: 'start', feed: 'screen:2', to: ['PC'] })
  assert.equal(pc.of('state')[0].label, 'phone (Pixel)')
  const pull = phone.of('pull')[0]
  assert.equal(pull.w, QUALITY_STEPS[START_STEP].w)
  // No second pull until this one is answered.
  assert.equal(phone.of('pull').length, 1)
  h.handle(phone.id, { op: 'frame', n: pull.n, data: 'JPEG1', w: 640, h: 360 })
  await settle()
  assert.equal(pc.of('frame')[0].data, 'JPEG1')
  // The source may not run ahead of the viewer: still one pull until the ack.
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(phone.of('pull').length, 1)
  h.handle(pc.id, { op: 'ack', id: 'b1' })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(phone.of('pull').length, 2)
  // A frame answering an old pull is ignored.
  h.handle(phone.id, { op: 'frame', n: 999, data: 'STALE' })
  await settle()
  assert.equal(pc.of('frame').length, 1)
  // Closing the blade: no viewers, so the phone camera stops.
  h.handle(pc.id, { op: 'close', id: 'b1' })
  assert.deepEqual(phone.of('stop')[0], { type: 'cam', op: 'stop', feed: 'screen:2' })
  assert.equal(h.feeds.size, 0)
})

test('cut at the source ends every viewer; voice turns everything off', () => {
  const { h } = hub()
  const pc = fakeScreen(1, 'pc')
  const mac = fakeScreen(3, 'mac', 'Air')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  for (const s of [pc, mac, phone]) h.addScreen(s)
  h.grant('b1', 'phone', pc.id)
  h.grant('b2', 'phone', mac.id)
  h.handle(pc.id, { op: 'watch', id: 'b1' })
  h.handle(mac.id, { op: 'watch', id: 'b2' })
  assert.deepEqual(phone.of('start').at(-1).to, ['PC', 'Mac (Air)'], 'the banner names both')
  h.handle(phone.id, { op: 'cut' })
  assert.match(pc.of('ended')[0].reason, /Cut on the phone/)
  assert.match(mac.of('ended')[0].reason, /Cut on the phone/)
  assert.equal(phone.of('stop').length, 1)

  h.grant('b3', 'mac', phone.id)
  h.handle(phone.id, { op: 'watch', id: 'b3' })
  assert.equal(h.stopAll(), 1)
  assert.match(phone.of('ended').at(-1).reason, /by voice/)
})

test('a source or viewer that disconnects takes its feed down with it', () => {
  const { h } = hub()
  const pc = fakeScreen(1, 'pc')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  h.addScreen(pc)
  h.addScreen(phone)
  h.grant('b1', 'phone', pc.id)
  h.handle(pc.id, { op: 'watch', id: 'b1' })
  h.dropScreen(phone.id)
  assert.match(pc.of('ended')[0].reason, /disconnected/)
  assert.equal(h.feeds.size, 0)

  const phone2 = fakeScreen(5, 'phone', 'Pixel')
  h.addScreen(phone2)
  h.grant('b2', 'pc', phone2.id)
  // PC interface is open: it is the source, not the bridge.
  h.handle(phone2.id, { op: 'watch', id: 'b2' })
  assert.equal(pc.of('start').length, 1)
  h.dropScreen(phone2.id)
  assert.equal(pc.of('stop').length, 1, 'the last viewer left, so the PC camera stops')
})

test('a reconnected viewer reclaims its blade; another screen cannot', () => {
  const { h } = hub()
  const pc = fakeScreen(1, 'pc')
  const phone = fakeScreen(2, 'phone', 'Pixel')
  const mac = fakeScreen(3, 'mac')
  for (const s of [pc, phone, mac]) h.addScreen(s)
  h.grant('b1', 'phone', pc.id)
  h.handle(mac.id, { op: 'watch', id: 'b1' })
  assert.match(mac.of('ended')[0].reason, /another screen/)
  h.dropScreen(pc.id)
  const pcAgain = fakeScreen(9, 'pc')
  h.addScreen(pcAgain)
  h.handle(pcAgain.id, { op: 'watch', id: 'b1' })
  assert.equal(phone.of('start').length, 1)
  h.shutdown()
})

test('the bridge’s own capture: viewers are told, and it stops itself unless asked again', async () => {
  const host = fakeHost()
  const { h, clock } = hub({ hostCamera: host })
  const phone = fakeScreen(2, 'phone', 'Pixel')
  h.addScreen(phone)
  const g = h.grant('b1', 'pc', phone.id)
  assert.equal(g.host, true)
  assert.match(g.label, /no JARVIS screen open there/)
  h.handle(phone.id, { op: 'watch', id: 'b1' })
  const st = phone.of('state')[0]
  assert.equal(st.host, true)
  assert.equal(st.until, clock.now() + 10 * 60_000)
  await settle()
  assert.equal(host.started, 1)
  assert.equal(phone.of('frame')[0].data, 'HOST')

  // Nine minutes in, asked again: the clock restarts and the viewer hears it.
  clock.advance(9 * 60_000)
  h.grant('b2', 'pc', phone.id)
  assert.equal(phone.of('state').at(-1).until, clock.now() + 10 * 60_000)
  clock.advance(9 * 60_000)
  h.checkExpiry()
  assert.equal(h.feeds.size, 1, 'renewed, still running')
  clock.advance(60_001)
  h.checkExpiry()
  assert.equal(h.feeds.size, 0)
  assert.equal(host.stopped, 1, 'camera released')
  assert.match(phone.of('ended').at(-1).reason, /turns itself off after 10 minutes/)
  // And re-watching the old blade does not quietly turn it back on.
  h.handle(phone.id, { op: 'watch', id: 'b1' })
  assert.equal(host.started, 1)
  assert.match(phone.of('ended').at(-1).reason, /Ask JARVIS again/)
  h.shutdown()
})

test('a camera that keeps failing is given up, and says why', async () => {
  const host = fakeHost()
  host.fail = true
  const { h } = hub({ hostCamera: host })
  const phone = fakeScreen(2, 'phone')
  h.addScreen(phone)
  h.grant('b1', 'pc', phone.id)
  h.handle(phone.id, { op: 'watch', id: 'b1' })
  await new Promise((r) => setTimeout(r, 100 * (MAX_PULL_FAILURES + 2)))
  assert.equal(h.feeds.size, 0)
  assert.match(phone.of('ended')[0].reason, /no picture/)
})

test('quality follows the link one step at a time', () => {
  assert.equal(adaptStep(2, 1500), 1)
  assert.equal(adaptStep(0, 1500), 0)
  assert.equal(adaptStep(2, 100), 3)
  assert.equal(adaptStep(QUALITY_STEPS.length - 1, 50), QUALITY_STEPS.length - 1)
  assert.equal(adaptStep(2, 400), 2)
})

test('the webcam is chosen by any part of its name, or its id', () => {
  const devs = [
    { kind: 'audioinput', deviceId: 'm', label: 'Microphone' },
    { kind: 'videoinput', deviceId: 'a1', label: 'Integrated Webcam (0bda:5520)' },
    { kind: 'videoinput', deviceId: 'b2', label: 'Logitech C920' },
  ]
  assert.equal(pickDevice(devs, 'c920'), 'b2')
  assert.equal(pickDevice(devs, 'a1'), 'a1')
  assert.equal(pickDevice(devs, 'microphone'), null, 'only cameras')
  assert.equal(pickDevice(devs, ''), null, 'no preference: the default')
  assert.equal(pickDevice(devs, 'nothing'), null)
})

test('banner and blade texts', () => {
  assert.equal(watchersText({}), null)
  assert.equal(watchersText({ 'screen:1': ['PC'] }), 'PC')
  assert.equal(watchersText({ a: ['PC', 'phone (Pixel)'], b: ['PC'] }), 'PC AND PHONE (PIXEL)')
  assert.equal(minutesLeft(undefined, 0), null)
  assert.equal(minutesLeft(10 * 60_000, 0), 10)
  assert.equal(minutesLeft(61_000, 0), 2)
  assert.equal(minutesLeft(1000, 5000), 0, "past due reads 0")
})
