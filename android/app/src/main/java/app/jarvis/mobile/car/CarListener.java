package app.jarvis.mobile.car;

import android.os.Handler;
import android.os.Looper;
import androidx.car.app.CarContext;
import androidx.car.app.media.CarAudioRecord;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;

/**
 * The car's microphone, cut into utterances.
 *
 * Android Auto hands a car app raw 16 kHz, 16-bit mono audio from the car's
 * own microphone (CarAudioRecord). There is no recogniser in that path, so
 * this does the one thing the bridge's transcriber cannot: decide where
 * speech starts and stops. A plain energy gate with a noise floor that
 * follows the cabin — engine, road, fan — is enough for a voice a foot from
 * the microphone.
 *
 * Two modes, set by the session:
 *   WAKE    — listening for "Hey Jarvis". Only short bursts are kept: a wake
 *             phrase is a second or two, and anything long (music, a radio
 *             presenter, a passenger's story) is dropped before it costs a
 *             transcription.
 *   COMMAND — he has been called; keep the whole sentence, up to 15 seconds.
 */
final class CarListener {

    interface Events {
        /** A finished utterance, as PCM, and the mode it was heard in. */
        void onUtterance(byte[] pcm, boolean wake);

        /** Someone started talking (COMMAND mode only). */
        void onSpeechStart();

        /** COMMAND mode waited and nobody spoke. */
        void onSilence();

        /** The microphone is gone: the user closed it on the car screen, or the car stopped it. */
        void onMicClosed();
    }

    static final int OFF = 0, WAKE = 1, COMMAND = 2;

    static final int RATE = CarAudioRecord.AUDIO_CONTENT_SAMPLING_RATE; // 16000
    private static final int FRAME = CarAudioRecord.AUDIO_CONTENT_BUFFER_SIZE; // 512 bytes = 16 ms
    private static final int BYTES_PER_SEC = RATE * 2;
    private static final int START_FRAMES = 3; // ~50 ms above the gate to count as speech
    private static final int END_FRAMES = 50; // ~800 ms of quiet ends an utterance
    private static final int PREROLL_FRAMES = 20; // ~320 ms kept from before the start
    private static final int WAKE_MAX = 4 * BYTES_PER_SEC;
    private static final int COMMAND_MAX = 15 * BYTES_PER_SEC;

    private final Events events;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile int mode = OFF;
    private volatile long deadline = 0;
    private volatile boolean running = false;
    private Thread thread;

    CarListener(Events events) {
        this.events = events;
    }

    /** Open the car microphone. Must be called while the JARVIS screen is in front. */
    void start(CarContext cc) {
        if (running) return;
        CarAudioRecord rec = CarAudioRecord.create(cc);
        rec.startRecording();
        running = true;
        thread = new Thread(() -> loop(rec), "jarvis-car-mic");
        thread.start();
    }

    void stop() {
        running = false;
        mode = OFF;
    }

    boolean running() {
        return running;
    }

    /** Switch mode; for COMMAND, how long to wait for speech before giving up. */
    void setMode(int m, long waitMs) {
        deadline = m == COMMAND ? System.currentTimeMillis() + waitMs : 0;
        mode = m;
    }

    private void loop(CarAudioRecord rec) {
        byte[] buf = new byte[FRAME];
        ArrayDeque<byte[]> preroll = new ArrayDeque<>();
        ByteArrayOutputStream utterance = new ByteArrayOutputStream();
        boolean speaking = false;
        int loud = 0, quiet = 0;
        double noise = 300;
        int lastMode = OFF;

        try {
            while (running) {
                int n = rec.read(buf, 0, FRAME);
                if (n < 0) {
                    main.post(events::onMicClosed);
                    break;
                }
                if (n == 0) continue;

                int m = mode;
                if (m != lastMode) {
                    // A mode change abandons whatever was half-heard.
                    speaking = false;
                    loud = 0;
                    utterance.reset();
                    lastMode = m;
                }
                if (m == OFF) continue;

                double rms = rms(buf, n);
                double gate = Math.max(noise * 3.0, 600);

                if (!speaking) {
                    preroll.addLast(java.util.Arrays.copyOf(buf, n));
                    if (preroll.size() > PREROLL_FRAMES) preroll.removeFirst();
                    if (rms > gate) {
                        loud++;
                    } else {
                        loud = 0;
                        noise = noise * 0.95 + rms * 0.05;
                    }
                    if (loud >= START_FRAMES) {
                        speaking = true;
                        quiet = 0;
                        utterance.reset();
                        for (byte[] f : preroll) utterance.write(f, 0, f.length);
                        preroll.clear();
                        if (m == COMMAND) main.post(events::onSpeechStart);
                    } else if (m == COMMAND && deadline > 0 && System.currentTimeMillis() > deadline) {
                        deadline = 0;
                        mode = OFF;
                        main.post(events::onSilence);
                    }
                } else {
                    utterance.write(buf, 0, n);
                    quiet = rms < gate ? quiet + 1 : 0;
                    int max = m == WAKE ? WAKE_MAX : COMMAND_MAX;
                    boolean tooLong = utterance.size() >= max;
                    if (quiet >= END_FRAMES || tooLong) {
                        speaking = false;
                        loud = 0;
                        // A long burst in WAKE mode is not someone saying his name.
                        if (!(m == WAKE && tooLong)) {
                            byte[] pcm = utterance.toByteArray();
                            boolean wake = m == WAKE;
                            if (m == COMMAND) mode = OFF; // one sentence per command
                            main.post(() -> events.onUtterance(pcm, wake));
                        }
                        utterance.reset();
                    }
                }
            }
        } catch (Exception e) {
            main.post(events::onMicClosed);
        } finally {
            running = false;
            try {
                rec.stopRecording();
            } catch (Exception ignored) {
                // already stopped
            }
        }
    }

    /** Root-mean-square of little-endian 16-bit samples. */
    private static double rms(byte[] b, int n) {
        long sum = 0;
        int samples = n / 2;
        for (int i = 0; i + 1 < n; i += 2) {
            int s = (short) ((b[i] & 0xff) | (b[i + 1] << 8));
            sum += (long) s * s;
        }
        return samples == 0 ? 0 : Math.sqrt(sum / (double) samples);
    }

    /** Wrap PCM in a WAV header so the bridge's transcriber knows what it is. */
    static byte[] wav(byte[] pcm) {
        int len = pcm.length;
        byte[] out = new byte[44 + len];
        java.nio.ByteBuffer h = java.nio.ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + len).put("WAVE".getBytes());
        h.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
            .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        h.put("data".getBytes()).putInt(len);
        System.arraycopy(pcm, 0, out, 44, len);
        return out;
    }
}
