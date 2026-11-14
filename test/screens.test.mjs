import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderScreen, screenId, ScreenLibrary } from '../bridge/screens.mjs'

const withTempDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-screens-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('screen ids are stable, bounded and safe for persistence', () => {
  assert.equal(screenId('  Project Status / São Paulo  '), 'project-status-sao-paulo')
  assert.match(screenId('../../etc/passwd'), /^[a-z0-9-]+$/)
  assert.ok(screenId('x'.repeat(100)).length <= 64)
})

test('saved screens survive a new library instance and values render as inert text', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'screens.json')
    const first = new ScreenLibrary(file)
    await first.save({
      name: 'service health',
      title: 'SERVICE HEALTH',
      html: '<p class="hud-note">{{status}} · {{missing}}</p>',
      size: 'tall',
    })

    const saved = await new ScreenLibrary(file).get('service-health')
    assert.equal(saved.title, 'SERVICE HEALTH')
    assert.equal(saved.size, 'tall')
    assert.equal(
      renderScreen(saved, { status: '<img src=x onerror=alert(1)>' }),
      '<p class="hud-note">&lt;img src=x onerror=alert(1)&gt; · —</p>',
    )
    assert.equal((await new ScreenLibrary(file).list())[0].html, undefined)
  })
})

test('concurrent libraries do not lose updates or collide on temporary files', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'screens.json')
    const libraries = Array.from({ length: 24 }, () => new ScreenLibrary(file))
    await Promise.all(libraries.map((library, index) => library.save({
      name: `screen-${index}`,
      html: `<span class="hud-label">${index}</span>`,
    })))

    const records = JSON.parse(await readFile(file, 'utf8')).screens
    assert.equal(records.length, 24)
    assert.deepEqual(
      records.map(({ id }) => id).sort(),
      Array.from({ length: 24 }, (_, index) => `screen-${index}`).sort(),
    )
  })
})

test('a failed mutation does not prevent a later mutation from succeeding', async () => {
  await withTempDir(async (dir) => {
    const parent = join(dir, 'parent')
    const file = join(parent, 'screens.json')
    await writeFile(parent, 'not a directory')
    const library = new ScreenLibrary(file)

    await assert.rejects(library.save({ name: 'first', html: '<p>first</p>' }))
    await rm(parent)
    await mkdir(parent)
    await library.save({ name: 'second', html: '<p>second</p>' })

    assert.equal((await library.get('second')).id, 'second')
  })
})

test('a corrupt library is not silently replaced on the next save', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'screens.json')
    const corrupt = '{ definitely not json'
    await writeFile(file, corrupt)
    const library = new ScreenLibrary(file)

    await assert.rejects(library.save({ name: 'new', html: '<p>new</p>' }), SyntaxError)
    assert.equal(await readFile(file, 'utf8'), corrupt)
  })
})

test('limits reject empty and oversized templates and retain only the newest 64', async () => {
  await withTempDir(async (dir) => {
    const library = new ScreenLibrary(join(dir, 'screens.json'))
    await assert.rejects(library.save({ name: '', html: '<p>x</p>' }), /short name/)
    await assert.rejects(library.save({ name: 'empty', html: '  ' }), /HTML template/)
    await assert.rejects(
      library.save({ name: 'large', html: 'x'.repeat(100_001) }),
      /too large/,
    )

    for (let index = 0; index < 66; index += 1) {
      await library.save({ name: `bounded-${index}`, html: `<p>${index}</p>` })
    }
    const listed = await library.list()
    assert.equal(listed.length, 64)
    assert.equal(await library.get('bounded-0'), null)
    assert.equal((await library.get('bounded-65')).id, 'bounded-65')
  })
})

test('rendering refuses placeholder expansion beyond the output limit', () => {
  assert.throws(
    () => renderScreen({ html: '{{value}}{{value}}' }, { value: 'x'.repeat(100_001) }),
    /rendered screen is too large/,
  )
})
