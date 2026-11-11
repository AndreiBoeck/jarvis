package app.jarvis.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bring the background link back after a reboot or an app update, if it was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            DeviceLinkService.sync(ctx);
        }
    }
}
