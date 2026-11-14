import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { modeForPhase } from './lib/listenPolicy'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { IS_APP, TTS_ENGINE } from './config'
import { TalkButton } from './ui/Mobile'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  brief,
  type AskHandlers,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  watchAlerts,
  type WatchAlert,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, releaseMic } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'
import { isRestOrder } from './lib/rest'
import { IS_DESKTOP, onDesktopMute, reportMuted, loadMuted, saveMuted } from './lib/desktop'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  // -- the microphone: mute, and the phone app off screen -------------------

  /** Opens a fresh voice loop. Set once the boot sequence knows how. */
  const openVoiceFn = useRef<(() => Promise<Voice>) | null>(null)
  const reopening = useRef<Promise<void> | null>(null)
  /** Moves every time the microphone is closed, so a reopen that was still in
   *  flight when that happened knows the stream it started on is gone. */
  const micGen = useRef(0)

  /**
   * Whether the microphone should be open right now. Two things close it: the
   * user muting him, and — in the phone app only — the app leaving the screen,
   * where a loop kept running in a pocket all day and drained the battery.
   */
  const micWanted = () =>
    !store.getState().muted && !(IS_APP && document.visibilityState === 'hidden')

  /** Let go completely: the loop, the stream, the analyser. The OS microphone
   *  light goes out, which is the only mute indicator anyone actually trusts. */
  const closeMic = () => {
    micGen.current++
    voice.current?.stop()
    voice.current = null
    releaseMic()
  }

  /** Bring the microphone in line with micWanted(). Safe to call any time. */
  const syncMic = () => {
    if (!micWanted()) {
      closeMic()
      // The phone app leaving the screen closes a turn that was waiting for
      // words, as muting does: nothing is listening for them any more.
      const phase = store.getState().phase
      if (!store.getState().muted && (phase === 'listening' || phase === 'waking')) {
        goDormant()
      }
      return
    }
    const open = openVoiceFn.current
    if (voice.current || reopening.current || !open) return
    const gen = micGen.current
    reopening.current = (async () => {
      try {
        await startAnalyser()
      } catch {
        /* the reactor just won't pulse */
      }
      const v = await open()
      // Muted, or sent off screen, while it was opening — even if it has come
      // back since, the stream this loop started on was let go in between.
      if (gen !== micGen.current || !micWanted()) {
        v.stop()
        releaseMic()
      } else voice.current = v
    })().finally(() => {
      reopening.current = null
      // Closed and wanted again while that one was opening: open a clean one.
      if (!voice.current && micWanted()) syncMic()
    })
  }

  const setMute = (on: boolean) => {
    const s = store.getState()
    if (s.muted === on) return
    s.setMuted(on)
    saveMuted(on)
    reportMuted(on)
    // A turn that was waiting for words will never get them.
    if (on && (s.phase === 'listening' || s.phase === 'waking')) goDormant()
    if (s.phase !== 'offline' && s.phase !== 'boot') sfx.play(on ? 'done' : 'listen')
    syncMic()
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /**
   * Rest, now. Whatever he was doing stops — the answer in flight is abandoned
   * on the bridge too, so it does not go on spending tokens on something nobody
   * will hear — and he drops to standby until his name is said again.
   */
  const rest = () => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
      interrupt()
    }
    goDormant()
    sfx.play('done')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    // Muted — or, in the phone app, off screen — the follow-up window would
    // be a lie: nothing is listening.
    if (!micWanted()) {
      s.setPhase('dormant')
      return
    }
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- watches speaking up ------------------------------------------------

  /**
   * Alerts from standing watches, waiting for a gap.
   *
   * An alert is JARVIS volunteering something, so it never talks over him or
   * over a question in flight: it waits until he is idle or merely listening,
   * then speaks and leaves the mic open for the obvious follow-up ("how much
   * is it now?"). Saying anything while it plays stops it, like any answer.
   */
  const alerts = useRef<WatchAlert[]>([])
  /** The morning briefing was gathered while he was already up: it is read
   *  the next time his name is said, not to an empty room at seven. */
  const mailWaiting = useRef(false)
  const alertSub = useRef<(() => void) | null>(null)

  const announceNext = () => {
    const phase = store.getState().phase
    if (phase !== 'dormant' && phase !== 'listening') return
    const next = alerts.current.shift()
    if (!next) return
    // The afternoon mail report: the bridge holds it, the briefing path reads it.
    if (next.kind === 'mail-report') {
      void respond('', true)
      return
    }

    clearIdle()
    const mine = ++turn.current
    const s = store.getState()
    s.pushPanel({
      id: `watch-${next.id}`,
      title: next.kind === 'paused' ? 'WATCH PAUSED' : 'WATCH',
      html: `<p>${next.message.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`,
      anim: 'snap',
      slot: 'right',
      accent: next.kind === 'paused' ? 'red' : 'amber',
      hold: 'turn',
    })
    s.pushTurn({ id: newId(), role: 'jarvis', text: next.message })
    s.setPhase('speaking')
    sfx.play('wake')
    const spk = createSpeaker()
    speaker.current = spk
    spk.say(next.message)
    void spk.end().then(() => {
      if (mine !== turn.current) return
      speaker.current = null
      listen(FOLLOW_UP_MS)
    })
  }

  // -- one turn -------------------------------------------------------------

  /** `briefing` is the start-up briefing: nobody said anything, so there is
   *  no user line, and the bridge writes the question itself. */
  const respond = async (said: string, briefing = false): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    if (!briefing) s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const handlers: AskHandlers = {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }
      const { text } = briefing
        ? await brief(handlers)
        : await ask(said, history.current, handlers)

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge && !briefing) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => modeForPhase(store.getState().phase)

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      if (isRestOrder(trailing)) return rest()
      void respond(trailing)
      return
    }

    // The morning briefing has been waiting for him to be called.
    if (mailWaiting.current) {
      mailWaiting.current = false
      void respond('', true)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    if (isRestOrder(said)) return rest()

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))
    watchAlerts((alert) => {
      if (alert.kind === 'mail-morning') {
        mailWaiting.current = true
        return
      }
      if (alerts.current.some((a) => a.id === alert.id)) return
      alerts.current.push(alert)
      announceNext()
    })
    // Held alerts go out the moment he is free again.
    // Replaced rather than added to, since a failed boot runs this again.
    alertSub.current?.()
    alertSub.current = store.subscribe((st, prev) => {
      if (st.phase !== prev.phase && alerts.current.length) announceNext()
    })

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        case 'rest':
          // The model recognised an order to rest that isRestOrder did not.
          rest()
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'open') {
        // A first dial that failed (the bridge was still starting) left its
        // error up; now that the line is open it is no longer true.
        const e = store.getState().error
        if (e && /reach (the bridge|JARVIS)/.test(e)) store.getState().setError(null)
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    if (micWanted()) {
      try {
        await startAnalyser()
      } catch {
        console.warn(
          '[jarvis] no microphone stream — the reactor will not pulse with your ' +
            'voice. Speech recognition is unaffected.',
        )
      }
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload. The HUD label is set only
    // after this resolves, or it always reports the browser fallback voice
    // even when ElevenLabs is the one actually about to speak.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())

    // One voice loop, running until the page closes — unless the user mutes
    // him, or (in the phone app) the app leaves the screen. Either closes the
    // microphone completely and syncMic() opens it again afterwards. An answer
    // already on its way still arrives and is spoken.
    openVoiceFn.current = () =>
      startVoice({
        mode,
        onWake,
        onSpeechStart,
        onPartial,
        onUtterance,
        onError: onVoiceError,
      })
    if (micWanted()) {
      const v = await openVoiceFn.current()
      if (micWanted()) voice.current = v
      else {
        v.stop()
        releaseMic()
      }
    } else releaseMic()

    if (IS_APP) document.addEventListener('visibilitychange', syncMic)

    store.getState().setPhase('dormant')

    // The start-up briefing — the mail that matters, each on its own blade,
    // and the weather and the day on one more — read out the moment he is up.
    // The PC and the Mac only; the bridge answers the phone with nothing. Saying
    // anything cuts it off, like any answer, and "descansa" ends it outright.
    if (usingBridge && !IS_APP) {
      mailWaiting.current = false
      void respond('', true)
    }
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   *
   * Not in the phone app. Its start screen says "tap to power up" — the phone
   * is in a hand, the screen is right there — and a microphone open before
   * anyone has touched it is the last thing a phone should have: it recorded
   * from a pocket, and kept recording once the app left the screen.
   */
  const muted = useStore((s) => s.muted)
  useEffect(() => {
    if (IS_APP || phase !== 'offline' || muted) return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, muted])

  // -- talk: Space on the desktop, the talk button in the app ---------------

  /**
   * Start a turn without the wake word — or, while he is busy, cut in. The
   * desktop binds it to Space; the app, which has no wake word at all, puts
   * it under a button.
   */
  const talk = () => {
    const phase = store.getState().phase
    if (phase === 'offline') {
      void powerOn()
    } else if (store.getState().muted) {
      store.getState().setError('Microphone muted — press M to unmute.')
    } else if (phase === 'boot') {
      /* ignore — the boot sequence owns the phase until it finishes */
    } else if (
      phase === 'thinking' ||
      phase === 'tooling' ||
      phase === 'speaking'
    ) {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
    } else {
      onWake('')
    }
  }

  // -- level pump + keys ----------------------------------------------------

  const toggleMute = () => {
    const on = !store.getState().muted
    setMute(on)
    store.getState().setError(null)
  }

  // Mute is remembered across reloads, and the Windows app can drive it from
  // the tray and a global shortcut. The app also boots him straight away: it
  // restarts the page by itself after a crash, and a JARVIS that comes back to
  // a button nobody is there to press has not really come back.
  useEffect(() => {
    if (loadMuted()) store.getState().setMuted(true)
    reportMuted(store.getState().muted)
    onDesktopMute((on) => {
      if (on === null) toggleMute()
      else setMute(on)
    })
    if (IS_DESKTOP) void powerOn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // M mutes the microphone, and M again brings it back. Muted is properly
      // off — the device is released, not merely ignored — so the wake word
      // cannot fire either.
      if (e.key === 'm' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggleMute()
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      talk()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud onToggleMute={toggleMute} />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
      {IS_APP && <TalkButton onTalk={talk} />}
    </>
  )
}
