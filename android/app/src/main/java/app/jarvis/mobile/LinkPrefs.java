package app.jarvis.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The phone's pairing with the bridge, as the native side keeps it.
 *
 * The web interface keeps its own copy (localStorage) for the conversation
 * socket; this one is for the background link, which has to work with the
 * interface closed. Both are written together by the pairing screen.
 */
public final class LinkPrefs {
    private LinkPrefs() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("jarvis_link", Context.MODE_PRIVATE);
    }

    public static String url(Context c) {
        return prefs(c).getString("url", "");
    }

    public static String token(Context c) {
        return prefs(c).getString("token", "");
    }

    static boolean enabled(Context c) {
        return prefs(c).getBoolean("enabled", false);
    }

    static boolean ready(Context c) {
        return enabled(c) && !url(c).isEmpty() && !token(c).isEmpty();
    }

    static void save(Context c, String url, String token, boolean enabled) {
        prefs(c).edit().putString("url", url).putString("token", token).putBoolean("enabled", enabled).apply();
    }

    /** The paired address as a WebSocket base, no trailing slash: wss://host. */
    public static String wsBase(Context c) {
        String u = url(c).trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (u.startsWith("https://")) u = "wss://" + u.substring(8);
        else if (u.startsWith("http://")) u = "ws://" + u.substring(7);
        else if (!u.startsWith("ws")) u = "wss://" + u;
        return u;
    }

    /** The same address for plain requests: https://host. */
    public static String httpBase(Context c) {
        return wsBase(c).replaceFirst("^ws", "http");
    }

    /** wss://host (as paired) → wss://host/device, the background link's path. */
    static String deviceUrl(Context c) {
        return wsBase(c) + "/device";
    }

    /** Whether "Hey Jarvis" listens while the JARVIS screen is open in the car. */
    public static boolean carWake(Context c) {
        return prefs(c).getBoolean("car_wake", true);
    }

    public static void setCarWake(Context c, boolean on) {
        prefs(c).edit().putBoolean("car_wake", on).apply();
    }
}
