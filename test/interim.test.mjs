import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { wakeStep, emitNow, readResults, FINAL_GRACE_MS } = await import('../src/lib/interim.ts')

test('from standby: a guess never asks — only final words do', () => {
  // "Hey Jarvis, search the web … tell me the" is still a guess: wait.
  assert.deepEqual(wakeStep('search the web and tell me the', false), { kind: 'await' })
  // The same sentence once final: wake with the whole request.
  assert.deepEqual(wakeStep('search the web and tell me the headline', true), {
    kind: 'fire',
    trailing: 'search the web and tell me the headline',
  })
  // "Hey Jarvis" alone answers quickly, final or not.
  assert.deepEqual(wakeStep('', false), { kind: 'quick' })
  assert.deepEqual(wakeStep('', true), { kind: 'fire', trailing: '' })
})

test('a quiet gap waits for the final, but not forever', () => {
  assert.equal(emitNow(false, 0), true, 'final words go at once')
  assert.equal(emitNow(true, 0), false, 'a guess waits for its final')
  assert.equal(emitNow(true, FINAL_GRACE_MS - 1), false)
  assert.equal(emitNow(true, FINAL_GRACE_MS), true, 'then the guess is used')
})

const r = (transcript, isFinal) => ({ transcript, isFinal })

test('one sentence is one sentence: a late final for words already used is ignored', () => {
  // Chrome: index 0 is a guess, then the same index turns final.
  const guess = [r('hey jarvis forget the stopwatch', false)]
  const final = [r('hey jarvis forget the stopwatch screen', true)]
  assert.deepEqual(readResults(guess, 0, -1), { fresh: '', interim: 'hey jarvis forget the stopwatch', last: 0 })
  assert.deepEqual(readResults(final, 0, -1), { fresh: 'hey jarvis forget the stopwatch screen', interim: '', last: 0 })
  // Index 0 was handed on: its late final is not heard again …
  assert.deepEqual(readResults(final, 0, 0), { fresh: '', interim: '', last: -1 })
  // … but the next sentence, at index 1, is.
  const next = [...final, r('what time is it', true)]
  assert.deepEqual(readResults(next, 0, 0), { fresh: 'what time is it', interim: '', last: 1 })
})

test('after answering to his name alone, the rest of that breath is the command', () => {
  const strip = { index: 0, fn: (t) => t.replace(/^hey jarvis\s*/i, '') }
  assert.deepEqual(readResults([r('hey jarvis what time is it', true)], 0, -1, strip), {
    fresh: 'what time is it',
    interim: '',
    last: 0,
  })
  // Only that result: a later one keeps its words.
  assert.equal(readResults([r('hey jarvis', true), r('hey jarvis again', false)], 1, -1, strip).interim, 'hey jarvis again')
})
