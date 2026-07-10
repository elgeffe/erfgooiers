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
const VERSION = 2;
const META_KEY = 'erfgooiers.meta.v2';
const RUN_KEY = 'erfgooiers.run.v2';

// v1 saves predate the card-slot/contract/mutator run structure and are
// intentionally not migrated — clean them out so they don't linger forever.
try { localStorage.removeItem('erfgooiers.meta.v1'); localStorage.removeItem('erfgooiers.run.v1'); } catch { /* ignore */ }

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
  if (!m) return newMeta();
  // fields added after v2 shipped — normalize older documents in place
  m.ascension ??= 0;
  m.stats.wins ??= 0;
  return m;
}
export function saveMeta(meta: MetaState): void { write(META_KEY, meta); }

export function loadRun(): RunState | null {
  const r = read<RunState>(RUN_KEY);
  if (r) r.ascension ??= 0;
  return r;
}
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
