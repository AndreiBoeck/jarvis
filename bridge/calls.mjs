import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Telephone calls placed by JARVIS, through an ElevenLabs conversational agent.
 *
 * Three different requests that all sound like "call":
 *
 *   "call me when a message arrives"      -> callUser: the agent rings the
 *                                            user's own number (JARVIS_CALL_TO)
 *                                            and tells them.
 *   "call my dentist, say I'm running late" -> callOther: the agent rings the
 *                                            dentist and carries out the task.
 *   "use my phone to call Maria"          -> not here at all: jarvis_phone's
 *                                            `call`, dialled on the handset.
 *
 * The elevenlabs MCP server has a make_outbound_call tool, but it can only
 * start the agent as configured — it cannot say what this particular call is
 * for. So the bridge calls the API itself, sending each call's prompt and
 * opening line as a conversation override. The agent must allow those
 * overrides (Security tab: first message, system prompt, language), or the
 * call is refused; checkLine() says so in plain words.
 */

const API = 'https://api.elevenlabs.io'

/**
 * How every call to someone else opens. On these calls the voice is Friday,
 * not JARVIS: JARVIS is who the user talks to, Friday is who answers the
 * dentist. {name} is JARVIS_USER_NAME.
 */
export const DEFAULT_INTRO = "Hello, I'm Friday, {name}'s AI assistant, calling on his behalf."

/** "+55 (11) 9 1234-5678" -> "+5511912345678"; null if it isn't a full number. */
export function normaliseNumber(raw) {
  let n = String(raw ?? '').trim().replace(/[\s().-]/g, '')
  if (n.startsWith('00')) n = `+${n.slice(2)}`
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null
}

/** For logs: everything but the last four digits hidden. */
export const maskNumber = (n) => String(n ?? '').replace(/\d(?=\d{4})/g, '•')

export class Caller {
  /**
   * @param {object} o
   * @param {() => string|null} o.key       the ElevenLabs API key
   * @param {string} [o.agentId]            JARVIS_CALL_AGENT_ID
   * @param {string} [o.fromId]             JARVIS_CALL_FROM_NUMBER_ID
   * @param {string} [o.userNumber]         JARVIS_CALL_TO
   * @param {string} [o.userName]           JARVIS_USER_NAME, for calls on their behalf
   * @param {string} [o.intro]              JARVIS_CALL_INTRO, how a call to someone else opens; {name} is the user
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ key, agentId = '', fromId = '', userNumber = '', userName = '', intro = '', fetchImpl = fetch }) {
    this.intro = intro.trim() || DEFAULT_INTRO
    this.key = key
    this.agentId = agentId
    this.fromId = fromId
    this.userNumber = normaliseNumber(userNumber)
    this.userName = userName.trim()
    this.fetch = fetchImpl
    this.cached = null
  }

  async api(path, init = {}) {
    const key = this.key()
    if (!key) throw new Error('No ElevenLabs key is configured, so no call can be placed.')
    const res = await this.fetch(`${API}${path}`, {
      ...init,
      headers: { 'xi-api-key': key, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = body?.detail
      const msg =
        typeof detail === 'string' ? detail : (detail?.message ?? JSON.stringify(detail ?? body ?? {}))
      const err = new Error(`ElevenLabs said ${res.status}: ${String(msg).slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return body
  }

  /**
   * Which agent and which number to call from. Configured ids win; otherwise
   * the number assigned to the agent, or the account's only number and agent.
   * Cached, since none of this changes while the bridge runs.
   */
  async line() {
    if (this.cached) return this.cached
    const numbers = await this.api('/v1/convai/phone-numbers')
    const list = Array.isArray(numbers) ? numbers : (numbers?.phone_numbers ?? [])
    let number =
      (this.fromId && list.find((n) => n.phone_number_id === this.fromId)) ||
      (this.agentId && list.find((n) => n.assigned_agent?.agent_id === this.agentId)) ||
      (list.length === 1 ? list[0] : null)
    if (!number) {
      throw new Error(
        list.length
          ? 'There are several ElevenLabs numbers; set JARVIS_CALL_FROM_NUMBER_ID to choose one.'
          : 'The ElevenLabs account has no phone number to call from.',
      )
    }
    let agentId = this.agentId || number.assigned_agent?.agent_id
    if (!agentId) {
      const agents = (await this.api('/v1/convai/agents'))?.agents ?? []
      const pick = agents.find((a) => /jarvis/i.test(a.name ?? '')) ?? (agents.length === 1 ? agents[0] : null)
      if (!pick) throw new Error('Set JARVIS_CALL_AGENT_ID to the ElevenLabs agent that should place calls.')
      agentId = pick.agent_id
    }
    this.cached = {
      agentId,
      phoneNumberId: number.phone_number_id,
      provider: number.provider ?? 'twilio',
      from: number.phone_number,
    }
    return this.cached
  }

  /**
   * Whether the agent lets each call bring its own prompt and opening line.
   * Returns the list of overrides that are still switched off.
   */
  async missingOverrides() {
    const { agentId } = await this.line()
    const agent = await this.api(`/v1/convai/agents/${agentId}`)
    const o = agent?.platform_settings?.overrides?.conversation_config_override?.agent ?? {}
    const missing = []
    if (!o.first_message) missing.push('first message')
    if (!o.prompt?.prompt) missing.push('system prompt')
    if (!o.language) missing.push('language')
    return missing
  }

  /** Place one call. Returns the conversation id, for call_status. */
  async place({ to, prompt, firstMessage, language }) {
    const number = normaliseNumber(to)
    if (!number) throw new Error('That is not a full phone number with its country code.')
    const line = await this.line()
    const agent = { prompt: { prompt }, first_message: firstMessage }
    if (language) agent.language = language
    const path =
      line.provider === 'twilio' ? '/v1/convai/twilio/outbound-call' : '/v1/convai/sip-trunk/outbound-call'
    let out
    try {
      out = await this.api(path, {
        method: 'POST',
        body: JSON.stringify({
          agent_id: line.agentId,
          agent_phone_number_id: line.phoneNumberId,
          to_number: number,
          conversation_initiation_client_data: { conversation_config_override: { agent } },
        }),
      })
    } catch (err) {
      if (err.status >= 400 && err.status < 500 && /override/i.test(err.message)) {
        throw new Error(
          'The ElevenLabs agent does not allow per-call instructions. Turn on the first message, ' +
            'system prompt and language overrides in the agent’s Security settings.',
        )
      }
      throw err
    }
    if (out && out.success === false) throw new Error(out.message || 'The call could not be placed.')
    console.log(`[jarvis] call placed to ${maskNumber(number)}`)
    return { conversationId: out?.conversation_id ?? null, to: number }
  }

  /** Ring the user and tell them something. */
  async callUser(message) {
    if (!this.userNumber) {
      throw new Error('The number to call you on is not configured (JARVIS_CALL_TO).')
    }
    return this.place({
      to: this.userNumber,
      prompt: userCallPrompt(message),
      firstMessage: message,
      language: 'en',
    })
  }

  /** The line a call to someone else opens with. */
  introduction() {
    return this.userName
      ? this.intro.replaceAll('{name}', this.userName)
      : "Hello, I'm Friday, an AI assistant, calling on behalf of the person I work for."
  }

  /** Ring someone else and carry out a task for the user. */
  async callOther({ to, who, task, language }) {
    const number = normaliseNumber(to)
    if (number && number === this.userNumber) return this.callUser(task)
    const intro = this.introduction()
    return this.place({
      to,
      prompt: otherCallPrompt({ who, task, onBehalfOf: this.userName, language, intro }),
      firstMessage: intro,
      language,
    })
  }

  /** How a call went: its state, and once it is over, what was said. */
  async status(conversationId) {
    const c = await this.api(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`)
    const transcript = (c?.transcript ?? [])
      .filter((t) => t?.message)
      .map((t) => `${t.role === 'agent' ? 'Assistant' : 'Them'}: ${t.message}`)
    return {
      status: c?.status ?? 'unknown',
      summary: c?.analysis?.transcript_summary ?? null,
      outcome: c?.analysis?.call_successful ?? null,
      seconds: c?.metadata?.call_duration_secs ?? null,
      transcript: transcript.slice(-30),
    }
  }
}

export function userCallPrompt(message) {
  return `You are JARVIS, a personal assistant, on the telephone to the person you work for.
You rang them to tell them this: ${message}
You have already said it as your opening line. Answer what you can about it briefly, from what is above only; if you do not know, say so.
British service register, dry, extremely concise: one or two short sentences per turn. Call them "sir" about half the time, never by name.
Never apologise, never use filler words, never show enthusiasm. English only.
When they have what they need, say goodbye and end the call.`
}

export function otherCallPrompt({ who, task, onBehalfOf, language, intro }) {
  const principal = onBehalfOf || 'the person you work for'
  return `You are Friday, ${principal}'s AI assistant, making a telephone call on their behalf.
You are calling: ${who || 'the person who answers'}.
Your task: ${task}

You have already opened the call with: "${intro}"
Do not introduce yourself again; go straight on to the task.

How to behave:
- Speak ${language ? `the language with code "${language}"` : 'the language of the person you are calling'}, naturally and politely, like a capable human assistant. Be brief. If that is not English, switch to it from your second sentence on.
- If asked who you are: Friday, an AI assistant calling for ${principal}. Never pretend to be human.
- Do only this task. Do not agree to anything beyond it, make payments, or share personal details the task does not need. If they ask for something you cannot settle, say ${principal} will get back to them.
- If you reach voicemail or an answering machine, leave one short message with the task and end the call.
- When the task is done, thank them, say goodbye and end the call.`
}

/**
 * The tools the conversation agent calls, mounted as `jarvis_call`.
 */
export function callServer(caller) {
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
  const fail = (err) => ({
    isError: true,
    content: [{ type: 'text', text: String(err?.message ?? err) }],
  })

  return createSdkMcpServer({
    name: 'jarvis_call',
    version: '1.0.0',
    instructions:
      'Telephone calls placed by JARVIS through ElevenLabs: ringing the user, or ringing someone else to do a task for them.',
    alwaysLoad: true,
    tools: [
      tool(
        'call_me',
        'Ring the user on their own phone, now, and tell them something. Their number is configured; you never need it.',
        {
          message: z
            .string()
            .min(3)
            .describe('The opening line, said the moment they answer, in English. E.g. "Sir, a message from Maria has just arrived."'),
        },
        async ({ message }) => {
          try {
            const r = await caller.callUser(message)
            return ok({ calling: 'you', conversation_id: r.conversationId })
          } catch (err) {
            return fail(err)
          }
        },
      ),
      tool(
        'call_someone',
        'Ring someone other than the user and carry out a task for them by voice — tell the dentist they are running late, book a table, ask opening hours. ' +
          'The call runs on its own; use call_status afterwards to hear how it went.',
        {
          to_number: z.string().describe('Full number with country code, e.g. +5511912345678. Never guess one.'),
          who: z.string().describe('Who is being called, e.g. "Dr Paulo\'s dental clinic".'),
          task: z
            .string()
            .min(5)
            .describe('Exactly what to say or find out, with every detail needed: names, times, how late, what to ask.'),
          language: z
            .string()
            .optional()
            .describe('Language code for the call, e.g. "pt" for a Brazilian number, "en" for English.'),
        },
        async (args) => {
          try {
            const r = await caller.callOther({
              to: args.to_number,
              who: args.who,
              task: args.task,
              language: args.language,
            })
            return ok({ calling: args.who, conversation_id: r.conversationId })
          } catch (err) {
            return fail(err)
          }
        },
      ),
      tool(
        'call_status',
        'How a call placed with call_me or call_someone went: whether it is still going, a summary, and what was said.',
        { conversation_id: z.string() },
        async ({ conversation_id }) => {
          try {
            return ok(await caller.status(conversation_id))
          } catch (err) {
            return fail(err)
          }
        },
      ),
    ],
  })
}
