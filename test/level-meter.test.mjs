import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { createLevelMeter, RESUME_EVERY_MS } = await import('../src/lib/levelMeter.ts')

/**
 * A fake AudioContext that reproduces what the S25 showed: an analyser wired
 * while the context was suspended reads zeros for ever, even once the context
 * runs; one wired while it runs reads the room.
 */
function fakeContext(initial, { resumeTakes = true } = {}) {
  const ctx = {
    state: initial,
    resumes: 0,
    closed: false,
    onstatechange: null,
    resume() {
      ctx.resumes++
      if (resumeTakes) ctx.become('running')
      return Promise.resolve()
    },
    close() {
      ctx.closed = true
      ctx.state = 'closed'
      return Promise.resolve()
    },
    become(state) {
      ctx.state = state
      ctx.onstatechange?.()
    },
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    },
    createAnalyser() {
      const dead = ctx.state !== 'running'
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 256,
        getByteFrequencyData(buf) {
          buf.fill(dead ? 0 : 80)
        },
      }
    },
  }
  return ctx
}

const stream = {}

test('a context born running reads the room at once and is never touched', () => {
  const ctx = fakeContext('running')
  const m = createLevelMeter(stream, ctx)
  assert.ok(m.level() > 0)
  assert.equal(ctx.resumes, 0)
  assert.equal(m.rewires(), 0)
})

test('born suspended: resumed, then rewired, and the level comes back', () => {
  let t = 0
  const ctx = fakeContext('suspended', { resumeTakes: false })
  const m = createLevelMeter(stream, ctx, () => t)
  assert.equal(ctx.resumes, 1, 'asked to resume straight away')
  assert.equal(m.level(), 0)

  // Resume refused at first; asked again, but not every frame.
  t += 16
  m.level()
  assert.equal(ctx.resumes, 1)
  t += RESUME_EVERY_MS
  m.level()
  assert.equal(ctx.resumes, 2)

  // Seconds later the context runs. The old nodes would read zero for ever.
  ctx.become('running')
  assert.equal(m.rewires(), 1)
  assert.ok(m.level() > 0, 'the reactor pulses again')
})

test('running without a statechange event still heals on the next read', () => {
  const ctx = fakeContext('suspended', { resumeTakes: false })
  const m = createLevelMeter(stream, ctx, () => 0)
  ctx.state = 'running' // no event fired
  assert.ok(m.level() > 0)
  assert.equal(m.rewires(), 1)
})

test('closing lets the context go and stops reading', () => {
  const ctx = fakeContext('running')
  const m = createLevelMeter(stream, ctx)
  m.close()
  assert.ok(ctx.closed)
  assert.equal(m.level(), 0)
  assert.equal(ctx.onstatechange, null)
})
