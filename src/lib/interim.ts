/**
 * The browser recogniser's interim results, and what may be done with them.
 *
 * Chrome hands over a guess while you are still talking ("…and tell me the")
 * and the real transcript once you stop ("…and tell me the headline"). Acting
 * on the guess sent a truncated question, and then the final, arriving for the
 * same words a moment later, sent the whole one again: two asks per sentence,
 * the first of them free to start doing things. The rule here is the one that
 * fixes it — a guess may STOP him, it may never ASK him anything — plus the
 * bookkeeping that keeps one sentence from being heard twice.
 *
 * Pure on purpose — no imports — so the tests can read it under plain Node.
 */

/** "Hey Jarvis" alone and nothing after it for this long: answer, don't wait for the final. */
export const QUICK_WAKE_MS = 450

/** After the speaker goes quiet, how long to wait for a pending final before using the guess. */
export const FINAL_GRACE_MS = 1200

/** What to do when his name is heard from standby. */
export type WakeStep =
  /** The words are final: wake now, with whatever followed the name. */
  | { kind: 'fire'; trailing: string }
  /** Only his name so far, still a guess: answer shortly unless more words come. */
  | { kind: 'quick' }
  /** His name and a request, still a guess: wait for the final before asking anything. */
  | { kind: 'await' }

export function wakeStep(trailing: string, final: boolean): WakeStep {
  if (final) return { kind: 'fire', trailing }
  return trailing ? { kind: 'await' } : { kind: 'quick' }
}

/**
 * Whether a quiet gap may hand the words on now. Final words go at once; a
 * guess waits for its final, up to the grace period — Chrome does sometimes
 * never finalise, and a sentence that is never sent is worse than a guess.
 */
export function emitNow(hasInterim: boolean, waitedMs: number): boolean {
  return !hasInterim || waitedMs >= FINAL_GRACE_MS
}

export type RecResult = { transcript: string; isFinal: boolean }

/**
 * Read one onresult event. Results at or below `consumedUpTo` were already
 * handed on, so a final arriving late for them is ignored rather than heard as
 * a new sentence. `strip`, for the result his name was in when he answered to
 * it alone, takes the name off the front of that result's words.
 */
export function readResults(
  results: ArrayLike<RecResult>,
  resultIndex: number,
  consumedUpTo: number,
  strip: { index: number; fn: (s: string) => string } | null = null,
): { fresh: string; interim: string; last: number } {
  let fresh = ''
  let interim = ''
  let last = -1
  for (let i = Math.max(resultIndex, consumedUpTo + 1); i < results.length; i++) {
    const r = results[i]
    const chunk = strip && i === strip.index ? strip.fn(r.transcript) : r.transcript
    last = i
    if (r.isFinal) fresh += chunk
    else interim += chunk
  }
  return { fresh, interim, last }
}
