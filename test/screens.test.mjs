import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_CSP,
  MAX_SCREEN_BYTES,
  approvalHash,
  MAX_SCREENS,
  appDocument,
  fillTemplate,
  screenId,
  screenStore,
  templateFields,
} from '../bridge/screens.mjs'

const KNOWN = new Set(['media.play_pause', 'media.next', 'media.now_playing'])
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-screens-'))
  return {
    dir,
    store: screenStore(dir, { validAction: (a) => KNOWN.has(a) }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('save, list, get, update, forget — and it survives a new store on the same folder', () => {
  const { dir, store, done } = fresh()
  try {
    const e = store.save({
      name: 'Solar Panels',
      description: 'today on the roof',
      html: '<span class="hud-metric">{{kwh}}</span><span class="hud-unit">{{when}}</span>',
    })
    assert.equal(e.id, 'solar-panels')
    assert.equal(e.kind, 'template')
    assert.deepEqual(e.fields, ['kwh', 'when'])

    const again = screenStore(dir)
    assert.equal(again.list().length, 1)
    assert.equal(again.get('solar panels').html.includes('{{kwh}}'), true)

    const u = again.update('Solar Panels', { html: '<b>{{kwh}} kWh</b>', description: 'roof' })
    assert.deepEqual(u.fields, ['kwh'])
    assert.equal(again.get('solar-panels').description, 'roof')

    assert.equal(again.forget('solar panels'), true)
    assert.equal(again.list().length, 0)
    assert.equal(again.get('solar-panels'), null)
    assert.equal(again.forget('solar panels'), false)
  } finally {
    done()
  }
})

test('writes are atomic: nothing half-written or temporary is left behind', () => {
  const { dir, store, done } = fresh()
  try {
    store.save({ name: 'a', html: '<p>a</p>' })
    store.save({ name: 'b', kind: 'app', html: '<script>1</script>' })
    store.update('a', { html: '<p>A</p>' })
    assert.deepEqual(readdirSync(dir).sort(), ['a.html', 'b.html', 'index.json'])
  } finally {
    done()
  }
})

test('limits: a taken name, the size cap, the count cap, an unknown kind, an empty body', () => {
  const { store, done } = fresh()
  try {
    store.save({ name: 'x', html: '<p>x</p>' })
    assert.throws(() => store.save({ name: 'X', html: '<p>y</p>' }), /already/)
    assert.throws(() => store.save({ name: 'big', html: 'a'.repeat(MAX_SCREEN_BYTES + 1) }), /at most/)
    assert.throws(() => store.save({ name: 'k', kind: 'php', html: '<p>k</p>' }), /kind/)
    assert.throws(() => store.save({ name: 'e', html: '   ' }), /needs html/)
    assert.throws(() => store.save({ name: '!!!', html: '<p>k</p>' }), /needs a name/)
    for (let i = 1; i < MAX_SCREENS; i++) store.save({ name: `s${i}`, html: '<p>s</p>' })
    assert.throws(() => store.save({ name: 'one-too-many', html: '<p>s</p>' }), /forget one/)
  } finally {
    done()
  }
})

test('a corrupt index reads as empty instead of crashing the bridge', () => {
  const { dir, store, done } = fresh()
  try {
    writeFileSync(join(dir, 'index.json'), '{not json')
    assert.deepEqual(store.list(), [])
  } finally {
    done()
  }
})

test('names cannot walk out of the folder', () => {
  assert.equal(screenId('../../etc/passwd'), 'etc-passwd')
  assert.equal(screenId('C:\\Windows\\win.ini'), 'c-windows-win-ini')
  assert.equal(screenId('Previsão do Tempo'), 'previsao-do-tempo')
  assert.equal(screenId('...'), '')
})

test('a template is filled with escaped text, never markup', () => {
  const html = '<span class="hud-metric">{{ temp }}</span><span>{{city}}</span><i>{{missing}}</i>'
  assert.deepEqual(templateFields(html), ['temp', 'city', 'missing'])
  const out = fillTemplate(html, { temp: 21, city: '<img src=x onerror=alert(1)>' })
  assert.match(out, /<span class="hud-metric">21<\/span>/)
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(out, /<img/)
  assert.match(out, /<i>—<\/i>/, 'a missing value shows as missing')
})

test('an app screen: the data shim runs first, and the CSP lets nothing leave', () => {
  const doc = appDocument('<html><head><title>t</title></head><body><script>go()</script></body></html>')
  assert.ok(doc.indexOf("m.jarvis==='data'") < doc.indexOf('go()'), 'shim before the screen code')
  assert.match(appDocument('<p>bare</p>'), /^<!doctype html>.*JARVIS_DATA.*<p>bare<\/p>/s)
  // A transparent screen must not be painted white behind (iframe is dark).
  assert.match(doc, /<meta name="color-scheme" content="dark">/)
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"]) {
    assert.ok(APP_CSP.includes(rule), rule)
  }
  assert.doesNotMatch(APP_CSP, /https?:|'self'|\*/, 'no remote origin anywhere')
})

test('actions: declared on save, only known names, only on app screens', () => {
  const { store, done } = fresh()
  try {
    const e = store.save({ name: 'p', kind: 'app', html: '<b>p</b>', actions: ['media.next', 'media.next', 'media.play_pause'] })
    assert.deepEqual(e.actions, ['media.next', 'media.play_pause'], 'deduplicated')
    assert.equal(e.approval, null)
    assert.throws(() => store.save({ name: 'q', kind: 'app', html: '<b>q</b>', actions: ['system.shell'] }), /unknown action/)
    assert.throws(() => store.save({ name: 'r', html: '<b>{{x}}</b>', actions: ['media.next'] }), /only an app screen/)
    assert.throws(() => store.save({ name: 's', kind: 'app', html: '<b>s</b>', actions: 'media.next' }), /list/)
    assert.deepEqual(store.save({ name: 't', kind: 'app', html: '<b>t</b>' }).actions, [])
  } finally {
    done()
  }
})

test('approval is a hash of html + actions, and any change to either voids it', () => {
  const { dir, store, done } = fresh()
  try {
    store.save({ name: 'Deck', kind: 'app', html: '<b>v1</b>', actions: ['media.next'] })
    let saved = store.get('deck')
    assert.equal(store.isApproved(saved), false, 'not approved on save')
    const hash = store.hashOf(saved)
    assert.equal(hash, approvalHash('<b>v1</b>', ['media.next']))
    assert.equal(store.approve('deck', 'not-the-hash'), false)
    assert.equal(store.approve('deck', hash), true)
    assert.equal(store.isApproved(store.get('deck')), true)
    assert.equal(screenStore(dir, { validAction: (a) => KNOWN.has(a) }).isApproved(screenStore(dir).get('deck')), true, 'persists')

    // Description only: still the same screen.
    store.update('deck', { description: 'now playing' })
    assert.equal(store.isApproved(store.get('deck')), true)

    // New html: the old approval is gone, and the old hash approves nothing.
    store.update('deck', { html: '<b>v2</b>' })
    saved = store.get('deck')
    assert.equal(store.isApproved(saved), false)
    assert.equal(store.approve('deck', hash), false, 'a card shown for v1 cannot approve v2')
    assert.equal(store.approve('deck', store.hashOf(saved)), true)

    // New actions: the same.
    store.update('deck', { actions: ['media.next', 'media.play_pause'] })
    assert.equal(store.isApproved(store.get('deck')), false)

    // Order does not matter to the hash.
    assert.equal(approvalHash('x', ['b', 'a']), approvalHash('x', ['a', 'b']))
    // A file edited behind the index's back is not approved either.
    store.approve('deck', store.hashOf(store.get('deck')))
    writeFileSync(join(dir, 'deck.html'), '<b>tampered</b>')
    assert.equal(store.isApproved(store.get('deck')), false)
  } finally {
    done()
  }
})

test('a screen with no actions needs no approval; turning it into a template drops them', () => {
  const { store, done } = fresh()
  try {
    store.save({ name: 'calc', kind: 'app', html: '<b>1+1</b>' })
    assert.equal(store.isApproved(store.get('calc')), true)
    store.save({ name: 'p2', kind: 'app', html: '<b>p</b>', actions: ['media.next'] })
    assert.deepEqual(store.update('p2', { kind: 'template', html: '<b>{{x}}</b>' }).actions, [])
  } finally {
    done()
  }
})

test('the shim offers JARVIS.action and hears only its parent', () => {
  const doc = appDocument('<p>x</p>')
  assert.match(doc, /window\.JARVIS=\{action:/)
  assert.match(doc, /e\.source!==parent/)
  assert.match(doc, /jarvis:'action'/)
  assert.match(doc, /'action-result'/)
})

test('built-in screens: shipped, pre-approved, read-only, offered only when their actions exist', async () => {
  const { BUILTIN_SCREENS } = await import('../bridge/screens.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-screens-'))
  try {
    const all = screenStore(dir, { validAction: () => true })
    const player = all.get('player')
    assert.ok(player, 'the player ships')
    assert.equal(player.builtin, true)
    assert.equal(player.kind, 'app')
    assert.match(player.html, /JARVIS\.action\('media\.now_playing'/)
    assert.equal(all.isApproved(player), true)
    assert.equal(all.approve('player', 'anything'), true)
    assert.deepEqual(player.actions, BUILTIN_SCREENS.find((b) => b.id === 'player').actions)
    assert.equal(all.list()[0].id, 'player')

    assert.throws(() => all.save({ name: 'Player', kind: 'app', html: '<b>x</b>' }), /built-in/)
    assert.throws(() => all.update('player', { html: '<b>evil</b>' }), /built in/)
    assert.throws(() => all.forget('player'), /built in/)

    // Every action the player calls is one it declared.
    const called = [...player.html.matchAll(/JARVIS\.action\('([\w.]+)'/g)].map((m) => m[1])
    const pressed = [...player.html.matchAll(/press\('([\w.]+)'\)/g)].map((m) => m[1])
    for (const a of [...called, ...pressed]) assert.ok(player.actions.includes(a), a)

    const none = screenStore(dir, { validAction: () => false })
    assert.equal(none.get('player'), null, 'without media actions there is no player')
    assert.equal(none.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every built-in screen calls only the actions it declares', async () => {
  const { BUILTIN_SCREENS } = await import('../bridge/screens.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-screens-'))
  try {
    const store = screenStore(dir, { validAction: () => true })
    for (const b of BUILTIN_SCREENS) {
      const s = store.get(b.id)
      assert.ok(s, b.id)
      const used = new Set([
        ...[...s.html.matchAll(/(?:JARVIS\.action|press|ctl)\('([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]),
      ])
      assert.ok(used.size > 0, `${b.id} calls something`)
      for (const a of used) assert.ok(b.actions.includes(a), `${b.id}: ${a} not declared`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
