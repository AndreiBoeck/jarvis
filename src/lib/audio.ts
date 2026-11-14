/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

import { IS_APP } from '../config'
import { micConstraints } from './micProfile'
import { createLevelMeter, type LevelMeter } from './levelMeter'

let stream: MediaStream | null = null
let meter: LevelMeter | null = null

export async function getMic(): Promise<MediaStream> {
  if (stream) return stream
  // In the Android app the processing is off: asking for it puts the phone
  // in call mode. See micProfile.ts.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: micConstraints(IS_APP),
  })
  return stream
}

export async function startAnalyser(): Promise<void> {
  if (meter) return
  const s = await getMic()
  // Self-healing: a context born suspended (the phone app coming back to the
  // screen) is resumed and rewired rather than left reading zeros. See
  // levelMeter.ts.
  meter = createLevelMeter(s, new AudioContext())
}

/**
 * Let go of the microphone entirely: the stream's tracks and the analyser.
 * The phone app does this when it leaves the screen, so nothing records from
 * a pocket and the audio pipeline stops holding the phone awake. The next
 * getMic() opens it afresh.
 */
export function releaseMic(): void {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  meter?.close()
  meter = null
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  return meter ? meter.level() : 0
}

// For the WebView / DevTools console: `__meter` — is the reactor's meter up,
// is its context running, and how often has it had to heal itself.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__meter', {
    configurable: true,
    get: () => ({
      open: Boolean(meter),
      state: meter ? meter.state() : 'none',
      rewires: meter ? meter.rewires() : 0,
      level: micLevel(),
    }),
  })
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
