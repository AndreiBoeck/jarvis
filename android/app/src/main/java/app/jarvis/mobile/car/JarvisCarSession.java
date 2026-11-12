package app.jarvis.mobile.car;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import app.jarvis.mobile.LinkPrefs;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * One visit of JARVIS to the car screen: the voice loop.
 *
 *   idle      — "Hey Jarvis" is listened for, if switched on.
 *   listening — he has been called (the button, or his name): the next
 *               sentence is the question.
 *   thinking  — the question is with JARVIS at home.
 *   speaking  — the answer, out of the car's speakers. Then a few seconds of
 *               listening for a follow-up, as at home.
 *
 * The microphone is only open while the JARVIS screen is in front on the car
 * display (the session is STARTED). Switch to Maps or music and he stops
 * listening: Android Auto shows a microphone indicator for as long as it is
 * open, and it should never be open behind the user's back.
 */
public class JarvisCarSession extends Session implements DefaultLifecycleObserver, CarListener.Events {

    enum State { IDLE, LISTENING, THINKING, SPEAKING }

    /** His name, and the usual ways a transcriber mishears it. */
    private static final Pattern WAKE =
        Pattern.compile("\\b(?:hey|hi|ok|okay|ei|oi)?[ ,]*(jarvis|jarvys|jervis|javis|travis|charvis)\\b[ ,.!?]*", Pattern.CASE_INSENSITIVE);

    private static final long COMMAND_WAIT_MS = 7_000;
    private static final long FOLLOW_UP_MS = 5_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build();
    private final CarListener mic = new CarListener(this);
    private CarVoice voice;
    private JarvisCarScreen screen;
    private AudioFocusRequest recordFocus;

    State state = State.IDLE;
    String status = "";
    String lastAnswer = "";
    String lastQuestion = "";

    @NonNull
    @Override
    public Screen onCreateScreen(@NonNull Intent intent) {
        voice = new CarVoice(getCarContext());
        recordFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .build();
        screen = new JarvisCarScreen(getCarContext(), this);
        getLifecycle().addObserver(this);

        // Alerts from JARVIS's watches, spoken in the car while it is open.
        CarConversation.get(getCarContext()).setAlertListener(message -> {
            CarMessages.fromJarvis(getCarContext(), message, false);
            if (state == State.IDLE) speak(message, false);
        });

        // The message conversation (option 2) needs one message to reply to.
        if (CarMessages.empty()) {
            CarMessages.fromJarvis(getCarContext(), "At your service. Reply to this message to talk to me.", false);
        }
        return screen;
    }

    // ------------------------------------------------------------- lifecycle

    @Override
    public void onStart(@NonNull LifecycleOwner owner) {
        openMic();
    }

    @Override
    public void onStop(@NonNull LifecycleOwner owner) {
        mic.stop();
        voice.stop();
        releaseFocus();
        set(State.IDLE, "");
    }

    @Override
    public void onDestroy(@NonNull LifecycleOwner owner) {
        mic.stop();
        if (voice != null) voice.shutdown();
        CarConversation.get(getCarContext()).setAlertListener(null);
    }

    private void openMic() {
        Context c = getCarContext();
        if (!CarConversation.get(c).paired()) {
            set(State.IDLE, "Abra o app Jarvis no celular e pareie com o PC.");
            return;
        }
        if (ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            set(State.IDLE, "Falta a permissão de microfone (app Jarvis → engrenagem).");
            return;
        }
        if (!mic.running()) {
            try {
                mic.start(getCarContext());
            } catch (Exception e) {
                set(State.IDLE, "Não consegui abrir o microfone do carro.");
                return;
            }
        }
        idle();
    }

    // ------------------------------------------------------------- actions from the screen

    /** The big button: talk now, or cut him off and talk. */
    void talk() {
        voice.stop();
        if (!mic.running()) openMic();
        if (!mic.running()) return;
        listen(COMMAND_WAIT_MS);
        beep();
    }

    void setWake(boolean on) {
        LinkPrefs.setCarWake(getCarContext(), on);
        if (state == State.IDLE) idle();
        screen.invalidate();
    }

    boolean wakeOn() {
        return LinkPrefs.carWake(getCarContext());
    }

    void repeat() {
        if (!lastAnswer.isEmpty()) speak(lastAnswer, false);
    }

    // ------------------------------------------------------------- the loop

    private void idle() {
        releaseFocus();
        mic.setMode(wakeOn() ? CarListener.WAKE : CarListener.OFF, 0);
        set(State.IDLE, wakeOn() ? "Diga \"Hey Jarvis\" ou toque em Falar" : "Toque em Falar");
    }

    private void listen(long waitMs) {
        // Exclusive focus pauses the music, so the question is not sung over.
        getCarContext().getSystemService(AudioManager.class).requestAudioFocus(recordFocus);
        mic.setMode(CarListener.COMMAND, waitMs);
        set(State.LISTENING, "Ouvindo…");
    }

    @Override
    public void onSpeechStart() {
        set(State.LISTENING, "Ouvindo…");
    }

    @Override
    public void onSilence() {
        idle();
    }

    @Override
    public void onMicClosed() {
        set(State.IDLE, "Microfone fechado. Toque em Falar para reabrir.");
    }

    @Override
    public void onUtterance(byte[] pcm, boolean wake) {
        if (wake && state != State.IDLE) return;
        if (!wake) set(State.THINKING, "Entendendo…");
        transcribe(pcm, text -> {
            if (wake) {
                if (state != State.IDLE) return;
                Matcher m = WAKE.matcher(text);
                if (!m.find()) return;
                String rest = text.substring(m.end()).trim();
                // "Jarvis, what's the weather" in one breath is one turn.
                if (rest.length() > 3) ask(rest);
                else talk();
                return;
            }
            if (text.isEmpty()) {
                speak("Sorry, I didn't catch that.", false);
                return;
            }
            ask(text);
        });
    }

    private void ask(String question) {
        mic.setMode(CarListener.OFF, 0);
        lastQuestion = question;
        set(State.THINKING, "Pensando…");
        CarMessages.fromUser(getCarContext(), question);
        CarConversation.get(getCarContext()).ask(question, new CarConversation.Listener() {
            @Override
            public void onAnswer(String answer) {
                String said = answer.isEmpty() ? "Done." : answer;
                lastAnswer = said;
                CarMessages.fromJarvis(getCarContext(), said, false);
                speak(said, true);
            }

            @Override
            public void onError(String message) {
                speak("I can't reach home right now. Is the PC on, with the bridge running?", false);
            }
        });
    }

    private void speak(String text, boolean followUp) {
        mic.setMode(CarListener.OFF, 0); // he must not hear himself
        set(State.SPEAKING, text);
        voice.say(text, () -> {
            if (state != State.SPEAKING) return;
            if (followUp) listen(FOLLOW_UP_MS);
            else idle();
        });
    }

    // ------------------------------------------------------------- plumbing

    private interface Heard {
        void on(String text);
    }

    /** The utterance to the bridge's transcriber; text back on the main thread. */
    private void transcribe(byte[] pcm, Heard heard) {
        Context c = getCarContext();
        Request req = new Request.Builder()
            .url(LinkPrefs.httpBase(c) + "/stt")
            .header("Authorization", "Bearer " + LinkPrefs.token(c))
            .post(RequestBody.create(CarListener.wav(pcm), MediaType.get("audio/wav")))
            .build();
        http.newCall(req).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, java.io.IOException e) {
                main.post(() -> {
                    if (state == State.THINKING) speak("I can't reach home right now.", false);
                });
            }

            @Override
            public void onResponse(Call call, Response res) {
                String text = "";
                try (Response r = res) {
                    if (r.isSuccessful() && r.body() != null) {
                        text = new JSONObject(r.body().string()).optString("text", "").trim();
                    }
                } catch (Exception ignored) {
                    // treated as nothing heard
                }
                String t = text;
                main.post(() -> heard.on(t));
            }
        });
    }

    private void beep() {
        try {
            new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60).startTone(ToneGenerator.TONE_PROP_BEEP, 120);
        } catch (Exception ignored) {
            // a missing beep is not worth failing over
        }
    }

    private void releaseFocus() {
        if (recordFocus != null) {
            getCarContext().getSystemService(AudioManager.class).abandonAudioFocusRequest(recordFocus);
        }
    }

    private void set(State s, String text) {
        state = s;
        status = text;
        if (screen != null) screen.invalidate();
    }
}
