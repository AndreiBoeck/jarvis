import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { BRIDGE_WS_URL, DEFAULT_BRIDGE_URL, readLink, saveLink } from '../config'
import { Device, type DeviceStatus } from '../lib/device'

/**
 * The parts of the interface that exist only in the Android app.
 *
 * Everything else is the desktop HUD, unchanged. These are the three things a
 * phone needs that a desktop browser does not: a way to pair with the bridge
 * at home, a button in place of the wake word, and a sheet of switches for
 * what the phone lets JARVIS do.
 */

/** wss://host → https://host, for the health check. */
const httpOf = (ws: string) => ws.trim().replace(/\/+$/, '').replace(/^ws/, 'http')

/** Accept "pc.tailnet.ts.net", "https://…" or "wss://…" alike. */
function normaliseAddress(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '')
  if (/^wss?:\/\//i.test(v)) return v
  if (/^https?:\/\//i.test(v)) return v.replace(/^http/i, 'ws')
  return `wss://${v}`
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * Shown instead of the whole interface until the phone is paired.
 *
 * The token comes from `npm run pair` on the PC. It is checked against the
 * bridge before anything is saved, so a typo is caught here rather than
 * surfacing later as an assistant that silently never answers.
 */
export function Pairing() {
  const [address, setAddress] = useState(readLink()?.url ?? DEFAULT_BRIDGE_URL)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pair = async () => {
    const url = normaliseAddress(address)
    const t = token.trim()
    if (!url || !t) return setError('Preencha o endereço e o token.')
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${httpOf(url)}/health`, {
        headers: { authorization: `Bearer ${t}` },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 403 || res.status === 401) {
        throw new Error('O Jarvis recusou este token. Gere outro com npm run pair no PC.')
      }
      if (!res.ok) throw new Error(`O Jarvis respondeu com erro ${res.status}.`)
      saveLink({ url, token: t })
      // The background link uses the same pairing. Best effort: the
      // interface works without it, and the setup sheet can switch it on.
      await Device.configure({ url, token: t, enabled: true }).catch(() => {})
      location.reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        /fetch|network|abort|timed? ?out/i.test(msg)
          ? 'Não consegui chegar ao PC. Confira se o Tailscale está ligado no celular e se a ponte está rodando.'
          : msg,
      )
      setBusy(false)
    }
  }

  return (
    <div className="m-pair">
      <div className="m-pair-card">
        <div className="m-pair-title">J.A.R.V.I.S.</div>
        <div className="m-pair-sub">Conectar ao Jarvis de casa</div>

        <label className="m-field">
          <span>Endereço</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="seu-pc.sua-rede.ts.net"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </label>
        <label className="m-field">
          <span>Token</span>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="jv_…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        {error && <div className="m-error">{error}</div>}

        <button className="m-primary" disabled={busy} onClick={() => void pair()}>
          {busy ? 'Conectando…' : 'Conectar'}
        </button>
        <div className="m-hint">
          No PC, rode <code>npm run pair -- "Meu celular"</code> e cole aqui o token que aparecer.
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Talk button
// ---------------------------------------------------------------------------

/**
 * In place of the wake word. One tap starts a turn; tapped while he is
 * thinking or talking, it cuts in, exactly like Space on the desktop.
 */
export function TalkButton({ onTalk }: { onTalk: () => void }) {
  const phase = useStore((s) => s.phase)
  const [setup, setSetup] = useState(false)
  if (phase === 'offline' || phase === 'boot') return null

  const live = phase === 'listening' || phase === 'waking'
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  return (
    <>
      <button
        className={`m-talk${live ? ' is-live' : ''}${busy ? ' is-busy' : ''}`}
        onClick={onTalk}
        aria-label={busy ? 'Interromper e falar' : 'Falar com o Jarvis'}
      >
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
          />
        </svg>
      </button>
      <button className="m-gear" onClick={() => setSetup(true)} aria-label="Ajustes do celular">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.5h-4L10.7 6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
            transform="translate(-1 0)"
          />
        </svg>
      </button>
      {setup && <Setup onClose={() => setSetup(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Setup sheet
// ---------------------------------------------------------------------------

type Row = {
  title: string
  detail: string
  on: boolean
  action?: { label: string; run: () => Promise<unknown> }
}

/**
 * What the phone lets JARVIS do, and the switch for each.
 *
 * Every one of these is granted in Android's own settings — the app can only
 * open the right page. So the sheet re-reads the status whenever the app comes
 * back to the front, which is the moment the user returns from granting it.
 */
function Setup({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<DeviceStatus | null>(null)
  const [error, setError] = useState('')

  const refresh = () =>
    Device.status()
      .then(setS)
      .catch((e) => setError(String(e?.message ?? e)))

  useEffect(() => {
    void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    const poll = setInterval(() => void refresh(), 3000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(poll)
    }
  }, [])

  const link = readLink()
  const perms = s?.permissions ?? {}
  const allPerms = Object.values(perms).length > 0 && Object.values(perms).every(Boolean)

  const rows: Row[] = s
    ? [
        {
          title: 'Conexão em segundo plano',
          detail: s.enabled
            ? s.connected
              ? 'Conectado. O Jarvis do PC alcança este celular.'
              : `Tentando conectar…${s.lastError ? ` (${s.lastError})` : ''}`
            : 'Desligada. O PC só alcança o celular com o app aberto.',
          on: s.enabled && s.connected,
          action: link
            ? {
                label: s.enabled ? 'Desligar' : 'Ligar',
                run: () => Device.configure({ ...link, enabled: !s.enabled }),
              }
            : undefined,
        },
        {
          title: 'Permissões',
          detail: 'Microfone, ligações, SMS, contatos, localização e avisos.',
          on: allPerms,
          action: allPerms ? undefined : { label: 'Conceder', run: () => Device.grantPermissions() },
        },
        {
          title: 'Controle da tela',
          detail: 'Ler a tela, tocar e digitar em qualquer app (Acessibilidade → Jarvis).',
          on: s.accessibility,
          action: { label: s.accessibility ? 'Abrir' : 'Ativar', run: () => Device.openAccessibilitySettings() },
        },
        {
          title: 'Notificações',
          detail: 'Ler mensagens e responder por elas.',
          on: s.notifications,
          action: { label: s.notifications ? 'Abrir' : 'Ativar', run: () => Device.openNotificationSettings() },
        },
        {
          title: 'Bateria sem restrição',
          detail: 'Evita que o Android derrube a conexão com a tela apagada.',
          on: s.batteryUnrestricted,
          action: s.batteryUnrestricted
            ? undefined
            : { label: 'Permitir', run: () => Device.requestBatteryExemption() },
        },
      ]
    : []

  const unpair = async () => {
    await Device.configure({ url: '', token: '', enabled: false }).catch(() => {})
    saveLink(null)
    location.reload()
  }

  return (
    <div className="m-sheet-back" onClick={onClose}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-head">
          <span>Celular</span>
          <button className="m-x" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="m-sheet-host">{BRIDGE_WS_URL.replace(/^wss?:\/\//, '')}</div>

        {error && <div className="m-error">{error}</div>}
        {!s && !error && <div className="m-hint">Lendo o estado do celular…</div>}

        {rows.map((r) => (
          <div className="m-row" key={r.title}>
            <span className={`m-dot${r.on ? ' is-on' : ''}`} />
            <div className="m-row-text">
              <div className="m-row-title">{r.title}</div>
              <div className="m-row-detail">{r.detail}</div>
            </div>
            {r.action && (
              <button
                className="m-small"
                onClick={() => void r.action!.run().then(refresh).catch((e) => setError(String(e?.message ?? e)))}
              >
                {r.action.label}
              </button>
            )}
          </div>
        ))}

        {(!s?.accessibility || !s?.notifications) && (
          <div className="m-hint">
            Opção acinzentada no Android? Abra as informações do app, toque em ⋮ e escolha
            "Permitir configurações restritas". Depois volte e ative.{' '}
            <button className="m-small" onClick={() => void Device.openAppInfo()}>
              Info do app
            </button>
          </div>
        )}

        <div className="m-hint">
          Ligar, mandar SMS e responder mensagens sempre pedem sua confirmação aqui no celular.
          Apps de banco, carteiras e autenticadores ficam bloqueados para o Jarvis.
        </div>

        <button className="m-danger" onClick={() => void unpair()}>
          Desparear este celular
        </button>
      </div>
    </div>
  )
}
