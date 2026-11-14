import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { micConstraints, echoTuning } = await import('../src/lib/micProfile.ts')

test('the Android app opens the microphone with no call-mode processing', () => {
  // Any of these set makes Android WebView put the phone in MODE_IN_COMMUNICATION.
  assert.deepEqual(micConstraints(true), {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  })
})

test('the desktop and the Mac keep the browser processing on', () => {
  assert.deepEqual(micConstraints(false), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  })
})

test('the desktop and the Mac keep their echo tuning unchanged', () => {
  assert.deepEqual(echoTuning(false), { guardBoost: 2.4, selfGuardMs: 350, echoRatio: 0.6 })
})

test('without a canceller, the app guards harder against its own echo', () => {
  const app = echoTuning(true)
  const desk = echoTuning(false)
  assert.ok(app.guardBoost > desk.guardBoost, 'higher barge-in threshold')
  assert.ok(app.selfGuardMs > desk.selfGuardMs, 'longer deaf window on his first syllable')
  assert.ok(app.echoRatio < desk.echoRatio, 'less overlap needed to call it echo')
  assert.ok(app.echoRatio > 0 && app.echoRatio < 1)
})
