import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { checkApp, checkUrl, registerSystemActions, systemHost } from '../bridge/system.mjs'
import { actionRegistry, screenActions } from '../bridge/actions.mjs'
import { decideScreenAction, decideTool } from '../bridge/policy.mjs'
import { hostScriptText } from '../bridge/media.mjs'
import { screenStore } from '../bridge/screens.mjs'

test('links and app names are vetted before anything runs', () => {
  assert.equal(checkUrl('https://open.spotify.com/x'), 'https://open.spotify.com/x')
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:', 'nope']) {
    assert.throws(() => checkUrl(bad), /link/)
  }
  assert.equal(checkApp(' Calculator '), 'Calculator')
  for (const bad of ['', '-n', 'a; rm -rf ~', 'C:\\Windows\\cmd.exe', '$(x)', 'a'.repeat(61)]) {
    assert.throws(() => checkApp(bad), /app name/)
  }
})

test('policy: volume, lock and display run unasked; apps, links and sleep need writes or a click', () => {
  for (const t of ['volume', 'lock', 'display_off']) {
    assert.equal(decideTool(`mcp__jarvis_pc__${t}`), true, t)
    assert.equal(decideScreenAction(`system.${t}`), 'allow', t)
  }
  for (const t of ['open_app', 'open_url', 'sleep']) {
    assert.equal(decideTool(`mcp__jarvis_pc__${t}`), false, `${t} read-only`)
    assert.equal(decideTool(`mcp__jarvis_pc__${t}`, true), true, `${t} with writes`)
    assert.equal(decideScreenAction(`system.${t}`), 'confirm', t)
  }
  assert.equal(decideTool('mcp__jarvis_pc__shutdown', true), false, 'not in the table, not even with writes')
})

test('Mac: osascript for the volume, open for apps and links, pmset for the display', async () => {
  const runs = []
  let level = 40
  let muted = false
  const run = async (cmd, args) => {
    runs.push([cmd, ...args])
    const set = /set volume output volume (\d+)/.exec(args[1] ?? '')
    if (set) level = Number(set[1])
    if (/output muted true/.test(args[1] ?? '')) muted = true
    return /^get/.test(args[1] ?? '') ? `${level}, ${muted}` : ''
  }
  const sys = systemHost({ platform: 'mac', run })
  assert.deepEqual(await sys.volume(), { level: 40, muted: false })
  assert.deepEqual(await sys.volume({ change: -15 }), { level: 25, muted: false })
  assert.deepEqual(await sys.volume({ level: 180 }), { level: 100, muted: false }, 'clamped')
  assert.deepEqual(await sys.volume({ mute: true }), { level: 100, muted: true })
  await sys.openApp('Calculator')
  await sys.openUrl('https://example.com')
  await sys.displayOff()
  assert.deepEqual(runs.slice(-3), [['open', '-a', 'Calculator'], ['open', 'https://example.com/'], ['pmset', 'displaysleepnow']])
  await assert.rejects(sys.openUrl('file:///etc/passwd'), /link/)
})

test('Windows: every operation goes to the one PowerShell helper, which knows it', async () => {
  const sent = []
  const host = { request: async (op, args = {}) => (sent.push([op, args]), op === 'volume' ? { level: 30, muted: false } : { ok: true }) }
  const sys = systemHost({ platform: 'windows', host })
  await sys.volume({ change: 10 })
  await sys.lock()
  await sys.displayOff()
  await sys.openApp('Spotify')
  await sys.openUrl('https://example.com/a')
  await sys.sleep()
  assert.deepEqual(sent, [
    ['volume', {}],
    ['volume', { level: 40, mute: null }],
    ['lock', {}],
    ['display_off', {}],
    ['open_app', { app: 'Spotify' }],
    ['open_url', { url: 'https://example.com/a' }],
    ['sleep', {}],
  ])
  const ps = hostScriptText()
  for (const op of ["'volume'", "'lock'", "'display_off'", "'sleep'", "'open_app'", "'open_url'", 'IAudioEndpointVolume', 'LockWorkStation', 'Get-StartApps']) {
    assert.ok(ps.includes(op), op)
  }
})

test('a confirm action from a screen waits for the user, and runs only on yes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sys-'))
  try {
    const opened = []
    const backend = { openApp: async (app) => (opened.push(app), { opened: app }), volume: async () => ({ level: 1, muted: false }) }
    const reg = registerSystemActions(actionRegistry(), systemHost({ platform: 'test', backend }), z)
    const store = screenStore(dir, { validAction: (n) => reg.has(n) })
    store.save({ name: 'launcher', kind: 'app', html: '<b>l</b>', actions: ['system.open_app', 'system.volume'] })
    store.approve('launcher', store.hashOf(store.get('launcher')))
    const asked = []
    let answer = false
    const channel = screenActions({ registry: reg, store, confirm: async (q) => (asked.push(q), answer) })

    const no = await channel.handle({ screen: 'launcher', name: 'system.open_app', args: { app: 'Calculator' } })
    assert.equal(no.code, 'declined')
    assert.deepEqual(opened, [])
    assert.equal(asked[0].action.label, 'Abrir um app')
    assert.deepEqual(asked[0].args, { app: 'Calculator' })

    answer = true
    assert.deepEqual(await channel.handle({ screen: 'launcher', name: 'system.open_app', args: { app: 'Calculator' } }), { ok: true, result: { opened: 'Calculator' } })
    assert.deepEqual(opened, ['Calculator'])

    // A safe one never asks.
    asked.length = 0
    assert.equal((await channel.handle({ screen: 'launcher', name: 'system.volume' })).ok, true)
    assert.equal(asked.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
