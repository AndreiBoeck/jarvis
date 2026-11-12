import AppKit
import ApplicationServices
import ImageIO
import UniformTypeIdentifiers

/// Reading the screen and acting on it: the accessibility API to see what is
/// in the front window and press it, CGEvent to click, scroll and type, and
/// screencapture for a picture.
///
/// Everything is in global screen points with the origin at the top-left of
/// the main display — what the accessibility API reports, what CGEvent takes,
/// and (because screenshot() scales the capture to points) what a pixel in the
/// screenshot is. So a coordinate read off any of the three works in the others.
///
/// Needs two macOS permissions, granted once in System Settings → Privacy &
/// Security: Accessibility (reading and acting) and Screen Recording (pictures).
final class ScreenControl {
    /// Elements from the last read_screen, by id. Replaced on every read, so
    /// an id only ever means what the model was last shown.
    private var elements: [String: AXUIElement] = [:]
    private let lock = NSLock()

    static var trusted: Bool { AXIsProcessTrusted() }

    /// Asks macOS to show the Accessibility prompt (once; after that it is a
    /// switch in System Settings).
    static func promptForTrust() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    static var canCapture: Bool { CGPreflightScreenCaptureAccess() }

    private static let needAccessibility =
        "The JARVIS app on the Mac has no Accessibility permission. Tell the user to turn it on in System Settings, Privacy & Security, Accessibility."
    private static let needRecording =
        "The JARVIS app on the Mac has no Screen Recording permission. Tell the user to turn it on in System Settings, Privacy & Security, Screen Recording, then reopen the app."

    /// The main display, in points.
    static var mainBounds: CGRect { CGDisplayBounds(CGMainDisplayID()) }

    // MARK: - reading

    private static let interesting: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXLink",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXComboBox",
        "AXTab", "AXTabGroup", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXCell", "AXRow",
        "AXStaticText", "AXImage", "AXHeading", "AXToolbar",
    ]

    func readScreen() -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }
        guard let front = NSWorkspace.shared.frontmostApplication else {
            return Reply.error("Nothing is in front on the Mac right now.")
        }
        let appEl = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 2)

        let window = attr(appEl, "AXFocusedWindow") ?? attr(appEl, "AXMainWindow")
            ?? (attr(appEl, "AXWindows") as? [AXUIElement])?.first.map { $0 as AnyObject }

        var found: [String: AXUIElement] = [:]
        var list: [[String: Any]] = []
        var budget = 3000 // nodes visited — a web page can have tens of thousands

        func visit(_ el: AXUIElement, depth: Int) {
            guard budget > 0, list.count < 350, depth < 40 else { return }
            budget -= 1
            let role = attr(el, "AXRole") as? String ?? ""
            let subrole = attr(el, "AXSubrole") as? String
            var text = [attr(el, "AXTitle"), attr(el, "AXValue"), attr(el, "AXDescription"), attr(el, "AXPlaceholderValue")]
                .compactMap { $0 as? String }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .reduce(into: [String]()) { acc, s in if !acc.contains(s) { acc.append(s) } }
                .joined(separator: " — ")
            if role == "AXSecureTextField" { text = "(password field)" }
            if text.count > 300 { text = String(text.prefix(300)) + "…" }

            let keep = Self.interesting.contains(role) && (!text.isEmpty || role != "AXStaticText")
            if keep, let rect = frame(el), rect.width > 1, rect.height > 1 {
                let id = "e\(list.count + 1)"
                found[id] = el
                var item: [String: Any] = [
                    "id": id,
                    "role": role.replacingOccurrences(of: "AX", with: ""),
                    "x": Int(rect.midX), "y": Int(rect.midY),
                    "w": Int(rect.width), "h": Int(rect.height),
                ]
                if !text.isEmpty { item["text"] = text }
                if let subrole, subrole != "AXUnknown" { item["subrole"] = subrole.replacingOccurrences(of: "AX", with: "") }
                if (attr(el, "AXFocused") as? Bool) == true { item["focused"] = true }
                if (attr(el, "AXEnabled") as? Bool) == false { item["enabled"] = false }
                list.append(item)
            }
            // Static text has no children worth reading; everything else may.
            if role == "AXStaticText" { return }
            for child in (attr(el, "AXChildren") as? [AXUIElement]) ?? [] {
                visit(child, depth: depth + 1)
            }
        }

        if let window, CFGetTypeID(window) == AXUIElementGetTypeID() {
            visit(window as! AXUIElement, depth: 0)
        }

        lock.lock()
        elements = found
        lock.unlock()

        let bounds = Self.mainBounds
        var out: [String: Any] = [
            "app": front.localizedName ?? "",
            "bundleId": front.bundleIdentifier ?? "",
            "screen": ["w": Int(bounds.width), "h": Int(bounds.height)],
            "elements": list,
        ]
        if let window, CFGetTypeID(window) == AXUIElementGetTypeID(),
           let title = attr(window as! AXUIElement, "AXTitle") as? String, !title.isEmpty {
            out["window"] = title
        }
        if list.isEmpty {
            out["note"] = "Nothing readable in the front window — try a screenshot."
        }
        return Reply.json(out)
    }

    // MARK: - acting

    func click(element: String?, x: Double?, y: Double?, double: Bool, right: Bool) -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }

        var point: CGPoint?
        if let element, !element.isEmpty {
            lock.lock()
            let el = elements[element]
            lock.unlock()
            guard let el else {
                return Reply.error("No element \(element) — read the screen again first; ids change on every read.")
            }
            // A plain click on a control is best done as the control's own
            // press: it works even when something covers it.
            if !double, !right, AXUIElementPerformAction(el, "AXPress" as CFString) == .success {
                return Reply.text("Pressed \(element).")
            }
            guard let f = frame(el) else { return Reply.error("Element \(element) has no position on screen.") }
            point = CGPoint(x: f.midX, y: f.midY)
        } else if let x, let y {
            point = CGPoint(x: x, y: y)
        }
        guard let p = point else { return Reply.error("Say what to click: an element id or x and y.") }

        let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
        let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
        let button: CGMouseButton = right ? .right : .left
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button)?
            .post(tap: .cghidEventTap)
        usleep(30_000)
        for n in 1...(double ? 2 : 1) {
            let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)
            let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)
            d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            d?.post(tap: .cghidEventTap)
            usleep(15_000)
            u?.post(tap: .cghidEventTap)
            usleep(40_000)
        }
        return Reply.text("Clicked at \(Int(p.x)), \(Int(p.y)).")
    }

    func scroll(direction: String, amount: Int, x: Double?, y: Double?) -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }
        if let x, let y {
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
                .post(tap: .cghidEventTap)
            usleep(30_000)
        }
        let n = Int32(max(1, min(amount, 50)))
        var dy: Int32 = 0
        var dx: Int32 = 0
        switch direction {
        case "up": dy = n
        case "down": dy = -n
        case "left": dx = n
        case "right": dx = -n
        default: return Reply.error("Scroll up, down, left or right.")
        }
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?
            .post(tap: .cghidEventTap)
        return Reply.text("Scrolled \(direction).")
    }

    func typeText(_ text: String, submit: Bool) -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }
        let lines = text.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            typeChunked(line)
            if i < lines.count - 1 { tap(key: Keys.code["return"]!, flags: []) }
        }
        if submit { tap(key: Keys.code["return"]!, flags: []) }
        return Reply.text(submit ? "Typed and submitted." : "Typed.")
    }

    func pressKey(_ combo: String) -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }
        guard let parsed = Keys.parse(combo) else {
            return Reply.error("I don't know the key \"\(combo)\". Use names like return, escape, tab, space, left, cmd+t.")
        }
        tap(key: parsed.0, flags: parsed.1)
        return Reply.text("Pressed \(combo).")
    }

    /// Play/pause, next, previous — the media keys, so it reaches whichever
    /// app is playing.
    func media(_ action: String) -> [String: Any] {
        guard Self.trusted else { return Reply.error(Self.needAccessibility) }
        let key: Int
        switch action {
        case "play_pause": key = 16 // NX_KEYTYPE_PLAY
        case "next": key = 17 // NX_KEYTYPE_NEXT
        case "previous": key = 18 // NX_KEYTYPE_PREVIOUS
        default: return Reply.error("Use play_pause, next or previous.")
        }
        for down in [true, false] {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
            let data1 = (key << 16) | ((down ? 0xA : 0xB) << 8)
            let event = NSEvent.otherEvent(
                with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1
            )
            event?.cgEvent?.post(tap: .cghidEventTap)
            usleep(20_000)
        }
        return Reply.text("Done.")
    }

    // MARK: - picture

    func screenshot() -> [String: Any] {
        guard Self.canCapture else {
            // Puts the app in the Screen Recording list, so the user only has to flip the switch.
            _ = CGRequestScreenCaptureAccess()
            return Reply.error(Self.needRecording)
        }
        if let app = Blocklist.frontmostBlocked() { return Reply.error(Blocklist.refusal(app)) }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-shot-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-m", "-t", "png", tmp.path]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return Reply.error("The Mac could not take a screenshot.")
        }
        guard let src = CGImageSourceCreateWithURL(tmp as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else { return Reply.error("The Mac could not take a screenshot.") }

        // Scaled to points, so its pixels are the coordinates click takes.
        let bounds = Self.mainBounds
        let w = Int(bounds.width), h = Int(bounds.height)
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return Reply.error("The Mac could not take a screenshot.") }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let scaled = ctx.makeImage() else { return Reply.error("The Mac could not take a screenshot.") }

        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            return Reply.error("The Mac could not take a screenshot.")
        }
        CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return Reply.error("The Mac could not take a screenshot.") }
        return Reply.image((out as Data).base64EncodedString(), mimeType: "image/jpeg")
    }

    // MARK: - helpers

    private func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    private func frame(_ el: AXUIElement) -> CGRect? {
        guard let pos = attr(el, "AXPosition"), let size = attr(el, "AXSize"),
              CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
        else { return nil }
        var p = CGPoint.zero
        var s = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else {
            return nil
        }
        return CGRect(origin: p, size: s)
    }

    private func tap(key: CGKeyCode, flags: CGEventFlags) {
        let d = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
        let u = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
        d?.flags = flags
        u?.flags = flags
        d?.post(tap: .cghidEventTap)
        usleep(12_000)
        u?.post(tap: .cghidEventTap)
        usleep(25_000)
    }

    /// Any text, in any script, without a keyboard layout in the way: each
    /// event carries its characters directly.
    private func typeChunked(_ text: String) {
        let units = Array(text.utf16)
        var i = 0
        while i < units.count {
            var end = min(i + 16, units.count)
            // Never split a surrogate pair across two events.
            if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            var chunk = Array(units[i..<end])
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                e?.flags = []
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                e?.post(tap: .cghidEventTap)
            }
            usleep(20_000)
            i = end
        }
    }
}

/// Key names to macOS virtual key codes (US layout positions).
enum Keys {
    static let code: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
            "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
            "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
            "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
            "`": 50,
            "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51,
            "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119,
            "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
            "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        ]
        m["arrowleft"] = 123; m["arrowright"] = 124; m["arrowdown"] = 125; m["arrowup"] = 126
        return m
    }()

    static func parse(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
        let parts = combo.lowercased()
            .replacingOccurrences(of: " ", with: "")
            .split(separator: "+", omittingEmptySubsequences: false)
            .map(String.init)
        // "cmd++" means cmd and the plus key's position ("=").
        guard !parts.isEmpty else { return nil }
        var flags: CGEventFlags = []
        var key: CGKeyCode?
        for (i, p) in parts.enumerated() {
            switch p {
            case "cmd", "command", "⌘", "meta", "super": flags.insert(.maskCommand)
            case "shift", "⇧": flags.insert(.maskShift)
            case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
            case "ctrl", "control", "⌃": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            case "" where i == parts.count - 1: key = code["="]
            default:
                guard let k = code[p] else { return nil }
                key = k
            }
        }
        guard let key else { return nil }
        return (key, flags)
    }
}
