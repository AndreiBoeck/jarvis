// Calls through ElevenLabs: who gets rung, from which line, with what told.
//
//   node --test test/
//
// fetch is a stub, so nothing here places a real call.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Caller, maskNumber, normaliseNumber } from '../bridge/calls.mjs'
import { Watchtower } from '../bridge/monitor.mjs'
import { decideTool } from '../bridge/policy.mjs'

const ME = '+5511900001234'

/** A fake ElevenLabs: one agent, one SIP number assigned to it. */
function fakeApi({ provider = 'sip_trunk', overrides = true, refuse = null } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body })
    if (path === '/v1/convai/phone-numbers') {
      return json(200, [
        {
          phone_number_id: 'phnum_1',
          phone_number: '+551130002005',
          provider,
          assigned_agent: { agent_id: 'agent_1', agent_name: 'JARVIS' },
        },
      ])
    }
    if (path === '/v1/convai/agents/agent_1') {
      return json(200, {
        platform_settings: {
          overrides: {
            conversation_config_override: {
              agent: { first_message: overrides, language: overrides, prompt: { prompt: overrides } },
            },
          },
        },
      })
    }
    if (path.endsWith('/outbound-call')) {
      if (refuse) return json(400, { detail: { message: refuse } })
      calls.push({ path, body: JSON.parse(init.body) })
      return json(200, { success: true, conversation_id: `conv_${calls.length}` })
    }
    return json(404, { detail: 'not found' })
  }
  return { calls, fetchImpl }
}

const caller = (api, extra = {}) =>
  new Caller({ key: () => 'k', userNumber: ME, userName: 'Andrei', fetchImpl: api.fetchImpl, ...extra })

test('numbers are normalised to full international form, or refused', () => {
  assert.equal(normaliseNumber('+55 (11) 9 0000-1234'), '+5511900001234')
  assert.equal(normaliseNumber('0055 11 900001234'), '+5511900001234')
  assert.equal(normaliseNumber('11 90000-1234'), null, 'no country code')
  assert.equal(normaliseNumber('call 190'), null)
  assert.equal(maskNumber(ME), '+•••••••••1234')
})

test('"call me" rings the configured number, in English, from the agent\'s own line', async () => {
  const api = fakeApi()
  const r = await caller(api).callUser('Sir, a message from Maria has arrived.')
  assert.equal(r.conversationId, 'conv_1')
  const [{ path, body }] = api.calls
  assert.equal(path, '/v1/convai/sip-trunk/outbound-call')
  assert.equal(body.agent_id, 'agent_1')
  assert.equal(body.agent_phone_number_id, 'phnum_1')
  assert.equal(body.to_number, ME)
  const agent = body.conversation_initiation_client_data.conversation_config_override.agent
  assert.equal(agent.first_message, 'Sir, a message from Maria has arrived.')
  assert.equal(agent.language, 'en')
  assert.match(agent.prompt.prompt, /message from Maria/)
})

test('Twilio numbers use the Twilio endpoint', async () => {
  const api = fakeApi({ provider: 'twilio' })
  await caller(api).callUser('Sir.')
  assert.equal(api.calls[0].path, '/v1/convai/twilio/outbound-call')
})

test('"call my dentist" opens as Friday, then does the task in their language', async () => {
  const api = fakeApi()
  await caller(api).callOther({
    to: '+55 11 3333-4444',
    who: 'the dental clinic',
    task: 'Tell them Andrei will be twenty minutes late for his three o\'clock appointment.',
    language: 'pt',
  })
  const { body } = api.calls[0]
  assert.equal(body.to_number, '+551133334444')
  const agent = body.conversation_initiation_client_data.conversation_config_override.agent
  assert.equal(agent.language, 'pt')
  assert.equal(agent.first_message, "Hello, I'm Friday, Andrei's AI assistant, calling on his behalf.")
  assert.match(agent.prompt.prompt, /You are Friday, Andrei's AI assistant/)
  assert.match(agent.prompt.prompt, /twenty minutes late/)
  assert.match(agent.prompt.prompt, /Do not introduce yourself again/)
})

test('the introduction can be reworded, and survives a missing name', () => {
  const api = fakeApi()
  assert.equal(
    caller(api, { intro: 'Hi, Friday here for {name}.' }).introduction(),
    'Hi, Friday here for Andrei.',
  )
  assert.match(caller(api, { userName: '' }).introduction(), /^Hello, I'm Friday, an AI assistant/)
})

test('without the user\'s number, "call me" refuses rather than guessing', async () => {
  const api = fakeApi()
  await assert.rejects(caller(api, { userNumber: '' }).callUser('Sir.'), /JARVIS_CALL_TO/)
  await assert.rejects(caller(api).callOther({ to: '12345', task: 'x' }), /country code/)
  assert.equal(api.calls.length, 0)
})

test('an agent that refuses overrides is reported plainly', async () => {
  const api = fakeApi({ overrides: false, refuse: 'Override for field first_message is not allowed by config.' })
  const c = caller(api)
  assert.deepEqual(await c.missingOverrides(), ['first message', 'system prompt', 'language'])
  await assert.rejects(c.callUser('Sir.'), /Security settings/)
})

test('a watch set to call rings the user; a spoken one and a broken one do not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-calls-'))
  try {
    const alerts = []
    const tower = new Watchtower({
      file: join(dir, 'w.json'),
      check: async () => ({ alert: true, message: 'Sir, it arrived.', observation: 'x', next_check_minutes: 5, finished: false }),
      notify: (a) => (alerts.push(a), 1),
    })
    tower.create({ task: 'mail', notifyWhen: 'new message', intervalMinutes: 5, notifyBy: 'call' })
    await tower.running
    tower.create({ task: 'price', notifyWhen: 'drop', intervalMinutes: 5 })
    await tower.running
    assert.deepEqual(alerts.map((a) => a.channel), ['call', 'speak'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ringing the user is always allowed; ringing anyone else needs write access', () => {
  assert.equal(decideTool('mcp__jarvis_call__call_me', false), true)
  assert.equal(decideTool('mcp__jarvis_call__call_status', false), true)
  assert.equal(decideTool('mcp__jarvis_call__call_someone', false), false)
  assert.equal(decideTool('mcp__jarvis_call__call_someone', true), true)
})
