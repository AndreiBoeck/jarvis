package app.jarvis.mobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * JARVIS's fingers: reading what is on screen, tapping, swiping, typing.
 *
 * The same reach the old ADB route had, without the cable — and with one thing
 * ADB never had: a fence. While a banking, wallet or authenticator app is in
 * front (see Blocklist), every one of these refuses.
 *
 * Event-driven, so it costs nothing while JARVIS is not using it. It only
 * listens for window changes, to know which app is in front.
 *
 * It also matters for something unrelated: Android lets an app with a running
 * accessibility service start activities from the background. That is how
 * "open Spotify on my phone", said to the PC, opens Spotify with the JARVIS
 * app closed.
 */
public class JarvisAccessibilityService extends AccessibilityService {

    static volatile JarvisAccessibilityService instance;

    /** Package of the app in front, from the last window change. */
    private volatile String foreground = "";

    /** The elements from the last read_screen, so a tap can name one by id. */
    private final List<AccessibilityNodeInfo> lastNodes = new ArrayList<>();

    private static final int MAX_NODES = 250;

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && event.getPackageName() != null) {
            foreground = event.getPackageName().toString();
        }
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    String foregroundPackage() {
        AccessibilityNodeInfo root = appRoot();
        if (root != null && root.getPackageName() != null) return root.getPackageName().toString();
        return foreground;
    }

    /**
     * The root of the app the user is looking at.
     *
     * getRootInActiveWindow() is the obvious call and is null more often than
     * it should be — measured on Android 15, right after an app opens, and
     * for some apps (Settings) for as long as they are up. The window list is
     * the dependable route: the active application window, else the focused
     * one, else any application window. Retried briefly, because a screen
     * that is still animating in has no window yet.
     */
    private AccessibilityNodeInfo appRoot() {
        for (int attempt = 0; attempt < 5; attempt++) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) return root;
            AccessibilityNodeInfo fallback = null;
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                AccessibilityNodeInfo r = w.getRoot();
                if (r == null) continue;
                if (w.isActive() || w.isFocused()) return r;
                if (fallback == null) fallback = r;
            }
            if (fallback != null) return fallback;
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                return null;
            }
        }
        return null;
    }

    /** Null if the app in front may be touched, otherwise the refusal. */
    private JSONObject fence() {
        String pkg = foregroundPackage();
        if (Blocklist.blocked(pkg)) {
            return Result.error("A banking, payment or security app is on the phone screen. JARVIS does not read or touch those; the user has to do this part themselves.");
        }
        return null;
    }

    // -------------------------------------------------------------- reading

    synchronized JSONObject readScreen() throws Exception {
        JSONObject refused = fence();
        if (refused != null) return refused;
        AccessibilityNodeInfo root = appRoot();
        if (root == null) return Result.error("The phone screen could not be read right now (it may be locked or off).");

        lastNodes.clear();
        JSONArray elements = new JSONArray();
        walk(root, elements);

        JSONObject out = new JSONObject();
        out.put("app", root.getPackageName());
        out.put("elements", elements);
        if (elements.length() >= MAX_NODES) out.put("truncated", true);
        return Result.json(out);
    }

    private void walk(AccessibilityNodeInfo node, JSONArray out) throws Exception {
        if (node == null || out.length() >= MAX_NODES) return;
        if (node.isVisibleToUser()) {
            CharSequence text = node.getText();
            CharSequence desc = node.getContentDescription();
            boolean interesting = node.isClickable() || node.isEditable() || node.isCheckable()
                || (text != null && text.length() > 0) || (desc != null && desc.length() > 0);
            if (interesting) {
                Rect b = new Rect();
                node.getBoundsInScreen(b);
                JSONObject e = new JSONObject();
                e.put("id", String.valueOf(lastNodes.size()));
                if (text != null && text.length() > 0) e.put("text", clip(text));
                if (desc != null && desc.length() > 0) e.put("label", clip(desc));
                CharSequence cls = node.getClassName();
                if (cls != null) e.put("role", cls.toString().replaceAll(".*\\.", ""));
                if (node.isClickable()) e.put("clickable", true);
                if (node.isEditable()) e.put("editable", true);
                if (node.isCheckable()) e.put("checked", node.isChecked());
                if (node.isFocused()) e.put("focused", true);
                e.put("bounds", new JSONArray(new int[] {b.left, b.top, b.right, b.bottom}));
                out.put(e);
                lastNodes.add(node);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), out);
    }

    private static String clip(CharSequence s) {
        String t = s.toString();
        return t.length() > 300 ? t.substring(0, 300) + "…" : t;
    }

    JSONObject screenshot() throws Exception {
        JSONObject refused = fence();
        if (refused != null) return refused;
        if (Build.VERSION.SDK_INT < 30) return Result.error("Screenshots need Android 11 or newer on the phone.");

        CompletableFuture<Bitmap> shot = new CompletableFuture<>();
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult r) {
                Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                shot.complete(hw == null ? null : hw.copy(Bitmap.Config.ARGB_8888, false));
                r.getHardwareBuffer().close();
            }

            @Override
            public void onFailure(int code) {
                shot.completeExceptionally(new Exception("the phone refused the screenshot (" + code + ")"));
            }
        });
        Bitmap bmp = shot.get(5, TimeUnit.SECONDS);
        if (bmp == null) return Result.error("The screenshot came back empty.");

        // A full-resolution phone screenshot is several megabytes of tokens for
        // the model; 720 wide is plenty to read every word on it.
        int w = Math.min(720, bmp.getWidth());
        int h = Math.round(bmp.getHeight() * (w / (float) bmp.getWidth()));
        Bitmap small = Bitmap.createScaledBitmap(bmp, w, h, true);
        ByteArrayOutputStream jpg = new ByteArrayOutputStream();
        small.compress(Bitmap.CompressFormat.JPEG, 70, jpg);
        return Result.image(Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP), "image/jpeg");
    }

    // -------------------------------------------------------------- acting

    synchronized JSONObject tap(String element, Double x, Double y) throws Exception {
        JSONObject refused = fence();
        if (refused != null) return refused;
        if (element != null && !element.isEmpty()) {
            int i;
            try {
                i = Integer.parseInt(element);
            } catch (NumberFormatException e) {
                return Result.error("Element ids are numbers from read_screen.");
            }
            if (i < 0 || i >= lastNodes.size()) return Result.error("That element is gone — read the screen again.");
            AccessibilityNodeInfo node = lastNodes.get(i);
            for (AccessibilityNodeInfo n = node; n != null; n = n.getParent()) {
                if (n.isClickable() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    return Result.text("Tapped.");
                }
            }
            Rect b = new Rect();
            node.getBoundsInScreen(b);
            return gestureTap(b.exactCenterX(), b.exactCenterY());
        }
        if (x == null || y == null) return Result.error("Give an element id from read_screen, or x and y.");
        return gestureTap(x.floatValue(), y.floatValue());
    }

    private JSONObject gestureTap(float x, float y) throws Exception {
        Path p = new Path();
        p.moveTo(x, y);
        return gesture(p, 60) ? Result.text("Tapped.") : Result.error("The tap did not go through.");
    }

    JSONObject swipe(String direction, double distance) throws Exception {
        JSONObject refused = fence();
        if (refused != null) return refused;
        DisplayMetrics m = getResources().getDisplayMetrics();
        float cx = m.widthPixels / 2f, cy = m.heightPixels / 2f;
        float dx = 0, dy = 0;
        float d = (float) Math.max(0.1, Math.min(1.0, distance));
        switch (direction) {
            case "up": dy = -m.heightPixels * d / 2; break;
            case "down": dy = m.heightPixels * d / 2; break;
            case "left": dx = -m.widthPixels * d / 2; break;
            case "right": dx = m.widthPixels * d / 2; break;
            default: return Result.error("Direction must be up, down, left or right.");
        }
        Path p = new Path();
        p.moveTo(cx - dx / 2, cy - dy / 2);
        p.lineTo(cx + dx / 2, cy + dy / 2);
        return gesture(p, 300) ? Result.text("Swiped " + direction + ".") : Result.error("The swipe did not go through.");
    }

    private boolean gesture(Path path, long ms) throws Exception {
        GestureDescription g = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, ms))
            .build();
        CompletableFuture<Boolean> done = new CompletableFuture<>();
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gd) {
                done.complete(true);
            }

            @Override
            public void onCancelled(GestureDescription gd) {
                done.complete(false);
            }
        }, null);
        return sent && done.get(3, TimeUnit.SECONDS);
    }

    JSONObject typeText(String text, boolean submit) throws Exception {
        JSONObject refused = fence();
        if (refused != null) return refused;
        AccessibilityNodeInfo field = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null || !field.isEditable()) {
            return Result.error("No text field is selected on the phone. Tap one first.");
        }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            return Result.error("That field would not take the text.");
        }
        if (submit && Build.VERSION.SDK_INT >= 30) {
            field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return Result.text(submit ? "Typed and submitted." : "Typed.");
    }

    JSONObject pressKey(String key) {
        int action;
        switch (key) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "lock":
                if (Build.VERSION.SDK_INT < 28) return Result.error("Locking needs Android 9 or newer.");
                action = GLOBAL_ACTION_LOCK_SCREEN;
                break;
            default: return Result.error("Unknown key " + key + ".");
        }
        return performGlobalAction(action) ? Result.text("Pressed " + key + ".") : Result.error("The phone ignored that key.");
    }
}
