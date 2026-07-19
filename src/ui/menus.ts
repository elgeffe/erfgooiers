import { UPGRADES, cardUnlocked, unlockLabel } from '../data/upgrades';
import { HERO_BY_ID } from '../data/heroes';
import { levelFor } from '../data/levels';
import { ASCENSION_NAMES, RUN_LEVELS, bestLevelTimes, compareScores, formatRunTime, type MetaState, type ScoreEntry } from '../game/RunState';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** The main menu's speedrun scoreboard: victorious runs, highest tier first,
 *  fastest within a tier. Hidden until someone has actually won. */
export function renderMenuScores(box: HTMLElement, meta: MetaState): void {
  // The menu shows only the podium — the Scoreboard screen holds the full Hall.
  const scores = [...meta.scores].sort(compareScores).slice(0, 3);
  if (!scores.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="scorehead">Fastest victories</div>'
    + scores.map((s, i) =>
      `<div class="scorerow"><span class="rank">${i + 1}.</span>`
      + `<span class="who">${escapeHtml(s.name)} ${escapeHtml(s.title)}</span>`
      + `<span class="tier">${ASCENSION_NAMES[s.ascension] ?? `tier ${s.ascension}`}</span>`
      + `<span class="time">${formatRunTime(s.timeSeconds)}</span></div>`).join('');
}

function heroLabel(hero: string | null): string {
  const def = hero ? HERO_BY_ID[hero] : null;
  return def ? `${def.icon} ${def.name}` : '—';
}

function tierLabel(ascension: number): string {
  return ASCENSION_NAMES[ascension] ?? `tier ${ascension}`;
}

/** The scoreboard screen's run list: every victorious run, highest tier first,
 *  fastest within a tier. Each row opens that run's detail view via `onPick`. */
export function renderScoreboard(metaLine: HTMLElement, box: HTMLElement, meta: MetaState, onPick: (entry: ScoreEntry) => void): void {
  const scores = [...meta.scores].sort(compareScores);
  box.innerHTML = '';
  if (!scores.length) {
    metaLine.innerHTML = 'No victories recorded yet.';
    box.innerHTML = '<div class="sb-empty">Clear all ten levels of a run to sign the Hall — every win records its time and per-level splits.</div>';
    return;
  }
  metaLine.innerHTML = `<b>${scores.length}</b> recorded victor${scores.length === 1 ? 'y' : 'ies'} · click a run for its per-level splits`;
  const head = document.createElement('div');
  head.className = 'sb-row sb-head';
  head.innerHTML = '<span class="rank">#</span><span class="who">Who</span><span class="hero">Hero</span><span class="tier">Tier</span><span class="date">When</span><span class="time">Time</span>';
  box.appendChild(head);
  scores.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'sb-row sb-click';
    el.innerHTML = `<span class="rank">${i + 1}.</span>`
      + `<span class="who">${escapeHtml(s.name)} ${escapeHtml(s.title)}</span>`
      + `<span class="hero">${heroLabel(s.hero)}</span>`
      + `<span class="tier">${tierLabel(s.ascension)}</span>`
      + `<span class="date">${new Date(s.date).toLocaleDateString()}</span>`
      + `<span class="time">${formatRunTime(s.timeSeconds)}</span>`;
    el.onclick = () => onPick(s);
    box.appendChild(el);
  });
}

/** One run's detail view: overall stats plus per-level splits, each compared
 *  against the save's personal-best split for that level. */
export function renderRunDetail(metaLine: HTMLElement, box: HTMLElement, entry: ScoreEntry, meta: MetaState): void {
  const scores = [...meta.scores].sort(compareScores);
  const rank = scores.indexOf(entry) + 1;
  metaLine.innerHTML = `<b>${escapeHtml(entry.name)} ${escapeHtml(entry.title)}</b>${rank ? ` · rank ${rank} of ${scores.length}` : ''}`;
  const tiles =
    `<div class="victory-outputs sb-tiles">`
    + `<div class="vout"><span class="vout-ico">⏱</span><b>${formatRunTime(entry.timeSeconds)}</b><small>Run time</small></div>`
    + `<div class="vout"><span class="vout-ico">⬆</span><b>${tierLabel(entry.ascension).split(' — ')[0]}</b><small>Ascension</small></div>`
    + `<div class="vout"><span class="vout-ico">🛡</span><b>${heroLabel(entry.hero)}</b><small>Hero</small></div>`
    + `<div class="vout"><span class="vout-ico">📜</span><b>${new Date(entry.date).toLocaleDateString()}</b><small>Won on</small></div>`
    + `</div>`;
  if (!entry.levelTimes?.length) {
    box.innerHTML = tiles + '<div class="sb-empty">This run predates split tracking — only its total time was recorded. New victories record every level’s time.</div>';
    return;
  }
  const best = bestLevelTimes(meta.scores);
  let rows = '', sumOfBest = 0, sumComplete = true;
  for (let i = 0; i < RUN_LEVELS; i++) {
    const t = entry.levelTimes[i];
    const b = best[i];
    if (b !== null) sumOfBest += b; else sumComplete = false;
    const delta = t === undefined || b === null ? ''
      : t <= b ? '<span class="sb-best">★ best</span>'
      : `<span class="sb-delta">+${formatRunTime(t - b)}</span>`;
    rows += `<div class="sb-row sb-split"><span class="rank">${i + 1}.</span>`
      + `<span class="who">${escapeHtml(levelFor(i + 1).name)}</span>`
      + `<span class="delta">${delta}</span>`
      + `<span class="time">${t === undefined ? '—' : formatRunTime(t)}</span></div>`;
  }
  box.innerHTML = tiles
    + '<div class="sb-row sb-head"><span class="rank">#</span><span class="who">Level</span><span class="delta">vs. your best</span><span class="time">Split</span></div>'
    + rows
    + (sumComplete ? `<div class="sb-row sb-sum"><span class="rank"></span><span class="who">Sum of best splits</span><span class="delta"></span><span class="time">${formatRunTime(sumOfBest)}</span></div>` : '');
}

/** The achievements screen: every achievement-gated card. Unlocked feats show
 *  the card in full; locked ones show the feat as a hint plus live progress. */
export function renderAchievements(metaLine: HTMLElement, grid: HTMLElement, meta: MetaState): void {
  const gated = UPGRADES.filter(u => u.unlockAt);
  const unlockedCount = gated.filter(u => cardUnlocked(u, meta.stats)).length;
  metaLine.innerHTML = `<b>${unlockedCount}/${gated.length}</b> cards earned · progress lives in your save (export it to keep it safe)`;
  grid.innerHTML = '';
  for (const def of gated) {
    const gate = def.unlockAt!;
    const unlocked = cardUnlocked(def, meta.stats);
    const progress = Math.min(meta.stats[gate.stat], gate.n);
    const tag = `<span class="rtag rtag-${def.rarity}">${def.rarity}</span>`;
    const el = document.createElement('div');
    el.className = `scard rar-${def.rarity}` + (unlocked ? '' : ' cant');
    el.innerHTML = unlocked
      ? `<div class="sc-icon">${def.icon}</div><div class="sc-body"><div class="sc-name">${def.name}${tag}</div><div class="sc-desc">${def.desc}</div>`
        + `<div class="sc-price owned">✓ ${unlockLabel(gate)} — earned</div></div>`
      : `<div class="sc-icon">🔒</div><div class="sc-body"><div class="sc-name">???${tag}</div><div class="sc-desc">Hint: ${unlockLabel(gate).toLowerCase()} to reveal this card.</div>`
        + `<div class="sc-price">${unlockLabel(gate)} · ${progress}/${gate.n}</div></div>`;
    grid.appendChild(el);
  }
}
