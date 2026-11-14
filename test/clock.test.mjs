import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeNow, stampNow, PROMPT_CLOCK } from '../bridge/clock.mjs'

// 14 November 2026, 13:15 UTC — a quarter past ten in the morning in São Paulo.
const MOMENT = Date.UTC(2026, 10, 14, 13, 15)

test('the clock gives the local date, weekday, 24-hour time and zone', () => {
  assert.equal(
    describeNow(MOMENT, 'America/Sao_Paulo'),
    'Saturday, 14 November 2026, 10:15, UTC-03:00 (America/Sao_Paulo)',
  )
})

test('the same moment reads differently in another zone, date and all', () => {
  assert.equal(
    describeNow(MOMENT, 'Asia/Tokyo'),
    'Saturday, 14 November 2026, 22:15, UTC+09:00 (Asia/Tokyo)',
  )
  assert.equal(
    describeNow(Date.UTC(2026, 10, 14, 23, 30), 'Asia/Tokyo'),
    'Sunday, 15 November 2026, 08:30, UTC+09:00 (Asia/Tokyo)',
  )
})

test('midnight is 00, not 24, and zero offset is spelled out', () => {
  assert.equal(
    describeNow(Date.UTC(2026, 10, 14, 0, 5), 'UTC'),
    'Saturday, 14 November 2026, 00:05, UTC+00:00 (UTC)',
  )
})

test('a zone nobody has heard of falls back to the machine, not to a crash', () => {
  const local = new Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.ok(describeNow(MOMENT, 'Mars/Olympus_Mons').endsWith(`(${local})`))
  assert.ok(describeNow(MOMENT, '').endsWith(`(${local})`))
})

test('every question is stamped in front, and left whole', () => {
  const asked = 'What time is it?\nAnd the day?'
  const stamped = stampNow(asked, MOMENT, 'America/Sao_Paulo')
  assert.equal(
    stamped,
    '[Now: Saturday, 14 November 2026, 10:15, UTC-03:00 (America/Sao_Paulo)]\n' + asked,
  )
})

test('the stamp follows the clock from one question to the next', () => {
  const first = stampNow('x', MOMENT, 'America/Sao_Paulo')
  const later = stampNow('x', MOMENT + 5 * 3600_000, 'America/Sao_Paulo')
  assert.notEqual(first, later)
  assert.ok(later.includes('15:15'))
})

test('the part of the prompt that explains the stamp never changes', () => {
  // It sits in the cached system prompt: no date or time may be computed into it.
  assert.ok(PROMPT_CLOCK.includes('[Now: '))
  assert.ok(PROMPT_CLOCK.endsWith('\n\n'))
})
