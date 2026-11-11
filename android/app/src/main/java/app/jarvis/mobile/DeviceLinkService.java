package app.jarvis.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/**
 * The background link: one quiet WebSocket to the bridge's /device endpoint,
 * held open so the JARVIS on the PC can reach this phone at any time.
 *
 * Cheap by design. No microphone, no agent, no polling: the socket sits idle
 * until the bridge sends a command, and the only regular traffic is a ping
 * every minute or so to notice a dead mobile connection. Android requires a
 * visible notification for anything that runs like this; it is a silent,
 * low-priority one.
 *
 * Reconnects by itself — on network changes at once, otherwise with backoff
 * up to a minute — because phones change networks constantly and Tailscale
 * takes a moment to come back after each change.
 */
public class DeviceLinkService extends Service {

    private static final String TAG = "JarvisLink";
    private static final String CHANNEL = "jarvis_link";
    private static final int NOTIFICATION_ID = 7;

    static volatile boolean connected = false;
    static volatile String lastError = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newCachedThreadPool();
    private OkHttpClient client;
    /** Read from OkHttp's threads to ignore events from a socket already replaced. */
    private volatile WebSocket socket;
    private Commands commands;
    private int attempt = 0;
    private boolean stopping = false;
    private String linkedTo = "";
    private ConnectivityManager.NetworkCallback netWatch;

    /** Start or stop the service to match the saved pairing. */
    static void sync(Context c) {
        Intent i = new Intent(c, DeviceLinkService.class);
        if (LinkPrefs.ready(c)) {
            ContextCompat.startForegroundService(c, i);
        } else {
            c.stopService(i);
            connected = false;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        commands = new Commands(this);
        client = new OkHttpClient.Builder()
            .pingInterval(55, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .build();
        goForeground("Conectando ao Jarvis…");
        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!LinkPrefs.ready(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // A new pairing (or the first start) means a fresh connection.
        String target = LinkPrefs.deviceUrl(this) + "|" + LinkPrefs.token(this);
        if (!target.equals(linkedTo)) {
            linkedTo = target;
            attempt = 0;
            reconnectNow();
        }
        return START_STICKY;
    }

    private void goForeground(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Conexão com o Jarvis", NotificationManager.IMPORTANCE_MIN);
            ch.setDescription("Mantém o Jarvis do PC em contato com este celular");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_jarvis)
            .setContentTitle("Jarvis")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void setState(boolean up, String error) {
        connected = up;
        if (error != null) lastError = error;
        main.post(() -> goForeground(up ? "Conectado ao Jarvis de casa" : "Reconectando ao Jarvis…"));
    }

    // ------------------------------------------------------------- the socket

    private void reconnectNow() {
        main.removeCallbacksAndMessages(null);
        if (socket != null) socket.cancel();
        socket = null;
        connect();
    }

    private void connect() {
        if (stopping || !LinkPrefs.ready(this)) return;
        Request req = new Request.Builder()
            .url(LinkPrefs.deviceUrl(this))
            .header("Authorization", "Bearer " + LinkPrefs.token(this))
            .header("Sec-WebSocket-Protocol", "jarvis.v1")
            .build();
        socket = client.newWebSocket(req, new Listener());
    }

    private void scheduleReconnect() {
        if (stopping) return;
        long delay = Math.min(60_000L, 1000L << Math.min(attempt, 6));
        attempt++;
        main.postDelayed(this::connect, delay);
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket ws, Response response) {
            if (ws != socket) return;
            attempt = 0;
            setState(true, "");
            try {
                JSONObject hello = new JSONObject()
                    .put("type", "device_hello")
                    .put("capabilities", Commands.capabilities())
                    .put("model", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("android", Build.VERSION.RELEASE);
                ws.send(hello.toString());
            } catch (Exception e) {
                Log.w(TAG, "hello failed", e);
            }
        }

        @Override
        public void onMessage(WebSocket ws, String text) {
            JSONObject msg;
            try {
                msg = new JSONObject(text);
            } catch (Exception e) {
                return;
            }
            if (!"device_call".equals(msg.optString("type"))) return;
            String id = msg.optString("id");
            String tool = msg.optString("tool");
            JSONObject args = msg.optJSONObject("args");
            JSONObject finalArgs = args == null ? new JSONObject() : args;
            // Off the socket's thread: some commands wait (a GPS fix, a tap on
            // "allow"), and the next command must not queue behind them.
            work.execute(() -> {
                JSONObject reply = commands.run(tool, finalArgs);
                Result.put(reply, "type", "device_result");
                Result.put(reply, "id", id);
                ws.send(reply.toString());
            });
        }

        @Override
        public void onClosing(WebSocket ws, int code, String reason) {
            ws.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket ws, int code, String reason) {
            if (ws != socket) return;
            setState(false, code == 4000 ? "" : "conexão encerrada");
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket ws, Throwable t, Response response) {
            if (ws != socket) return;
            String why;
            if (response != null && (response.code() == 401 || response.code() == 403)) {
                why = "o PC recusou o token — pareie de novo";
            } else if (response != null) {
                why = "o PC respondeu " + response.code();
            } else {
                why = "sem acesso ao PC (Tailscale ligado?)";
            }
            setState(false, why);
            scheduleReconnect();
        }
    }

    /** Back on a network → try at once rather than waiting out the backoff. */
    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        netWatch = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                if (!connected) main.post(() -> {
                    attempt = 0;
                    reconnectNow();
                });
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netWatch);
        } catch (Exception e) {
            netWatch = null;
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        main.removeCallbacksAndMessages(null);
        if (netWatch != null) {
            try {
                getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netWatch);
            } catch (Exception ignored) {
                // already gone
            }
        }
        if (socket != null) socket.close(1000, "stopped");
        socket = null;
        connected = false;
        work.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
