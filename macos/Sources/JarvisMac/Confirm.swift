import AppKit
import UserNotifications

/// "Permitir" on the Mac itself, for anything that leaves the Mac or runs the
/// user's own automations: an iMessage, a Shortcut.
///
/// The bridge has its own gate (JARVIS_ALLOW_WRITES), but that gate is on the
/// PC, and a web page the agent read could talk the agent into using it. A
/// button on this screen, in front of the person, is the one thing such a page
/// cannot reach. Nobody there to click it means no.
///
/// "Recusar" is the default button, so a stray Return refuses.
enum Confirm {
    static func ask(title: String, detail: String, timeout: TimeInterval = 85) -> Bool {
        let done = DispatchSemaphore(value: 0)
        var allowed = false

        notify(title: "Jarvis precisa da sua confirmação", body: title)

        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = detail
            alert.alertStyle = .warning
            let allow = alert.addButton(withTitle: "Permitir")
            let refuse = alert.addButton(withTitle: "Recusar")
            allow.keyEquivalent = ""
            refuse.keyEquivalent = "\r"
            alert.window.level = .modalPanel

            let timer = Timer(timeInterval: timeout, repeats: false) { _ in
                NSApp.abortModal()
            }
            RunLoop.main.add(timer, forMode: .modalPanel)
            let answer = alert.runModal()
            timer.invalidate()
            allowed = answer == .alertFirstButtonReturn
            done.signal()
        }

        _ = done.wait(timeout: .now() + timeout + 10)
        return allowed
    }

    /// A banner, so a confirmation waiting behind other windows is noticed.
    static func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { _ in }
    }
}
