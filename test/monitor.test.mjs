// Watches: the scheduler and store behind "keep an eye on this".
//
//   node --test test/
//
// The check is a stub and the clock is fake, so nothing here talks to Claude.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_FAILURES,
  MIN_MINUTES,
  Watchtower,
  checkPrompt,
  clampMinutes,
} from '../bridge/monitor.mjs'
import { decideTool } from '../bridge/policy.mjs'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-watch-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const MIN = 60_000

function rig(results, { listeners = 1 } = {}) {
  let t = 1_700_000_000_000
  const seen = []
  const alerts = []
  const tower = new Watchtower({
    file: join(dir, `w${++n}.json`),
    now: () => t,
    check: async (w) => {
      seen.push(structuredClone(w))
      const r = results.shift()
      if (r instanceof Error) throw r
      return r
    },
    notify: (a) => {
      alerts.push(a)
      return listeners
    },
  })
  return { tower, seen, alerts, advance: (ms) => (t += ms), now: () => t }
}

const quiet = (extra = {}) => ({
  alert: false,
  message: '',
  observation: 'price 310',
  next_check_minutes: 10,
  finished: false,
  ...extra,
})

test('intervals are clamped to sane bounds', () => {
  assert.equal(clampMinutes(0.1), MIN_MINUTES)
  assert.equal(clampMinutes(-5, 30), 30)
  assert.equal(clampMinutes('nope', 15), 15)
  assert.equal(clampMinutes(45), 45)
  assert.equal(clampMinutes(1e9), 7 * 24 * 60)
})

test('a new watch checks at once, then follows the interval the check chose', async () => {
  const { tower, seen, advance } = rig([quiet({ next_check_minutes: 7 }), quiet()])
  const w = tower.create({ task: 'BTC price', notifyWhen: 'below 60k', intervalMinutes: 15 })
  await tower.running
  assert.equal(seen.length, 1)
  assert.equal(w.intervalMinutes, 7, 'the check retimed it')
  assert.equal(w.lastObservation, 'price 310')

  advance(6 * MIN)
  await tower.tick()
  assert.equal(seen.length, 1, 'not due yet')

  advance(1 * MIN)
  await tower.tick()
  assert.equal(seen.length, 2)
  assert.equal(seen[1].lastObservation, 'price 310', 'the next check sees the last note')
})

test('an alert reaches the interface, and is held when none is connected', async () => {
  const live = rig([quiet({ alert: true, message: 'Sir, it is under sixty thousand.' })])
  live.tower.create({ task: 'BTC', notifyWhen: 'below 60k', intervalMinutes: 5 })
  await live.tower.running
  assert.equal(live.alerts.length, 1)
  assert.equal(live.tower.drainPending().length, 0)

  const away = rig([quiet({ alert: true, message: 'Sir, it is under.' })], { listeners: 0 })
  away.tower.create({ task: 'BTC', notifyWhen: 'below 60k', intervalMinutes: 5 })
  await away.tower.running
  const held = away.tower.drainPending()
  assert.equal(held.length, 1)
  assert.equal(held[0].message, 'Sir, it is under.')
  assert.equal(away.tower.drainPending().length, 0, 'handed over once')
})

test('a watch that finishes stops being checked', async () => {
  const { tower, seen, advance } = rig([quiet({ finished: true, alert: true, message: 'Delivered.' })])
  const w = tower.create({ task: 'parcel', notifyWhen: 'delivered', intervalMinutes: 60 })
  await tower.running
  assert.equal(w.status, 'finished')
  advance(10 * 60 * MIN)
  await tower.tick()
  assert.equal(seen.length, 1)
})

test('failures back off, then pause the watch and say so', async () => {
  const errs = Array.from({ length: MAX_FAILURES }, () => new Error('down'))
  const { tower, alerts, advance, now } = rig(errs)
  const w = tower.create({ task: 'site', notifyWhen: 'down', intervalMinutes: 5 })
  await tower.running
  assert.equal(w.failures, 1)
  assert.equal(w.nextRunAt - now(), 10 * MIN, 'doubled')
  for (let i = 1; i < MAX_FAILURES; i++) {
    advance(2 * 60 * MIN)
    await tower.tick()
  }
  assert.equal(w.status, 'paused')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'paused')

  tower.retime(w.id, 10)
  assert.equal(w.status, 'active', 'retiming resumes it')
  assert.equal(w.failures, 0)
})

test('watches expire, can be stopped, and survive a restart', async () => {
  const { tower, advance } = rig([quiet(), quiet()])
  const a = tower.create({ task: 'a', notifyWhen: 'x', intervalMinutes: 5, forHours: 1 })
  await tower.running
  const b = tower.create({ task: 'b', notifyWhen: 'x', intervalMinutes: 5 })
  await tower.running

  const reloaded = new Watchtower({ file: tower.file, check: async () => quiet(), notify: () => 1 })
  assert.deepEqual(reloaded.active().map((w) => w.task), ['a', 'b'])

  advance(61 * MIN)
  await tower.tick().catch(() => {})
  assert.equal(a.status, 'finished')
  assert.equal(tower.cancel(b.id), 1)
  assert.equal(tower.active().length, 0)
  const saved = JSON.parse(readFileSync(tower.file, 'utf8'))
  assert.ok(saved.watches.every((w) => w.status === 'finished'))
})

test('a check that comes back after its watch was stopped changes nothing', async () => {
  let release
  const tower = new Watchtower({
    file: join(dir, 'race.json'),
    check: () => new Promise((r) => (release = r)),
    notify: () => 1,
  })
  const w = tower.create({ task: 'x', notifyWhen: 'y', intervalMinutes: 5 })
  tower.cancel(w.id)
  release(quiet({ alert: true, message: 'late' }))
  await tower.running
  assert.equal(w.status, 'finished')
  assert.equal(w.lastAlert, null)
})

test('check_now brings a watch forward', async () => {
  const { tower, seen, advance } = rig([quiet({ next_check_minutes: 60 }), quiet()])
  const w = tower.create({ task: 'x', notifyWhen: 'y', intervalMinutes: 60 })
  await tower.running
  advance(MIN)
  tower.checkNow(w.id)
  await tower.running
  assert.equal(seen.length, 2)
  assert.equal(tower.checkNow('nope'), null)
})

test('the check prompt carries the task, the condition and the last note', () => {
  const p = checkPrompt({
    task: 'Price of the Kindle on Amazon BR',
    notifyWhen: 'below R$ 300',
    why: 'prices change daily',
    intervalMinutes: 120,
    runs: 3,
    lastObservation: 'R$ 349',
    lastRunAt: 0,
    lastAlert: null,
    expiresAt: null,
  })
  assert.match(p, /Kindle/)
  assert.match(p, /below R\$ 300/)
  assert.match(p, /R\$ 349/)
  assert.match(p, /check number 4/)
})

test('the watch tools are allowed even in read-only mode', () => {
  for (const t of ['start', 'stop', 'list', 'retime', 'check_now']) {
    assert.equal(decideTool(`mcp__jarvis_watch__${t}`, false), true)
  }
})

test('a check can hand back its structured answer in read-only mode', () => {
  // Measured: with this denied, every check answered in prose and failed.
  assert.equal(decideTool('StructuredOutput', false), true)
})
