import { test } from 'node:test'
import assert from 'node:assert/strict'

// Node strips the types from this one on import; it has nothing else TS-only.
const { isRestOrder } = await import('../src/lib/rest.ts')

test('orders to rest, in English and Portuguese, are recognised', () => {
  for (const said of [
    'descansa',
    'Descanse.',
    'pode descansar',
    'Jarvis pode descansar agora',
    'vai descansar, Jarvis',
    'Vá dormir.',
    'entra em repouso',
    'Modo repouso',
    'ok, pode ir descansar por hoje',
    'boa noite',
    'é só isso, obrigado',
    'go to sleep',
    'You can rest now.',
    'Stand down.',
    'That will be all, sir.',
    "That's all, thanks",
    'Okay, standby please',
  ]) {
    assert.ok(isRestOrder(said), `should rest on "${said}"`)
  }
})

test('questions that merely mention rest or sleep still go to the model', () => {
  for (const said of [
    "what's the rest of my day",
    'set a sleep timer for ten minutes',
    'how did I sleep last night',
    'descansar faz bem para a saúde?',
    'qual o melhor horário para dormir',
    'read the rest of the article',
    'quanto tempo de repouso depois da cirurgia',
    'good night messages for my wife',
  ]) {
    assert.ok(!isRestOrder(said), `should not rest on "${said}"`)
  }
})
