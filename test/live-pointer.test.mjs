import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { toPage, modsOf, wheelPixels, touchKind, addressToUrl } = await import('../src/lib/livePointer.ts')

const rect = { left: 100, top: 50, width: 400, height: 300 }

test('a point on the blade lands on the same point of the page', () => {
  assert.deepEqual(toPage(100, 50, rect, 400, 300), { x: 0, y: 0 })
  assert.deepEqual(toPage(300, 200, rect, 400, 300), { x: 200, y: 150 })
  // The frame is 800×600 drawn at half size: page coordinates double.
  assert.deepEqual(toPage(300, 200, rect, 800, 600), { x: 400, y: 300 })
})

test('a letterboxed frame: the bars are not the page', () => {
  // 400×400 frame in a 400×300 surface: drawn 300×300, 50px bars either side.
  assert.equal(toPage(120, 100, rect, 400, 400), null)
  assert.deepEqual(toPage(300, 200, rect, 400, 400), { x: 200, y: 200 })
})

test('before the first frame, the surface size stands in', () => {
  assert.deepEqual(toPage(150, 60, rect, 0, 0), { x: 50, y: 10 })
  assert.equal(toPage(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 0, 0), null)
})

test('modifiers, wheel units, tap or drag, and the address bar', () => {
  assert.equal(modsOf({ altKey: true, shiftKey: true }), 9)
  assert.equal(modsOf({ ctrlKey: true, metaKey: true }), 6)
  assert.equal(wheelPixels(3, 1), 120)
  assert.equal(wheelPixels(-1, 2), -800)
  assert.equal(wheelPixels(42, 0), 42)
  assert.equal(touchKind(3, 4), 'tap')
  assert.equal(touchKind(0, 20), 'drag')
  assert.equal(addressToUrl('pucrs.br'), 'https://pucrs.br')
  assert.equal(addressToUrl('http://x.y/z'), 'http://x.y/z')
  assert.equal(addressToUrl('rota pucrs'), 'https://www.google.com/search?q=rota%20pucrs')
  assert.equal(addressToUrl('  '), '')
})
