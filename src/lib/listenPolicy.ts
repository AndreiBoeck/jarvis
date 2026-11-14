/**
 * What the voice loop does with what it hears, phase by phase — and the one
 * phrase that gets through while he is working.
 *
 * Pure on purpose — no imports — so the tests can read it under plain Node.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /**
   * He is working on an answer — thinking, or using tools — and has not
   * started saying it. Talk in the room must not cancel the work: nothing
   * interrupts on loudness, and a transcript counts only if it opens with his
   * name ("Hey JARVIS, …"). Anything else is dropped without a word.
   */
  | 'busy'
  /** He is talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

/** The app's phase, mapped onto what the voice loop should do. */
export function modeForPhase(phase: string): VoiceMode {
  switch (phase) {
    case 'offline':
    case 'boot':
      return 'deaf'
    case 'dormant':
      return 'wake'
    case 'waking':
    case 'listening':
      return 'command'
    case 'thinking':
    case 'tooling':
      return 'busy'
    default:
      return 'guard' // speaking
  }
}

/**
 * His name at the very start of what was said, with an optional greeting in
 * front: "Hey JARVIS", "Hei Jarvis", "Ei, Jarvis", "E aí Jarvis", "Jarvis, …".
 * The name's spellings are the ones a transcriber actually returns for it.
 * Anchored at the start on purpose: "ask Jarvis later" in a conversation across
 * the room is not someone addressing him.
 */
const WAKE_AT_START = new RegExp(
  '^[\\s"\'“«¡¿.,…-]*' +
    '(?:(?:hey|hei|ei|e\\s+a[ií]|hi|oi|ok|okay|yo)[\\s,.!…–—-]*)?' +
    "(?:j\\.\\s?a\\.\\s?r\\.\\s?v\\.\\s?i\\.\\s?s\\.?|jarvis|jarvys|jervis|jarviss|travis|java's|jarv)" +
    "(?![\\p{L}\\p{N}'’])" +
    '[\\s,.:;!?…–—-]*',
  'iu',
)

/**
 * What follows his name, when the words open with it ('' for the name alone),
 * or null when they do not.
 */
export function wakeAtStart(text: string): string | null {
  const m = WAKE_AT_START.exec(text)
  if (!m) return null
  return text.slice(m[0].length).trim()
}

/** What to do with words heard while he was busy. */
export type BusyAction =
  /** Not addressed to him: drop it, silently. */
  | { kind: 'drop' }
  /** His name alone: stop, and listen. */
  | { kind: 'wake' }
  /** His name and a request: stop, and take the rest as the new request. */
  | { kind: 'command'; text: string }

export function busyAction(text: string): BusyAction {
  const rest = wakeAtStart(text)
  if (rest === null) return { kind: 'drop' }
  return rest ? { kind: 'command', text: rest } : { kind: 'wake' }
}
