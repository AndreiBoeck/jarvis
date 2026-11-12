package app.jarvis.mobile.car;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import app.jarvis.mobile.LinkPrefs;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/**
 * The car's conversation with JARVIS at home.
 *
 * The same socket the interface uses (/ws), opened natively with the pairing
 * token and `?surface=car`, so the bridge knows this conversation is voice-only
 * and in a moving car (see promptWhere in bridge/server.mjs). One per process,
 * shared by the car screen and the message replies, so both are one
 * conversation that remembers what was said.
 *
 * Only the finished answer is used: speech is generated in one go from it.
 * Answers in the car are a sentence or two, so waiting for the end costs
 * little and keeps this simple.
 */
public final class CarConversation {

    public interface Listener {
        void onAnswer(String text);

        void onError(String message);
    }

    public interface AlertListener {
        void onAlert(String message);
    }

    private static CarConversation instance;

    public static synchronized CarConversation get(Context c) {
        if (instance == null) instance = new CarConversation(c.getApplicationContext());
        return instance;
    }

    /** How long an answer may take before the car gives up on it. */
    private static final long ANSWER_TIMEOUT_MS = 120_000;

    private final Context app;
    private final OkHttpClient client;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Listener> pending = new HashMap<>();
    private final List<String> outbox = new ArrayList<>();
    private WebSocket socket;
    private boolean open = false;
    private int seq = 0;
    private volatile AlertListener alerts;

    private CarConversation(Context app) {
        this.app = app;
        this.client = new OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .build();
    }

    public void setAlertListener(AlertListener l) {
        alerts = l;
    }

    public boolean paired() {
        return !LinkPrefs.url(app).isEmpty() && !LinkPrefs.token(app).isEmpty();
    }

    /** Ask a question. Callbacks arrive on the main thread. A newer question abandons an older one. */
    public synchronized void ask(String text, Listener l) {
        if (!paired()) {
            main.post(() -> l.onError("not paired"));
            return;
        }
        if (!pending.isEmpty()) {
            pending.clear();
            send("{\"type\":\"interrupt\"}");
        }
        String id = "car" + (++seq);
        pending.put(id, l);
        try {
            send(new JSONObject().put("type", "ask").put("text", text).put("id", id).toString());
        } catch (Exception e) {
            pending.remove(id);
            main.post(() -> l.onError(e.getMessage()));
            return;
        }
        main.postDelayed(() -> {
            Listener late;
            synchronized (this) {
                late = pending.remove(id);
            }
            if (late != null) late.onError("timeout");
        }, ANSWER_TIMEOUT_MS);
    }

    private synchronized void send(String frame) {
        if (open && socket != null) {
            socket.send(frame);
        } else {
            outbox.add(frame);
            connect();
        }
    }

    private synchronized void connect() {
        if (socket != null) return;
        Request req = new Request.Builder()
            .url(LinkPrefs.wsBase(app) + "/ws?surface=car")
            .header("Authorization", "Bearer " + LinkPrefs.token(app))
            .build();
        socket = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response r) {
                synchronized (CarConversation.this) {
                    if (ws != socket) return;
                    open = true;
                    for (String f : outbox) ws.send(f);
                    outbox.clear();
                }
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handle(ws, text);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                dropped(ws);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response r) {
                dropped(ws);
            }
        });
    }

    private void handle(WebSocket ws, String text) {
        JSONObject m;
        try {
            m = new JSONObject(text);
        } catch (Exception e) {
            return;
        }
        String type = m.optString("type");
        String ask = m.optString("ask", "");
        switch (type) {
            case "done": {
                Listener l = take(ask);
                String answer = m.optString("text", "").trim();
                if (l != null) main.post(() -> l.onAnswer(answer));
                break;
            }
            case "error": {
                Listener l = take(ask);
                String why = m.optString("message", "");
                if (l != null) main.post(() -> l.onError(why));
                break;
            }
            case "capture":
                // The camera lives in the phone's interface, not in the car.
                try {
                    ws.send(new JSONObject().put("type", "reply").put("id", m.optString("id"))
                        .put("error", "There is no camera in the car.").toString());
                } catch (Exception ignored) {
                    // nothing to do; the bridge times the request out
                }
                break;
            case "alert": {
                JSONObject a = m.optJSONObject("alert");
                AlertListener l = alerts;
                if (a != null && l != null && "speak".equals(a.optString("channel", "speak"))) {
                    String msg = a.optString("message", "");
                    if (!msg.isEmpty()) main.post(() -> l.onAlert(msg));
                }
                break;
            }
            default:
                break;
        }
    }

    private synchronized Listener take(String ask) {
        return ask.isEmpty() ? null : pending.remove(ask);
    }

    private void dropped(WebSocket ws) {
        List<Listener> failed;
        synchronized (this) {
            if (ws != socket) return;
            socket = null;
            open = false;
            failed = new ArrayList<>(pending.values());
            pending.clear();
            outbox.clear();
        }
        for (Listener l : failed) main.post(() -> l.onError("unreachable"));
    }

    /** Close the conversation; the next question opens a new one. */
    public synchronized void close() {
        if (socket != null) socket.close(1000, "car session ended");
        socket = null;
        open = false;
        outbox.clear();
        pending.clear();
    }
}
