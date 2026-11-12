import AppKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let settings = Settings.shared
    private let link = DeviceLink()
    private let local = LocalBridge()
    private var server: StaticServer?

    private var web: WebWindowController!
    private var settingsWindow: SettingsWindowController?
    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var chromeItem: NSMenuItem!

    /// Bumped on every start, so a slow local start that is overtaken by a
    /// newer one (the user changed mode meanwhile) does not finish over it.
    private var generation = 0
    private var repairedOnce = false

    // MARK: - launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMainMenu()
        buildStatusItem()
        web = WebWindowController()

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        link.onChange = { [weak self] state in self?.linkChanged(state) }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.link.reconnect() }

        if settings.ready {
            start()
        } else {
            web.showMessage("Vamos configurar", "Escolha como este Mac vai usar o JARVIS.")
            web.showWindow(nil)
            openSettings()
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showJarvis() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        link.stop()
        local.stop()
        server?.stop()
    }

    // MARK: - starting either mode

    private func start() {
        generation += 1
        let gen = generation
        repairedOnce = false
        link.stop()
        web.showWindow(nil)
        chromeItem.isHidden = settings.mode != .local

        switch settings.mode {
        case .paired: startPaired()
        case .local: startLocal(gen)
        }
    }

    private func startPaired() {
        local.stop()
        let address = Settings.normalise(settings.address)
        guard let token = settings.pairedToken, let deviceURL = URL(string: address + "/device") else {
            web.showMessage("Falta parear", "Abra Configurações e cole o endereço do PC e o token.")
            openSettings()
            return
        }
        link.start(url: deviceURL, token: token)

        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"),
              FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path)
        else {
            web.showMessage(
                "A interface não veio dentro do app",
                "Gere o app com npm run mac, que monta a interface junto. As mãos do Mac já estão ligadas ao PC."
            )
            return
        }
        if server == nil { server = StaticServer(root: webRoot) }
        guard let port = server?.start() else {
            web.showMessage("Não consegui abrir a interface", "Nenhuma porta local ficou livre. Feche e abra o app de novo.")
            return
        }
        web.load(URL(string: "http://127.0.0.1:\(port)/")!, mode: .paired, link: (address, token))
    }

    private func startLocal(_ gen: Int) {
        server?.stop()
        server = nil
        let repo = settings.repoPath
        let writes = settings.allowWrites
        let name = settings.deviceName
        web.showMessage("Ligando o JARVIS…", "Iniciando a ponte e a interface neste Mac. Na primeira vez leva um pouco.")
        setStatus("Ligando a ponte local…")

        // Captured up front: the background closure touches only these, and
        // hops back to the main queue for anything on self.
        let local = self.local
        let saved = Keychain.get("local")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try local.ensureRunning(repo: repo, writes: writes)
                let token = try saved ?? local.pair(repo: repo, name: name)
                DispatchQueue.main.async {
                    guard let self, gen == self.generation else { return }
                    self.settings.localToken = token
                    self.link.start(url: LocalBridge.deviceURL, token: token)
                    self.web.load(LocalBridge.faceURL, mode: .local, link: nil)
                }
            } catch {
                let message = "\(error)"
                DispatchQueue.main.async {
                    guard let self, gen == self.generation else { return }
                    self.web.showMessage("O JARVIS local não ligou", message)
                    self.setStatus("Ponte local parada")
                }
            }
        }
    }

    /// The local bridge forgot this Mac (its devices file was reset): pair again, once.
    private func repairLocal() {
        guard settings.mode == .local, !repairedOnce else { return }
        repairedOnce = true
        let repo = settings.repoPath, name = settings.deviceName, gen = generation
        let local = self.local
        DispatchQueue.global().async { [weak self] in
            guard let token = try? local.pair(repo: repo, name: name) else { return }
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                self.settings.localToken = token
                self.link.start(url: LocalBridge.deviceURL, token: token)
            }
        }
    }

    private func linkChanged(_ state: DeviceLink.State) {
        switch state {
        case .off: setStatus("Mãos do Mac desligadas")
        case .connecting: setStatus("Conectando…")
        case .connected:
            setStatus(settings.mode == .local ? "Conectado à ponte deste Mac" : "Conectado ao JARVIS de casa")
        case .failed(let why):
            setStatus(why.isEmpty ? "Reconectando…" : "Reconectando — \(why)")
            if why.contains("recusou") { repairLocal() }
        }
    }

    // MARK: - menus

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "circle.hexagongrid.circle", accessibilityDescription: "JARVIS")
            button.image?.isTemplate = true
        }
        let menu = NSMenu()
        statusLine = NSMenuItem(title: "Iniciando…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(item("Abrir o JARVIS", #selector(showJarvisAction), "j"))
        chromeItem = item("Abrir no Chrome", #selector(openInChrome), "")
        menu.addItem(chromeItem)
        menu.addItem(item("Recarregar a interface", #selector(reloadInterface), "r"))
        menu.addItem(item("Reconectar", #selector(restart), ""))
        menu.addItem(.separator())
        menu.addItem(item("Configurações…", #selector(openSettingsAction), ","))
        menu.addItem(item("Ver o registro da ponte local", #selector(openLog), ""))
        menu.addItem(.separator())
        menu.addItem(item("Sair do JARVIS", #selector(NSApplication.terminate(_:)), "q"))
        statusItem.menu = menu
    }

    /// The app menu bar. The Edit menu is what makes ⌘C / ⌘V / ⌘A work in
    /// the web view's text fields — without it they do nothing.
    private func buildMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(item("Sobre o JARVIS", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Configurações…", #selector(openSettingsAction), ","))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Ocultar o JARVIS", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Sair do JARVIS", #selector(NSApplication.terminate(_:)), "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Editar")
        edit.addItem(item("Desfazer", Selector(("undo:")), "z"))
        edit.addItem(item("Refazer", Selector(("redo:")), "Z"))
        edit.addItem(.separator())
        edit.addItem(item("Recortar", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copiar", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Colar", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Selecionar tudo", #selector(NSText.selectAll(_:)), "a"))
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "Visualizar")
        view.addItem(item("Recarregar", #selector(reloadInterface), "r"))
        let fs = item("Tela cheia", #selector(NSWindow.toggleFullScreen(_:)), "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fs)
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Janela")
        window.addItem(item("Minimizar", #selector(NSWindow.performMiniaturize(_:)), "m"))
        window.addItem(item("Fechar", #selector(NSWindow.performClose(_:)), "w"))
        windowItem.submenu = window
        main.addItem(windowItem)
        NSApp.windowsMenu = window

        NSApp.mainMenu = main
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        // Our own actions go to this delegate; the standard ones travel the
        // responder chain, so they reach the web view or the window.
        if responds(to: action) { i.target = self }
        return i
    }

    private func setStatus(_ text: String) {
        statusLine?.title = text
        statusItem?.button?.toolTip = "JARVIS — \(text)"
    }

    // MARK: - actions

    private func showJarvis() {
        web.showWindow(nil)
        web.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showJarvisAction() { showJarvis() }

    @objc private func reloadInterface() { web.reload() }

    @objc private func restart() { start() }

    /// Local mode: the same interface in Chrome — for the browser's own speech
    /// recognition, which WebKit does not offer inside an app.
    @objc private func openInChrome() {
        let chrome = URL(fileURLWithPath: "/Applications/Google Chrome.app")
        guard FileManager.default.fileExists(atPath: chrome.path) else {
            NSWorkspace.shared.open(LocalBridge.faceURL)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["--app=\(LocalBridge.faceURL.absoluteString)"]
        NSWorkspace.shared.openApplication(at: chrome, configuration: config) { _, _ in }
    }

    @objc private func openLog() {
        if FileManager.default.fileExists(atPath: local.logFile.path) {
            NSWorkspace.shared.open(local.logFile)
        }
    }

    @objc private func openSettingsAction() { openSettings() }

    private func openSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController { [weak self] token in
                guard let self else { return }
                if let token { self.settings.pairedToken = token }
                self.settingsWindow?.close()
                self.start()
            }
        }
        settingsWindow?.showWindow(nil)
        settingsWindow?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
