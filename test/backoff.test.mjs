import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure module, no imports: Node strips the types on import.
const { reconnectDelay, shouldReconnect, RECONNECT_MAX_MS } = await import('../src/lib/backoff.ts')

test('the re-dial backs off from half a second to ten, and keeps going', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay), [500, 1000, 2000, 4000, 8000, 10000, 10000])
  assert.equal(reconnectDelay(1000), RECONNECT_MAX_MS, 'no overflow, no giving up')
  assert.equal(reconnectDelay(-3), 500)
})

test('it stops only when stopping is right', () => {
  assert.equal(shouldReconnect({}), true, 'a dropped link (1006) is retried')
  assert.equal(shouldReconnect({ closeCode: 1001 }), true, 'the bridge going away is retried')
  assert.equal(shouldReconnect({ intentional: true }), false, 'closed by the interface itself')
  assert.equal(shouldReconnect({ closeCode: 4003 }), false, 'closed by the bridge on purpose')
  assert.equal(shouldReconnect({ unauthorized: true }), false, 'the token was refused (unpaired)')
})
