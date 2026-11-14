/**
 * Draws the app icon — an arc-reactor ring — as a 256px PNG, with nothing but
 * Node. Run once (`node desktop/make-icon.mjs`); the result is committed, so
 * this only matters when the icon is to change.
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const N = 256
const px = Buffer.alloc(N * N * 4)
const c = (N - 1) / 2

const clamp = (v) => Math.max(0, Math.min(1, v))
/** Soft band: 1 inside [a, b], fading over 1.2px at both edges. */
const band = (r, a, b) => clamp(Math.min(r - a, b - r) / 1.2 + 0.5)

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const dx = x - c
    const dy = y - c
    const r = Math.hypot(dx, dy)
    const ang = Math.atan2(dy, dx)
    // Ten segments in the middle ring, like the reactor's coils.
    const seg = Math.cos(ang * 10) > -0.55 ? 1 : 0
    const outer = band(r, 112, 124)
    const mid = band(r, 74, 96) * seg
    const core = band(r, 0, 38)
    const glow = clamp(1 - Math.abs(r - 60) / 70) * 0.35
    const a = clamp(Math.max(outer, mid, core, glow * (r < 124 ? 1 : 0)))
    const white = core * clamp(1 - r / 38) // hot centre
    const i = (y * N + x) * 4
    px[i] = Math.round(255 * clamp(0.25 + white * 0.75))
    px[i + 1] = Math.round(255 * clamp(0.85 + white * 0.15))
    px[i + 2] = 255
    px[i + 3] = Math.round(255 * a)
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)

writeFileSync(
  new URL('./icon.png', import.meta.url),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
console.log('wrote desktop/icon.png')
