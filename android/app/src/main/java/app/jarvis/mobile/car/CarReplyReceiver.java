package app.jarvis.mobile.car;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;

/**
 * A reply to the JARVIS conversation in Android Auto, spoken by the driver
 * and transcribed by Android Auto, or "mark as read".
 *
 * The answer takes longer than a receiver may live, so the question is handed
 * to CarConversation and the answer posted when it arrives; the background
 * link keeps the process alive in the meantime.
 */
public class CarReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Context c = ctx.getApplicationContext();
        if (CarMessages.ACTION_READ.equals(intent.getAction())) {
            CarMessages.markRead(c);
            return;
        }
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence said = results == null ? null : results.getCharSequence(CarMessages.REPLY_KEY);
        if (said == null || said.toString().trim().isEmpty()) return;
        String text = said.toString().trim();

        CarMessages.fromUser(c, text);
        CarConversation.get(c).ask(text, new CarConversation.Listener() {
            @Override
            public void onAnswer(String answer) {
                CarMessages.fromJarvis(c, answer.isEmpty() ? "Done." : answer, true);
            }

            @Override
            public void onError(String message) {
                CarMessages.fromJarvis(c, "I can't reach home right now. Is the PC on, with the bridge running?", true);
            }
        });
    }
}
