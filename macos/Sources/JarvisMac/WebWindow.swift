import AppKit
import WebKit

/// The JARVIS interface, in a window of its own.
///
/// The same page as on the PC (src/), in a WKWebView. Before it runs, the page
/// is told it is inside the Mac app — `window.JarvisMac` — and, in paired mode,
/// where the bridge is and the token to reach it with (see src/config.ts).
/// The token stays in the Keychain between runs and lives only in this page's
/// memory while it is open.
final class WebWindowController: NSWindowController, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    private var webView: WKWebView!
    private var allowedOrigin: String?

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "J.A.R.V.I.S."
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0x01 / 255, green: 0x06 / 255, blue: 0x0C / 255, alpha: 1)
        window.minSize = NSSize(width: 720, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        window.setFrameAutosaveName("JarvisMain")
        if !window.setFrameUsingName("JarvisMain") { window.center() }
        self.init(window: window)
        window.delegate = self
        buildWebView()
    }

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        // Speech plays the moment the answer arrives, not after a click.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        config.userContentController = WKUserContentController()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.uiDelegate = self
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        wv.allowsMagnification = false
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        window?.contentView = wv
        webView = wv
    }

    /// Load the interface at `url`, telling it about the bridge it should use.
    func load(_ url: URL, mode: Mode, link: (url: String, token: String)?) {
        var native: [String: Any] = ["mode": mode.rawValue, "version": Bundle.main.version]
        if let link { native["link"] = ["url": link.url, "token": link.token] }
        let json = (try? JSONSerialization.data(withJSONObject: native)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(
            source: "Object.defineProperty(window, 'JarvisMac', { value: Object.freeze(\(json)), writable: false });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        allowedOrigin = Self.origin(of: url)
        webView.load(URLRequest(url: url))
    }

    func showMessage(_ title: String, _ detail: String) {
        let html = """
        <html><body style="background:#01060c;color:#7fdcff;font:15px -apple-system;display:flex;
        align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
        <div><div style="letter-spacing:.4em;font-size:22px;margin-bottom:18px">J.A.R.V.I.S.</div>
        <div style="font-size:17px;margin-bottom:10px">\(Self.escape(title))</div>
        <div style="opacity:.7;max-width:520px;line-height:1.5">\(Self.escape(detail))</div></div></body></html>
        """
        allowedOrigin = nil
        webView.loadHTMLString(html, baseURL: nil)
    }

    func reload() { webView.reload() }

    // MARK: - window

    /// Closing hides: the link to the bridge, and the wake word, keep going.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // MARK: - WKUIDelegate

    /// The microphone and camera, for the interface itself only — never for a
    /// page someone framed inside a blade.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let host = origin.host
        let local = host == "127.0.0.1" || host == "localhost"
        decisionHandler(local && frame.isMainFrame ? .grant : .deny)
    }

    /// target=_blank and window.open go to the default browser.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    /// The main frame stays on the interface; a link that would replace it
    /// opens in the browser instead. Frames inside blades load freely.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard navigationAction.targetFrame?.isMainFrame ?? false,
              let url = navigationAction.request.url,
              let allowed = allowedOrigin
        else { return decisionHandler(.allow) }
        if url.scheme == "about" || Self.origin(of: url) == allowed { return decisionHandler(.allow) }
        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// WebKit's content process can be killed under memory pressure; come back.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: -

    private static func origin(of url: URL) -> String {
        "\(url.scheme ?? "")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

extension Bundle {
    var version: String { infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev" }
}
