/*
 * The Airflow OS sound scheme.
 *
 * Every sound is synthesised with Web Audio oscillators rather than shipped as a
 * .wav: the bundle is dynamically imported by the host UI, so adding a megabyte of
 * base64 audio to it would be rude, and these are simple enough to build from
 * envelopes and partials. It also means the scheme is theme-able in code - change a
 * frequency table, not a binary.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so the context is
 * created lazily and `unlock()` is called from the first pointer or key event. The
 * startup chime plays at that moment rather than on mount, which is why the desktop
 * greets you on your first click rather than silently missing its own entrance.
 */

export type SoundName =
  | "asterisk"
  | "boot"
  | "chord"
  | "ding"
  | "exclamation"
  | "modem"
  | "question"
  | "logon"
  | "shutdown"
  | "tada";

const STORAGE_KEY = "airflow-os:sound";
const MASTER_GAIN = 0.32;

interface ToneOptions {
  /** Seconds from now. */
  at?: number;
  attack?: number;
  detune?: number;
  duration?: number;
  gain?: number;
  /** Adds a quieter partial at this multiple of the fundamental, for a bell timbre. */
  partial?: number;
  release?: number;
  type?: OscillatorType;
}

class SoundScheme {
  private context: AudioContext | undefined;

  private master: GainNode | undefined;

  private started = false;

  private on: boolean = readPreference();

  public get enabled(): boolean {
    return this.on;
  }

  public setEnabled(value: boolean): void {
    this.on = value;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value ? "on" : "off");
    } catch {
      // Private browsing, or site data blocked. The preference just will not persist.
    }
    if (value) this.play("ding");
  }

  /**
   * Start the audio context and play the startup chime, once.
   *
   * Safe to call on mount as well as from a gesture. A document that has already been
   * interacted with - and clicking the nav item to reach Airflow OS counts - gives a
   * context that starts in `running`, so the chime can play over the boot splash
   * rather than waiting for a click the user has no reason to make. Only a cold load
   * (direct URL, restored tab) starts `suspended`, and then the gesture listeners are
   * what get us here.
   */
  public unlock(first: SoundName = "boot"): void {
    const context = this.ensureContext();
    if (!context) return;

    const begin = () => {
      if (this.started) return;
      this.started = true;
      this.play(first);
    };

    if (context.state === "running") {
      begin();
      return;
    }

    // resume() only succeeds where the document has user activation; without it the
    // context stays suspended and this resolves to nothing, which is fine - the
    // pointerdown/keydown listeners will call unlock() again.
    void context
      .resume()
      .then(() => {
        if (context.state === "running") begin();
      })
      .catch(() => {
        // No activation yet. Wait for a gesture.
      });
  }

  /**
   * What the sound system currently is, for the readout in Control Panel -> Sounds.
   *
   * "I can't hear anything" has three quite different causes - the scheme switched
   * off, an AudioContext the browser will not start, or a stale bundle - and guessing
   * between them from the outside wasted a round of debugging. So the desktop says.
   */
  public diagnostics(): { enabled: boolean; contextState: string; startupPlayed: boolean } {
    return {
      contextState: this.context ? this.context.state : this.supported() ? "not created" : "unsupported",
      enabled: this.on,
      startupPlayed: this.started,
    };
  }

  /**
   * True when a sound would be silently swallowed because the browser has not been
   * given user activation yet.
   *
   * A page *load* carries no activation - only navigating within an already-touched
   * document does - so on reload the context comes up suspended and audio is
   * impossible until a gesture. The boot splash uses this to decide whether it can
   * play itself in or has to invite a click first.
   */
  public needsGesture(): boolean {
    if (!this.on) return false;
    const context = this.ensureContext();
    return context === undefined ? false : context.state !== "running";
  }

  private supported(): boolean {
    return Boolean(
      globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: unknown }).webkitAudioContext,
    );
  }

  public play(name: SoundName): void {
    if (!this.on) return;
    const context = this.ensureContext();
    if (!context || context.state !== "running") return;
    VOICES[name](this, context.currentTime);
  }

  /** One oscillator with an ADSR-ish envelope, plus an optional bell partial. */
  public tone(frequency: number, options: ToneOptions = {}): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const {
      at = 0,
      attack = 0.005,
      detune = 0,
      duration = 0.2,
      gain = 0.3,
      partial,
      release = 0.25,
      type = "sine",
    } = options;

    const start = context.currentTime + at;
    const end = start + duration;

    const build = (freq: number, level: number) => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(freq, start);
      oscillator.detune.setValueAtTime(detune, start);

      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), start + attack);
      // Exponential ramps cannot reach zero, so decay to a floor and stop the node.
      envelope.gain.exponentialRampToValueAtTime(0.0001, end + release);

      oscillator.connect(envelope).connect(master);
      oscillator.start(start);
      oscillator.stop(end + release + 0.02);
    };

    build(frequency, gain);
    if (partial !== undefined) build(frequency * partial, gain * 0.32);
  }

  /** Filtered white noise, for the modem handshake. */
  public noise(
    options: { at?: number; duration?: number; frequency?: number; gain?: number; q?: number } = {},
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const { at = 0, duration = 0.2, frequency = 1800, gain = 0.12, q = 1.4 } = options;
    const start = context.currentTime + at;

    const frames = Math.max(Math.floor(context.sampleRate * duration), 1);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) channel[index] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    source.buffer = buffer;

    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(frequency, start);
    filter.Q.setValueAtTime(q, start);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter).connect(envelope).connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    try {
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(this.context.destination);
      return this.context;
    } catch {
      return undefined;
    }
  }
}

function readPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/* Equal-tempered frequencies, so the tables below read as notes. */
const N = {
  A4: 440,
  A5: 880,
  B4: 493.88,
  C4: 261.63,
  C5: 523.25,
  C6: 1046.5,
  D4: 293.66,
  D5: 587.33,
  E5: 659.25,
  F3: 174.61,
  F4: 349.23,
  G3: 196,
  G4: 392,
  G5: 783.99,
};

const VOICES: Record<SoundName, (scheme: SoundScheme, now: number) => void> = {
  /** A short bright bell. Windows called this one Asterisk. */
  asterisk: (s) => {
    s.tone(N.A5, { attack: 0.004, duration: 0.16, gain: 0.22, partial: 2.4, release: 0.3 });
  },

  /**
   * Boot: air, and only air. Four overlapping noise bands sweeping upward with a low
   * breath underneath - the gust that turns the pinwheel while the splash is up.
   */
  boot: (s) => {
    // Wide Q so the bands actually pass energy, and gains several times higher than a
    // tone would need: band-limited noise is perceptually much quieter than a
    // transient at the same amplitude, which is what made the first version inaudible.
    s.noise({ duration: 2.2, frequency: 220, gain: 0.5, q: 0.4 });
    s.noise({ at: 0.15, duration: 2, frequency: 520, gain: 0.42, q: 0.5 });
    s.noise({ at: 0.45, duration: 1.6, frequency: 1100, gain: 0.3, q: 0.6 });
    s.noise({ at: 0.8, duration: 1.2, frequency: 2200, gain: 0.16, q: 0.8 });
    // Low rumble for body, so it feels like moving air rather than hiss.
    s.tone(70, { attack: 0.6, duration: 1.4, gain: 0.14, release: 1, type: "triangle" });
    s.tone(105, { attack: 0.8, duration: 1.2, gain: 0.09, release: 0.9, type: "sine" });
  },

  /** Critical Stop: four notes falling away from you. */
  chord: (s) => {
    [N.D5, N.B4, N.G4, N.D4].forEach((frequency, index) => {
      s.tone(frequency, {
        at: index * 0.11,
        duration: 0.18,
        gain: 0.26,
        partial: 2,
        release: 0.42,
        type: "triangle",
      });
    });
  },

  /** The little acknowledgement tick, used when the scheme is switched on. */
  ding: (s) => {
    s.tone(N.C6, { attack: 0.003, duration: 0.09, gain: 0.16, partial: 2.6, release: 0.16 });
  },

  /** Exclamation: two firm knocks. */
  exclamation: (s) => {
    s.tone(N.A4, { duration: 0.13, gain: 0.24, partial: 2, release: 0.2, type: "triangle" });
    s.tone(N.F4, { at: 0.16, duration: 0.16, gain: 0.24, partial: 2, release: 0.3, type: "triangle" });
  },

  /**
   * Logged in: a switch closing. A bright transient, a lower one just behind it and a
   * short low thunk for weight - the sound of a latch, not a chime, so it lands as
   * "the desktop is yours" rather than as a second fanfare.
   */
  logon: (s) => {
    s.noise({ duration: 0.03, frequency: 3400, gain: 0.2 });
    s.noise({ at: 0.006, duration: 0.05, frequency: 1500, gain: 0.11 });
    s.tone(150, { attack: 0.001, duration: 0.035, gain: 0.17, release: 0.07, type: "triangle" });
    // One quiet tick behind the click, so it reads as an event and not a stray noise.
    s.tone(N.C6, { at: 0.055, attack: 0.002, duration: 0.06, gain: 0.07, partial: 2.6, release: 0.16 });
  },

  /**
   * Dial-up. Three touch tones, then the carrier: two warbling tones over filtered
   * noise. Not a faithful V.34 handshake, but unmistakable.
   */
  modem: (s) => {
    // DTMF is a pair of tones per key; these are 1, 4, 7.
    const dtmf: [number, number][] = [
      [697, 1209],
      [770, 1209],
      [852, 1209],
    ];
    dtmf.forEach(([low, high], index) => {
      const at = index * 0.16;
      s.tone(low, { at, duration: 0.09, gain: 0.14, release: 0.02, type: "sine" });
      s.tone(high, { at, duration: 0.09, gain: 0.14, release: 0.02, type: "sine" });
    });

    s.tone(1070, { at: 0.62, duration: 0.34, gain: 0.13, release: 0.05, type: "sine" });
    s.tone(1270, { at: 0.72, duration: 0.42, gain: 0.13, release: 0.05, type: "sine" });
    s.noise({ at: 0.98, duration: 0.34, frequency: 1900, gain: 0.1 });
    s.noise({ at: 1.3, duration: 0.26, frequency: 2600, gain: 0.08 });
    s.tone(2225, { at: 1.32, duration: 0.3, gain: 0.09, release: 0.12, type: "sine" });
  },

  /** Question: two notes going up, because it is asking. */
  question: (s) => {
    s.tone(N.G4, { duration: 0.12, gain: 0.22, partial: 2, release: 0.18, type: "triangle" });
    s.tone(N.C5, { at: 0.14, duration: 0.18, gain: 0.22, partial: 2, release: 0.3, type: "triangle" });
  },

  /** The lights going out: the startup chord, reversed and falling. */
  shutdown: (s) => {
    [N.C5, N.G4, N.C4].forEach((frequency, index) => {
      s.tone(frequency, {
        at: index * 0.18,
        attack: 0.06,
        duration: 0.5,
        gain: 0.2,
        release: 0.8,
        type: "sine",
      });
    });
    s.tone(N.F3, { at: 0.36, attack: 0.12, duration: 0.7, gain: 0.16, release: 1.1, type: "triangle" });
  },

  /** Ta-da. A run finished, and finished well. */
  tada: (s) => {
    [N.G3, N.C4, N.E5].forEach((frequency, index) => {
      s.tone(frequency, {
        at: index * 0.075,
        duration: 0.1,
        gain: 0.2,
        partial: 2,
        release: 0.12,
        type: "triangle",
      });
    });
    [N.C5, N.E5, N.G5].forEach((frequency) => {
      s.tone(frequency, {
        at: 0.24,
        attack: 0.01,
        duration: 0.42,
        gain: 0.17,
        partial: 2,
        release: 0.7,
        type: "triangle",
      });
    });
  },

};

export const sound = new SoundScheme();

/** Human-readable event list, for the Sounds page of the Control Panel. */
export const SOUND_EVENTS: { description: string; name: SoundName; label: string }[] = [
  { description: "The boot splash is up", label: "Airflow", name: "boot" },
  { description: "The desktop appears", label: "Logon", name: "logon" },
  { description: "You shut the desktop down", label: "Exit Windows", name: "shutdown" },
  { description: "A task instance succeeds", label: "Task complete", name: "tada" },
  { description: "A task instance fails", label: "Critical stop", name: "chord" },
  { description: "A warning dialog opens", label: "Exclamation", name: "exclamation" },
  { description: "An information dialog opens", label: "Asterisk", name: "asterisk" },
  { description: "A confirmation is requested", label: "Question", name: "question" },
  { description: "A dag run is triggered", label: "Dial-up connection", name: "modem" },
  { description: "Clippy has something to say", label: "Menu popup", name: "ding" },
];
