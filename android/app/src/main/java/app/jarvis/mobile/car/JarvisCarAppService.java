package app.jarvis.mobile.car;

import android.content.pm.ApplicationInfo;
import androidx.car.app.CarAppService;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/**
 * JARVIS in Android Auto. Declared in the manifest under the POI category:
 * IoT would describe it better, but Android Auto treats IoT as a beta
 * category and, with beta features off, ignored this screen entirely.
 */
public class JarvisCarAppService extends CarAppService {

    @Override
    public HostValidator createHostValidator() {
        // A debug build (the one installed by `npm run app`) is also run on
        // the Desktop Head Unit for testing, which the allowlist does not name.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
        }
        return new HostValidator.Builder(getApplicationContext())
            .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
            .build();
    }

    @Override
    public Session onCreateSession() {
        return new JarvisCarSession();
    }
}
