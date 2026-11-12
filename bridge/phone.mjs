import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * JARVIS's hands on the user's phone.
 *
 * The phone runs the JARVIS app, which keeps one quiet socket open to this
 * bridge (see DeviceHub in devices.mjs). Each tool here is a command sent down
 * that socket; the app carries it out with the phone's own APIs — intents for
 * calls, maps and alarms, the notification listener for messages, the
 * accessibility service for reading the screen and tapping — and sends back
 * what happened.
 *
 * This replaces driving the phone over ADB, which needed a cable or the same
 * Wi-Fi. The app reaches the bridge from anywhere the phone has signal.
 *
 * Two gates, deliberately on different machines:
 *   - here, policy.mjs: anything that acts needs JARVIS_ALLOW_WRITES, exactly
 *     like every other effectful tool;
 *   - on the phone: anything that leaves the phone — a call, a text, a reply —
 *     waits for the user to tap "allow" on the phone itself, and apps the user
 *     has fenced off (banks, wallets, authenticators) are never read or
 *     touched. A web page the agent read cannot talk its way past a button on
 *     a screen in someone's hand.
 */

/** Commands that wait on a person tapping "allow" on the phone. */
const CONFIRM_TIMEOUT_MS = 90_000

const device = z
  .string()
  .optional()
  .catch(undefined)
  .describe('Which phone, by its paired name. Leave out to use the one connected most recently.')

/**
 * Phone screenshots written to disk, oldest first. Only the last few are
 * kept: each is a picture of whatever was on the user's phone, and a temp
 * folder full of them is a record nobody asked for.
 */
const KEEP_IMAGES = 10
const savedImages = []

function savePhoneImage(base64, mimeType) {
  try {
    const ext = mimeType === 'image/png' ? 'png' : 'jpg'
    const path = join(tmpdir(), `jarvis-phone-${Date.now()}.${ext}`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    savedImages.push(path)
    while (savedImages.length > KEEP_IMAGES) rmSync(savedImages.shift(), { force: true })
    return path
  } catch {
    return null // the image still reaches the model; only the blade misses out
  }
}

const text = (t) => ({ type: 'text', text: t })
const fail = (t) => ({ isError: true, content: [text(t)] })

/**
 * @param {import('./devices.mjs').DeviceHub} hub
 */
export function phoneServer(hub) {
  /**
   * Run one command on the phone and turn its reply into tool content.
   *
   * The phone answers { ok, text?, json?, data?, mimeType?, error? }. Every
   * failure comes back as one plain sentence, because it may well be spoken.
   */
  const relay = async (name, args, timeoutMs) => {
    const { device: which, ...rest } = args ?? {}
    let reply
    try {
      reply = await hub.call(name, rest, { device: which, timeoutMs })
    } catch (err) {
      return fail(
        `Could not reach the phone: ${err?.message ?? err}. ` +
          'Tell the user in one sentence; the JARVIS app on the phone may be closed or offline.',
      )
    }
    if (!reply?.ok) {
      return fail(String(reply?.error ?? 'The phone could not do that.'))
    }
    const content = []
    if (typeof reply.text === 'string' && reply.text) content.push(text(reply.text))
    if (reply.json !== undefined) content.push(text(JSON.stringify(reply.json)))
    if (typeof reply.data === 'string' && reply.data) {
      // The model can see an image it is handed, but a blade can only show a
      // file or a URL. Saved to disk as well, so "show me my phone screen"
      // can put it on the display — the /file route serves the temp folder.
      const path = savePhoneImage(reply.data, reply.mimeType)
      if (path) {
        content.push(
          text(`Saved at ${path} — to show it, open a blade of kind "image" with this path as its url.`),
        )
      }
      content.push({ type: 'image', data: reply.data, mimeType: reply.mimeType ?? 'image/jpeg' })
    }
    if (!content.length) content.push(text('Done.'))
    return { content }
  }

  const def = (name, description, shape, timeoutMs) =>
    tool(name, description, { ...shape, device }, (args) => relay(name, args, timeoutMs))

  return createSdkMcpServer({
    name: 'jarvis_phone',
    version: '1.0.0',
    instructions:
      "The user's Android phone, through the JARVIS app on it. Works from anywhere " +
      'the phone has signal. Use it when they ask for something on their phone. ' +
      'Calls, texts and replies are confirmed by the user on the phone itself.',
    alwaysLoad: true,
    tools: [
      // --- reading ---------------------------------------------------------
      tool(
        'status',
        'Which phones are connected right now, with battery, network and what each app build can do. Check this first when unsure whether the phone is reachable.',
        {},
        async () => {
          const phones = hub.connected()
          if (!phones.length) return { content: [text('No phone is connected.')] }
          const live = await relay('status', {}, 8_000)
          return {
            content: [text(JSON.stringify({ connected: phones })), ...(live.isError ? [] : live.content)],
          }
        },
      ),
      def('list_apps', 'The apps installed on the phone, as label and package name.', {}),
      def(
        'read_screen',
        'What is on the phone screen right now, as a list of elements with text, role and position. Prefer this to a screenshot for reading and for finding what to tap.',
        {},
      ),
      def('screenshot', 'A picture of the phone screen right now.', {}),
      def(
        'read_notifications',
        'Recent notifications on the phone — messages, mail, reminders — with app, title, text and an id for replying.',
        {
          app: z.string().optional().catch(undefined).describe('Only this app (label or package).'),
          limit: z.number().int().min(1).max(50).optional().catch(undefined),
        },
      ),
      def('get_location', 'Where the phone is: coordinates and, when available, an address.', {}),

      // --- acting on the phone itself --------------------------------------
      def(
        'open_app',
        'Open an app on the phone by its name or package.',
        { app: z.string().describe('App label ("Spotify") or package name.') },
      ),
      def(
        'open_url',
        'Open a web address on the phone, in its browser or the app that handles it.',
        { url: z.string().url() },
      ),
      def(
        'navigate',
        'Start turn-by-turn navigation on the phone to a place or address.',
        {
          destination: z.string(),
          mode: z.enum(['drive', 'walk', 'bike', 'transit']).optional().catch(undefined),
        },
      ),
      def(
        'set_timer',
        'Start a countdown timer on the phone.',
        { seconds: z.number().int().min(1).max(86_400), label: z.string().optional().catch(undefined) },
      ),
      def(
        'set_alarm',
        'Set an alarm on the phone, in the phone’s local time.',
        {
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          label: z.string().optional().catch(undefined),
        },
      ),
      def('flashlight', 'Turn the phone torch on or off.', { on: z.boolean() }),
      def(
        'set_volume',
        'Set a phone volume, 0 to 100.',
        {
          level: z.number().min(0).max(100),
          stream: z.enum(['media', 'ring', 'alarm']).optional().catch(undefined),
        },
      ),
      def(
        'tap',
        'Tap the phone screen, either on an element from read_screen (by its id) or at coordinates.',
        {
          element: z.string().optional().catch(undefined),
          x: z.number().optional().catch(undefined),
          y: z.number().optional().catch(undefined),
        },
      ),
      def(
        'swipe',
        'Swipe on the phone screen.',
        {
          direction: z.enum(['up', 'down', 'left', 'right']),
          distance: z.number().min(0.1).max(1).optional().catch(undefined).describe('Fraction of the screen, default 0.5.'),
        },
      ),
      def(
        'type_text',
        'Type text into whatever field has focus on the phone.',
        { text: z.string().max(2000), submit: z.boolean().optional().catch(undefined) },
      ),
      def(
        'press_key',
        'Press a system button on the phone.',
        { key: z.enum(['back', 'home', 'recents', 'notifications', 'lock']) },
      ),

      // --- leaving the phone: confirmed by the user on the phone -----------
      def(
        'call',
        'Place a phone call to a contact name or number. The user confirms it on the phone before it dials.',
        { to: z.string() },
        CONFIRM_TIMEOUT_MS,
      ),
      def(
        'send_sms',
        'Send a text message to a contact name or number. The user confirms it on the phone before it sends.',
        { to: z.string(), message: z.string().max(1000) },
        CONFIRM_TIMEOUT_MS,
      ),
      def(
        'reply_notification',
        'Reply to a message notification (WhatsApp, Telegram, SMS…) by its id from read_notifications. The user confirms it on the phone before it sends.',
        { id: z.string(), message: z.string().max(1000) },
        CONFIRM_TIMEOUT_MS,
      ),
    ],
  })
}
