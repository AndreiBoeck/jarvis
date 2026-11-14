/**
 * The microphone's loudness, for the reactor's pulse — and able to heal itself.
 *
 * Why it needs to: in the Android app, coming back to the screen after a few
 * seconds away reopens the microphone, and the AudioContext created for this
 * meter at that moment is born 'suspended'. resume() straight away does not
 * take; resume() seconds later does — but the source → analyser pair wired
 * while it was suspended goes on reading zeros for ever, so the reactor and
 * SIGNAL sit at 0% while the voice loop hears perfectly well. A fresh source
 * on the same context reads normally.
 *
 * So: while the context is not running, ask it to resume (now and then, not
 * every frame), and the moment it is running after having been anything else,
 * wire a fresh source and analyser. A context born running — the desktop and
 * the Mac, every time — never takes either path.
 *
 * Pure on purpose — no imports, the context handed in — so the tests can drive
 * it under plain Node with a fake.
 */

/** Just what is used of an AudioContext. */
export type MeterContext = {
  readonly state: string
  resume(): Promise<void>
  close(): Promise<void>
  createMediaStreamSource(s: MediaStream): MediaStreamAudioSourceNode
  createAnalyser(): AnalyserNode
  onstatechange: ((this: never, ev: Event) => unknown) | null
}

export type LevelMeter = {
  /** 0..1 loudness. */
  level(): number
  /** The context's own state, for diagnostics. */
  state(): string
  /** Times the nodes were rewired after the context came back to life. */
  rewires(): number
  close(): void
}

/** How often a suspended context is asked to resume, at most. */
export const RESUME_EVERY_MS = 500

export function createLevelMeter(
  stream: MediaStream,
  ctx: MeterContext,
  now: () => number = () => Date.now(),
): LevelMeter {
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let buf: Uint8Array | null = null
  /** Wired while the context was not running: those nodes may be dead. */
  let stale = false
  let lastResume = -Infinity
  let closed = false
  let wired = 0

  const wire = () => {
    try {
      source?.disconnect()
    } catch {
      /* already gone */
    }
    source = ctx.createMediaStreamSource(stream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    buf = new Uint8Array(analyser.frequencyBinCount)
    stale = ctx.state !== 'running'
    wired++
  }

  const nudge = () => {
    if (closed || ctx.state === 'running' || ctx.state === 'closed') return
    const t = now()
    if (t - lastResume < RESUME_EVERY_MS) return
    lastResume = t
    void ctx.resume().catch(() => {})
  }

  ctx.onstatechange = () => {
    if (closed) return
    if (ctx.state === 'running' && stale) wire()
  }

  wire()
  nudge()

  return {
    level() {
      if (closed) return 0
      if (ctx.state !== 'running') {
        nudge()
        return 0
      }
      // Running, but the statechange event was missed: heal here instead.
      if (stale) wire()
      if (!analyser || !buf) return 0
      analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
      let sum = 0
      // Skip the lowest bins — they're mostly rumble and mains hum.
      for (let i = 4; i < buf.length; i++) sum += buf[i]
      const avg = sum / (buf.length - 4) / 255
      // Voice sits low in this range; stretch it so the visuals actually move.
      return Math.min(1, avg * 3.2)
    },
    state: () => ctx.state,
    rewires: () => wired - 1,
    close() {
      closed = true
      ctx.onstatechange = null
      try {
        source?.disconnect()
      } catch {
        /* already gone */
      }
      void ctx.close().catch(() => {})
      source = null
      analyser = null
      buf = null
    },
  }
}
