# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly, or only the
ones you name in `JARVIS_MCP_SERVERS`. Depending on what you have installed, that
is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** (mail, drive, calendar and other account connectors) are not in `~/.claude.json`,
> but the CLI fetches them on its own and they join the session from the second
> turn. The bridge keeps them out by default; set `JARVIS_ACCOUNT_CONNECTORS=1`
> to let them in, and `JARVIS_MCP_SERVERS` to choose which `~/.claude.json`
> servers JARVIS gets.

### JARVIS keeps watch

Ask him to keep an eye on something and he starts a **watch**: a check that runs
in the background on its own schedule and speaks up only when the condition you
gave him comes true.

- *"Keep an eye on the Bitcoin price and tell me if it drops below sixty thousand."*
- *"Let me know when my parcel leaves the depot."*
- *"Watch the status page and tell me if it goes down."*
- *"What are you watching?"* · *"Stop watching the parcel."*

He chooses how often to look from how fast the thing changes and how soon you
would want to know — every few minutes for a live price near its threshold, every
hour or two for a delivery — and each check can tighten or relax that interval
as things develop. Each check is its own short agent run that compares what it
sees with what the previous one saw, so you hear about a change once rather than
on every pass.

Watches live in the bridge, not the page: they keep running with the interface
closed, survive a bridge restart (`~/.jarvis/watches.json`), and any alert that
fires while no screen is open is spoken when one connects. Checks are always
read-only, whatever `JARVIS_ALLOW_WRITES` says, and never use the camera.

Each check costs a few cents on your account (about $0.07 on the default model
at low effort), so a five-minute watch left running all day adds up; set
`JARVIS_WATCH_MODEL` to a cheaper model if you keep many.

### JARVIS makes calls

Calls go out through an ElevenLabs conversational agent, and which kind depends
on what you ask:

- *"Call me"* rings your own number (`JARVIS_CALL_TO`).
- *"Call me as soon as a message arrives"* starts a watch that rings you when
  it does.
- *"Call my dentist and tell them I'm running twenty minutes late"* rings the
  dentist. That call opens as Friday — *"Hello, I'm Friday, Andrei's AI
  assistant, calling on his behalf"* (`JARVIS_CALL_INTRO`) — then does the task
  in their language. *"How did the call go?"* reads back the outcome.
- *"Use my phone to call Maria"* is the one case that dials from your own
  phone instead.

The agent has to allow per-call overrides of the first message, system prompt
and language (its **Security** settings), because each call carries its own
instructions; the bridge warns at start-up when it does not. Calling anyone but
you needs write access.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

Read from the shell, and from `.env.local` for anything the shell does not set.

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_BRIDGE_HOST` | `127.0.0.1` | Interface to listen on. Any other address puts the agent on your network |
| `JARVIS_ALLOWED_HOSTS` | none | Extra hostnames the bridge answers to; a request for any other name gets a 403 |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_MCP_SERVERS` | all configured | Comma-separated `~/.claude.json` servers to pass on; empty passes none |
| `JARVIS_ACCOUNT_CONNECTORS` | off | `1` lets your claude.ai account's connectors join the session |
| `JARVIS_DISABLE` | none | Comma-separated capabilities to leave out: `browser`, `camera`, `interface`, `phone`, `mac`, `watch` |
| `JARVIS_CALL_TO` | none | Your own number, e.g. `+5511…`, for "call me" and calling watches |
| `JARVIS_USER_NAME` | none | Who JARVIS says he is calling on behalf of |
| `JARVIS_CALL_INTRO` | `Hello, I'm Friday, {name}'s AI assistant, calling on his behalf.` | How a call to someone else opens |
| `JARVIS_CALL_AGENT_ID` | the number's agent | ElevenLabs agent that places calls |
| `JARVIS_CALL_FROM_NUMBER_ID` | the agent's number | ElevenLabs phone-number id calls come from |
| `JARVIS_WATCH_MODEL` | `JARVIS_MODEL` | The model each background watch check runs on |
| `JARVIS_WATCH_EFFORT` | `low` | Reasoning effort for a watch check |
| `JARVIS_WATCH_BUDGET_USD` | `0.5` | Spending cap on a single watch check |
| `JARVIS_WATCH_MIN_MINUTES` | `2` | The shortest interval any watch may use |
| `JARVIS_WATCH_MAX` | `12` | How many watches may run at once |
| `JARVIS_WATCH_FILE` | `~/.jarvis/watches.json` | Where watches are kept |
| `JARVIS_DEVICES_FILE` | `~/.jarvis/devices.json` | Where paired phones are kept (token hashes only) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_WORKSPACE` | `~/.jarvis/workspace` | The agent's working directory; file tools are confined to it and the temp directory |
| `JARVIS_FILE_ROOTS` | none | Extra folders the file tools and the `/file` endpoint may use |
| `JARVIS_KEEP_TRANSCRIPTS` | off | `1` keeps the SDK's session transcripts in `~/.claude/projects` |
| `JARVIS_CLAUDE_EXECUTABLE` | bundled CLI | Run the agent through this executable instead, e.g. a sandbox wrapper that execs the real CLI |
| `JARVIS_CHROME_PIPE` | none | WSL only: the Windows pipe name the browser relay connects to |
| `JARVIS_DEBUG` | off | `1` logs every agent message to the bridge terminal, answer text and tool calls included |
| `JARVIS_VOICE_ID` | none | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | none | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time, in
`decideTool()` in `bridge/policy.mjs`. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

A `PreToolUse` hook applies that policy to every call, including the reads the
Claude Code CLI would otherwise approve by itself. In read-only mode the agent
has no shell, and its file tools reach only its workspace (`~/.jarvis/workspace`),
the temp directory and any folders in `JARVIS_FILE_ROOTS`. Paths that hold
credentials, such as `~/.ssh`, `~/.claude` and `.env` files, stay refused even
inside those folders.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

The script passes `--writes` to the bridge, so it works in Windows `cmd` and
PowerShell too. With `npm start`, use `npm start -- --writes`. Writes add `Bash`,
`Write`, `Edit` and `NotebookEdit` to the agent's tools. The file tools stay
inside the same folders; the shell can reach anything your user account can.

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Your phone

A phone running the JARVIS app reaches this bridge from anywhere, and JARVIS —
asked on the PC or on the phone — can work the phone: open apps, navigate, set
alarms, read notifications and the screen, tap and type, call and text.

1. Install [Tailscale](https://tailscale.com) on the PC and the phone, signed in
   to the same account. It is a private network between your own devices; the
   bridge is never put on the internet.
2. Make the bridge reachable on that network only (it keeps listening on
   `127.0.0.1`; Tailscale forwards to it, with HTTPS):

   ```bash
   tailscale serve --bg 8787
   ```

3. Pair the phone. This prints a token, once, to enter in the app:

   ```bash
   npm run pair -- "Pixel"
   ```

4. Build the Android app and install it (needs Android Studio, for its JDK and
   SDK). `--install` puts it on a phone connected by USB; otherwise copy the APK
   it prints to the phone:

   ```bash
   npm run app -- --install
   ```

5. Open the app, paste the token, tap **Conectar**. Then open the gear and grant
   what you want JARVIS to have: permissions, screen control (Accessibility),
   notifications, unrestricted battery. On Android 13+, screen control and
   notifications stay greyed out for an app installed outside the Play Store
   until you open the app's info page, tap ⋮ and choose *Allow restricted
   settings*.

`npm run pair -- --list` shows paired phones and `npm run pair -- --revoke "Pixel"`
unpairs one immediately. Only a hash of each token is stored.

The app is the same interface as the desktop. "Hey Jarvis" works while the app
is on screen, and there is a talk button too — nothing is listened to once it is
in the background or closed. What it adds is a quiet
background connection (`/device`) that starts no agent of its own, so JARVIS on
the PC can reach the phone at any time; it can be switched off from the gear.

Reading the phone runs freely; acting on it needs write access like every other
action. Calls, texts and replies are also confirmed on the phone itself, and
banking, wallet, payment and authenticator apps are never read or touched: their
notifications are left out, and screen reading, taps and typing refuse while one
is in front.

## Your MacBook

The JARVIS app for macOS (`macos/`, native Swift) works two ways — pick one in
its **Configurações** window, and switch whenever you like:

- **Paired with the PC** — exactly like the phone. The Mac shows the JARVIS
  interface (wake word and the full scene included) and links to the bridge on
  the PC through Tailscale, so JARVIS — asked on the PC, the phone or the Mac —
  can work the Mac. Nothing but the app runs on the Mac.
- **The whole JARVIS on the Mac** — the app starts the bridge and the interface
  from a checkout of this repository on the Mac (`npm start` under the hood),
  shows it, and links its own hands to that local bridge. Needs Node.js and
  Claude Code, logged in, on the Mac. The PC can be off.

Either way, JARVIS can open and quit apps, open links, read the front window
(accessibility), take screenshots, click, scroll, type and press shortcuts,
control what is playing and the volume, use the clipboard, show notifications,
and — confirmed on the Mac first — run your Shortcuts and send iMessages.

Build it on the Mac (needs the Xcode command line tools: `xcode-select --install`):

```bash
npm install
npm run mac -- --install     # builds JARVIS.app and copies it to /Applications
```

Set `JARVIS_BRIDGE_URL=wss://your-pc.your-tailnet.ts.net` while building to
pre-fill the PC's address. For paired mode, on the PC (with
`tailscale serve --bg 8787` already set up, as for the phone):

```bash
npm run pair:mac "MacBook"
```

Paste the token into Configurações and click **Salvar e conectar**. Local mode
pairs itself. Then grant, in the same window, what you want JARVIS to have:
Accessibility (read the screen, click, type), Screen Recording (screenshots),
Microphone and Contacts. The token is kept in the macOS Keychain.

Closing the window keeps JARVIS running in the menu bar (the hexagon icon); quit
from there. The same gates as the phone apply: reading runs freely, acting needs
write access, iMessages and Shortcuts wait for **Permitir** on the Mac, and
password managers, Keychain Access, banks and wallets are never read or touched
while in front — nor is a clipboard a password manager marked as secret.

The app is signed ad hoc, which is enough to run on your own Mac. macOS ties
Accessibility and Screen Recording to the signature, so after rebuilding you may
need to switch those two off and on again — or set `JARVIS_SIGN_IDENTITY` to a
code-signing certificate in your keychain to keep them. WebKit has no built-in
speech recognition inside an app, so use an ElevenLabs key for hearing (or, in
local mode, **Abrir no Chrome** from the menu bar).

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. If the port is taken,
the bridge says so in one line at startup and exits. It listens on `127.0.0.1`
only. Reaching it from another machine takes `JARVIS_BRIDGE_HOST` and
`JARVIS_ALLOWED_HOSTS`, and your own authentication in front of it first.

**Browser control on Windows.** The bridge finds the Claude extension's named
pipe, `\\.\pipe\claude-mcp-browser-bridge-<user>`, by itself. If the boot log
says the extension is not running, open Chrome with the extension signed in.
Each browser request looks for the pipe again, so the bridge does not need a
restart.

**Running the bridge in WSL, with Chrome on Windows.** Browser control works:
the Windows native host exposes a named pipe rather than a Unix socket, and the
bridge reaches it through a short PowerShell relay (WSL interop must be on,
which it is by default). Open the app at `http://127.0.0.1:5173` if
`localhost` is slow to load — Windows tries IPv6 loopback first, and WSL does
not forward it.

---

## Tests

`npm test` runs the bridge's tests with Node's built-in runner. They cover the
network binding, the tool policy, the MCP server allowlist and the WSL browser
relay, which runs only under WSL. The network and allowlist tests start the
bridge on a random loopback port, and none of the tests opens an agent session.

---

## Security

The bridge's defences live in `bridge/server.mjs` and `bridge/policy.mjs`:

- It listens on `127.0.0.1` and answers only requests addressed to `localhost`,
  `127.0.0.1` or `[::1]`, which blocks DNS rebinding.
- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A `PreToolUse` hook enforces the tool policy on every call. File tools stay
  inside the workspace, the temp directory and `JARVIS_FILE_ROOTS`, and
  `WebFetch` cannot reach loopback, LAN or cloud metadata addresses.
- claude.ai account connectors stay out of the session unless
  `JARVIS_ACCOUNT_CONNECTORS=1`, and `JARVIS_MCP_SERVERS` narrows which
  `~/.claude.json` servers the agent gets.
- Session transcripts are written to `~/.claude/projects` only when
  `JARVIS_KEEP_TRANSCRIPTS=1`.
- `JARVIS_DISABLE` removes browser control, the camera or the interface tools
  entirely, and `JARVIS_CLAUDE_EXECUTABLE` can run the agent inside a sandbox
  wrapper.
- Background watch checks run with writes off and without the camera or the
  interface tools, whatever the bridge's own write setting, and each has a
  spending cap and a four-minute timeout.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
