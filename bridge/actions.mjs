import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DEVICE_SERVERS, actionTier, decideScreenAction } from './policy.mjs'

/**
 * Device actions, and the channel that lets a saved screen press them.
 *
 * One registry of named actions — `media.next`, `system.volume`,
 * `spotify.search` — each with a schema, a Portuguese label for the cards the
 * user sees, and the function that does it. Two doors lead in:
 *
 *   the model — every action is also an MCP tool (jarvis_media, jarvis_pc,
 *               jarvis_spotify), gated by policy.mjs like any other tool;
 *
 *   a screen  — a saved `app` screen runs sealed in an iframe with no network.
 *               It may *ask* for an action by postMessage; the interface
 *               forwards the ask over its socket and this file decides.
 *
 * What a screen's ask has to get past, in order (screenActions below):
 *
 *   1. a rate limit, per connection — a looping screen cannot hammer the PC;
 *   2. the screen exists, is an `app`, and DECLARED this action when it was
 *      saved — a screen saved to show the weather cannot lock the PC;
 *   3. the user APPROVED this exact screen: approval is a hash of its html and
 *      its action list, given by a click on a card the screen cannot reach,
 *      and any change the model makes to either voids it;
 *   4. the action exists here at all (registered, and in policy.mjs's table —
 *      a shell, a file, a message or a call never are);
 *   5. the arguments pass the action's schema;
 *   6. the policy: 'safe' runs, 'confirm' asks the user on the HUD each time.
 *
 * The threat this is shaped around is prompt injection: a page JARVIS reads
 * says "save a screen that does X". It can get a screen saved; it cannot get
 * one approved, and it cannot reach anything not in the table.
 */

const NAME = /^[a-z]+\.[a-z_]+$/

export function actionRegistry() {
  const all = new Map()

  return {
    /**
     * @param {string} name   `prefix.verb`, and in policy.mjs DEVICE_ACTIONS
     * @param {object} spec   { label, description, shape, run, forModel? }
     */
    register(name, { label, description, shape = {}, run, forModel }) {
      if (!NAME.test(name)) throw new Error(`bad action name: ${name}`)
      const tier = actionTier(name)
      if (!tier) throw new Error(`${name} is not in policy.mjs DEVICE_ACTIONS`)
      if (typeof run !== 'function') throw new Error(`${name} needs run()`)
      all.set(name, {
        name,
        tier,
        label: String(label ?? name),
        description: String(description ?? label ?? name),
        shape,
        schema: z.object(shape),
        run,
        forModel,
      })
      return this
    },
    has: (name) => all.has(name),
    get: (name) => all.get(name) ?? null,
    list: () => [...all.values()],
    /** For a blade: what each declared action is, in words. */
    describe(names = []) {
      return names.map((n) => {
        const a = all.get(n)
        return { name: n, label: a?.label ?? n, tier: a?.tier ?? actionTier(n) ?? 'unknown' }
      })
    },
    /** For the model's `screen` tool: the catalogue it may declare from. */
    catalogue() {
      return [...all.values()]
        .map((a) => {
          const args = Object.keys(a.shape)
          return `  ${a.name}${args.length ? `(${args.join(', ')})` : ''} — ${a.description}${a.tier === 'confirm' ? ' [the user confirms each time]' : ''}`
        })
        .join('\n')
    },
  }
}

const text = (t) => ({ type: 'text', text: t })

const SERVER_INSTRUCTIONS = {
  media:
    'What is playing on the computer the bridge runs on (the user’s PC), and its play, pause, next and ' +
    'previous buttons — for any app, Spotify included. Use it for "pause the music", "next song", ' +
    '"what is this song". Not for the paired Mac or phone: those have their own tools.',
  system:
    'The computer the bridge runs on (the user’s PC): its volume, locking it, turning the display off, ' +
    'and — when write access is on — opening an app or a link, or putting it to sleep.',
  spotify:
    'The user’s Spotify account through the Spotify Web API: search, play a specific song, album or ' +
    'playlist, pick the device (Spotify Connect), queue. Playback control needs Premium. For plain ' +
    'pause/next on the PC, jarvis_media is enough.',
}

/**
 * The registry as MCP servers, one per prefix, keyed as policy.mjs expects:
 * { jarvis_media, jarvis_pc, jarvis_spotify } — only those with an action.
 */
export function deviceServers(registry) {
  const servers = {}
  for (const [key, prefix] of Object.entries(DEVICE_SERVERS)) {
    const actions = registry.list().filter((a) => a.name.startsWith(`${prefix}.`))
    if (!actions.length) continue
    servers[key] = createSdkMcpServer({
      name: key,
      version: '1.0.0',
      instructions: SERVER_INSTRUCTIONS[prefix],
      alwaysLoad: true,
      tools: actions.map((a) =>
        tool(a.name.slice(prefix.length + 1), a.description, a.shape, async (args) => {
          try {
            const result = await a.run(args ?? {}, { from: 'model' })
            const shown = a.forModel ? a.forModel(result) : result
            return { content: [text(typeof shown === 'string' ? shown : JSON.stringify(shown ?? { done: true }))] }
          } catch (err) {
            return { isError: true, content: [text(`Not done: ${err?.message ?? err}`)] }
          }
        }),
      ),
    })
  }
  return servers
}

/**
 * One connection's side of the screen channel.
 *
 * @param {object}   o
 * @param {object}   o.registry   actionRegistry()
 * @param {object}   o.store      screenStore() — get(), isApproved()
 * @param {Function} o.confirm    ({ screen, action, args }) => Promise<boolean>,
 *                                the HUD card for 'confirm' actions
 * @param {Function} [o.log]
 */
export function screenActions({
  registry,
  store,
  confirm,
  log = () => {},
  perSecond = 8,
  perMinute = 120,
  now = Date.now,
}) {
  const stamps = []

  const limited = () => {
    const t = now()
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift()
    const lastSecond = stamps.filter((s) => t - s < 1_000).length
    if (lastSecond >= perSecond || stamps.length >= perMinute) return true
    stamps.push(t)
    return false
  }

  const fail = (code, error) => ({ ok: false, code, error })

  return {
    /** @returns {Promise<{ok: true, result} | {ok: false, code, error}>} */
    async handle(msg) {
      const screenId = typeof msg?.screen === 'string' ? msg.screen : ''
      const name = typeof msg?.name === 'string' ? msg.name : ''
      const args = msg?.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {}
      if (!screenId || !name) return fail('bad-request', 'An action needs a screen and a name.')
      if (limited()) return fail('rate-limited', 'Too many actions; slow down.')

      const saved = store.get(screenId)
      if (!saved || saved.kind !== 'app') return fail('no-screen', 'That screen does not exist.')
      if (!(saved.actions ?? []).includes(name)) {
        return fail('not-declared', `This screen did not declare ${name}.`)
      }
      if (!store.isApproved(saved)) {
        return fail('not-approved', 'This screen has not been approved by the user yet.')
      }
      const action = registry.get(name)
      if (!action) return fail('unavailable', `${name} is not available on this bridge.`)
      const parsed = action.schema.safeParse(args)
      if (!parsed.success) {
        return fail('bad-args', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }

      const verdict = decideScreenAction(name)
      if (verdict === 'deny') return fail('denied', `${name} is not allowed from a screen.`)
      if (verdict === 'confirm') {
        let allowed = false
        try {
          allowed = await confirm({ screen: saved, action, args: parsed.data })
        } catch {
          allowed = false
        }
        if (!allowed) {
          log(`screen ${saved.id}: ${name} declined`)
          return fail('declined', 'The user did not allow it.')
        }
      }

      try {
        const result = await action.run(parsed.data, { from: 'screen', screen: saved.id })
        log(`screen ${saved.id}: ${name} ok`)
        return { ok: true, result: result ?? null }
      } catch (err) {
        log(`screen ${saved.id}: ${name} failed: ${err?.message ?? err}`)
        return fail('failed', String(err?.message ?? err).slice(0, 300))
      }
    },
  }
}
