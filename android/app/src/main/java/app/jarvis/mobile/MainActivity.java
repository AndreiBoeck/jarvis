package app.jarvis.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Whether the interface is on screen. Android lets an app open other
     * screens only while it is in front (or through the accessibility
     * service), so Commands checks this before trying.
     */
    static volatile boolean inFront = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JarvisDevicePlugin.class);
        super.onCreate(savedInstanceState);
        // The link may have been switched on before the last restart.
        DeviceLinkService.sync(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        inFront = true;
    }

    @Override
    public void onPause() {
        inFront = false;
        super.onPause();
    }
}
