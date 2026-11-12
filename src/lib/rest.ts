/**
 * Telling him to rest — in English or Portuguese — stands him down on the spot.
 *
 * Decided here, not by the model: a round trip to the bridge is seconds of him
 * still talking after being told to stop, which is the opposite of what was
 * asked. The whole utterance has to be the order, once politeness is trimmed
 * off both ends, so "what's the rest of my day" and "set a sleep timer" still
 * go to the model. Anything this misses the model can still catch: it has
 * `ui_rest` for the same purpose.
 */
const REST_LEAD =
  /^(?:(?:ok|okay|alright|right|well|now|please|thanks|thank you|you can|you may|can you|could you|i said|then|ja|entao|agora|pode|podes|voce pode|vc pode|por favor|obrigado|obrigada|valeu|beleza|ta bom|chega|hey|jarvis)\s+)+/
const REST_TAIL =
  /(?:\s+(?:now|please|sir|jarvis|for now|for a while|for today|then|thanks|thank you|agora|por favor|um pouco|por hoje|por enquanto|ja|obrigado|obrigada|valeu))+$/
const REST_ORDER = new RegExp(
  '^(?:' +
    [
      'go to sleep', 'go sleep', 'sleep', 'go rest', 'go and rest', 'rest',
      'take a rest', 'get some rest', 'have a rest', 'stand down', 'stand by',
      'standby', 'go to standby', 'power down', 'go dormant', 'dismissed',
      'thats all', 'that is all', 'that will be all', 'thats it', 'good night',
      'goodnight',
      'descansa', 'descanse', 'descansar', 'vai descansar', 'va descansar',
      'pode ir descansar', 'ir descansar', 'dorme', 'durma', 'dormir',
      'vai dormir', 'va dormir', 'repouso', 'modo repouso', 'em repouso',
      'entra em repouso', 'entre em repouso', 'entrar em repouso',
      'fica em repouso', 'fique em repouso', 'hiberna', 'hiberne',
      'boa noite', 'em espera', 'fica em espera', 'fique em espera',
      'so isso', 'e so isso', 'era so isso',
    ].join('|') +
    ')$',
)

/** True when the whole of what was said is an order to rest. */
export function isRestOrder(text: string): boolean {
  const plain = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(REST_LEAD, '')
    .replace(REST_TAIL, '')
  return REST_ORDER.test(plain)
}
