import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { actionRegistry, deviceServers, screenActions } from '../bridge/actions.mjs'
import { DEVICE_ACTIONS, decideScreenAction, decideTool } from '../bridge/policy.mjs'
import { screenStore } from '../bridge/screens.mjs'

const calls = []
const registry = () =>
  actionRegistry()
    .register('media.next', { label: 'Próxima faixa', run: async () => (calls.push('next'), { done: 'next' }) })
    .register('media.now_playing', {
      label: 'Ver o que está tocando',
      shape: { app: z.string().max(5).optional() },
      run: async ({ app }) => ({ title: 'Song', app: app ?? null }),
    })

function setup({ confirm = async () => true, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-actions-'))
  const reg = registry()
  const store = screenStore(dir, { validAction: (n) => reg.has(n) })
  const channel = screenActions({ registry: reg, store, confirm, ...opts })
  return { dir, reg, store, channel, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const approved = (store, name, html, actions) => {
  store.save({ name, kind: 'app', html, actions })
  assert.equal(store.approve(name, store.hashOf(store.get(name))), true)
}

test('the registry only takes names from the policy table', () => {
  const reg = actionRegistry()
  assert.throws(() => reg.register('system.shell', { run: () => {} }), /DEVICE_ACTIONS/)
  assert.throws(() => reg.register('rm -rf', { run: () => {} }), /bad action name/)
  assert.throws(() => reg.register('media.next', {}), /run/)
  assert.equal(Object.keys(DEVICE_ACTIONS).every((n) => /^[a-z]+\.[a-z_]+$/.test(n)), true)
})

test('policy: device tools by tier, not by verb; screens get allow / confirm / deny', () => {
  assert.equal(decideTool('mcp__jarvis_media__next'), true, 'safe without writes')
  assert.equal(decideTool('mcp__jarvis_media__now_playing'), true)
  assert.equal(decideTool('mcp__jarvis_media__format_disk'), false, 'unknown tool on a device server')
  assert.equal(decideScreenAction('media.next'), 'allow')
  assert.equal(decideScreenAction('system.shell'), 'deny')
  assert.equal(decideScreenAction('constructor'), 'deny')
})

test('an approved screen runs a declared action', async () => {
  const { store, channel, done } = setup()
  try {
    approved(store, 'player', '<b>p</b>', ['media.next', 'media.now_playing'])
    calls.length = 0
    assert.deepEqual(await channel.handle({ screen: 'player', name: 'media.next' }), { ok: true, result: { done: 'next' } })
    assert.deepEqual(calls, ['next'])
    const np = await channel.handle({ screen: 'player', name: 'media.now_playing', args: { app: 'spot' } })
    assert.deepEqual(np, { ok: true, result: { title: 'Song', app: 'spot' } })
  } finally {
    done()
  }
})

test('refusals: undeclared, unapproved, changed since approval, unknown screen, bad args', async () => {
  const { store, channel, done } = setup()
  try {
    approved(store, 'player', '<b>p</b>', ['media.now_playing'])
    assert.equal((await channel.handle({ screen: 'player', name: 'media.next' })).code, 'not-declared')

    store.save({ name: 'fresh', kind: 'app', html: '<b>f</b>', actions: ['media.next'] })
    assert.equal((await channel.handle({ screen: 'fresh', name: 'media.next' })).code, 'not-approved')

    store.update('player', { html: '<b>changed by the model</b>' })
    assert.equal((await channel.handle({ screen: 'player', name: 'media.now_playing' })).code, 'not-approved')

    assert.equal((await channel.handle({ screen: 'nope', name: 'media.next' })).code, 'no-screen')
    store.save({ name: 'tpl', html: '<b>{{x}}</b>' })
    assert.equal((await channel.handle({ screen: 'tpl', name: 'media.next' })).code, 'no-screen')
    assert.equal((await channel.handle({ name: 'media.next' })).code, 'bad-request')

    approved(store, 'args', '<b>a</b>', ['media.now_playing'])
    assert.equal((await channel.handle({ screen: 'args', name: 'media.now_playing', args: { app: 'far too long' } })).code, 'bad-args')
  } finally {
    done()
  }
})

test('an action declared and approved but missing from this bridge is unavailable', async () => {
  const { store, done } = setup()
  try {
    // media.pause is in the policy table but not registered in this test.
    store.save({ name: 'p', kind: 'app', html: '<b>p</b>', actions: ['media.next'] })
    const saved = store.get('p')
    // Hand-craft an index entry declaring a name the registry lacks.
    const forged = { ...saved, actions: ['media.pause'] }
    const fake = { get: () => forged, isApproved: () => true }
    const ch = screenActions({ registry: registry(), store: fake, confirm: async () => true })
    assert.equal((await ch.handle({ screen: 'p', name: 'media.pause' })).code, 'unavailable')
  } finally {
    done()
  }
})

test('a looping screen is rate limited', async () => {
  let t = 0
  const { store, channel, done } = setup({ perSecond: 3, perMinute: 5, now: () => t })
  try {
    approved(store, 'loop', '<b>l</b>', ['media.next'])
    const codes = []
    for (let i = 0; i < 4; i++) codes.push((await channel.handle({ screen: 'loop', name: 'media.next' })).ok)
    assert.deepEqual(codes, [true, true, true, false])
    t += 1500
    assert.equal((await channel.handle({ screen: 'loop', name: 'media.next' })).ok, true)
    assert.equal((await channel.handle({ screen: 'loop', name: 'media.next' })).ok, true)
    assert.equal((await channel.handle({ screen: 'loop', name: 'media.next' })).code, 'rate-limited', 'five a minute')
    t += 61_000
    assert.equal((await channel.handle({ screen: 'loop', name: 'media.next' })).ok, true, 'and it recovers')
  } finally {
    done()
  }
})

test('a failing action reports the failure instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-actions-'))
  try {
    const reg = actionRegistry().register('media.next', { run: async () => { throw new Error('player gone') } })
    const store = screenStore(dir, { validAction: (n) => reg.has(n) })
    approved(store, 'p', '<b>p</b>', ['media.next'])
    const r = await screenActions({ registry: reg, store, confirm: async () => true }).handle({ screen: 'p', name: 'media.next' })
    assert.deepEqual(r, { ok: false, code: 'failed', error: 'player gone' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registry becomes MCP servers keyed as the policy expects', () => {
  const servers = deviceServers(registry())
  assert.deepEqual(Object.keys(servers), ['jarvis_media'])
  assert.match(registry().catalogue(), /media\.now_playing\(app\)/)
  assert.deepEqual(registry().describe(['media.next']), [{ name: 'media.next', label: 'Próxima faixa', tier: 'safe' }])
})
