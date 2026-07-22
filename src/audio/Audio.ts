/* =====================================================================
   Erfgooiers — audio.
   A self-contained Web Audio engine: no asset files, everything is
   synthesised at runtime. It provides a gentle, idyllic pastoral score
   (slow extended chords, warm pads, and evolving ambient texture)
   and a handful of small, period-flavoured sound effects (wooden thud,
   axe on timber, harvest swish, coin, a raised-building chime).

   Browsers require a user gesture before audio may sound, so the context
   is created lazily on the first unlock() call (wired to the first click).
   ===================================================================== */

type SfxName = 'place' | 'build' | 'coin' | 'chop' | 'harvest' | 'demolish' | 'click' | 'error'
  | 'sword' | 'clang' | 'maul' | 'bite' | 'claw' | 'arrow' | 'bell' | 'heal';

// Combat effects fire from every fighter in a battle, so rate-limit them
// (per name) or a big melee becomes a wall of white noise.
const SFX_THROTTLE_MS: Partial<Record<SfxName, number>> = { sword: 90, clang: 90, maul: 100, bite: 90, claw: 100, arrow: 80, heal: 220 };

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
  prog: ChordCell[];                                 // one sustained chord per bar
  variants?: ChordCell[][];                          // alternate harmonic identities
  pad: number;                                       // pad voice level (× base)
  fb: number;                                        // delay feedback (space)
  shimmer: number;                                   // high octave sparkle (0 = none)
  air: number;                                        // breathy noise texture (0 = none)
  drone: number;                                     // low sustained drone (0 = none)
  drum: number;                                      // frame-drum hits per bar (0 = none)
}

type ChordCell = { bass: number; chord: number[] };

// Shared C-major extended voicings, kept around C4 for smooth voice-leading.
// The extra seventh/ninth colours provide motion without introducing a lead.
const C: ChordCell = { bass: 48, chord: [60, 64, 67, 71, 74] };  // Cmaj9 (I)
const G: ChordCell = { bass: 43, chord: [55, 59, 62, 65, 69] };  // G13 (V)
const Am: ChordCell = { bass: 45, chord: [57, 60, 64, 67, 71] }; // Am9 (vi)
const F: ChordCell = { bass: 41, chord: [53, 57, 60, 64, 67] };  // Fmaj9 (IV)
const Em: ChordCell = { bass: 40, chord: [55, 59, 62, 64] };     // Em7 (iii)
const Dm: ChordCell = { bass: 38, chord: [57, 60, 64, 65] };     // Dm9 (ii)
const Fm: ChordCell = { bass: 41, chord: [53, 56, 60, 62] };     // Fm6/9 (iv minor)

// Tier 0 — sunlit C major: warm, clean, idyllic. Pads only. One of these
// harmonic identities is selected per home-screen visit and held into the run.
const MOOD_MAJOR: Mood = {
  bpm: 60, pad: 1, fb: 0.16, shimmer: 0, air: 0, drone: 0, drum: 0,
  prog: [C, G, Am, F],
  variants: [
    [C, G, Am, F],      // Imaj9–V13–vi9–IVmaj9
    [C, Am, Dm, G],     // Imaj9–vi9–ii9–V13
    [C, F, Em, Am],     // Imaj9–IVmaj9–iii7–vi9
    [C, Em, F, G],      // Imaj9–iii7–IVmaj9–V13
    [C, G, Fm, C],      // Imaj9–V13–iv6/9–Imaj9 (borrowed minor iv)
  ],
};

// Tier 1 — wistful A minor (vi–IV–I–V): the same warmth turned pensive; a
// faint high shimmer begins to hang over the chords.
const MOOD_WISTFUL: Mood = {
  bpm: 60, pad: 1.05, fb: 0.24, shimmer: 0.4, air: 0.03, drone: 0, drum: 0,
  prog: [
    { bass: 45, chord: [57, 60, 64, 67, 71] }, // Am9
    { bass: 41, chord: [53, 57, 60, 64] },     // Fmaj7
    { bass: 48, chord: [60, 64, 67, 71] },     // Cmaj7
    { bass: 43, chord: [55, 59, 62, 65] },     // G7
  ],
};

// Tier 2 — a D-minor lament (i–VI–III–VII): darker, with a breath of air, a
// low drone and a slow drum settling in beneath the pads.
const MOOD_MINOR: Mood = {
  bpm: 66, pad: 1.1, fb: 0.32, shimmer: 0.5, air: 0.06, drone: 0.08, drum: 2,
  prog: [
    { bass: 38, chord: [62, 65, 69, 72, 76] }, // Dm9
    { bass: 46, chord: [58, 62, 65, 69] },     // Bbmaj7
    { bass: 41, chord: [53, 57, 60, 64] },     // Fmaj7
    { bass: 48, chord: [60, 64, 67, 70] },     // C7
  ],
};

// Tier 3 — an urgent E harmonic minor (i–VI–iv–V) with a raised leading tone;
// thick pads, more air, a stronger drone and a driving drum. The final stretch.
const MOOD_URGENT: Mood = {
  bpm: 76, pad: 1.15, fb: 0.4, shimmer: 0.6, air: 0.09, drone: 0.12, drum: 4,
  prog: [
    { bass: 40, chord: [64, 66, 67, 71] },     // Em(add9)
    { bass: 48, chord: [60, 64, 67, 71] },     // Cmaj7
    { bass: 45, chord: [57, 60, 64, 71] },     // Am9
    { bass: 47, chord: [59, 63, 66, 69, 72] }, // B7(b9)
  ],
};

// =====================================================================
//  Biome moods — each landscape has its own musical signature. When a
//  biome mood is active it overrides the level-tier moods entirely.
// =====================================================================
// The Ardennes — a wandering D-dorian folk lilt: rolling hills, a light
// walking drum, a hint of open air. Music for a road that keeps climbing.
const MOOD_ARDENNES: Mood = {
  bpm: 68, pad: 1.05, fb: 0.22, shimmer: 0.3, air: 0.04, drone: 0, drum: 2,
  prog: [
    { bass: 38, chord: [62, 65, 69, 72, 76] }, // Dm9
    { bass: 41, chord: [60, 64, 65, 69] },     // Fmaj7
    { bass: 48, chord: [64, 67, 71, 72] },     // Cmaj7
    { bass: 43, chord: [62, 65, 67, 71] },     // G7
  ],
  variants: [
    [{ bass: 38, chord: [62, 65, 69, 72, 76] }, { bass: 41, chord: [60, 64, 65, 69] }, { bass: 48, chord: [64, 67, 71, 72] }, { bass: 43, chord: [62, 65, 67, 71] }],
    [{ bass: 38, chord: [62, 65, 69, 72, 76] }, { bass: 48, chord: [64, 67, 71, 72] }, { bass: 43, chord: [62, 65, 67, 71] }, { bass: 41, chord: [60, 64, 65, 69] }],
  ],
};

// The Black Forest — a hushed E-minor murk: very slow, a deep drone and a
// heavy breath of air under barely-lit chords. The trees are listening.
const MOOD_BLACKFOREST: Mood = {
  bpm: 52, pad: 0.95, fb: 0.38, shimmer: 0.2, air: 0.09, drone: 0.14, drum: 0,
  prog: [
    { bass: 40, chord: [59, 62, 64, 67] },     // Em7
    { bass: 45, chord: [60, 64, 67, 69] },     // Am7
    { bass: 48, chord: [60, 64, 67, 71] },     // Cmaj7
    { bass: 47, chord: [59, 63, 66, 69, 72] }, // B7(b9) — the leading tone glints
  ],
};

// The Alps — wide, thin-aired A major: slow chords voiced high and open, a
// strong shimmer like light off snow and a long low drone like a distant
// alphorn. No drum this high up.
const MOOD_ALPS: Mood = {
  bpm: 48, pad: 1.1, fb: 0.3, shimmer: 0.7, air: 0.12, drone: 0.1, drum: 0,
  prog: [
    { bass: 45, chord: [61, 64, 68, 69] }, // Amaj7
    { bass: 40, chord: [59, 62, 64, 68] }, // E7
    { bass: 42, chord: [61, 64, 66, 69] }, // F#m7
    { bass: 38, chord: [61, 62, 66, 69] }, // Dmaj7
  ],
};

// Winter — a held breath in A minor: very slow open add9 voicings, a heavy
// shimmer like frost in sunlight, and long silences between the chords.
const MOOD_WINTER: Mood = {
  bpm: 46, pad: 1.0, fb: 0.3, shimmer: 0.75, air: 0.1, drone: 0.06, drum: 0,
  prog: [
    { bass: 45, chord: [57, 60, 64, 71] }, // Am9, wide and cold
    { bass: 41, chord: [53, 57, 60, 64] }, // Fmaj7
    { bass: 43, chord: [55, 59, 62, 69] }, // G(add9)
    { bass: 40, chord: [52, 55, 59, 62] }, // Em7
  ],
};

// The Polder — an easy F-major stroll under a big sky: the Gooi's warmth
// with a light walking drum, music for straight roads and tulip strips.
const MOOD_POLDER: Mood = {
  bpm: 63, pad: 1.0, fb: 0.2, shimmer: 0.35, air: 0.04, drone: 0, drum: 2,
  prog: [
    { bass: 41, chord: [53, 57, 60, 64] }, // Fmaj7
    { bass: 46, chord: [58, 62, 65, 69] }, // Bbmaj7
    { bass: 48, chord: [60, 64, 67, 70] }, // C7
    { bass: 41, chord: [53, 57, 60, 67] }, // F(add9)
  ],
};

// The Zeeland Delta — a rolling G mixolydian: the flattened seventh washes
// in and out like surf, with plenty of open air and a steady swell of a drum.
const MOOD_SEASIDE: Mood = {
  bpm: 70, pad: 1.05, fb: 0.26, shimmer: 0.4, air: 0.09, drone: 0.04, drum: 2,
  prog: [
    { bass: 43, chord: [59, 62, 65, 67] }, // G7
    { bass: 41, chord: [57, 60, 64, 65] }, // Fmaj7 — the mixolydian wave
    { bass: 48, chord: [60, 64, 67, 70] }, // C7
    { bass: 43, chord: [59, 62, 67, 69] }, // G(add9)
  ],
};

// Texel — wide D major with salt in the air: slow bright chords, gull-height
// shimmer and a soft drone underneath like the sea you can always hear.
const MOOD_ISLAND: Mood = {
  bpm: 56, pad: 1.05, fb: 0.28, shimmer: 0.55, air: 0.11, drone: 0.06, drum: 0,
  prog: [
    { bass: 38, chord: [57, 61, 62, 66] }, // Dmaj7
    { bass: 43, chord: [59, 62, 66, 67] }, // Gmaj7
    { bass: 45, chord: [61, 64, 67, 69] }, // A7
    { bass: 47, chord: [59, 62, 66, 69] }, // Bm7
  ],
};

// Hell — an E phrygian grind: the flat second leaning on the tonic, a deep
// drone, thick air and a slow heavy drum. The ground itself is smouldering.
const MOOD_HELL: Mood = {
  bpm: 58, pad: 1.1, fb: 0.45, shimmer: 0.15, air: 0.12, drone: 0.2, drum: 4,
  prog: [
    { bass: 40, chord: [59, 62, 64, 67] },     // Em7
    { bass: 41, chord: [60, 64, 65, 69] },     // Fmaj7 — phrygian shadow
    { bass: 40, chord: [59, 64, 66, 67] },     // Em(add9)
    { bass: 47, chord: [59, 63, 66, 69, 72] }, // B7(b9)
  ],
};

const BIOME_MOODS: Record<string, Mood> = {
  ardennes: MOOD_ARDENNES,
  blackforest: MOOD_BLACKFOREST,
  alps: MOOD_ALPS,
  winter: MOOD_WINTER,
  polder: MOOD_POLDER,
  seaside: MOOD_SEASIDE,
  island: MOOD_ISLAND,
  hell: MOOD_HELL,
};

/** Map a 1-based level within a run to a mood tier. */
function moodForLevel(level: number): Mood {
  if (level <= 3) return MOOD_MAJOR;
  if (level <= 5) return MOOD_WISTFUL;
  if (level <= 8) return MOOD_MINOR;
  return MOOD_URGENT;
}

const HARMONY_VARIANTS = MOOD_MAJOR.variants!.length;

/** Select the same harmonic identity deterministically in every mood. */
export function selectProgression<T>(variants: readonly T[], harmonyIndex: number): T {
  return variants[((harmonyIndex % variants.length) + variants.length) % variants.length];
}

/** Pick a genuinely different identity when possible. Injected RNG keeps this testable. */
export function nextHarmonyIndex(current: number, count: number, random: () => number = Math.random): number {
  if (count <= 1) return 0;
  if (current < 0) return Math.floor(random() * count);
  return (current + 1 + Math.floor(random() * (count - 1))) % count;
}

function progressionFor(m: Mood, harmonyIndex: number): ChordCell[] {
  return selectProgression(m.variants?.length ? m.variants : [m.prog], harmonyIndex);
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
  // settings-screen multipliers on the built-in mix (0..1, default full)
  private musicVol = 1;
  private sfxVol = 1;
  private timer = 0;
  private nextNote = 0;   // ctx time of the next bar to schedule
  private step = 0;       // running bar counter

  private mood: Mood = MOOD_MAJOR;        // mood the current bar is playing in
  private pendingMood: Mood = MOOD_MAJOR; // mood to switch to at the next bar
  private biomeMood: Mood | null = null;  // biome signature overriding level moods
  private activeProg = MOOD_MAJOR.prog;   // the selected progression for this play
  private harmonyIndex = -1;              // one arrangement identity, stable through a run
  private pendingHarmonyIndex = -1;       // rerolls land cleanly on the next bar boundary

  constructor() {
    this.muted = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
      && localStorage.getItem(MUTE_KEY) === '1';
  }

  get isMuted(): boolean { return this.muted; }

  /** Settings: scale the score's loudness (0 silences the music entirely). */
  setMusicVolume(v: number): void {
    this.musicVol = Math.min(1, Math.max(0, v));
    if (this.music) this.music.gain.value = 0.34 * this.musicVol;
  }

  /** Settings: scale effect loudness (0 silences clicks, swords, arrows…). */
  setSfxVolume(v: number): void {
    this.sfxVol = Math.min(1, Math.max(0, v));
    if (this.sfx) this.sfx.gain.value = 0.9 * this.sfxVol;
  }

  /**
   * Shift the score to match a run's difficulty. The change is queued and lands
   * on the next bar boundary so the music never jumps mid-phrase. Pass 0 (or
   * omit) to return to the bright menu mood.
   */
  setLevel(level = 0): void {
    if (this.biomeMood) return; // a biome signature owns the score while active
    this.pendingMood = level > 0 ? moodForLevel(level) : MOOD_MAJOR;
    // If nothing is playing yet, adopt it straight away.
    if (!this.timer) { this.mood = this.pendingMood; this.activeProg = progressionFor(this.mood, this.harmonyIndex); }
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
      if (!this.timer) { this.mood = this.pendingMood; this.activeProg = progressionFor(this.mood, this.harmonyIndex); }
    }
  }

  /**
   * Choose a new pads-and-chords arrangement. Main calls this only when the
   * page first reaches home or returns there; level, biome, mute, and screen
   * transitions retain the current identity. An active score adopts the new
   * arrangement on its next bar boundary.
   */
  rerollHarmony(): void {
    const current = this.pendingHarmonyIndex >= 0 ? this.pendingHarmonyIndex : this.harmonyIndex;
    this.pendingHarmonyIndex = nextHarmonyIndex(current, HARMONY_VARIANTS);
    if (!this.timer) {
      this.harmonyIndex = this.pendingHarmonyIndex;
      this.activeProg = progressionFor(this.mood, this.harmonyIndex);
    }
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
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    }
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
    this.music.gain.value = 0.34 * this.musicVol;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9 * this.sfxVol;

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
    if (this.harmonyIndex < 0) this.rerollHarmony();
    this.activeProg = progressionFor(this.mood, this.harmonyIndex);
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
      // A return to the home screen may queue a new arrangement. Nothing else
      // mutates this identity, so menu → hero select → gameplay stays seamless.
      if (this.pendingHarmonyIndex !== this.harmonyIndex) {
        this.harmonyIndex = this.pendingHarmonyIndex;
        this.activeProg = progressionFor(this.mood, this.harmonyIndex);
      }
      // Adopt any queued mood change at the bar boundary so shifts glide in.
      if (this.pendingMood !== this.mood) {
        this.mood = this.pendingMood;
        this.activeProg = progressionFor(this.mood, this.harmonyIndex);
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
    // Extended voicings use four or five oscillators, so keep each voice
    // lighter than the old triads to preserve headroom and a soft pad blend.
    const peak = 0.052 * this.mood.pad * level;
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
      case 'clang': return this.efClang(t);
      case 'maul': return this.efMaul(t);
      case 'bite': return this.efBite(t);
      case 'claw': return this.efClaw(t);
      case 'arrow': return this.efArrow(t);
      case 'bell': return this.efBell(t);
      case 'heal': return this.efHeal(t);
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

  /** A tone that slides in pitch — a growl or a shriek, depending on direction.
   *  Optional lowpass tames the sawtooth's rasp. */
  private glide(f0: number, f1: number, t: number, dur: number, type: OscillatorType, gain: number, cutoff = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let tail: AudioNode = g;
    if (cutoff) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; g.connect(lp); tail = lp; }
    o.connect(g); tail.connect(this.sfx);
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

  // harvest — a gentle rustle of stalks with a warm low body (the old
  // high-passed hiss read harsh, especially with several farms running)
  private efHarvest(t: number): void {
    this.burst(t, 0.16, 850, 'bandpass', 0.09);
    this.tone(hz(64), t, 0.12, 'sine', 0.07);
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

  // light sword swing (soldiers, pikemen, bandits, skeletons) — a quick air
  // swish then a bright, fast-decaying steel clink. Pitch jittered so a melee
  // reads as many blades rather than one repeating sample.
  private efSword(t: number): void {
    const ring = 2400 + Math.random() * 1000;
    this.burst(t, 0.035, 5200, 'highpass', 0.22);           // the swish of the swing
    this.tone(ring, t + 0.02, 0.08, 'triangle', 0.2);       // steel on steel
    this.tone(ring * 1.5, t + 0.02, 0.05, 'sine', 0.09);    // faint upper partial
    this.glide(ring * 1.1, ring * 0.8, t + 0.02, 0.06, 'triangle', 0.08); // a glancing scrape
  }

  // heavy steel clash (knights, horse knights, the hero, orcs) — a lower,
  // meatier clang with a real body thud under a longer-ringing partial.
  private efClang(t: number): void {
    const ring = 1200 + Math.random() * 500;
    this.burst(t, 0.05, 3000, 'bandpass', 0.26);            // weighty swing
    this.tone(95, t, 0.11, 'sine', 0.3);                    // the shock through the arms
    this.tone(ring, t + 0.02, 0.18, 'triangle', 0.2);       // deep steel ring
    this.tone(ring * 1.5, t + 0.02, 0.1, 'sine', 0.08);     // upper partial, slowly fading
  }

  // blunt strike on rotten flesh (zombies, bloated zombies) — a wet, dull
  // thud with no metal in it at all.
  private efMaul(t: number): void {
    this.tone(70, t, 0.15, 'sine', 0.34);                   // the heavy thump
    this.burst(t, 0.1, 420, 'lowpass', 0.3);                // muffled impact body
    this.burst(t + 0.01, 0.06, 700, 'bandpass', 0.14);      // a squelch of torn flesh
  }

  // beast bite (wolves, boars) — a snap of teeth over a short low growl.
  private efBite(t: number): void {
    this.burst(t, 0.03, 1900, 'bandpass', 0.3);             // the snap
    this.glide(190, 90, t, 0.13, 'sawtooth', 0.16, 700);    // a guttural growl
  }

  // demon slash (the hell fiends) — a raking claw with a dark descending shriek.
  private efClaw(t: number): void {
    this.burst(t, 0.09, 3200, 'bandpass', 0.22);            // the rake of claws
    this.glide(520, 120, t, 0.16, 'sawtooth', 0.14, 1400);  // a menacing downward shriek
    this.tone(58, t, 0.14, 'sine', 0.22);                   // an infernal low body
  }

  // arrow loosed — a plucked string twang and the hiss of the shaft in flight
  private efArrow(t: number): void {
    const pluck = 180 + Math.random() * 60;
    this.tone(pluck, t, 0.07, 'triangle', 0.28);         // bowstring
    this.tone(pluck * 2, t, 0.04, 'sine', 0.12);         // string overtone
    this.burst(t + 0.02, 0.14, 2600, 'highpass', 0.14);  // fletching whoosh
  }

  // the castle bell — two solemn strikes with a bright partial ringing over each
  private efBell(t: number): void {
    for (const dt of [0, 0.55]) {
      this.tone(523, t + dt, 1.1, 'sine', 0.3);
      this.tone(1046, t + dt, 0.5, 'sine', 0.1);
      this.tone(1567, t + dt, 0.25, 'sine', 0.05);
    }
  }

  // heal — a soft rising glockenspiel chime, a warm blessing over the din
  private efHeal(t: number): void {
    this.tone(784, t, 0.34, 'sine', 0.14);
    this.tone(1046, t + 0.06, 0.4, 'sine', 0.12);
    this.tone(1318, t + 0.12, 0.44, 'sine', 0.08);
  }

  // error — a gentle low two-tone, never harsh
  private efError(t: number): void {
    this.tone(hz(59), t, 0.12, 'sine', 0.28);
    this.tone(hz(55), t + 0.1, 0.18, 'sine', 0.28);
  }
}

/** Shared engine instance. */
export const audio = new AudioEngine();
