import AppKit
import Contacts
import IOKit.ps
import UserNotifications

/// The reply shapes the bridge expects from a command (see bridge/phone.mjs,
/// deviceRelay): { ok, text?, json?, data?, mimeType?, error? }.
enum Reply {
    static func text(_ text: String) -> [String: Any] { ["ok": true, "text": text] }
    static func json(_ json: Any) -> [String: Any] { ["ok": true, "json": json] }
    static func image(_ base64: String, mimeType: String) -> [String: Any] {
        ["ok": true, "data": base64, "mimeType": mimeType]
    }
    /// One plain sentence: it may well be spoken aloud.
    static func error(_ message: String) -> [String: Any] {
        ["ok": false, "error": message.isEmpty ? "The Mac could not do that." : message]
    }
}

/// Everything the bridge can ask of this Mac (bridge/mac.mjs is the other half).
final class Commands {
    static let capabilities = [
        "status", "list_apps", "read_screen", "screenshot", "read_clipboard",
        "open_app", "quit_app", "open_url", "click", "scroll", "type_text", "press_key",
        "media", "set_volume", "write_clipboard", "notify", "sleep_display",
        "run_shortcut", "send_imessage",
    ]

    private let screen = ScreenControl()

    func run(_ tool: String, _ a: [String: Any]) -> [String: Any] {
        switch tool {
        case "status": return status()
        case "list_apps": return listApps()
        case "read_screen": return screen.readScreen()
        case "screenshot": return screen.screenshot()
        case "read_clipboard": return readClipboard()
        case "open_app": return openApp(str(a, "app"))
        case "quit_app": return quitApp(str(a, "app"))
        case "open_url": return openURL(str(a, "url"))
        case "click":
            return screen.click(
                element: a["element"] as? String, x: num(a, "x"), y: num(a, "y"),
                double: a["double"] as? Bool ?? false, right: a["right"] as? Bool ?? false
            )
        case "scroll":
            return screen.scroll(
                direction: str(a, "direction"), amount: Int(num(a, "amount") ?? 5),
                x: num(a, "x"), y: num(a, "y")
            )
        case "type_text": return screen.typeText(str(a, "text"), submit: a["submit"] as? Bool ?? false)
        case "press_key": return screen.pressKey(str(a, "key"))
        case "media": return screen.media(str(a, "action"))
        case "set_volume": return setVolume(level: num(a, "level"), mute: a["mute"] as? Bool)
        case "write_clipboard": return writeClipboard(str(a, "text"))
        case "notify": return notify(title: str(a, "title"), message: str(a, "message"))
        case "sleep_display": return sleepDisplay()
        case "run_shortcut": return runShortcut(str(a, "name"), input: a["input"] as? String)
        case "send_imessage": return sendIMessage(to: str(a, "to"), message: str(a, "message"))
        default:
            return Reply.error("The JARVIS app on the Mac does not know \"\(tool)\" yet. It may need updating.")
        }
    }

    // MARK: - reading

    private func status() -> [String: Any] {
        var out: [String: Any] = [
            "model": SystemInfo.model(),
            "macos": ProcessInfo.processInfo.operatingSystemVersionString,
            "permissions": [
                "accessibility": ScreenControl.trusted,
                "screenRecording": ScreenControl.canCapture,
                "contacts": CNContactStore.authorizationStatus(for: .contacts) == .authorized,
            ],
        ]
        if let battery = SystemInfo.battery() { out["battery"] = battery }
        if let front = NSWorkspace.shared.frontmostApplication {
            out["frontmost"] = front.localizedName ?? front.bundleIdentifier ?? ""
        }
        return Reply.json(out)
    }

    private func listApps() -> [String: Any] {
        let installed = Apps.installed().map { $0.name }.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        let running = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { $0.localizedName }
        return Reply.json(["running": running, "installed": installed])
    }

    /// Clipboard text — but never what a password manager put there. They
    /// mark what they copy as concealed (the nspasteboard.org convention), and
    /// a password on its way to a login field is not something to hand to a
    /// model that has been reading the open web.
    private func readClipboard() -> [String: Any] {
        let pb = NSPasteboard.general
        let types = (pb.types ?? []).map { $0.rawValue }
        if types.contains("org.nspasteboard.ConcealedType") || types.contains("org.nspasteboard.TransientType") {
            return Reply.error("The clipboard holds something a password manager marked as secret, so JARVIS will not read it.")
        }
        guard let text = pb.string(forType: .string), !text.isEmpty else {
            return Reply.text("The clipboard has no text.")
        }
        return Reply.text(text.count > 20_000 ? String(text.prefix(20_000)) + "…" : text)
    }

    // MARK: - acting

    private func openApp(_ name: String) -> [String: Any] {
        guard let app = Apps.find(name) else {
            return Reply.error("There is no app called \(name) on the Mac.")
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.openApplication(at: app.url, configuration: config) { _, error in
            failure = error
            done.signal()
        }
        _ = done.wait(timeout: .now() + 15)
        if failure != nil { return Reply.error("The Mac could not open \(app.name).") }
        return Reply.text("Opened \(app.name).")
    }

    private func quitApp(_ name: String) -> [String: Any] {
        let key = Apps.fold(name)
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let match = running.first { Apps.fold($0.localizedName ?? "") == key || ($0.bundleIdentifier ?? "").lowercased() == key }
            ?? running.first { Apps.fold($0.localizedName ?? "").contains(key) && !key.isEmpty }
        guard let app = match else { return Reply.error("\(name) is not running on the Mac.") }
        if app.bundleIdentifier == Bundle.main.bundleIdentifier {
            return Reply.error("JARVIS will not quit himself on the Mac.")
        }
        _ = app.terminate()
        return Reply.text("Asked \(app.localizedName ?? name) to quit.")
    }

    private func openURL(_ raw: String) -> [String: Any] {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else {
            return Reply.error("Only web addresses can be opened on the Mac.")
        }
        return NSWorkspace.shared.open(url) ? Reply.text("Opened.") : Reply.error("The Mac could not open that address.")
    }

    private func setVolume(level: Double?, mute: Bool?) -> [String: Any] {
        var script: [String] = []
        if let mute { script.append("set volume output muted \(mute)") }
        if let level { script.append("set volume output volume \(Int(max(0, min(100, level))))") }
        if level != nil, mute == nil { script.append("set volume output muted false") }
        guard !script.isEmpty else { return Reply.error("Give a level from 0 to 100, or mute.") }
        let r = Shell.osascript(script)
        return r.ok ? Reply.text("Volume set.") : Reply.error("The Mac could not change the volume.")
    }

    private func writeClipboard(_ text: String) -> [String: Any] {
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.setString(text, forType: .string) ? Reply.text("Copied.") : Reply.error("The Mac could not use the clipboard.")
    }

    private func notify(title: String, message: String) -> [String: Any] {
        Confirm.notify(title: title.isEmpty ? "Jarvis" : title, body: message)
        return Reply.text("Notification shown.")
    }

    private func sleepDisplay() -> [String: Any] {
        Shell.run("/usr/bin/pmset", ["displaysleepnow"]).ok
            ? Reply.text("Display off.")
            : Reply.error("The Mac could not turn its display off.")
    }

    // MARK: - confirmed on the Mac

    private func runShortcut(_ name: String, input: String?) -> [String: Any] {
        guard !name.isEmpty else { return Reply.error("Which Shortcut?") }
        let list = Shell.run("/usr/bin/shortcuts", ["list"])
        let names = list.out.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard let exact = names.first(where: { $0 == name }) ?? names.first(where: { $0.lowercased() == name.lowercased() }) else {
            return Reply.error("There is no Shortcut called \(name) on the Mac.")
        }
        var detail = "O Jarvis quer rodar o atalho \"\(exact)\"."
        if let input, !input.isEmpty { detail += "\n\nCom a entrada:\n\(input.prefix(500))" }
        guard Confirm.ask(title: "Rodar o atalho \"\(exact)\"?", detail: detail) else {
            return Reply.error("The user did not allow running that Shortcut on the Mac.")
        }

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-shortcut-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let outFile = dir.appendingPathComponent("out.txt")
        var args = ["run", exact, "--output-path", outFile.path, "--output-type", "public.plain-text"]
        if let input, !input.isEmpty {
            let inFile = dir.appendingPathComponent("in.txt")
            try? input.write(to: inFile, atomically: true, encoding: .utf8)
            args += ["--input-path", inFile.path]
        }
        let r = Shell.run("/usr/bin/shortcuts", args, timeout: 120)
        guard r.ok else { return Reply.error("The Shortcut \(exact) failed on the Mac.") }
        let output = (try? String(contentsOf: outFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Reply.text(output.isEmpty ? "Ran \(exact)." : "Ran \(exact). It returned: \(output.prefix(4000))")
    }

    private func sendIMessage(to: String, message: String) -> [String: Any] {
        guard !to.isEmpty, !message.isEmpty else { return Reply.error("Say who to message and what to say.") }
        let resolved = ContactLookup.resolve(to)
        guard let best = resolved.first else {
            return Reply.error(ContactLookup.lastError ?? "There is no contact called \(to) on the Mac.")
        }
        let (handle, who) = best
        guard Confirm.ask(
            title: "Enviar iMessage para \(who)?",
            detail: "Para: \(who) (\(handle))\n\n\(message)"
        ) else {
            return Reply.error("The user did not allow sending that message on the Mac.")
        }
        // The recipient and text go in as arguments, never pasted into the
        // script, so nothing in a message can change what the script does.
        let r = Shell.osascript([
            "on run argv",
            "tell application \"Messages\"",
            "set svc to 1st account whose service type = iMessage",
            "send (item 2 of argv) to participant (item 1 of argv) of svc",
            "end tell",
            "end run",
        ], args: [handle, message])
        if !r.ok {
            if r.err.contains("-1743") || r.err.lowercased().contains("not authorized") {
                return Reply.error("macOS has not let the JARVIS app control Messages. Tell the user to allow it in System Settings, Privacy & Security, Automation.")
            }
            return Reply.error("Messages could not send it to \(who).")
        }
        return Reply.text("Sent to \(who).")
    }

    // MARK: - args

    private func str(_ a: [String: Any], _ k: String) -> String {
        (a[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func num(_ a: [String: Any], _ k: String) -> Double? {
        if let d = a[k] as? Double { return d }
        if let i = a[k] as? Int { return Double(i) }
        if let n = a[k] as? NSNumber { return n.doubleValue }
        return nil
    }
}

// MARK: - apps

enum Apps {
    struct App { let name: String; let url: URL; let bundleId: String? }

    /// Lower-case, no accents, so "musica" finds "Música".
    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    static func installed() -> [App] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let roots = [
            "/Applications", "/Applications/Utilities", "/System/Applications",
            "/System/Applications/Utilities", "\(home)/Applications",
        ]
        var seen = Set<String>()
        var apps: [App] = []
        for root in roots {
            guard let items = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for item in items where item.hasSuffix(".app") {
                let url = URL(fileURLWithPath: root).appendingPathComponent(item)
                let bundle = Bundle(url: url)
                let name = (bundle?.localizedInfoDictionary?["CFBundleDisplayName"] as? String)
                    ?? (bundle?.infoDictionary?["CFBundleDisplayName"] as? String)
                    ?? String(item.dropLast(4))
                if seen.insert(url.path).inserted {
                    apps.append(App(name: name, url: url, bundleId: bundle?.bundleIdentifier))
                }
            }
        }
        return apps
    }

    static func find(_ query: String) -> App? {
        let q = fold(query)
        guard !q.isEmpty else { return nil }
        if q.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) {
            return App(name: url.deletingPathExtension().lastPathComponent, url: url, bundleId: query)
        }
        let all = installed()
        let fileName = { (a: App) in fold(a.url.deletingPathExtension().lastPathComponent) }
        return all.first { fold($0.name) == q || fileName($0) == q }
            ?? all.first { fold($0.name).hasPrefix(q) || fileName($0).hasPrefix(q) }
            ?? all.first { fold($0.name).contains(q) || fileName($0).contains(q) }
    }
}

// MARK: - contacts

enum ContactLookup {
    static var lastError: String?

    /// A phone number or email as is; a name looked up in Contacts. Returns
    /// (handle, how to show it) pairs, best first.
    static func resolve(_ to: String) -> [(String, String)] {
        lastError = nil
        let digits = to.filter { $0.isNumber || $0 == "+" }
        if to.contains("@") || digits.count >= 8 && digits.count >= to.filter({ !$0.isWhitespace }).count - 4 {
            return [(to.contains("@") ? to : digits, to)]
        }
        let store = CNContactStore()
        if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
            let done = DispatchSemaphore(value: 0)
            store.requestAccess(for: .contacts) { _, _ in done.signal() }
            _ = done.wait(timeout: .now() + 60)
        }
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else {
            lastError = "The JARVIS app on the Mac has no access to Contacts. Tell the user to allow it in System Settings, Privacy & Security, Contacts, or give a phone number."
            return []
        }
        let keys = [
            CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
            CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
        ] as [CNKeyDescriptor]
        let found = (try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: to), keysToFetch: keys)) ?? []
        var out: [(String, String)] = []
        for c in found {
            let name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            let label = name.isEmpty ? to : name
            if let phone = c.phoneNumbers.first?.value.stringValue { out.append((phone, label)) }
            if let mail = c.emailAddresses.first.map({ $0.value as String }) { out.append((mail, label)) }
        }
        return out
    }
}

// MARK: - system

enum SystemInfo {
    static func model() -> String {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &buf, &size, nil, 0)
        return String(cString: buf)
    }

    static func battery() -> [String: Any]? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef]
        else { return nil }
        for source in list {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any] else { continue }
            let current = d["Current Capacity"] as? Int ?? 0
            let max = d["Max Capacity"] as? Int ?? 100
            return [
                "percent": max > 0 ? current * 100 / max : current,
                "charging": d["Is Charging"] as? Bool ?? false,
                "pluggedIn": (d["Power Source State"] as? String) == "AC Power",
            ]
        }
        return nil
    }
}

enum Shell {
    struct Result { let ok: Bool; let out: String; let err: String }

    @discardableResult
    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 30) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return Result(ok: false, out: "", err: error.localizedDescription) }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        // Read before waiting, so a chatty process cannot fill the pipe and stall.
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        return Result(
            ok: p.terminationStatus == 0,
            out: String(decoding: o, as: UTF8.self),
            err: String(decoding: e, as: UTF8.self)
        )
    }

    static func osascript(_ lines: [String], args: [String] = []) -> Result {
        run("/usr/bin/osascript", lines.flatMap { ["-e", $0] } + args)
    }
}
