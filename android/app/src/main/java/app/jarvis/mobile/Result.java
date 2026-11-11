package app.jarvis.mobile;

import org.json.JSONException;
import org.json.JSONObject;

/** The reply shapes the bridge expects from a command (see bridge/phone.mjs). */
final class Result {
    private Result() {}

    static JSONObject text(String text) {
        JSONObject o = new JSONObject();
        put(o, "ok", true);
        put(o, "text", text);
        return o;
    }

    static JSONObject json(Object json) {
        JSONObject o = new JSONObject();
        put(o, "ok", true);
        put(o, "json", json);
        return o;
    }

    static JSONObject image(String base64, String mimeType) {
        JSONObject o = new JSONObject();
        put(o, "ok", true);
        put(o, "data", base64);
        put(o, "mimeType", mimeType);
        return o;
    }

    /** One plain sentence: it may well be spoken aloud. */
    static JSONObject error(String message) {
        JSONObject o = new JSONObject();
        put(o, "ok", false);
        put(o, "error", message == null || message.isEmpty() ? "The phone could not do that." : message);
        return o;
    }

    static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (JSONException ignored) {
            // only thrown for NaN/Infinity, which nothing here produces
        }
    }
}
