import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_CSP,
  MAX_SCREEN_BYTES,
  MAX_SCREENS,
  appDocument,
  fillTemplate,
  screenId,
  screenStore,
  templateFields,
} from '../bridge/screens.mjs'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-screens-'))
  return { dir, store: screenStore(dir), done: () => rmSync(dir, { recursive: true, force: true }) }
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
  assert.ok(doc.indexOf("m.jarvis!=='data'") < doc.indexOf('go()'), 'shim before the screen code')
  assert.match(appDocument('<p>bare</p>'), /^<!doctype html>.*JARVIS_DATA.*<p>bare<\/p>/s)
  // A transparent screen must not be painted white behind (iframe is dark).
  assert.match(doc, /<meta name="color-scheme" content="dark">/)
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"]) {
    assert.ok(APP_CSP.includes(rule), rule)
  }
  assert.doesNotMatch(APP_CSP, /https?:|'self'|\*/, 'no remote origin anywhere')
})
