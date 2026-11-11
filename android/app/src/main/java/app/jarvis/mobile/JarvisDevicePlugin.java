package app.jarvis.mobile;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/**
 * The web interface's door to the native side (see src/lib/device.ts).
 *
 * Pairing, the background link's switch, and the system settings JARVIS needs.
 * Android only lets the user grant most of these in its own settings screens,
 * so for those this can only open the right page; the interface re-reads the
 * status when the user comes back.
 */
@CapacitorPlugin(name = "JarvisDevice")
public class JarvisDevicePlugin extends Plugin {

    /** Short name → the runtime permissions behind it. */
    private static String[][] permissionGroups() {
        List<String[]> g = new ArrayList<>();
        g.add(new String[] {"mic", Manifest.permission.RECORD_AUDIO});
        g.add(new String[] {"calls", Manifest.permission.CALL_PHONE});
        g.add(new String[] {"sms", Manifest.permission.SEND_SMS});
        g.add(new String[] {"contacts", Manifest.permission.READ_CONTACTS});
        g.add(new String[] {"location", Manifest.permission.ACCESS_FINE_LOCATION});
        g.add(new String[] {"camera", Manifest.permission.CAMERA});
        if (Build.VERSION.SDK_INT >= 33) g.add(new String[] {"notify", Manifest.permission.POST_NOTIFICATIONS});
        return g.toArray(new String[0][]);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        Context c = getContext();
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        LinkPrefs.save(c, url, token, enabled);
        try {
            DeviceLinkService.sync(c);
        } catch (Exception e) {
            call.reject("Could not start the background link: " + e.getMessage());
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    /** Ask for whatever is still missing; the interface polls status for the outcome. */
    @PluginMethod
    public void grantPermissions(PluginCall call) {
        List<String> missing = new ArrayList<>();
        for (String[] g : permissionGroups()) {
            if (!granted(g[1])) missing.add(g[1]);
        }
        if (!missing.isEmpty()) {
            ActivityCompat.requestPermissions(getActivity(), missing.toArray(new String[0]), 4242);
        }
        call.resolve(status());
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 30) {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                    new ComponentName(getContext(), JarvisNotificationListener.class).flattenToString());
        } else {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        open(i);
        call.resolve();
    }

    /**
     * Android 13+ keeps accessibility and notification access greyed out for
     * apps installed outside the Play Store until the user allows "restricted
     * settings" on the app's own info page. This opens that page.
     */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    // ------------------------------------------------------------------

    private void open(Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject status() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("enabled", LinkPrefs.enabled(c));
        o.put("connected", DeviceLinkService.connected);
        o.put("lastError", DeviceLinkService.lastError);
        o.put("accessibility", JarvisAccessibilityService.instance != null);
        o.put("notifications", NotificationManagerCompat.getEnabledListenerPackages(c).contains(c.getPackageName()));
        PowerManager pm = c.getSystemService(PowerManager.class);
        o.put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        JSObject perms = new JSObject();
        for (String[] g : permissionGroups()) perms.put(g[0], granted(g[1]));
        o.put("permissions", perms);
        return o;
    }
}
