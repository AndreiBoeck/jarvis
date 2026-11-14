import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapEmbed, mapFromUrl, isMapEmbed } from '../bridge/maps.mjs'
import { scriptOnly } from '../bridge/page.mjs'

test('a route with a starting point is a keyless directions embed', () => {
  const m = mapEmbed({ destination: 'PUCRS, Porto Alegre', origin: 'Moinhos de Vento' })
  assert.equal(m.route, true)
  const u = new URL(m.url)
  assert.equal(u.hostname, 'maps.google.com')
  assert.equal(u.searchParams.get('saddr'), 'Moinhos de Vento')
  assert.equal(u.searchParams.get('daddr'), 'PUCRS, Porto Alegre')
  assert.equal(u.searchParams.get('output'), 'embed')
  assert.equal(u.searchParams.get('dirflg'), null, 'driving has no flag')
  assert.ok(isMapEmbed(m.url))
})

test('no origin: the home location starts the route, or the place shows alone', () => {
  const fromHome = mapEmbed({ destination: 'PUCRS' }, { home: 'Porto Alegre' })
  assert.equal(fromHome.route, true)
  assert.equal(new URL(fromHome.url).searchParams.get('saddr'), 'Porto Alegre')

  const alone = mapEmbed({ destination: 'PUCRS' })
  assert.equal(alone.route, false)
  assert.equal(new URL(alone.url).searchParams.get('q'), 'PUCRS')
  assert.ok(isMapEmbed(alone.url))
})

test('travel modes, and the official Embed API when a key is set', () => {
  const walk = mapEmbed({ destination: 'B', origin: 'A', travel: 'walking' })
  assert.equal(new URL(walk.url).searchParams.get('dirflg'), 'w')
  const keyed = mapEmbed({ destination: 'B', origin: 'A', travel: 'transit' }, { key: 'K' })
  const u = new URL(keyed.url)
  assert.equal(u.pathname, '/maps/embed/v1/directions')
  assert.equal(u.searchParams.get('mode'), 'transit')
  assert.ok(isMapEmbed(keyed.url))
  assert.throws(() => mapEmbed({ destination: '  ' }))
})

test('Google Maps links are read into a place or a route', () => {
  assert.deepEqual(
    mapFromUrl('https://www.google.com/maps/dir/Moinhos+de+Vento/PUCRS,+Porto+Alegre/@-30.05,-51.2,13z/data=!3m1'),
    { destination: 'PUCRS, Porto Alegre', origin: 'Moinhos de Vento', travel: undefined },
  )
  assert.deepEqual(mapFromUrl('https://www.google.com/maps/dir//PUCRS/@-30,-51,12z'), {
    destination: 'PUCRS',
    travel: undefined,
  })
  assert.deepEqual(
    mapFromUrl('https://www.google.com/maps/dir/?api=1&destination=PUCRS&travelmode=walking'),
    { destination: 'PUCRS', origin: undefined, travel: 'walking' },
  )
  assert.deepEqual(mapFromUrl('https://www.google.com.br/maps/place/PUCRS/@-30,-51,17z'), {
    destination: 'PUCRS',
  })
  assert.deepEqual(mapFromUrl('https://maps.google.com/?q=Gasometro'), { destination: 'Gasometro' })
  assert.deepEqual(mapFromUrl('https://maps.app.goo.gl/AbC123'), { short: true })
})

test('anything else is not a map', () => {
  assert.equal(mapFromUrl('https://www.google.com/search?q=pucrs'), null)
  assert.equal(mapFromUrl('https://www.reuters.com/maps/article'), null)
  assert.equal(mapFromUrl('not a url'), null)
  assert.equal(isMapEmbed('https://maps.google.com/maps?q=x'), false, 'not the embed output')
  assert.equal(isMapEmbed('http://maps.google.com/maps?q=x&output=embed'), false)
  assert.equal(isMapEmbed('https://evil.example/maps?output=embed'), false)
  assert.equal(isMapEmbed('https://www.google.com/search?q=x'), false)
})

test('a page drawn only by its scripts is recognised; an article is not', () => {
  const shell =
    '<html><head><title>Google Maps</title><script src="/maps.js"></script></head>' +
    '<body><div id="app"></div><noscript>Turn on JavaScript</noscript><script>boot()</script></body></html>'
  assert.equal(scriptOnly(shell), true)
  const article =
    '<html><body><article><p>' + 'A real paragraph of prose that is long enough. '.repeat(10) +
    '</p></article><script>track()</script></body></html>'
  assert.equal(scriptOnly(article), false)
  const pictures = '<html><body><img src="a.jpg"><script>x()</script></body></html>'
  assert.equal(scriptOnly(pictures), false)
  assert.equal(scriptOnly('<html><body><p>tiny</p></body></html>'), false, 'no scripts: not script-only')
})
