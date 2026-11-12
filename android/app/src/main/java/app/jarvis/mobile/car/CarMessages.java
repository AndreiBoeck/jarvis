package app.jarvis.mobile.car;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import app.jarvis.mobile.R;
import java.util.ArrayList;
import java.util.List;

/**
 * JARVIS as a conversation in Android Auto's messages.
 *
 * Android Auto reads a messaging notification aloud and lets the driver
 * answer it by voice, with no screen involved — so every exchange in the car
 * is also kept here as one running conversation with JARVIS. A reply to it
 * (spoken, through Android Auto) goes to JARVIS at home through
 * CarReplyReceiver, and his answer arrives as the next message.
 *
 * The shape is what Android Auto requires of a messaging app: MessagingStyle,
 * a reply action with a RemoteInput, and a mark-as-read action, neither of
 * which opens any UI on the phone.
 */
public final class CarMessages {
    private CarMessages() {}

    static final String REPLY_KEY = "jarvis_reply";
    static final String ACTION_REPLY = "app.jarvis.mobile.car.REPLY";
    static final String ACTION_READ = "app.jarvis.mobile.car.READ";
    private static final String CHANNEL = "jarvis_chat";
    private static final int NOTIFICATION_ID = 77;
    private static final int KEEP = 10;

    private static final class Line {
        final boolean jarvis;
        final String text;
        final long at = System.currentTimeMillis();

        Line(boolean jarvis, String text) {
            this.jarvis = jarvis;
            this.text = text;
        }
    }

    private static final List<Line> history = new ArrayList<>();

    static synchronized boolean empty() {
        return history.isEmpty();
    }

    /** Something the user said, in the car or in a reply. Never alerts. */
    static void fromUser(Context c, String text) {
        add(c, new Line(false, text), false);
    }

    /**
     * Something JARVIS said. alert=false when it was already spoken in the car
     * (so Android Auto does not read it a second time); true when this message
     * is the only way it reaches the driver.
     */
    static void fromJarvis(Context c, String text, boolean alert) {
        add(c, new Line(true, text), alert);
    }

    private static void add(Context c, Line line, boolean alert) {
        synchronized (CarMessages.class) {
            history.add(line);
            while (history.size() > KEEP) history.remove(0);
        }
        post(c.getApplicationContext(), alert);
    }

    static void markRead(Context c) {
        NotificationManagerCompat.from(c).cancel(NOTIFICATION_ID);
    }

    private static void post(Context c, boolean alert) {
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Conversa com o Jarvis", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("As respostas do Jarvis, para o Android Auto ler e você responder por voz");
            c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }

        Person me = new Person.Builder().setName("Você").setKey("user").build();
        Person jarvis = new Person.Builder().setName("Jarvis").setKey("jarvis").setBot(true).build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        synchronized (CarMessages.class) {
            for (Line l : history) style.addMessage(l.text, l.at, l.jarvis ? jarvis : me);
        }

        RemoteInput input = new RemoteInput.Builder(REPLY_KEY).setLabel("Responder ao Jarvis").build();
        int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent replyIntent = PendingIntent.getBroadcast(c, 1,
            new Intent(c, CarReplyReceiver.class).setAction(ACTION_REPLY),
            PendingIntent.FLAG_UPDATE_CURRENT | mutable);
        PendingIntent readIntent = PendingIntent.getBroadcast(c, 2,
            new Intent(c, CarReplyReceiver.class).setAction(ACTION_READ),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Action reply = new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_jarvis, "Responder", replyIntent)
            .addRemoteInput(input)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build();
        NotificationCompat.Action read = new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_jarvis, "Marcar como lida", readIntent)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build();

        try {
            NotificationManagerCompat.from(c).notify(NOTIFICATION_ID,
                new NotificationCompat.Builder(c, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_jarvis)
                    .setStyle(style)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .addAction(reply)
                    .addInvisibleAction(read)
                    .setSilent(!alert)
                    .setOnlyAlertOnce(false)
                    .build());
        } catch (SecurityException e) {
            // notification permission revoked; the car screen still works
        }
    }
}
