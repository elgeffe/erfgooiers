import { newMeta, type MetaState, type RunState } from './RunState';

/**
 * Versioned localStorage persistence. Two independent documents:
 *  - `meta`       — Heritage, unlocks, lifetime stats (kept forever)
 *  - `currentRun` — the in-progress run, so closing the tab resumes at the
 *                   current level's start.
 *
 * Anything unreadable or from an older schema version is discarded rather than
 * crashing — a corrupt save must never brick the game. `clearAll()` wipes
 * everything, which is the panic button for save-related bugs.
 */
const VERSION = 1;
const META_KEY = 'erfgooiers.meta.v1';
const RUN_KEY = 'erfgooiers.run.v1';

interface Doc<T> { version: number; data: T; }

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const doc = JSON.parse(raw) as Doc<T>;
    if (!doc || doc.version !== VERSION) return null;
    return doc.data;
  } catch { return null; }
}

function write<T>(key: string, data: T): void {
  try { localStorage.setItem(key, JSON.stringify({ version: VERSION, data })); } catch { /* storage full or blocked — ignore */ }
}

export function loadMeta(): MetaState {
  const m = read<MetaState>(META_KEY);
  return m ?? newMeta();
}
export function saveMeta(meta: MetaState): void { write(META_KEY, meta); }

export function loadRun(): RunState | null { return read<RunState>(RUN_KEY); }
export function saveRun(run: RunState): void { write(RUN_KEY, run); }
export function hasRun(): boolean {
  try { return localStorage.getItem(RUN_KEY) !== null; } catch { return false; }
}

/** End the current run (keeps meta-progress). */
export function clearRun(): void {
  try { localStorage.removeItem(RUN_KEY); } catch { /* ignore */ }
}

/** Panic button — wipe run *and* meta. Used by the menu's "Clear save data". */
export function clearAll(): void {
  try { localStorage.removeItem(RUN_KEY); localStorage.removeItem(META_KEY); } catch { /* ignore */ }
}
