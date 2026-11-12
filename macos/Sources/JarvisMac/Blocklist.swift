import AppKit

/// Apps JARVIS may never read or touch on this Mac: password managers,
/// Keychain Access, banks, wallets, authenticators.
///
/// JARVIS reads the open web, and a page can carry instructions aimed at him.
/// The worst a successful one could do is reach into one of these — read a
/// password off the screen, click "confirm" on a transfer. So while one of
/// them is in front, reading the screen, screenshots, clicks, scrolling and
/// typing are refused. Opening them is still allowed: that is something the
/// user can see happen and take over from. The same list as the Android app's
/// Blocklist.java, plus the Mac's own.
///
/// Matched as substrings of the bundle id and the app name, lower-cased.
enum Blocklist {
    private static let patterns = [
        // macOS's own vaults
        "com.apple.keychainaccess", "com.apple.passwords", "com.apple.systempreferences.password",
        // password managers and authenticators
        "1password", "bitwarden", "lastpass", "keepass", "dashlane", "enpass", "proton.pass",
        "authenticator", "authy", "keeper",
        // banks (Brazil first, then generic)
        "bank", "banco", "itau", "bradesco", "santander", "caixa", "nubank", "bancointer",
        "c6bank", "sicredi", "sicoob", "btgpactual", "pagbank", "pagseguro", "safra", "banrisul",
        // payments and wallets
        "picpay", "mercadopago", "paypal", "wallet", "binance", "coinbase", "crypto", "metamask",
        "ledger", "exodus", "trezor",
        // government identity
        "br.gov", "gov.br",
    ]

    static func blocked(bundleId: String?, name: String?) -> Bool {
        let id = (bundleId ?? "").lowercased()
        let n = (name ?? "").lowercased()
        if id == "app.jarvis.mac" { return false }
        return patterns.contains { id.contains($0) || (!n.isEmpty && n.contains($0)) }
    }

    /// The app in front, when it is one of the fenced ones.
    static func frontmostBlocked() -> NSRunningApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return blocked(bundleId: app.bundleIdentifier, name: app.localizedName) ? app : nil
    }

    static func refusal(_ app: NSRunningApplication) -> String {
        "\(app.localizedName ?? "That app") is fenced off on the Mac: JARVIS does not read or touch it. Tell the user in one sentence."
    }
}
