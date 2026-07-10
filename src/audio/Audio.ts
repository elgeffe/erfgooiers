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

type SfxName = 'place' | 'build' | 'coin' | 'chop' | 'harvest' | 'demolish' | 'click' | 'error' | 'sword' | 'arrow';

// Combat effects fire from every fighter in a battle, so rate-limit them
// (per name) or a big melee becomes a wall of white noise.
const SFX_THROTTLE_MS: Partial<Record<SfxName, number>> = { sword: 90, arrow: 80 };

const MUTE_KEY = 'erfgooiers.muted';

/** MIDI note → frequency in Hz. */
const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * A musical "mood" — an evolving ambient texture rather than a tune. Each
 * progression entry is one bar: a bass root plus the chord tones that ring as
 * sustained pads. Higher tiers lean into minor keys and layer on more texture
 * (a high shimmer, a breath of air, a low drone, a soft frame-drum pulse), so
 * the score deepens and tightens as the run gets harder — no melody line to
 * distract, just shifting harmonic colour.
 */
interface Mood {
  bpm: number;                                       // tempo (bar length & drum)
  prog: { bass: number; chord: number[] }[];         // one sustained chord per bar
  variants?: { bass: number; chord: number[] }[][];  // alt progressions, picked per play
  pad: number;                                       // pad voice level (× base)
  fb: number;                                        // delay feedback (space)
  shimmer: number;                                   // high octave sparkle (0 = none)
  air: number;                                        // breathy noise texture (0 = none)
  drone: number;                                     // low sustained drone (0 = none)
  drum: number;                                      // frame-drum hits per bar (0 = none)
}

// Shared C-major chord voicings, kept around C4 for smooth voice-leading.
const C = { bass: 48, chord: [60, 64, 67] };  // I
const G = { bass: 43, chord: [55, 59, 62] };  // V
const Am = { bass: 45, chord: [57, 60, 64] }; // vi
const F = { bass: 41, chord: [53, 57, 60] };  // IV
const Em = { bass: 40, chord: [55, 59, 64] }; // iii

// Tier 0 — sunlit C major: warm, clean, idyllic. Pads only. A handful of
// bright progressions are shuffled between so no two games open the same way.
const MOOD_MAJOR: Mood = {
  bpm: 60, pad: 1, fb: 0.16, shimmer: 0, air: 0, drone: 0, drum: 0,
  prog: [C, G, Am, F],
  variants: [
    [C, G, Am, F],  // I–V–vi–IV
    [C, Am, F, G],  // I–vi–IV–V
    [C, F, G, Am],  // I–IV–V–vi
    [C, Em, F, G],  // I–iii–IV–V
    [C, G, F, Am],  // I–V–IV–vi
  ],
};

// Tier 1 — wistful A minor (vi–IV–I–V): the same warmth turned pensive; a
// faint high shimmer begins to hang over the chords.
const MOOD_WISTFUL: Mood = {
  bpm: 60, pad: 1.05, fb: 0.24, shimmer: 0.4, air: 0.03, drone: 0, drum: 0,
  prog: [
    { bass: 45, chord: [57, 60, 64] }, // Am
    { bass: 41, chord: [53, 57, 60] }, // F
    { bass: 48, chord: [60, 64, 67] }, // C
    { bass: 43, chord: [55, 59, 62] }, // G
  ],
};

// Tier 2 — a D-minor lament (i–VI–III–VII): darker, with a breath of air, a
// low drone and a slow drum settling in beneath the pads.
const MOOD_MINOR: Mood = {
  bpm: 66, pad: 1.1, fb: 0.32, shimmer: 0.5, air: 0.06, drone: 0.08, drum: 2,
  prog: [
    { bass: 38, chord: [62, 65, 69] }, // Dm
    { bass: 46, chord: [58, 62, 65] }, // Bb
    { bass: 41, chord: [53, 57, 60] }, // F
    { bass: 48, chord: [60, 64, 67] }, // C
  ],
};

// Tier 3 — an urgent E harmonic minor (i–VI–iv–V) with a raised leading tone;
// thick pads, more air, a stronger drone and a driving drum. The final stretch.
const MOOD_URGENT: Mood = {
  bpm: 76, pad: 1.15, fb: 0.4, shimmer: 0.6, air: 0.09, drone: 0.12, drum: 4,
  prog: [
    { bass: 40, chord: [64, 67, 71] }, // Em
    { bass: 48, chord: [60, 64, 67] }, // C
    { bass: 45, chord: [57, 60, 64] }, // Am
    { bass: 47, chord: [59, 63, 66] }, // B (D# leading tone)
  ],
};

const MOODS: Mood[] = [MOOD_MAJOR, MOOD_WISTFUL, MOOD_MINOR, MOOD_URGENT];

// =====================================================================
//  Biome moods — each landscape has its own musical signature. When a
//  biome mood is active it overrides the level-tier moods entirely.
// =====================================================================
// The Ardennes — a wandering D-dorian folk lilt: rolling hills, a light
// walking drum, a hint of open air. Music for a road that keeps climbing.
const MOOD_ARDENNES: Mood = {
  bpm: 68, pad: 1.05, fb: 0.22, shimmer: 0.3, air: 0.04, drone: 0, drum: 2,
  prog: [
    { bass: 38, chord: [62, 65, 69] }, // Dm
    { bass: 41, chord: [60, 65, 69] }, // F
    { bass: 48, chord: [64, 67, 72] }, // C
    { bass: 43, chord: [62, 67, 71] }, // G
  ],
  variants: [
    [{ bass: 38, chord: [62, 65, 69] }, { bass: 41, chord: [60, 65, 69] }, { bass: 48, chord: [64, 67, 72] }, { bass: 43, chord: [62, 67, 71] }],
    [{ bass: 38, chord: [62, 65, 69] }, { bass: 48, chord: [64, 67, 72] }, { bass: 43, chord: [62, 67, 71] }, { bass: 41, chord: [60, 65, 69] }],
  ],
};

// The Black Forest — a hushed E-minor murk: very slow, a deep drone and a
// heavy breath of air under barely-lit chords. The trees are listening.
const MOOD_BLACKFOREST: Mood = {
  bpm: 52, pad: 0.95, fb: 0.38, shimmer: 0.2, air: 0.09, drone: 0.14, drum: 0,
  prog: [
    { bass: 40, chord: [59, 64, 67] }, // Em
    { bass: 45, chord: [60, 64, 69] }, // Am
    { bass: 48, chord: [60, 64, 67] }, // C
    { bass: 47, chord: [59, 63, 66] }, // B — the raised leading tone glints in the dark
  ],
};

// The Alps — wide, thin-aired A major: slow chords voiced high and open, a
// strong shimmer like light off snow and a long low drone like a distant
// alphorn. No drum this high up.
const MOOD_ALPS: Mood = {
  bpm: 48, pad: 1.1, fb: 0.3, shimmer: 0.7, air: 0.12, drone: 0.1, drum: 0,
  prog: [
    { bass: 45, chord: [61, 64, 69] }, // A
    { bass: 40, chord: [59, 64, 68] }, // E
    { bass: 42, chord: [61, 66, 69] }, // F#m
    { bass: 38, chord: [62, 66, 69] }, // D
  ],
};

const BIOME_MOODS: Record<string, Mood> = {
  ardennes: MOOD_ARDENNES,
  blackforest: MOOD_BLACKFOREST,
  alps: MOOD_ALPS,
};

/** Map a 1-based level within a run to a mood tier. */
function moodForLevel(level: number): Mood {
  if (level <= 3) return MOOD_MAJOR;
  if (level <= 5) return MOOD_WISTFUL;
  if (level <= 8) return MOOD_MINOR;
  return MOOD_URGENT;
}

/** Choose a progression for a mood — a random variant if it has any. */
function pickProg(m: Mood): { bass: number; chord: number[] }[] {
  if (m.variants && m.variants.length) return m.variants[Math.floor(Math.random() * m.variants.length)];
  return m.prog;
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
  private nextNote = 0;   // ctx time of the next bar to schedule
  private step = 0;       // running bar counter

  private mood: Mood = MOOD_MAJOR;        // mood the current bar is playing in
  private pendingMood: Mood = MOOD_MAJOR; // mood to switch to at the next bar
  private biomeMood: Mood | null = null;  // biome signature overriding level moods
  private activeProg = MOOD_MAJOR.prog;   // the chosen progression for this play
  private dynamic = false;                // sandbox: drift through the moods over time

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
    if (this.biomeMood) return; // a biome signature owns the score while active
    this.pendingMood = level > 0 ? moodForLevel(level) : MOOD_MAJOR;
    // If nothing is playing yet, adopt it straight away.
    if (!this.timer) { this.mood = this.pendingMood; this.activeProg = pickProg(this.mood); }
  }

  /**
   * Give the score a landscape: biomes with their own musical signature
   * (Ardennes folk lilt, Black Forest hush, Alpine air) override the level
   * moods entirely; 'gooi' (or unknown) returns control to the level tiers.
   */
  setBiome(biome: string): void {
    this.biomeMood = BIOME_MOODS[biome] ?? null;
    if (this.biomeMood) {
      this.pendingMood = this.biomeMood;
      if (!this.timer) { this.mood = this.pendingMood; this.activeProg = pickProg(this.mood); }
    }
  }

  /**
   * Sandbox mode: let the score drift through every mood tier over time so a
   * long free-build session slowly evolves from sunlit major to urgent minor
   * and back, rather than sitting on one texture.
   */
  setDynamic(on: boolean): void { this.dynamic = on; }

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
    this.activeProg = pickProg(this.mood); // fresh progression variant each start
    // Lookahead scheduler: queue notes a fraction of a second ahead of the
    // audio clock so timing stays rock-steady regardless of frame rate.
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private stopMusic(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  private schedule(): void {
    const ctx = this.ctx!;
    // Bars are long and overlapping, so schedule one whole bar a little ahead
    // of the audio clock and let its sustained voices ring across the next.
    while (this.nextNote < ctx.currentTime + 0.4) {
      // Sandbox: every 4 bars drift to the next mood tier, cycling endlessly
      // (unless a biome signature owns the score).
      if (this.dynamic && !this.biomeMood && this.step % 4 === 0) {
        this.pendingMood = MOODS[((this.step / 4) | 0) % MOODS.length];
      }
      // Adopt any queued mood change at the bar boundary so shifts glide in.
      if (this.pendingMood !== this.mood) {
        this.mood = this.pendingMood;
        this.activeProg = pickProg(this.mood);
        if (this.fbGain) this.fbGain.gain.value = this.mood.fb;
      }
      const m = this.mood;
      const prog = this.activeProg;
      const barLen = (60 / m.bpm) * 4;
      const bar = this.step % prog.length;
      const cell = prog[bar];
      const t = this.nextNote;

      // Warm bass root + the sustained pad chord — the constant harmonic bed.
      this.bass(hz(cell.bass), t, barLen);
      for (const n of cell.chord) this.pad(n, t, barLen, 1);

      // Texture layers fade in as the run hardens.
      if (m.shimmer) for (const n of cell.chord) this.pad(n + 12, t, barLen, m.shimmer * 0.35);
      if (m.drone) this.drone(hz(cell.bass - 12), t, barLen, m.drone);
      if (m.air) this.air(t, barLen, m.air);
      if (m.drum) {
        const beat = barLen / m.drum;
        for (let i = 0; i < m.drum; i++) this.drum(t + i * beat, i === 0 ? 0.3 : 0.18);
      }

      this.nextNote += barLen;
      this.step++;
    }
  }

  /**
   * Soft sustained pad voice for a chord tone. Gentle attack, a long sustain
   * plateau, then a short release at the bar's end — a clean, ringing chord.
   * Adjacent bars overlap on the release/attack so chords cross-fade smoothly.
   */
  private pad(midi: number, t: number, dur: number, level: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz(midi);
    const g = ctx.createGain();
    const peak = 0.075 * this.mood.pad * level;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.5);
    g.gain.setValueAtTime(peak, t + Math.max(0.5, dur - 0.6));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.music);
    // A touch of the pad feeds the delay for a sense of space (never smearing).
    const send = ctx.createGain();
    send.gain.value = this.mood.fb * 0.35 * level;
    g.connect(send); send.connect(this.delay);
    o.start(t); o.stop(t + dur + 0.1);
  }

  /** A low, slowly-beating drone — two detuned sines under a soft lowpass. */
  private drone(freq: number, t: number, dur: number, level: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.8);
    g.gain.setValueAtTime(level, t + Math.max(0.8, dur - 0.8));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(this.music);
    for (const detune of [1, 1.004]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq * detune;
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }

  /** A breath of filtered noise that swells across the bar — open-air texture. */
  private air(t: number, dur: number, level: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g);
    g.connect(this.music); g.connect(this.delay);
    src.start(t); src.stop(t + dur + 0.1);
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
  private lastSfx: Partial<Record<SfxName, number>> = {};

  play(name: SfxName): void {
    if (this.muted) return;
    const gap = SFX_THROTTLE_MS[name];
    if (gap) {
      const now = performance.now();
      if (now - (this.lastSfx[name] ?? -Infinity) < gap) return;
      this.lastSfx[name] = now;
    }
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
      case 'sword': return this.efSword(t);
      case 'arrow': return this.efArrow(t);
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

  // sword swing — a metallic clink over a short air swish, pitch jittered so
  // a melee reads as many blades rather than one repeating sample
  private efSword(t: number): void {
    const ring = 2200 + Math.random() * 900;
    this.burst(t, 0.05, 4200, 'bandpass', 0.3);          // the swish of the swing
    this.tone(ring, t + 0.02, 0.09, 'triangle', 0.2);    // steel on steel
    this.tone(ring * 1.5, t + 0.02, 0.05, 'sine', 0.1);  // faint upper partial
  }

  // arrow loosed — a plucked string twang and the hiss of the shaft in flight
  private efArrow(t: number): void {
    const pluck = 180 + Math.random() * 60;
    this.tone(pluck, t, 0.07, 'triangle', 0.28);         // bowstring
    this.tone(pluck * 2, t, 0.04, 'sine', 0.12);         // string overtone
    this.burst(t + 0.02, 0.14, 2600, 'highpass', 0.14);  // fletching whoosh
  }

  // error — a gentle low two-tone, never harsh
  private efError(t: number): void {
    this.tone(hz(59), t, 0.12, 'sine', 0.28);
    this.tone(hz(55), t + 0.1, 0.18, 'sine', 0.28);
  }
}

/** Shared engine instance. */
export const audio = new AudioEngine();
