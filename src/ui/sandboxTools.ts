import { audio } from '../audio/Audio';
import { MAX_CARDS, UPGRADES, UPGRADE_BY_ID } from '../data/upgrades';
import { META_BY_ID } from '../data/metaUpgrades';
import { UNITS, type UnitKind } from '../data/units';
import type { Game } from '../game/Game';
import type { RunState } from '../game/RunState';
import type { View } from '../render/View';
import type { UI } from './UI';

type SpawnDef = { kind: UnitKind; count: number; icon: string; label: string };
const FRIENDLY: SpawnDef[] = [
  ['soldier', 12, '⚔️', 'Soldiers'], ['pikeman', 10, '🔱', 'Pikemen'], ['archer', 8, '🏹', 'Archers'],
  ['knight', 6, '🛡️', 'Knights'], ['priest', 4, '⛪', 'Priests'], ['lancer', 8, '🐎', 'Lancers'],
  ['horseknight', 6, '🏇', 'Horse Knights'], ['horsearcher', 8, '🎯', 'Horse Archers'],
  ['ballista', 3, '⚙️', 'Ballistas'], ['onager', 3, '💥', 'Onagers'], ['trebuchet', 2, '🪨', 'Trebuchets'],
].map(([kind, count, icon, label]) => ({ kind, count, icon, label }) as SpawnDef);
const ENEMY: SpawnDef[] = [
  ['bandit', 12, '🗡️', 'Bandits'], ['lancer', 8, '🐎', 'Enemy Lancers'], ['horseknight', 6, '🏇', 'Enemy Horse Knights'],
  ['horsearcher', 8, '🎯', 'Enemy Horse Archers'], ['boar', 6, '🐗', 'Boars'], ['wolf', 8, '🐺', 'Wolves'],
  ['orc', 8, '🪓', 'Orcs'], ['troll', 3, '🪨', 'Trolls'], ['skeleton', 10, '💀', 'Skeletons'],
  ['skelarcher', 8, '🏹', 'Skeletal Archers'], ['zombie', 10, '🧟', 'Zombies'], ['brute', 1, '🧟‍♂️', 'Bloated Zombie'],
  ['demon', 1, '🔥', 'Demon'], ['dragon', 1, '🐉', 'Dragon'],
].map(([kind, count, icon, label]) => ({ kind, count, icon, label }) as SpawnDef);
const $ = (id: string): HTMLElement => document.getElementById(id)!;

export interface SandboxToolPorts {
  getGame: () => Game | null;
  getRun: () => RunState | null;
  rebuildModifiers: () => void;
  isSandbox: () => boolean;
  getUnlocks: () => string[];
}

/** Installs sandbox-only spawn, wave, and card UI. Live game/run state stays
 * behind getters because levels are rebuilt throughout the session. */
export function installSandboxTools(view: View, ui: UI, ports: SandboxToolPorts): void {
  let timer: number | null = null;
  const stop = (): void => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const spawn = (def: SpawnDef, faction: 'player' | 'enemy'): void => {
    const game = ports.getGame();
    if (!game) return;
    const squad = game.spawnSquad(def.kind, def.count, view.camTarget.x, view.camTarget.z, faction);
    const label = def.kind === 'pikeman' && squad.length > 1 ? 'Pikemen' : UNITS[def.kind].name + (squad.length > 1 ? 's' : '');
    if (squad.length) ui.toast(`Spawned ${squad.length} ${label}`);
  };
  const button = (def: SpawnDef, faction: 'player' | 'enemy'): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.textContent = `${def.icon} ${def.label}`;
    btn.title = `Spawn ${faction} ${def.label.toLowerCase()} at the camera`;
    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); stop(); spawn(def, faction);
      timer = window.setInterval(() => spawn(def, faction), 180);
    });
    return btn;
  };
  for (const def of FRIENDLY) $('sbFriendly').appendChild(button(def, 'player'));
  for (const def of ENEMY) $('sbEnemy').appendChild(button(def, 'enemy'));
  addEventListener('pointerup', stop); addEventListener('pointercancel', stop); addEventListener('blur', stop);
  ($('sbToggle') as HTMLButtonElement).onclick = () => {
    const collapsed = $('sandboxbar').classList.toggle('collapsed');
    $('sbToggle').textContent = collapsed ? 'Sandbox ▸' : 'Sandbox ▾';
  };

  const waveModal = $('wavemodal');
  const delay = $('waveDelay') as HTMLInputElement;
  const counts = new Map<UnitKind, number>([['bandit', 12]]);
  const renderWave = (): void => {
    $('waveKinds').innerHTML = '';
    for (const def of ENEMY) {
      const row = document.createElement('div'); row.className = 'waverow-kind' + (counts.get(def.kind) ? ' on' : '');
      const label = document.createElement('span'); label.className = 'wavekind-label'; label.textContent = `${def.icon} ${def.label}`;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '1000'; input.step = '1'; input.value = String(counts.get(def.kind) ?? 0);
      input.title = `How many ${def.label.toLowerCase()} arrive in the wave`;
      input.addEventListener('keydown', e => e.stopPropagation());
      input.addEventListener('input', () => {
        const n = Math.max(0, Math.min(1000, Math.round(Number(input.value) || 0)));
        if (n) counts.set(def.kind, n); else counts.delete(def.kind);
        row.classList.toggle('on', n > 0); $('waveTotal').textContent = String([...counts.values()].reduce((a, b) => a + b, 0));
      });
      row.append(label, input); $('waveKinds').appendChild(row);
    }
    $('waveTotal').textContent = String([...counts.values()].reduce((a, b) => a + b, 0));
  };
  const closeWave = (): void => { waveModal.style.display = 'none'; };
  const summon = (): void => {
    const game = ports.getGame(); if (!game) return;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!total) { ui.toast('Set a count for at least one kind', 'err'); audio.play('error'); return; }
    const seconds = Math.max(0, Math.min(3600, Math.round(Number(delay.value) || 0))); delay.value = String(seconds);
    for (const [kind, count] of counts) game.scheduleWave(kind, count, seconds);
    ui.toast(seconds ? `A wave of ${total} raiders will march in ${seconds}s` : `A wave of ${total} raiders marches on your castle!`, seconds ? undefined : 'err');
    closeWave();
  };
  ($('sbWaveOpen') as HTMLButtonElement).onclick = () => { renderWave(); waveModal.style.display = 'flex'; };
  ($('waveCancel') as HTMLButtonElement).onclick = closeWave; ($('waveGo') as HTMLButtonElement).onclick = summon;
  delay.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') summon(); });

  // The Heritage & power-ups modal is the one card UI, opened from the top-bar
  // Cards button. In sandbox it adds/removes freely; in a real run it just
  // shows the cards you carry, read-only.
  const cardModal = $('sbcardmodal');
  const cardEl = (def: (typeof UPGRADES)[number], price: string, cls: string, action: () => void): HTMLElement => {
    const el = document.createElement('div'); el.className = `scard rar-${def.rarity}` + (cls ? ` ${cls}` : '');
    const tag = def.rarity !== 'common' ? `<span class="rtag rtag-${def.rarity}">${def.rarity}${def.unique ? ' · unique' : ''}</span>` : def.unique ? '<span class="rtag">unique</span>' : '';
    el.innerHTML = `<div class="sc-icon">${def.icon}</div><div class="sc-body"><div class="sc-name">${def.name}${tag}</div><div class="sc-desc">${def.desc}</div><div class="sc-price ${cls}">${price}</div></div>`;
    if (!cls.includes('disabled') && !cls.includes('readonly')) el.onclick = action; return el;
  };
  const metaEl = (d: { icon: string; name: string; desc: string }): HTMLElement => {
    const el = document.createElement('div'); el.className = 'scard rar-legendary readonly';
    el.innerHTML = `<div class="sc-icon">${d.icon}</div><div class="sc-body"><div class="sc-name">${d.name}<span class="rtag">heritage</span></div><div class="sc-desc">${d.desc}</div></div>`;
    return el;
  };
  const show = (id: string, on: boolean): void => { $(id).style.display = on ? '' : 'none'; };
  const renderCards = (): void => {
    const run = ports.getRun(); if (!run) return;
    const sb = ports.isSandbox(), full = run.upgrades.length >= MAX_CARDS;
    $('sbcardTag').textContent = sb
      ? 'Stack your run however you like — click a card below to add it, click one of your cards to remove it. No gold, no limits but the five card slots.'
      : 'The cards you carry this run — permanent Heritage unlocks and the power-ups you bought between levels.';

    // Heritage — permanent unlocks (read-only); the whole section hides when empty
    const heritage = $('sbcardHeritage'); heritage.innerHTML = '';
    const unlocks = ports.getUnlocks().map(id => META_BY_ID[id]).filter((d): d is NonNullable<typeof d> => !!d);
    for (const d of unlocks) heritage.appendChild(metaEl(d));
    show('sbcardHeritageSect', unlocks.length > 0); show('sbcardHeritage', unlocks.length > 0);

    // Your cards — removable one-by-one in sandbox, read-only (folded ×N) in a run
    const owned = $('sbcardOwned'); owned.innerHTML = '';
    $('sbcardOwnedLabel').textContent = `Your cards (${run.upgrades.length}/${MAX_CARDS})` +
      (run.upgrades.length && sb ? ' — click a card to remove it' : '');
    if (sb) {
      run.upgrades.forEach((id, i) => { const def = UPGRADE_BY_ID[id]; if (def) owned.appendChild(cardEl(def, 'remove ✕', 'sellable', () => { run.upgrades.splice(i, 1); ports.rebuildModifiers(); audio.play('click'); renderCards(); })); });
    } else {
      const counts = new Map<string, number>();
      for (const id of run.upgrades) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of counts) { const def = UPGRADE_BY_ID[id]; if (def) owned.appendChild(cardEl(def, n > 1 ? `×${n}` : '', 'readonly', () => {})); }
    }
    if (!run.upgrades.length) owned.innerHTML = `<div class="sc-desc">${sb ? 'No cards yet — add some below.' : 'No power-ups yet — buy some between levels.'}</div>`;

    // Add pool — sandbox only
    const available = $('sbcardAvail'); available.innerHTML = '';
    show('sbcardAvailSect', sb); show('sbcardAvail', sb);
    if (sb) for (const def of UPGRADES) {
      const held = def.unique && run.upgrades.includes(def.id), disabled = full || held;
      available.appendChild(cardEl(def, held ? 'held' : full ? 'slots full' : 'add +', disabled ? 'cant disabled' : '', () => { if (ui.onSandboxCard(def.id)) renderCards(); }));
    }
  };
  ui.onOpenCards = () => { renderCards(); cardModal.style.display = 'flex'; };
  ($('sbcardDone') as HTMLButtonElement).onclick = () => { cardModal.style.display = 'none'; };
  addEventListener('keydown', e => { if (e.key === 'Escape') { if (waveModal.style.display === 'flex') closeWave(); if (cardModal.style.display === 'flex') cardModal.style.display = 'none'; } });
}
