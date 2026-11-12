import AppKit
import AVFoundation
import Combine
import Contacts
import ServiceManagement
import SwiftUI

/// Configurações: which mode, how to reach the bridge, and the macOS
/// permissions the hands need — each with its state and a button that goes
/// straight to the right switch in System Settings.
struct SettingsView: View {
    @ObservedObject var settings = Settings.shared
    /// Called with the token the user typed (paired mode), after it checked out.
    var onSave: (String?) -> Void

    @State private var token = ""
    @State private var busy = false
    @State private var error = ""
    @State private var perms = Permissions.read()
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    private let refresh = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("J.A.R.V.I.S.").font(.system(size: 20, weight: .light)).tracking(6)

            Picker("Modo", selection: $settings.mode) {
                Text("Conectar ao JARVIS do PC de casa").tag(Mode.paired)
                Text("JARVIS completo neste Mac").tag(Mode.local)
            }
            .pickerStyle(.radioGroup)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    if settings.mode == .paired { pairedFields } else { localFields }
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GroupBox("Permissões do macOS") {
                VStack(alignment: .leading, spacing: 8) {
                    permissionRow("Acessibilidade", "ler a tela, clicar e digitar", perms.accessibility) {
                        ScreenControl.promptForTrust()
                        Permissions.open("Privacy_Accessibility")
                    }
                    permissionRow("Gravação de tela", "tirar prints da tela", perms.screenRecording) {
                        _ = CGRequestScreenCaptureAccess()
                        Permissions.open("Privacy_ScreenCapture")
                    }
                    permissionRow("Microfone", "ouvir \"Hey Jarvis\"", perms.microphone) {
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                        Permissions.open("Privacy_Microphone")
                    }
                    permissionRow("Contatos", "mandar iMessage pelo nome", perms.contacts) {
                        CNContactStore().requestAccess(for: .contacts) { _, _ in }
                        Permissions.open("Privacy_Contacts")
                    }
                    Text("Depois de ligar Gravação de tela, feche e abra o app de novo.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Toggle("Abrir o JARVIS quando o Mac ligar", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                    } catch {
                        launchAtLogin = SMAppService.mainApp.status == .enabled
                    }
                }

            if !error.isEmpty {
                Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button(busy ? "Conectando…" : "Salvar e conectar") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
            }
        }
        .padding(22)
        .frame(width: 540)
        .onReceive(refresh) { _ in perms = Permissions.read() }
    }

    @ViewBuilder private var pairedFields: some View {
        Text("Este Mac usa o JARVIS que roda no PC, pelo Tailscale — como o app do celular.")
            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        TextField("Endereço do PC (ex.: meu-pc.minha-rede.ts.net)", text: $settings.address)
            .textFieldStyle(.roundedBorder)
        SecureField(settings.pairedToken == nil ? "Token (jv_…)" : "Token salvo — cole outro para trocar", text: $token)
            .textFieldStyle(.roundedBorder)
        Text("No PC, rode  npm run pair:mac \"MacBook\"  e cole aqui o token que aparecer.")
            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }

    @ViewBuilder private var localFields: some View {
        Text("O JARVIS inteiro roda aqui: o app liga a ponte e a interface a partir do projeto neste Mac. Precisa de Node.js e do Claude Code com login feito.")
            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
            TextField("Pasta do projeto", text: $settings.repoPath).textFieldStyle(.roundedBorder)
            Button("Escolher…") { chooseRepo() }
        }
        TextField("Nome deste Mac", text: $settings.deviceName).textFieldStyle(.roundedBorder)
        Toggle("Deixar o JARVIS agir (abrir apps, clicar, mandar mensagens) — sem isto ele só olha", isOn: $settings.allowWrites)
    }

    private func permissionRow(_ name: String, _ what: String, _ ok: Bool, fix: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(ok ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                Text(what).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if !ok { Button("Permitir…", action: fix) }
        }
    }

    private func chooseRepo() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Usar esta pasta"
        if panel.runModal() == .OK, let url = panel.url { settings.repoPath = url.path }
    }

    private func save() {
        error = ""
        switch settings.mode {
        case .local:
            guard FileManager.default.fileExists(atPath: "\(settings.repoPath)/scripts/start.mjs") else {
                error = "Essa pasta não é o projeto do JARVIS (falta scripts/start.mjs)."
                return
            }
            onSave(nil)
        case .paired:
            let url = Settings.normalise(settings.address)
            let typed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let t = typed.isEmpty ? settings.pairedToken : typed, !url.isEmpty else {
                error = "Preencha o endereço e o token."
                return
            }
            settings.address = url
            busy = true
            // Checked against the bridge before anything is saved, so a typo
            // shows up here rather than as an assistant that never answers.
            Pairing.check(url: url, token: t) { problem in
                busy = false
                if let problem {
                    error = problem
                } else {
                    token = ""
                    onSave(t)
                }
            }
        }
    }
}

enum Pairing {
    static func check(url: String, token: String, done: @escaping (String?) -> Void) {
        guard let health = URL(string: Settings.httpOf(url) + "/health") else {
            return done("Esse endereço não parece certo.")
        }
        var req = URLRequest(url: health)
        req.timeoutInterval = 8
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { _, response, err in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let problem: String?
            switch code {
            case 200: problem = nil
            case 401, 403: problem = "O JARVIS recusou este token. Gere outro no PC com npm run pair:mac \"MacBook\"."
            case 0:
                let detail = err.map { " (\($0.localizedDescription))" } ?? ""
                problem = "Não consegui chegar ao PC. Confira se o Tailscale está ligado neste Mac e se a ponte está rodando no PC (e o tailscale serve)." + detail
            default: problem = "O JARVIS respondeu com erro \(code)."
            }
            DispatchQueue.main.async { done(problem) }
        }.resume()
    }
}

enum Permissions {
    struct State { var accessibility: Bool; var screenRecording: Bool; var microphone: Bool; var contacts: Bool }

    static func read() -> State {
        State(
            accessibility: ScreenControl.trusted,
            screenRecording: ScreenControl.canCapture,
            microphone: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            contacts: CNContactStore.authorizationStatus(for: .contacts) == .authorized
        )
    }

    /// The pane in System Settings → Privacy & Security.
    static func open(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// A window around SettingsView.
final class SettingsWindowController: NSWindowController {
    convenience init(onSave: @escaping (String?) -> Void) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 600),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Configurações do JARVIS"
        window.isReleasedWhenClosed = false
        self.init(window: window)
        window.contentViewController = NSHostingController(rootView: SettingsView(onSave: onSave))
        window.center()
    }
}
