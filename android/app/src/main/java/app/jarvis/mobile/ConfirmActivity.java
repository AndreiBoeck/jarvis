package app.jarvis.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * The invisible activity behind "Permitir", and the dialog behind tapping the
 * confirmation itself. See Confirm for why this is an activity.
 */
public class ConfirmActivity extends Activity {

    static Intent intent(Context ctx, String id, String decision) {
        return new Intent(ctx, ConfirmActivity.class)
            .putExtra("id", id)
            .putExtra("decision", decision)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String id = getIntent().getStringExtra("id");
        String decision = getIntent().getStringExtra("decision");

        if ("allow".equals(decision)) {
            Confirm.decide(this, id, true);
            finish();
            return;
        }

        Confirm.Pending p = id == null ? null : Confirm.pending.get(id);
        if (p == null) {
            finish();
            return;
        }
        // Backing out of the dialog without choosing is a no, not a maybe.
        final boolean[] decided = {false};
        new AlertDialog.Builder(this)
            .setTitle(p.title)
            .setMessage(p.text)
            .setPositiveButton("Permitir", (d, w) -> {
                decided[0] = true;
                Confirm.decide(this, id, true);
            })
            .setNegativeButton("Negar", (d, w) -> {
                decided[0] = true;
                Confirm.decide(this, id, false);
            })
            .setOnDismissListener(d -> {
                if (!decided[0]) Confirm.decide(this, id, false);
                finish();
            })
            .show();
    }
}
