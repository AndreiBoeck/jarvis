import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { modeForPhase, wakeAtStart, busyAction } = await import('../src/lib/listenPolicy.ts')

test('each phase listens the way it should', () => {
  assert.equal(modeForPhase('offline'), 'deaf')
  assert.equal(modeForPhase('boot'), 'deaf')
  assert.equal(modeForPhase('dormant'), 'wake')
  assert.equal(modeForPhase('waking'), 'command')
  assert.equal(modeForPhase('listening'), 'command')
  // Working on an answer: only "Hey JARVIS" gets through.
  assert.equal(modeForPhase('thinking'), 'busy')
  assert.equal(modeForPhase('tooling'), 'busy')
  // Talking: anything is an interruption, as before.
  assert.equal(modeForPhase('speaking'), 'guard')
})

test('his name at the start, with or without a greeting, in both languages', () => {
  for (const [said, rest] of [
    ['Hey JARVIS', ''],
    ['hey jarvis.', ''],
    ['Hey, Jarvis!', ''],
    ['Hei Jarvis, para', 'para'],
    ['Ei Jarvis cancela isso', 'cancela isso'],
    ['E aí, Jarvis, qual a previsão?', 'qual a previsão?'],
    ['E ai jarvis', ''],
    ['Jarvis, stop', 'stop'],
    ['jarvis what time is it', 'what time is it'],
    ['Hey Travis, never mind', 'never mind'],
    ['Hey Jervis', ''],
    ['Hey J.A.R.V.I.S., the weather', 'the weather'],
    ['  "Hey Jarvis — new question', 'new question'],
    ['OK Jarvis, open the door', 'open the door'],
  ]) {
    assert.equal(wakeAtStart(said), rest, `"${said}"`)
  }
})

test('talk that does not open with his name is not for him', () => {
  for (const said of [
    'what are you doing tonight',
    'ask Jarvis later',
    'I think hey jarvis is a silly name',
    "Jarvis's voice is odd",
    'Jarvisson called',
    'hey',
    'ei, olha isso',
    '',
  ]) {
    assert.equal(wakeAtStart(said), null, `"${said}"`)
  }
})

test('while busy: dropped, woken, or a new request', () => {
  assert.deepEqual(busyAction('so then she said no'), { kind: 'drop' })
  assert.deepEqual(busyAction('Hey JARVIS'), { kind: 'wake' })
  assert.deepEqual(busyAction('Hey Jarvis, what is the weather in Porto Alegre'), {
    kind: 'command',
    text: 'what is the weather in Porto Alegre',
  })
})
