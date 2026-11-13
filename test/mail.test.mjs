import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mailroom, parseClock, present } from '../bridge/mail.mjs'

const at = (h, m = 0, day = 13) => new Date(2026, 10, day, h, m).getTime()

function room({ now, gather, notify } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-mail-'))
  const clock = { t: now ?? at(6) }
  const calls = []
  const notes = []
  const r = new Mailroom({
    file: join(dir, 'mail.json'),
    now: () => clock.t,
    morningAt: 7 * 60,
    reportAt: 14 * 60,
    gather:
      gather ??
      (async (kind, since) => {
        calls.push({ kind, since })
        return { emails: [{ from: 'Ana', subject: kind, received: '08:00', summary: 's' }], speech: kind }
      }),
    notify: notify ?? ((kind) => notes.push(kind)),
  })
  return { r, clock, calls, notes, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const settle = () => new Promise((res) => setTimeout(res, 10))

test('clock times parse, and nonsense falls back', () => {
  assert.equal(parseClock('07:00', 0), 420)
  assert.equal(parseClock('14', 0), 840)
  assert.equal(parseClock('9h30', 0), 570)
  assert.equal(parseClock('25:00', 5), 5)
  assert.equal(parseClock(undefined, 5), 5)
})

test('the morning is gathered at seven and the report at two, once each', async () => {
  const t = room()
  await t.r.tick()
  assert.equal(t.calls.length, 0, 'nothing before seven')

  t.clock.t = at(7, 1)
  await t.r.tick()
  await settle()
  await t.r.tick()
  await settle()
  assert.deepEqual(t.calls.map((c) => c.kind), ['morning'])
  assert.deepEqual(t.notes, ['morning'])

  t.clock.t = at(14, 0)
  await t.r.tick()
  await settle()
  assert.deepEqual(t.calls.map((c) => c.kind), ['morning', 'report'])
  // The report covers what came in since the morning look.
  assert.equal(t.calls[1].since, at(7, 1))
  assert.deepEqual(t.notes, ['morning', 'report'])
  t.done()
})

test('a new day starts over', async () => {
  const t = room({ now: at(7, 5) })
  await t.r.tick()
  await settle()
  t.clock.t = at(7, 5, 14)
  await t.r.tick()
  await settle()
  assert.equal(t.calls.filter((c) => c.kind === 'morning').length, 2)
  t.done()
})

test('collecting is not showing: only markShown makes it go away', async () => {
  const t = room({ now: at(9) })
  await t.r.tick()
  await settle()
  const first = await t.r.collect()
  assert.deepEqual(first.map((i) => i.kind), ['morning'])
  assert.equal((await t.r.collect()).length, 1, 'still owed until shown')
  t.r.markShown(first)
  assert.equal((await t.r.collect()).length, 0, 'read once a day')
  t.done()
})

test('switched on with nothing gathered, the briefing is gathered there and then', async () => {
  const t = room({ now: at(5) })
  const items = await t.r.collect({ gatherMissing: true })
  assert.deepEqual(items.map((i) => i.kind), ['morning'])
  assert.equal(t.calls.length, 1)
  t.done()
})

test('a morning gathered after the report already covers it', async () => {
  const t = room({ now: at(16) })
  await t.r.tick() // after two: the report only — the morning waits to be asked for
  await settle()
  assert.deepEqual(t.calls.map((c) => c.kind), ['report'])
  t.clock.t = at(16, 30)
  const items = await t.r.collect({ gatherMissing: true })
  assert.deepEqual(items.map((i) => [i.kind, !!i.covered]), [['morning', false], ['report', true]])
  t.done()
})

test('a failed gathering is retried later, not every minute', async () => {
  let n = 0
  const t = room({
    now: at(7),
    gather: async () => {
      n++
      throw new Error('offline')
    },
  })
  await t.r.tick()
  await settle()
  t.clock.t = at(7, 5)
  await t.r.tick()
  await settle()
  assert.equal(n, 1)
  t.clock.t = at(7, 16)
  await t.r.tick()
  await settle()
  assert.equal(n, 2)
  t.done()
})

test('what is shown is escaped, one blade per email plus the day', () => {
  const { blades, speech } = present(
    {
      kind: 'morning',
      data: {
        emails: [
          { from: 'Bob <bob@x.com>', subject: '<img src=x onerror=alert(1)>', received: '07:10', summary: 'a & b' },
          { from: 'Ana', subject: 'Contrato', received: '06:00', summary: 'assinar' },
        ],
        weather: { place: 'Porto Alegre', now: '21°', high: '27°', low: '18°', rain: '30%', summary: 'Sunny.' },
        events: [{ time: '10:00', title: 'Call' }],
        notes: [],
        speech: 'Two emails.',
      },
    },
    at(8),
  )
  assert.equal(blades.length, 3)
  assert.ok(!blades[0].html.includes('<img'), 'markup from the mail is never rendered')
  assert.ok(blades.every((b) => b.hold === 'sticky'))
  assert.equal(blades[2].title, 'TODAY')
  assert.equal(speech, 'Good morning, sir. Two emails.')

  const empty = present({ kind: 'report', at: at(14), data: { emails: [], others: 0, speech: '' } }, at(14))
  assert.equal(empty.blades.length, 0)
  assert.match(empty.speech, /Nothing new/)
})
