import AppKit

// The JARVIS app for macOS.
//
// Two ways to run, chosen in Configurações:
//   - paired: this Mac links to the JARVIS bridge on the PC at home, through
//     Tailscale, exactly like the Android app. It shows the interface (served
//     from inside the app) and gives the PC hands on this Mac.
//   - local: the whole JARVIS runs here — the app starts the bridge and the
//     interface from a checkout of the repository on this Mac, shows it, and
//     links its own hands to that local bridge.
//
// Either way the hands are the same: DeviceLink holds one socket to the
// bridge's /device endpoint and Commands carries out what comes down it.

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
