package app.jarvis.mobile.car;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.Header;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.ListTemplate;
import androidx.car.app.model.Row;
import androidx.car.app.model.Template;
import androidx.car.app.model.Toggle;
import androidx.core.graphics.drawable.IconCompat;
import app.jarvis.mobile.R;

/**
 * What the car display shows: a list, because that is what a driver can read
 * at a glance and what Android Auto lets an app draw.
 *
 *   Falar com o Jarvis   — tap to talk (or to cut him off and talk)
 *   Hey Jarvis           — the wake word on or off
 *   the last answer      — tap to hear it again
 */
public class JarvisCarScreen extends Screen {

    private final JarvisCarSession session;

    JarvisCarScreen(@NonNull CarContext ctx, JarvisCarSession session) {
        super(ctx);
        this.session = session;
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        CarIcon mic = new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), R.drawable.ic_car_mic)).build();

        String title;
        switch (session.state) {
            case LISTENING: title = "Jarvis · ouvindo"; break;
            case THINKING: title = "Jarvis · pensando"; break;
            case SPEAKING: title = "Jarvis · falando"; break;
            default: title = "Jarvis";
        }

        ItemList.Builder list = new ItemList.Builder();
        Row.Builder talk = new Row.Builder()
            .setTitle("Falar com o Jarvis")
            .setImage(mic)
            .setOnClickListener(session::talk);
        if (!session.status.isEmpty()) talk.addText(clip(session.status));
        list.addItem(talk.build());
        list.addItem(new Row.Builder()
            .setTitle("Hey Jarvis")
            .addText(session.wakeOn() ? "Ouvindo enquanto esta tela está aberta" : "Desligado — use o botão")
            .setToggle(new Toggle.Builder(session::setWake).setChecked(session.wakeOn()).build())
            .build());
        if (!session.lastAnswer.isEmpty()) {
            list.addItem(new Row.Builder()
                .setTitle("Última resposta")
                .addText(clip(session.lastAnswer))
                .setOnClickListener(session::repeat)
                .build());
        }

        return new ListTemplate.Builder()
            .setHeader(new Header.Builder().setTitle(title).setStartHeaderAction(Action.APP_ICON).build())
            .setSingleList(list.build())
            .build();
    }

    private static String clip(String s) {
        return s.length() > 120 ? s.substring(0, 117) + "…" : s;
    }
}
