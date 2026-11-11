package app.jarvis.mobile;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reading notifications, and replying through them.
 *
 * Nothing is stored: when JARVIS asks, the notifications currently on the
 * phone are read and summarised. Ongoing ones (music, the JARVIS link itself),
 * group summaries, and anything from a blocked app — where one-time codes
 * live — are left out.
 */
public class JarvisNotificationListener extends NotificationListenerService {

    static volatile JarvisNotificationListener instance;

    /** Short ids handed to the model → notification keys, for reply_notification. */
    private static final Map<String, String> ids = new ConcurrentHashMap<>();
    private static final AtomicInteger counter = new AtomicInteger();

    @Override
    public void onListenerConnected() {
        instance = this;
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
    }

    JSONObject read(String appFilter, int limit) throws Exception {
        PackageManager pm = getPackageManager();
        String filter = appFilter == null ? "" : appFilter.toLowerCase(Locale.ROOT);
        JSONArray out = new JSONArray();
        StatusBarNotification[] active = getActiveNotifications();
        if (active == null) active = new StatusBarNotification[0];
        java.util.Arrays.sort(active, (a, b) -> Long.compare(b.getPostTime(), a.getPostTime()));

        for (StatusBarNotification sbn : active) {
            if (out.length() >= limit) break;
            Notification n = sbn.getNotification();
            String pkg = sbn.getPackageName();
            if (pkg.equals(getPackageName()) || Blocklist.blocked(pkg)) continue;
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) continue;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;

            String label = appLabel(pm, pkg);
            if (!filter.isEmpty()
                && !pkg.toLowerCase(Locale.ROOT).contains(filter)
                && !label.toLowerCase(Locale.ROOT).contains(filter)) continue;

            Bundle x = n.extras;
            // Running timers and the like post notifications with nothing to read.
            if (str(x.getCharSequence(Notification.EXTRA_TITLE)).isEmpty()
                && str(x.getCharSequence(Notification.EXTRA_TEXT)).isEmpty()) continue;
            JSONObject e = new JSONObject();
            String id = "n" + counter.incrementAndGet();
            ids.put(id, sbn.getKey());
            e.put("id", id);
            e.put("app", label);
            e.put("title", str(x.getCharSequence(Notification.EXTRA_TITLE)));
            CharSequence big = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            e.put("text", str(big != null ? big : x.getCharSequence(Notification.EXTRA_TEXT)));
            JSONArray msgs = messages(x);
            if (msgs.length() > 0) e.put("messages", msgs);
            e.put("minutesAgo", (System.currentTimeMillis() - sbn.getPostTime()) / 60000);
            e.put("canReply", replyAction(n) != null);
            out.put(e);
        }
        if (ids.size() > 500) ids.clear(); // ids from long ago are useless anyway
        return Result.json(out);
    }

    /** The last few lines of a conversation-style notification (WhatsApp, Telegram…). */
    private static JSONArray messages(Bundle x) {
        JSONArray out = new JSONArray();
        Parcelable[] arr = x.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (arr == null) return out;
        for (int i = Math.max(0, arr.length - 5); i < arr.length; i++) {
            if (!(arr[i] instanceof Bundle)) continue;
            Bundle m = (Bundle) arr[i];
            CharSequence sender = m.getCharSequence("sender");
            CharSequence text = m.getCharSequence("text");
            if (text == null) continue;
            out.put((sender != null ? sender + ": " : "") + text);
        }
        return out;
    }

    static Notification.Action replyAction(Notification n) {
        if (n.actions == null) return null;
        for (Notification.Action a : n.actions) {
            RemoteInput[] inputs = a.getRemoteInputs();
            if (inputs != null && inputs.length > 0 && a.actionIntent != null) return a;
        }
        return null;
    }

    /** Find the notification behind an id from read(), if it is still there. */
    StatusBarNotification find(String id) {
        String key = ids.get(id);
        if (key == null) return null;
        StatusBarNotification[] hits = getActiveNotifications(new String[] {key});
        return hits != null && hits.length > 0 ? hits[0] : null;
    }

    /** Send the reply. Runs after the user has confirmed it on the phone. */
    static JSONObject reply(Context ctx, StatusBarNotification sbn, String message) throws Exception {
        Notification.Action action = replyAction(sbn.getNotification());
        if (action == null) return Result.error("That notification no longer accepts a reply.");
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput in : action.getRemoteInputs()) results.putCharSequence(in.getResultKey(), message);
        RemoteInput.addResultsToIntent(action.getRemoteInputs(), fill, results);
        try {
            action.actionIntent.send(ctx, 0, fill);
        } catch (PendingIntent.CanceledException e) {
            return Result.error("The app that sent that notification no longer takes replies to it.");
        }
        return Result.text("Reply sent.");
    }

    static String appLabel(PackageManager pm, String pkg) {
        try {
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static String str(CharSequence s) {
        return s == null ? "" : s.toString();
    }
}
