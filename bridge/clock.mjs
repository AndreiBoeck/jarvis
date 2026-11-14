/**
 * The clock, for the model.
 *
 * The model has no sense of time: asked "what time is it?" with nothing to go
 * on, it invents one — a confident "twenty past eight in the evening" at a
 * quarter past ten in the morning. So every question handed to it starts with
 * a line saying when it is being asked.
 *
 * On the user's turn, not in the system prompt: the system prompt is cached,
 * and a line in it that changes every minute would throw the cache away on
 * every question. Stamped per question, not per session, because a session
 * lasts all day.
 *
 * The time is the bridge's own local time (override with JARVIS_TZ, an IANA
 * name like "America/Sao_Paulo"), which is where the user is assumed to be
 * whichever screen they are speaking through.
 */

const CONFIGURED_ZONE = process.env.JARVIS_TZ?.trim() || ''

function zoneOrLocal(zone) {
  if (zone) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone
    } catch {
      /* not a zone this machine knows: fall back to its own */
    }
  }
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * "Saturday, 14 November 2026, 10:15, UTC-03:00 (America/Sao_Paulo)"
 */
export function describeNow(now = Date.now(), zone = CONFIGURED_ZONE) {
  const timeZone = zoneOrLocal(zone)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  )
  // "GMT-03:00", or a bare "GMT" at zero offset.
  const offset = parts.timeZoneName === 'GMT' ? 'UTC+00:00' : parts.timeZoneName.replace('GMT', 'UTC')
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}, ${offset} (${timeZone})`
}

/** The question, with the moment it was asked in front of it. */
export function stampNow(text, now = Date.now(), zone = CONFIGURED_ZONE) {
  return `[Now: ${describeNow(now, zone)}]\n${text}`
}

/** Tells the model what the stamp is. Constant, so it is safe in a cached prompt. */
export const PROMPT_CLOCK = `The clock:
- Every message starts with a line like "[Now: Saturday, 14 November 2026,
  10:15, UTC-03:00 (America/Sao_Paulo)]". It is put there by the JARVIS
  system, not said by the user: the user's local date and time, in 24-hour
  form, at the moment they spoke.
- It is the only clock you have. Use the most recent one for the time, the
  date, the day of the week, "today", "tomorrow", "in an hour" and greetings
  for the time of day. Never guess the time, and never go by an earlier line.
- Do not mention the line or read it out unless asked what time or day it is.

`
