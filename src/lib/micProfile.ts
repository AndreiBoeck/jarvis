/**
 * How the microphone is opened, and how hard the echo defences work, on each
 * platform. Pure on purpose — no imports — so the tests can read it under
 * plain Node without Vite's import.meta.env.
 *
 * Why the app differs: on Android, asking getUserMedia for echo cancellation,
 * noise suppression or gain control makes WebView switch the whole phone into
 * MODE_IN_COMMUNICATION — call volume, the muffled call-quality output, and
 * Bluetooth dropped to the hands-free (HFP) profile. So the app opens a plain
 * stream, and without the browser's canceller the leftover echo of his own
 * voice is handled by stricter guards instead: a higher barge-in threshold, a
 * longer deaf window at the start of each answer, and an echo match that needs
 * less overlap with what he is saying.
 *
 * The desktop and the Mac keep exactly what they had.
 */

export function micConstraints(app: boolean): MediaTrackConstraints {
  const processed = !app
  return {
    echoCancellation: processed,
    noiseSuppression: processed,
    autoGainControl: processed,
  }
}

export type EchoTuning = {
  /** vad.ts — while he is speaking, the trigger is multiplied by this. */
  guardBoost: number
  /** voice.ts — ignore any barge-in this soon after he starts talking. */
  selfGuardMs: number
  /** voice.ts — share of distinctive words matching his own line to call it echo. */
  echoRatio: number
}

export function echoTuning(app: boolean): EchoTuning {
  return app
    ? { guardBoost: 4.0, selfGuardMs: 600, echoRatio: 0.5 }
    : { guardBoost: 2.4, selfGuardMs: 350, echoRatio: 0.6 }
}
