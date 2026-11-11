package app.jarvis.mobile;

import java.util.Locale;

/**
 * Apps JARVIS may never read or touch: banks, wallets, payment apps,
 * authenticators and password managers.
 *
 * JARVIS reads the open web, and a page can carry instructions aimed at him.
 * The worst a successful one could do is reach into one of these — read a
 * one-time code from a notification, tap "confirm" on a transfer. So while one
 * of them is on screen, reading the screen, screenshots, taps, swipes and
 * typing are refused, and their notifications are left out of everything he
 * sees. Opening them is still allowed: that is something the user can see
 * happen and take over from.
 *
 * Matched as substrings of the package name, lower-cased, so a bank's other
 * apps are caught along with its main one.
 */
final class Blocklist {
    private Blocklist() {}

    private static final String[] PATTERNS = {
        // banks (Brazil first, then generic)
        "bank", "banco", "itau", "bradesco", "santander", "caixa", "com.nu.production", "nubank",
        "bancointer", "intermedium", "c6bank", "com.bb.android", "sicredi", "sicoob", "btgpactual",
        "br.com.xp", "br.com.neon", "pagbank", "pagseguro", "safra", "banrisul",
        // payments and wallets
        "picpay", "mercadopago", "paypal", "wallet", "walletnfcrel", "samsungpay", "recargapay",
        "binance", "coinbase", "crypto", "metamask", "trustwallet",
        // authenticators and password managers
        "authenticator", "authy", "1password", "bitwarden", "lastpass", "keepass", "dashlane", "proton.pass",
        // government identity
        "br.gov", "gov.br",
    };

    static boolean blocked(CharSequence pkg) {
        if (pkg == null) return false;
        String p = pkg.toString().toLowerCase(Locale.ROOT);
        if (p.equals("app.jarvis.mobile")) return false;
        for (String pattern : PATTERNS) {
            if (p.contains(pattern)) return true;
        }
        return false;
    }
}
