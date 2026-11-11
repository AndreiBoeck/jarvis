package app.jarvis.mobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.AlarmClock;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.telephony.SmsManager;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Every command the bridge can send (bridge/phone.mjs), carried out with the
 * phone's own APIs. Each returns a Result; failures are one plain sentence,
 * because the model may read them out.
 *
 * Runs on a worker thread, never the main one: some commands wait — for a GPS
 * fix, for a gesture to finish, for the user to tap "allow".
 */
final class Commands {

    /** What this build can do, announced to the bridge on connect. */
    static final String[] CAPABILITIES = {
        "status", "list_apps", "read_screen", "screenshot", "read_notifications", "get_location",
        "open_app", "open_url", "navigate", "set_timer", "set_alarm", "flashlight", "set_volume",
        "tap", "swipe", "type_text", "press_key", "call", "send_sms", "reply_notification",
    };

    private static final long CONFIRM_MS = 85_000;

    private final Context ctx;

    Commands(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    JSONObject run(String tool, JSONObject a) {
        try {
            switch (tool) {
                case "status": return status();
                case "list_apps": return listApps();
                case "read_screen": return withScreen().readScreen();
                case "screenshot": return withScreen().screenshot();
                case "read_notifications": return readNotifications(a.optString("app", ""), a.optInt("limit", 15));
                case "get_location": return location();
                case "open_app": return openApp(a.optString("app"));
                case "open_url": return openUrl(a.optString("url"));
                case "navigate": return navigate(a.optString("destination"), a.optString("mode", "drive"));
                case "set_timer": return setTimer(a.optInt("seconds"), a.optString("label", ""));
                case "set_alarm": return setAlarm(a.optInt("hour"), a.optInt("minute"), a.optString("label", ""));
                case "flashlight": return flashlight(a.optBoolean("on"));
                case "set_volume": return volume(a.optDouble("level"), a.optString("stream", "media"));
                case "tap": return withScreen().tap(
                    a.optString("element", ""),
                    a.has("x") ? a.optDouble("x") : null,
                    a.has("y") ? a.optDouble("y") : null);
                case "swipe": return withScreen().swipe(a.optString("direction"), a.optDouble("distance", 0.5));
                case "type_text": return withScreen().typeText(a.optString("text"), a.optBoolean("submit", false));
                case "press_key": return withScreen().pressKey(a.optString("key"));
                case "call": return call(a.optString("to"));
                case "send_sms": return sms(a.optString("to"), a.optString("message"));
                case "reply_notification": return replyNotification(a.optString("id"), a.optString("message"));
                default: return Result.error("This version of the JARVIS app cannot do " + tool + " yet.");
            }
        } catch (NoScreen e) {
            return Result.error("Screen control is off. Turn on 'Controle da tela' in the JARVIS app settings on the phone.");
        } catch (SecurityException e) {
            return Result.error("The phone has not granted JARVIS that permission. Open the JARVIS app settings on the phone to allow it.");
        } catch (Exception e) {
            return Result.error(e.getMessage());
        }
    }

    private static final class NoScreen extends Exception {}

    private JarvisAccessibilityService withScreen() throws NoScreen {
        JarvisAccessibilityService s = JarvisAccessibilityService.instance;
        if (s == null) throw new NoScreen();
        return s;
    }

    // ------------------------------------------------------------- reading

    private JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        BatteryManager bm = ctx.getSystemService(BatteryManager.class);
        o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
        o.put("charging", bm.isCharging());
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
        o.put("network", nc == null ? "none"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "mobile data" : "other");
        o.put("screenOn", ctx.getSystemService(PowerManager.class).isInteractive());
        o.put("screenControl", JarvisAccessibilityService.instance != null);
        o.put("notificationAccess", JarvisNotificationListener.instance != null);
        JarvisAccessibilityService s = JarvisAccessibilityService.instance;
        if (s != null) {
            String pkg = s.foregroundPackage();
            if (pkg != null && !pkg.isEmpty() && !Blocklist.blocked(pkg)) {
                o.put("appInFront", JarvisNotificationListener.appLabel(ctx.getPackageManager(), pkg));
            }
        }
        return Result.json(o);
    }

    private List<ResolveInfo> launchable() {
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        return ctx.getPackageManager().queryIntentActivities(main, 0);
    }

    private JSONObject listApps() throws Exception {
        PackageManager pm = ctx.getPackageManager();
        List<String> rows = new ArrayList<>();
        for (ResolveInfo r : launchable()) {
            rows.add(r.loadLabel(pm) + " (" + r.activityInfo.packageName + ")");
        }
        java.util.Collections.sort(rows, String.CASE_INSENSITIVE_ORDER);
        return Result.text(String.join("\n", rows));
    }

    private JSONObject readNotifications(String app, int limit) throws Exception {
        JarvisNotificationListener l = JarvisNotificationListener.instance;
        if (l == null) {
            return Result.error("Notification access is off. Turn on 'Notificações' in the JARVIS app settings on the phone.");
        }
        return l.read(app, Math.max(1, Math.min(50, limit)));
    }

    private JSONObject location() throws Exception {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            return Result.error("Location permission is off for JARVIS on the phone.");
        }
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        Location best = null;
        if (Build.VERSION.SDK_INT >= 30) {
            for (String provider : new String[] {LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                if (!lm.isProviderEnabled(provider)) continue;
                CompletableFuture<Location> fix = new CompletableFuture<>();
                lm.getCurrentLocation(provider, null, ctx.getMainExecutor(), fix::complete);
                try {
                    best = fix.get(10, TimeUnit.SECONDS);
                } catch (Exception ignored) {
                    // try the next provider, then fall back to the last known fix
                }
                if (best != null) break;
            }
        }
        if (best == null) {
            for (String provider : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(provider);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
        }
        if (best == null) return Result.error("The phone could not get a location fix. Location may be switched off.");

        JSONObject o = new JSONObject();
        o.put("latitude", best.getLatitude());
        o.put("longitude", best.getLongitude());
        o.put("accuracyMeters", Math.round(best.getAccuracy()));
        o.put("minutesOld", (System.currentTimeMillis() - best.getTime()) / 60000);
        if (Geocoder.isPresent()) {
            try {
                @SuppressWarnings("deprecation")
                List<Address> found = new Geocoder(ctx, Locale.getDefault())
                    .getFromLocation(best.getLatitude(), best.getLongitude(), 1);
                if (found != null && !found.isEmpty() && found.get(0).getMaxAddressLineIndex() >= 0) {
                    o.put("address", found.get(0).getAddressLine(0));
                }
            } catch (Exception ignored) {
                // the coordinates are the answer; the address is a courtesy
            }
        }
        return Result.json(o);
    }

    // ------------------------------------------------------------- opening things

    /**
     * Start an activity from wherever this is running.
     *
     * Android stops background apps from opening screens, so with the JARVIS
     * app closed this only works through a running accessibility service (or
     * the overlay permission). Better to say so than to "succeed" silently
     * while nothing appears.
     */
    private JSONObject launch(Intent i, String done) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        JarvisAccessibilityService s = JarvisAccessibilityService.instance;
        if (s != null) {
            s.startActivity(i);
            return Result.text(done);
        }
        if (MainActivity.inFront || Settings.canDrawOverlays(ctx)) {
            ctx.startActivity(i);
            return Result.text(done);
        }
        return Result.error("The phone only lets JARVIS open things while its app is open, or with 'Controle da tela' turned on in the JARVIS app settings.");
    }

    private JSONObject openApp(String app) {
        if (app == null || app.trim().isEmpty()) return Result.error("Which app?");
        String want = fold(app);
        PackageManager pm = ctx.getPackageManager();
        String pkg = null;
        String label = null;
        for (ResolveInfo r : launchable()) {
            String p = r.activityInfo.packageName;
            String l = r.loadLabel(pm).toString();
            if (p.equalsIgnoreCase(app.trim()) || fold(l).equals(want)) {
                pkg = p;
                label = l;
                break;
            }
            if (pkg == null && fold(l).contains(want)) {
                pkg = p;
                label = l;
            }
        }
        if (pkg == null) return Result.error("No app called " + app + " is installed on the phone.");
        Intent i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) return Result.error(label + " cannot be opened directly.");
        return launch(i, "Opened " + label + ".");
    }

    private JSONObject openUrl(String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return Result.error("Only web addresses can be opened.");
        return launch(new Intent(Intent.ACTION_VIEW, u), "Opened.");
    }

    private JSONObject navigate(String destination, String mode) {
        if (destination == null || destination.trim().isEmpty()) return Result.error("Navigate where?");
        String m = mode == null ? "drive" : mode;
        if (!m.equals("transit")) {
            String code = m.equals("walk") ? "w" : m.equals("bike") ? "b" : "d";
            Intent nav = new Intent(Intent.ACTION_VIEW,
                Uri.parse("google.navigation:q=" + Uri.encode(destination) + "&mode=" + code));
            if (nav.resolveActivity(ctx.getPackageManager()) != null) {
                return launch(nav, "Navigation to " + destination + " started.");
            }
        }
        String travel = m.equals("walk") ? "walking" : m.equals("bike") ? "bicycling" : m.equals("transit") ? "transit" : "driving";
        Uri web = Uri.parse("https://www.google.com/maps/dir/?api=1&dir_action=navigate&destination="
            + Uri.encode(destination) + "&travelmode=" + travel);
        return launch(new Intent(Intent.ACTION_VIEW, web), "Directions to " + destination + " opened.");
    }

    private JSONObject setTimer(int seconds, String label) {
        if (seconds <= 0) return Result.error("How long should the timer be?");
        Intent i = new Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        if (!label.isEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        return launch(i, "Timer set.");
    }

    private JSONObject setAlarm(int hour, int minute, String label) {
        Intent i = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        if (!label.isEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        return launch(i, String.format(Locale.ROOT, "Alarm set for %02d:%02d.", hour, minute));
    }

    // ------------------------------------------------------------- the phone itself

    private JSONObject flashlight(boolean on) throws Exception {
        CameraManager cm = ctx.getSystemService(CameraManager.class);
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics c = cm.getCameraCharacteristics(id);
            Boolean flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (Boolean.TRUE.equals(flash) && facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                cm.setTorchMode(id, on);
                return Result.text(on ? "Torch on." : "Torch off.");
            }
        }
        return Result.error("This phone has no torch JARVIS can use.");
    }

    private JSONObject volume(double level, String stream) {
        int s = stream.equals("ring") ? AudioManager.STREAM_RING
            : stream.equals("alarm") ? AudioManager.STREAM_ALARM : AudioManager.STREAM_MUSIC;
        AudioManager am = ctx.getSystemService(AudioManager.class);
        int max = am.getStreamMaxVolume(s);
        int v = (int) Math.round(Math.max(0, Math.min(100, level)) / 100.0 * max);
        try {
            am.setStreamVolume(s, v, 0);
        } catch (SecurityException e) {
            return Result.error("The phone is in Do Not Disturb, which blocks changing that volume.");
        }
        return Result.text(stream + " volume set to " + Math.round(level) + "%.");
    }

    // ------------------------------------------------------------- leaving the phone

    /** A contact name or a number → a number, or null. */
    private String resolveNumber(String to) {
        if (to == null) return null;
        String digits = to.replaceAll("[^0-9+]", "");
        if (digits.length() >= 3 && digits.length() >= to.replaceAll("\\s", "").length() - 4) return digits;
        if (!granted(Manifest.permission.READ_CONTACTS)) return null;
        ContentResolver cr = ctx.getContentResolver();
        try (Cursor c = cr.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            new String[] {ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
            new String[] {"%" + to.trim() + "%"},
            ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY + " DESC")) {
            if (c != null && c.moveToFirst()) return c.getString(1);
        }
        return null;
    }

    private JSONObject call(String to) {
        String number = resolveNumber(to);
        if (number == null) return Result.error("I could not find a number for " + to + " in the phone's contacts.");
        String who = number.equals(to) ? number : to + " (" + number + ")";
        return Confirm.ask(ctx, "Jarvis quer ligar", "Ligar para " + who + "?", fg -> {
            Intent i = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            fg.startActivity(i);
            return Result.text("Calling " + who + ".");
        }, CONFIRM_MS);
    }

    private JSONObject sms(String to, String message) {
        if (message == null || message.isEmpty()) return Result.error("What should the message say?");
        String number = resolveNumber(to);
        if (number == null) return Result.error("I could not find a number for " + to + " in the phone's contacts.");
        String who = number.equals(to) ? number : to + " (" + number + ")";
        return Confirm.ask(ctx, "Jarvis quer mandar um SMS", "Para " + who + ":\n\n" + message, fg -> {
            SmsManager sm = Build.VERSION.SDK_INT >= 31 ? fg.getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sm.divideMessage(message);
            sm.sendMultipartTextMessage(number, null, parts, null, null);
            return Result.text("Text sent to " + who + ".");
        }, CONFIRM_MS);
    }

    private JSONObject replyNotification(String id, String message) {
        JarvisNotificationListener l = JarvisNotificationListener.instance;
        if (l == null) return Result.error("Notification access is off on the phone.");
        StatusBarNotification sbn = l.find(id);
        if (sbn == null) return Result.error("That notification is gone. Read the notifications again.");
        String app = JarvisNotificationListener.appLabel(ctx.getPackageManager(), sbn.getPackageName());
        CharSequence title = sbn.getNotification().extras.getCharSequence(android.app.Notification.EXTRA_TITLE);
        String where = app + (title != null ? " — " + title : "");
        return Confirm.ask(ctx, "Jarvis quer responder", where + ":\n\n" + message,
            fg -> JarvisNotificationListener.reply(fg, sbn, message), CONFIRM_MS);
    }

    // ------------------------------------------------------------- helpers

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Lower-case, accents off: "Câmera" finds "camera". */
    private static String fold(String s) {
        return Normalizer.normalize(s.trim(), Normalizer.Form.NFD)
            .replaceAll("\\p{M}", "")
            .toLowerCase(Locale.ROOT);
    }

    static boolean notificationsEnabled(Context c) {
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    static JSONArray capabilities() {
        return new JSONArray(java.util.Arrays.asList(CAPABILITIES));
    }
}
