package app.jarvis.mobile.car;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import app.jarvis.mobile.LinkPrefs;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * JARVIS's voice in the car: the same ElevenLabs voice as at home, fetched
 * from the bridge's /tts, played as an assistant so it comes out of the car's
 * speakers and ducks the music. If the bridge cannot speak, Android's own
 * voice says it instead — a plainer voice beats silence at the wheel.
 */
final class CarVoice {

    private static final AudioAttributes SPEECH = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();

    private final Context ctx;
    private final OkHttpClient client = new OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final AudioFocusRequest focus;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private MediaPlayer player;
    /** Bumped by every say() and stop(), so a late download never plays over a newer line. */
    private int generation = 0;

    CarVoice(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        audio = this.ctx.getSystemService(AudioManager.class);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(SPEECH)
            .build();
        tts = new TextToSpeech(this.ctx, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) tts.setLanguage(Locale.US); // JARVIS speaks English
        });
    }

    /** Speak, then run done on the main thread (also if it fails or is stopped). */
    void say(String text, Runnable done) {
        stop();
        final int gen = generation;
        try {
            Request req = new Request.Builder()
                .url(LinkPrefs.httpBase(ctx) + "/tts")
                .header("Authorization", "Bearer " + LinkPrefs.token(ctx))
                .post(RequestBody.create(
                    new JSONObject().put("text", text).toString(),
                    MediaType.get("application/json")))
                .build();
            client.newCall(req).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, java.io.IOException e) {
                    main.post(() -> fallback(text, gen, done));
                }

                @Override
                public void onResponse(Call call, Response res) {
                    try (Response r = res) {
                        if (!r.isSuccessful() || r.body() == null) {
                            main.post(() -> fallback(text, gen, done));
                            return;
                        }
                        File f = new File(ctx.getCacheDir(), "car-say-" + gen + ".mp3");
                        try (FileOutputStream out = new FileOutputStream(f)) {
                            out.write(r.body().bytes());
                        }
                        main.post(() -> play(f, text, gen, done));
                    } catch (Exception e) {
                        main.post(() -> fallback(text, gen, done));
                    }
                }
            });
        } catch (Exception e) {
            fallback(text, gen, done);
        }
    }

    private void play(File f, String text, int gen, Runnable done) {
        if (gen != generation) {
            f.delete();
            return;
        }
        try {
            MediaPlayer mp = new MediaPlayer();
            player = mp;
            mp.setAudioAttributes(SPEECH);
            mp.setDataSource(f.getAbsolutePath());
            mp.setOnCompletionListener(p -> finish(gen, f, done));
            mp.setOnErrorListener((p, what, extra) -> {
                finish(gen, f, null);
                fallback(text, gen, done);
                return true;
            });
            mp.prepare();
            audio.requestAudioFocus(focus);
            mp.start();
        } catch (Exception e) {
            finish(gen, f, null);
            fallback(text, gen, done);
        }
    }

    private void finish(int gen, File f, Runnable done) {
        if (player != null) {
            player.release();
            player = null;
        }
        if (f != null) f.delete();
        audio.abandonAudioFocusRequest(focus);
        if (done != null && gen == generation) done.run();
    }

    private void fallback(String text, int gen, Runnable done) {
        if (gen != generation) return;
        if (!ttsReady) {
            done.run();
            return;
        }
        audio.requestAudioFocus(focus);
        tts.setAudioAttributes(SPEECH);
        String id = "car" + gen;
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String u) {}

            @Override
            public void onDone(String u) {
                main.post(() -> {
                    audio.abandonAudioFocusRequest(focus);
                    if (gen == generation) done.run();
                });
            }

            @Override
            public void onError(String u) {
                onDone(u);
            }
        });
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
    }

    void stop() {
        generation++;
        if (player != null) {
            try {
                player.stop();
            } catch (Exception ignored) {
                // not started yet
            }
            player.release();
            player = null;
        }
        if (tts != null) tts.stop();
        audio.abandonAudioFocusRequest(focus);
    }

    void shutdown() {
        stop();
        if (tts != null) tts.shutdown();
        tts = null;
    }
}
