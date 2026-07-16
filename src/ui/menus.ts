import { UPGRADES, cardUnlocked, unlockLabel } from '../data/upgrades';
import { ASCENSION_NAMES, compareScores, formatRunTime, type MetaState } from '../game/RunState';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** The main menu's speedrun scoreboard: victorious runs, highest tier first,
 *  fastest within a tier. Hidden until someone has actually won. */
export function renderMenuScores(box: HTMLElement, meta: MetaState): void {
  const scores = [...meta.scores].sort(compareScores).slice(0, 8);
  if (!scores.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="scorehead">Hall of Erfgooiers — fastest victories</div>'
    + scores.map((s, i) =>
      `<div class="scorerow"><span class="rank">${i + 1}.</span>`
      + `<span class="who">${escapeHtml(s.name)} ${escapeHtml(s.title)}</span>`
      + `<span class="tier">${ASCENSION_NAMES[s.ascension] ?? `tier ${s.ascension}`}</span>`
      + `<span class="time">${formatRunTime(s.timeSeconds)}</span></div>`).join('');
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
