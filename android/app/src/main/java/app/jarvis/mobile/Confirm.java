package app.jarvis.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * "JARVIS wants to call Maria — allow?" on the phone itself.
 *
 * Anything that leaves the phone — a call, a text, a reply — waits here for a
 * tap. The bridge has its own gate (write access must be on), but that one
 * lives on the PC and can be satisfied by anything that convinces the model.
 * This one is a button on a screen in the user's hand.
 *
 * The request is a heads-up notification. "Allow" opens ConfirmActivity
 * directly (an activity, not a broadcast, because Android no longer lets a
 * notification action start an activity through a receiver — and placing a
 * call is starting an activity). The approved action then runs in that
 * activity's context, which is in the foreground and allowed to dial.
 */
final class Confirm {
    private Confirm() {}

    interface Action {
        JSONObject run(Context foreground) throws Exception;
    }

    static final class Pending {
        final String title;
        final String text;
        final Action action;
        final CompletableFuture<JSONObject> done = new CompletableFuture<>();

        Pending(String title, String text, Action action) {
            this.title = title;
            this.text = text;
            this.action = action;
        }
    }

    static final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private static final String CHANNEL = "jarvis_confirm";

    /** Blocks the calling (worker) thread until the user decides, or time runs out. */
    static JSONObject ask(Context ctx, String title, String text, Action action, long timeoutMs) {
        String id = UUID.randomUUID().toString();
        Pending p = new Pending(title, text, action);
        pending.put(id, p);
        int notificationId = id.hashCode();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        try {
            channel(ctx);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent allow = PendingIntent.getActivity(
                ctx, notificationId, ConfirmActivity.intent(ctx, id, "allow"), flags);
            PendingIntent review = PendingIntent.getActivity(
                ctx, notificationId + 1, ConfirmActivity.intent(ctx, id, "ask"), flags);
            Intent denyIntent = new Intent(ctx, ConfirmReceiver.class).putExtra("id", id);
            PendingIntent deny = PendingIntent.getBroadcast(ctx, notificationId + 2, denyIntent, flags);

            nm.notify(notificationId, new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_jarvis)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(review)
                // Swiping it away is a no. Not auto-cancelled on tap: that tap
                // only opens the review dialog, and must not read as a refusal.
                .setDeleteIntent(deny)
                .setOngoing(true)
                .setTimeoutAfter(timeoutMs)
                .addAction(0, "Negar", deny)
                .addAction(0, "Permitir", allow)
                .build());

            return p.done.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            return Result.error("The user did not confirm on the phone in time, so nothing was sent.");
        } catch (Exception e) {
            return Result.error("Could not ask for confirmation on the phone: " + e.getMessage());
        } finally {
            pending.remove(id);
            nm.cancel(notificationId);
        }
    }

    /** Called from ConfirmActivity (allow) or ConfirmReceiver (deny). */
    static void decide(Context ctx, String id, boolean allow) {
        Pending p = id == null ? null : pending.get(id);
        if (p == null || p.done.isDone()) return;
        if (!allow) {
            p.done.complete(Result.error("The user declined on the phone. Nothing was sent."));
            return;
        }
        try {
            p.done.complete(p.action.run(ctx));
        } catch (SecurityException e) {
            p.done.complete(Result.error("The phone has not granted JARVIS that permission yet. Open the JARVIS app settings to allow it."));
        } catch (Exception e) {
            p.done.complete(Result.error(e.getMessage()));
        }
    }

    private static void channel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL, "Confirmações", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Ligações, SMS e respostas que o Jarvis quer enviar");
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }
}
