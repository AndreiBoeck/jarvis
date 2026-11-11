package app.jarvis.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Negar", or the confirmation swiped away: both mean no. */
public class ConfirmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Confirm.decide(ctx, intent.getStringExtra("id"), false);
    }
}
