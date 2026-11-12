import Combine
import Foundation

enum Mode: String {
    /// Linked to the bridge on the PC at home, through Tailscale.
    case paired
    /// The whole JARVIS running on this Mac.
    case local
}

/// What the user chose in Configurações. Plain values in UserDefaults; the
/// tokens are kept apart, in the Keychain.
final class Settings: ObservableObject {
    static let shared = Settings()

    private let d = UserDefaults.standard

    @Published var mode: Mode { didSet { d.set(mode.rawValue, forKey: "mode") } }
    /// The PC's bridge, e.g. wss://pc.tailnet.ts.net
    @Published var address: String { didSet { d.set(address, forKey: "address") } }
    /// The repository checkout on this Mac, for local mode.
    @Published var repoPath: String { didSet { d.set(repoPath, forKey: "repoPath") } }
    /// Local mode: start the bridge with --writes, so JARVIS may act, not only look.
    @Published var allowWrites: Bool { didSet { d.set(allowWrites, forKey: "allowWrites") } }
    /// How this Mac is named to the bridge in local mode.
    @Published var deviceName: String { didSet { d.set(deviceName, forKey: "deviceName") } }

    private init() {
        mode = Mode(rawValue: d.string(forKey: "mode") ?? "") ?? .paired
        // build.sh bakes the address of the PC (when Tailscale knew it) and
        // the checkout the app was built from, so the first run asks for
        // as little as possible.
        let info = Bundle.main.infoDictionary ?? [:]
        address = d.string(forKey: "address") ?? (info["JarvisBridgeURL"] as? String ?? "")
        repoPath = d.string(forKey: "repoPath") ?? (info["JarvisRepoPath"] as? String ?? "")
        allowWrites = d.object(forKey: "allowWrites") as? Bool ?? true
        deviceName = d.string(forKey: "deviceName") ?? (Host.current().localizedName ?? "MacBook")
    }

    var pairedToken: String? {
        get { Keychain.get("paired") }
        set { Keychain.set("paired", newValue) }
    }

    var localToken: String? {
        get { Keychain.get("local") }
        set { Keychain.set("local", newValue) }
    }

    /// Enough is filled in to start.
    var ready: Bool {
        switch mode {
        case .paired: return !address.isEmpty && pairedToken != nil
        case .local: return !repoPath.isEmpty
        }
    }

    /// Accept "pc.tailnet.ts.net", "https://…" or "wss://…" alike.
    static func normalise(_ raw: String) -> String {
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while v.hasSuffix("/") { v.removeLast() }
        if v.isEmpty { return v }
        let lower = v.lowercased()
        if lower.hasPrefix("ws://") || lower.hasPrefix("wss://") { return v }
        if lower.hasPrefix("http://") { return "ws://" + v.dropFirst(7) }
        if lower.hasPrefix("https://") { return "wss://" + v.dropFirst(8) }
        return "wss://" + v
    }

    /// wss://host → https://host, for HTTP requests to the same bridge.
    static func httpOf(_ ws: String) -> String {
        if ws.lowercased().hasPrefix("wss://") { return "https://" + ws.dropFirst(6) }
        if ws.lowercased().hasPrefix("ws://") { return "http://" + ws.dropFirst(5) }
        return ws
    }
}
