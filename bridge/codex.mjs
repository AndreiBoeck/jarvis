import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reserve brain: OpenAI's Codex CLI, for when Claude has run out.
 *
 * A Claude subscription has hard usage windows — five hours, seven days — and
 * when one closes every turn comes back as "usage limit reached" until it
 * reopens. A voice assistant that goes mute for hours because of a quota is
 * worse than one that answers with a different model, so the bridge hands the
 * question to `codex exec` instead and speaks whatever it says.
 *
 * What it can do is narrower. It runs in Codex's read-only sandbox with live
 * web search, and with whatever MCP servers ~/.codex/config.toml gives it — but
 * none of JARVIS's own in-process tools (blades, the interface, the camera,
 * phone, Mac) exist on that side. It answers by voice. That is the trade: a
 * smaller JARVIS rather than a silent one.
 */

/** How the question is phrased and from where Codex runs. */
export const CODEX_ENABLED = process.env.JARVIS_CODEX_FALLBACK !== '0'
const MODEL = process.env.JARVIS_CODEX_MODEL?.trim() || ''
const TIMEOUT_MS = Number(process.env.JARVIS_CODEX_TIMEOUT_MS) || 3 * 60_000

/**
 * The command to run. The npm install puts a `codex.cmd` shim on Windows,
 * which only runs through a shell — and a shell is one more process between us
 * and the one that has to be killed on a barge-in. So the shim's own target is
 * run with this Node when it can be found.
 */
function codexCommand() {
  const explicit = process.env.JARVIS_CODEX_BIN?.trim()
  if (explicit) {
    return /\.[cm]?js$/.test(explicit)
      ? { cmd: process.execPath, pre: [explicit], shell: false }
      : { cmd: explicit, pre: [], shell: false }
  }
  if (process.platform === 'win32') {
    const js = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(js)) return { cmd: process.execPath, pre: [js], shell: false }
    return { cmd: 'codex', pre: [], shell: true }
  }
  return { cmd: 'codex', pre: [], shell: false }
}

/** Stop a run and everything it started. On Windows killing the parent leaves
 *  the native binary behind, so the whole tree goes. */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

/**
 * Whether a message from Claude means the account is out of usage, as opposed
 * to some other failure. Checked against the plain text the CLI substitutes for
 * an answer when a window closes ("Claude AI usage limit reached", "You've hit
 * your limit · resets 3pm") and the SDK's own error codes.
 */
export function looksLikeLimit(text) {
  return /usage limit|hit your (?:usage )?limit|limit reached|rate[ _-]?limit|out of (?:extra )?(?:usage|credits)|credit balance|billing_error|quota/i.test(
    String(text ?? ''),
  )
}

/**
 * Ask Codex one question.
 *
 * @param {object} o
 * @param {string} o.system    the persona and the rules for this run
 * @param {{role: 'user'|'jarvis', text: string}[]} o.history  recent turns, oldest first
 * @param {string} o.question  what was just asked
 * @param {string} o.cwd       where it runs (JARVIS's workspace)
 * @param {AbortSignal} o.signal
 * @param {(text: string) => void} o.onText  each message as it completes
 * @param {(name: string) => void} o.onTool  each piece of work it starts
 * @returns {Promise<string>} everything it said
 */
export function askCodex({ system, history, question, cwd, signal, onText, onTool }) {
  const convo = history.length
    ? '\n\nThe conversation so far:\n' +
      history.map((t) => `${t.role === 'user' ? 'User' : 'JARVIS'}: ${t.text}`).join('\n')
    : ''
  const prompt = `${system}${convo}\n\nUser: ${question}\n\nJARVIS:`

  const { cmd, pre, shell } = codexCommand()
  const args = [
    ...pre,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '-c',
    'web_search="live"',
    ...(MODEL ? ['-m', MODEL] : []),
    '-C',
    cwd,
    '-',
  ]

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const child = spawn(cmd, args, { cwd, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let said = ''
    let failure = ''
    let stderr = ''
    let buf = ''
    let settled = false

    const end = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      killTree(child)
      if (err) reject(err)
      else resolve(said.trim())
    }
    const onAbort = () => end(new Error('aborted'))
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => end(new Error('Codex took too long to answer.')), TIMEOUT_MS)

    const line = (raw) => {
      let ev
      try {
        ev = JSON.parse(raw)
      } catch {
        return
      }
      const item = ev.item
      if (ev.type === 'item.started' && item && item.type !== 'agent_message' && item.type !== 'reasoning') {
        onTool?.(`codex · ${String(item.type).replace(/_/g, ' ')}`)
      } else if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
        const piece = (said ? ' ' : '') + item.text
        said += piece
        onText?.(piece)
      } else if (ev.type === 'turn.failed') {
        failure = ev.error?.message ?? 'Codex could not answer.'
      } else if (ev.type === 'error') {
        failure = ev.message ?? 'Codex reported an error.'
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl).trim())
        buf = buf.slice(nl + 1)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on('error', (err) =>
      end(new Error(err.code === 'ENOENT' ? 'Codex is not installed on this machine.' : err.message)),
    )
    child.on('close', (code) => {
      if (buf.trim()) line(buf.trim())
      if (said) return end()
      end(new Error(failure || stderr.trim().split('\n').pop() || `Codex exited with code ${code}.`))
    })

    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}
