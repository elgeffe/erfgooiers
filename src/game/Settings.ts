/**
 * Player preferences, persisted in localStorage separately from save data —
 * clearing a save never resets someone's volume or camera feel. Anything
 * unreadable falls back to the defaults rather than crashing.
 */
export interface GameSettings {
  musicVol: number;                  // 0..1 multiplier on the score's mix
  sfxVol: number;                    // 0..1 multiplier on effect loudness
  panSpeed: number;                  // 0.5..2 camera keyboard/drag pan speed
  invertZoom: boolean;               // flip the wheel's zoom direction
  extendedZoom: boolean;             // unlock a much farther zoom-out ceiling
  edgePan: boolean;                  // pan when the pointer rests at a screen edge
  autoPauseOnBlur: boolean;          // open the pause menu when the tab loses focus
  quality: 'auto' | 'high' | 'low';  // render pixel-ratio strategy
  tutorials: boolean;                // Normal-tier story briefings, build checklist & hints
  unitCap: number;                   // performance ceiling on live units (godlike = MAX_UNITS)
  corpseCap: number;                 // battlefield bodies kept before the oldest is culled
  corpseLife: number;                // seconds a body lingers before fading away
}

export const DEFAULT_SETTINGS: GameSettings = {
  musicVol: 1, sfxVol: 1, panSpeed: 1,
  invertZoom: false, extendedZoom: false, edgePan: false, autoPauseOnBlur: false,
  quality: 'auto', tutorials: true,
  unitCap: 4000, corpseCap: 2000, corpseLife: 300,
};

const KEY = 'erfgooiers.settings.v1';

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = JSON.parse(raw) as Partial<GameSettings>;
    const num = (v: unknown, d: number, lo: number, hi: number): number =>
      typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    return {
      musicVol: num(s.musicVol, 1, 0, 1),
      sfxVol: num(s.sfxVol, 1, 0, 1),
      panSpeed: num(s.panSpeed, 1, 0.5, 2),
      invertZoom: !!s.invertZoom,
      extendedZoom: !!s.extendedZoom,
      edgePan: !!s.edgePan,
      autoPauseOnBlur: !!s.autoPauseOnBlur,
      quality: s.quality === 'high' || s.quality === 'low' ? s.quality : 'auto',
      tutorials: s.tutorials !== false, // default on for anyone without the key set
      unitCap: num(s.unitCap, DEFAULT_SETTINGS.unitCap, 100, 11000),
      corpseCap: num(s.corpseCap, DEFAULT_SETTINGS.corpseCap, 0, 11000),
      corpseLife: num(s.corpseLife, DEFAULT_SETTINGS.corpseLife, 10, 3600),
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s: GameSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked — ignore */ }
}
