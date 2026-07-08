/* =====================================================================
   Erfgooiers — audio.
   A self-contained Web Audio engine: no asset files, everything is
   synthesised at runtime. It provides a gentle, idyllic pastoral loop
   (soft harp/lute melody over a warm pad, folk I–V–vi–IV progression)
   and a handful of small, period-flavoured sound effects (wooden thud,
   axe on timber, harvest swish, coin, a raised-building chime).

   Browsers require a user gesture before audio may sound, so the context
   is created lazily on the first unlock() call (wired to the first click).
   ===================================================================== */

type SfxName = 'place' | 'build' | 'coin' | 'chop' | 'harvest' | 'demolish' | 'click' | 'error';

const MUTE_KEY = 'erfgooiers.muted';

/** MIDI note → frequency in Hz. */
const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * A musical "mood". Each progression entry is one bar: a bass root plus the
 * melody pool the scheduler draws from for that bar. Higher tiers lean into
 * minor keys, quicken the tempo, thicken the pad and add a soft frame-drum
 * pulse — so the score darkens and tightens as the run gets harder without
 * ever losing its folk, hand-made feel.
 */
interface Mood {
  bpm: number;                                      // tempo
  prog: { bass: number; pool: number[] }[];         // one entry per bar
  rest: number;                                     // chance of a rest on off-beats
  lift: number;                                     // chance of a high-octave ornament
  pad: number;                                      // pad voice level (× base)
  fb: number;                                       // delay feedback (tension/space)
  drum: number;                                     // frame-drum hits per bar (0 = none)
  lead: boolean;                                    // sprinkle leading-tone grace notes
}

// Tier 0 — sunlit C major (I–V–vi–IV): the idyllic opening mood.
const MOOD_MAJOR: Mood = {
  bpm: 96, rest: 0.28, lift: 0.15, pad: 1, fb: 0.16, drum: 0, lead: false,
  prog: [
    { bass: 48, pool: [72, 74, 76, 79, 81] }, // C  — I
    { bass: 43, pool: [71, 74, 76, 79, 83] }, // G  — V
    { bass: 45, pool: [72, 74, 76, 81, 84] }, // Am — vi
    { bass: 41, pool: [72, 74, 77, 81, 84] }, // F  — IV
  ],
};

// Tier 1 — wistful A minor (vi–IV–I–V): the same folk warmth turned pensive.
const MOOD_WISTFUL: Mood = {
  bpm: 100, rest: 0.3, lift: 0.16, pad: 1.1, fb: 0.32, drum: 0, lead: false,
  prog: [
    { bass: 45, pool: [69, 72, 74, 76, 79] }, // Am
    { bass: 41, pool: [69, 72, 74, 77, 81] }, // F
    { bass: 48, pool: [72, 74, 76, 79, 81] }, // C
    { bass: 43, pool: [71, 74, 76, 79, 83] }, // G
  ],
};

// Tier 2 — a D-minor lament (i–VI–III–VII): darker, with a low drum on the beat.
const MOOD_MINOR: Mood = {
  bpm: 108, rest: 0.24, lift: 0.18, pad: 1.15, fb: 0.36, drum: 2, lead: false,
  prog: [
    { bass: 38, pool: [74, 77, 79, 81, 84] }, // Dm
    { bass: 46, pool: [74, 77, 79, 82, 86] }, // Bb
    { bass: 41, pool: [72, 74, 77, 81, 84] }, // F
    { bass: 48, pool: [72, 76, 79, 81, 84] }, // C
  ],
};

// Tier 3 — an urgent E harmonic minor (i–VI–iv–V) with a raised leading tone;
// quicker, driving, tense. Reserved for the run's final, hardest stretch.
const MOOD_URGENT: Mood = {
  bpm: 116, rest: 0.2, lift: 0.2, pad: 1.2, fb: 0.42, drum: 4, lead: true,
  prog: [
    { bass: 40, pool: [76, 79, 81, 83, 86] }, // Em
    { bass: 48, pool: [72, 76, 79, 84, 88] }, // C
    { bass: 45, pool: [76, 81, 84, 86, 88] }, // Am
    { bass: 47, pool: [75, 78, 83, 86, 87] }, // B (D# leading tone)
  ],
};

const MOODS: Mood[] = [MOOD_MAJOR, MOOD_WISTFUL, MOOD_MINOR, MOOD_URGENT];

/** Map a 1-based level within a run to a mood tier. */
function moodForLevel(level: number): Mood {
  if (level <= 3) return MOOD_MAJOR;
  if (level <= 5) return MOOD_WISTFUL;
  if (level <= 8) return MOOD_MINOR;
  return MOOD_URGENT;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private sfx!: GainNode;
  private delay!: DelayNode;
  private fbGain!: GainNode;
  private noise!: AudioBuffer;

  private muted = false;
  private timer = 0;
  private nextNote = 0;   // ctx time of the next scheduled melody step
  private step = 0;       // running eighth-note counter

  private mood: Mood = MOOD_MAJOR;        // mood the current bar is playing in
  private pendingMood: Mood = MOOD_MAJOR; // mood to switch to at the next bar

  constructor() {
    this.muted = localStorage.getItem(MUTE_KEY) === '1';
  }

  get isMuted(): boolean { return this.muted; }

  /**
   * Shift the score to match a run's difficulty. The change is queued and lands
   * on the next bar boundary so the music never jumps mid-phrase. Pass 0 (or
   * omit) to return to the bright menu mood.
   */
  setLevel(level = 0): void {
    this.pendingMood = level > 0 ? moodForLevel(level) : MOOD_MAJOR;
    // If nothing is playing yet, adopt it straight away.
    if (!this.timer) this.mood = this.pendingMood;
  }

  /** Create the context on the first user gesture and (if unmuted) start music. */
  unlock(): void {
    if (!this.ctx) this.build();
    if (this.ctx!.state === 'suspended') void this.ctx!.resume();
    if (!this.muted && !this.timer) this.startMusic();
  }

  /** Toggle sound; returns the new muted state. Persists the choice. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.muted) this.stopMusic();
    else { this.unlock(); this.startMusic(); }
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
    return this.muted;
  }

  // ---------- graph ----------
  private build(): void {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    this.music = ctx.createGain();
    this.music.gain.value = 0.34;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;

    // A subtle feedback delay adds a little air without smearing the chords.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = this.mood.fb;
    this.fbGain = fb;
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    this.delay.connect(fb); fb.connect(this.delay);
    this.delay.connect(wet); wet.connect(this.master);

    this.music.connect(this.master);
    this.sfx.connect(this.master);

    // A one-second noise buffer reused by the percussive effects.
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---------- soundtrack ----------
  private startMusic(): void {
    if (!this.ctx || this.timer) return;
    this.nextNote = this.ctx.currentTime + 0.1;
    this.step = 0;
    // Lookahead scheduler: queue notes a fraction of a second ahead of the
    // audio clock so timing stays rock-steady regardless of frame rate.
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private stopMusic(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  private schedule(): void {
    const ctx = this.ctx!;
    const mood = this.mood;
    const spb = 60 / mood.bpm;    // seconds per beat
    const eighth = spb / 2;       // melody moves in eighth notes
    while (this.nextNote < ctx.currentTime + 0.12) {
      const inBar = this.step % 8;

      // At the head of every bar: adopt any queued mood change, then lay down
      // the bass root, a soft pad chord and (on harder tiers) a frame-drum.
      if (inBar === 0) {
        if (this.pendingMood !== this.mood) {
          this.mood = this.pendingMood;
          if (this.fbGain) this.fbGain.gain.value = this.mood.fb;
        }
        const bar = Math.floor(this.step / 8) % this.mood.prog.length;
        const chord = this.mood.prog[bar];
        this.bass(hz(chord.bass), this.nextNote, spb * 4);
        this.pad(chord.bass + 12, this.nextNote, spb * 4);
        this.pad(chord.bass + 19, this.nextNote, spb * 4);
      }

      const m = this.mood;
      const bar = Math.floor(this.step / 8) % m.prog.length;
      const chord = m.prog[bar];

      // Soft frame-drum: an even pulse that adds urgency on the darker moods.
      if (m.drum && inBar % (8 / m.drum) === 0) {
        this.drum(this.nextNote, inBar === 0 ? 0.32 : 0.2);
      }

      // Melody: pluck a pentatonic tone on most eighths, rest now and then so
      // the tune breathes instead of running on. The downbeat always sounds.
      if (inBar === 0 || Math.random() > m.rest) {
        const note = chord.pool[Math.floor(Math.random() * chord.pool.length)];
        const octave = Math.random() < m.lift ? 12 : 0;
        this.pluck(hz(note + octave), this.nextNote, eighth * 1.6);
        // Tense moods sprinkle a quick grace note a semitone below the beat.
        if (m.lead && inBar !== 0 && Math.random() < 0.18) {
          this.pluck(hz(note - 1), this.nextNote - eighth * 0.3, eighth * 0.5);
        }
      }

      this.nextNote += eighth;
      this.step++;
    }
  }

  /** Plucked harp/lute tone: bright attack, exponential decay, soft filter. */
  private pluck(freq: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    o.connect(g); g.connect(lp);
    lp.connect(this.music);
    // Only a touch of the melody feeds the delay, scaled by the mood's air.
    const send = ctx.createGain();
    send.gain.value = this.mood.fb * 0.5;
    lp.connect(send); send.connect(this.delay);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** Soft sustained pad voice for the underlying chord. */
  private pad(midi: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz(midi);
    const g = ctx.createGain();
    const peak = 0.12 * this.mood.pad;
    // Gentle attack, a long sustain plateau, then a short release at the end
    // of the bar — a clean, ringing chord rather than a swell that fades out.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.35);
    g.gain.setValueAtTime(peak, t + Math.max(0.35, dur - 0.4));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + dur + 0.1);
  }

  /** A soft frame-drum thump: low filtered noise with a quick body. */
  private drum(t: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(lp); lp.connect(g); g.connect(this.music);
    src.start(t); src.stop(t + 0.18);
  }

  /** Rounded bass note. */
  private bass(freq: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + dur);
  }

  // ---------- sound effects ----------
  play(name: SfxName): void {
    if (this.muted) return;
    if (!this.ctx) this.build();
    if (this.ctx!.state === 'suspended') void this.ctx!.resume();
    const t = this.ctx!.currentTime;
    switch (name) {
      case 'place': return this.efPlace(t);
      case 'build': return this.efBuild(t);
      case 'coin': return this.efCoin(t);
      case 'chop': return this.efChop(t);
      case 'harvest': return this.efHarvest(t);
      case 'demolish': return this.efDemolish(t);
      case 'click': return this.efClick(t);
      case 'error': return this.efError(t);
    }
  }

  /** A short filtered noise burst (used for wood/earth textures). */
  private burst(t: number, dur: number, cutoff: number, type: BiquadFilterType, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /** A single tuned tone with a soft envelope. */
  private tone(freq: number, t: number, dur: number, type: OscillatorType, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // wooden thud — a marker being planted in the ground
  private efPlace(t: number): void {
    this.tone(150, t, 0.16, 'sine', 0.4);
    this.burst(t, 0.09, 900, 'lowpass', 0.25);
  }

  // a building raised — a bright, gentle three-note chime
  private efBuild(t: number): void {
    [72, 76, 79].forEach((m, i) => this.tone(hz(m), t + i * 0.09, 0.4, 'triangle', 0.28));
  }

  // coin — two quick bell-like dings
  private efCoin(t: number): void {
    this.tone(hz(88), t, 0.18, 'sine', 0.3);
    this.tone(hz(93), t + 0.07, 0.28, 'sine', 0.3);
  }

  // axe on timber — a crisp tick over a low body
  private efChop(t: number): void {
    this.burst(t, 0.05, 3200, 'bandpass', 0.5);
    this.tone(120, t, 0.1, 'sine', 0.3);
  }

  // harvest — a soft scything swish
  private efHarvest(t: number): void {
    this.burst(t, 0.22, 1800, 'highpass', 0.22);
  }

  // demolish — a low earthy rumble
  private efDemolish(t: number): void {
    this.tone(80, t, 0.3, 'sine', 0.35);
    this.burst(t, 0.28, 500, 'lowpass', 0.3);
  }

  // click — a tiny soft tick for UI
  private efClick(t: number): void {
    this.tone(hz(84), t, 0.05, 'triangle', 0.18);
  }

  // error — a gentle low two-tone, never harsh
  private efError(t: number): void {
    this.tone(hz(59), t, 0.12, 'sine', 0.28);
    this.tone(hz(55), t + 0.1, 0.18, 'sine', 0.28);
  }
}

/** Shared engine instance. */
export const audio = new AudioEngine();
