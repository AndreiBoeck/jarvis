import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { deviceRelay, text } from './phone.mjs'

/**
 * JARVIS's hands on the user's Mac.
 *
 * The Mac runs the JARVIS app (macos/ in this repository), which keeps one
 * quiet socket open to this bridge — the same /device link and the same
 * protocol as the phone app, so DeviceHub carries both. Each tool here is a
 * command sent down that socket; the app carries it out with macOS's own APIs —
 * NSWorkspace for apps and links, the accessibility API for reading the screen
 * and clicking, CGEvent for typing, AppleScript for volume and Messages — and
 * sends back what happened.
 *
 * The same two gates as the phone, on different machines:
 *   - here, policy.mjs: anything that acts needs JARVIS_ALLOW_WRITES;
 *   - on the Mac: anything that leaves the Mac or runs the user's own
 *     automations — an iMessage, a Shortcut — waits for the user to click
 *     "Permitir" on the Mac itself, and apps fenced off there (password
 *     managers, banks, Keychain Access) are never read or touched.
 *
 * The bridge can run on the Mac too (local mode); then the app links to its
 * own bridge on localhost and these tools act on the machine the bridge is
 * running on. Nothing here changes.
 */

/** Commands that wait on a person clicking "Permitir" on the Mac. */
const CONFIRM_TIMEOUT_MS = 90_000

const device = z
  .string()
  .optional()
  .catch(undefined)
  .describe('Which Mac, by its paired name. Leave out to use the one connected most recently.')

/**
 * @param {import('./devices.mjs').DeviceHub} hub
 */
export function macServer(hub) {
  const relay = deviceRelay(hub, 'mac')

  const def = (name, description, shape, timeoutMs) =>
    tool(name, description, { ...shape, device }, (args) => relay(name, args, timeoutMs))

  return createSdkMcpServer({
    name: 'jarvis_mac',
    version: '1.0.0',
    instructions:
      "The user's MacBook, through the JARVIS app on it. Works from anywhere the Mac " +
      'is awake and online. Use it when they ask for something on their Mac. ' +
      'iMessages and Shortcuts are confirmed by the user on the Mac itself.',
    alwaysLoad: true,
    tools: [
      // --- reading ---------------------------------------------------------
      tool(
        'status',
        'Which Macs are connected right now, with battery, the app in front, and which macOS permissions the JARVIS app has. Check this first when unsure whether the Mac is reachable or a command failed for lack of permission.',
        {},
        async () => {
          const macs = hub.connected('mac')
          if (!macs.length) return { content: [text('No Mac is connected.')] }
          const live = await relay('status', {}, 8_000)
          return {
            content: [text(JSON.stringify({ connected: macs })), ...(live.isError ? [] : live.content)],
          }
        },
      ),
      def('list_apps', 'The apps installed on the Mac, and which are running right now.', {}),
      def(
        'read_screen',
        'What is in the front window on the Mac right now, as a list of elements with role, text, position and an id to click. Prefer this to a screenshot for reading and for finding what to click.',
        {},
      ),
      def(
        'screenshot',
        'A picture of the Mac main screen right now. Its pixels match the coordinates click and scroll take.',
        {},
      ),
      def('read_clipboard', 'The text on the Mac clipboard.', {}),

      // --- acting on the Mac itself ----------------------------------------
      def(
        'open_app',
        'Open (or bring to the front) an app on the Mac by its name or bundle id.',
        { app: z.string().describe('App name ("Safari", "Spotify") or bundle id.') },
      ),
      def(
        'quit_app',
        'Quit a running app on the Mac. It is asked to quit normally, so unsaved work prompts as usual.',
        { app: z.string() },
      ),
      def(
        'open_url',
        'Open a web address on the Mac, in its default browser or the app that handles it.',
        { url: z.string().url() },
      ),
      def(
        'click',
        'Click on the Mac, either on an element from read_screen (by its id) or at screen coordinates in points, as in the screenshot.',
        {
          element: z.string().optional().catch(undefined),
          x: z.number().optional().catch(undefined),
          y: z.number().optional().catch(undefined),
          double: z.boolean().optional().catch(undefined),
          right: z.boolean().optional().catch(undefined),
        },
      ),
      def(
        'scroll',
        'Scroll on the Mac, at coordinates or wherever the pointer is.',
        {
          direction: z.enum(['up', 'down', 'left', 'right']),
          amount: z.number().int().min(1).max(50).optional().catch(undefined).describe('Lines, default 5.'),
          x: z.number().optional().catch(undefined),
          y: z.number().optional().catch(undefined),
        },
      ),
      def(
        'type_text',
        'Type text into whatever has focus on the Mac.',
        { text: z.string().max(4000), submit: z.boolean().optional().catch(undefined) },
      ),
      def(
        'press_key',
        'Press a key or shortcut on the Mac, e.g. "return", "escape", "tab", "cmd+t", "cmd+shift+4", "left".',
        { key: z.string().max(40) },
      ),
      def(
        'media',
        'Control what is playing on the Mac, whichever app it is in.',
        { action: z.enum(['play_pause', 'next', 'previous']) },
      ),
      def(
        'set_volume',
        'Set the Mac output volume, 0 to 100, or mute it.',
        { level: z.number().min(0).max(100).optional().catch(undefined), mute: z.boolean().optional().catch(undefined) },
      ),
      def('write_clipboard', 'Put text on the Mac clipboard.', { text: z.string().max(20_000) }),
      def(
        'notify',
        'Show a notification on the Mac — for something they should see when they are back at it.',
        { title: z.string().max(100), message: z.string().max(500) },
      ),
      def('sleep_display', 'Turn the Mac display off (it locks if the Mac is set to).', {}),

      // --- leaving the Mac, or running their automations: confirmed there ---
      def(
        'run_shortcut',
        'Run one of the user’s Shortcuts on the Mac by its exact name, optionally with text input. The user confirms it on the Mac first.',
        { name: z.string().max(200), input: z.string().max(4000).optional().catch(undefined) },
        CONFIRM_TIMEOUT_MS,
      ),
      def(
        'send_imessage',
        'Send an iMessage from the Mac Messages app to a phone number, email or contact name. The user confirms it on the Mac before it sends.',
        { to: z.string().max(200), message: z.string().max(2000) },
        CONFIRM_TIMEOUT_MS,
      ),
    ],
  })
}
