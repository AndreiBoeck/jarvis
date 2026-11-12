import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A stand-in for `codex exec --json`, so none of this needs an OpenAI account.
// Written out here rather than kept under test/, where node --test would run it.
const FAKE = "// Stands in for `codex exec --json`: reads the prompt from stdin and answers\n// in the CLI's JSONL, so the reserve brain can be tested without an account.\nlet input = ''\nprocess.stdin.on('data', (c) => (input += c))\nprocess.stdin.on('end', () => {\n  const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n')\n  out({ type: 'thread.started', thread_id: 't1' })\n  out({ type: 'turn.started' })\n  if (input.includes('FAIL')) {\n    out({ type: 'turn.failed', error: { message: 'quota exceeded' } })\n    process.exit(1)\n  }\n  if (input.includes('HANG')) return setInterval(() => {}, 1000)\n  out({ type: 'item.started', item: { id: 'i0', type: 'web_search' } })\n  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Reserve online, sir.' } })\n  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: `Heard ${input.includes('User: ping') ? 'ping' : 'nothing'}.` } })\n  out({ type: 'turn.completed', usage: {} })\n})\n"
const bin = join(mkdtempSync(join(tmpdir(), 'jarvis-codex-')), 'fake-codex.mjs')
writeFileSync(bin, FAKE)
process.env.JARVIS_CODEX_BIN = bin
const { askCodex, looksLikeLimit } = await import('../bridge/codex.mjs')

const run = (question, extra = {}) => {
  const said = []
  const tools = []
  const done = askCodex({
    system: 'You are JARVIS.',
    history: [
      { role: 'user', text: 'earlier' },
      { role: 'jarvis', text: 'reply' },
    ],
    question,
    cwd: tmpdir(),
    onText: (t) => said.push(t),
    onTool: (n) => tools.push(n),
    ...extra,
  })
  return { done, said, tools }
}

test('limit notices are recognised, ordinary failures are not', () => {
  assert.ok(looksLikeLimit('Claude AI usage limit reached|1731400000'))
  assert.ok(looksLikeLimit("You've hit your limit · resets 3pm"))
  assert.ok(looksLikeLimit('API Error: 429 rate_limit_error'))
  assert.ok(looksLikeLimit('Credit balance is too low'))
  assert.ok(!looksLikeLimit('The turn failed part way through.'))
  assert.ok(!looksLikeLimit(''))
})

test('streams each message and the work it starts, and returns the whole answer', async () => {
  const { done, said, tools } = run('ping')
  const text = await done
  assert.equal(text, 'Reserve online, sir. Heard ping.')
  assert.deepEqual(said, ['Reserve online, sir.', ' Heard ping.'])
  assert.deepEqual(tools, ['codex · web search'])
})

test('a failed turn rejects with what Codex said', async () => {
  await assert.rejects(run('FAIL').done, /quota exceeded/)
})

test('a barge-in stops the run at once', async () => {
  const ac = new AbortController()
  const { done } = run('HANG', { signal: ac.signal })
  setTimeout(() => ac.abort(), 300)
  await assert.rejects(done, /aborted/)
})
