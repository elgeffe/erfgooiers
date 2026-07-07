import './style.css';
import { World } from './world/World';
import { View } from './render/View';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { Controls } from './input/Controls';

/* =====================================================================
   Erfgooiers — a cozy physical-economy prototype set in Het Gooi.
   Composition root: build the World (data), View (Three.js), Game (sim),
   UI (DOM overlay) and Controls (input), wire them, then run the loop.
   ===================================================================== */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;

const world = new World();
const view = new View(world, canvas, minimap);
const game = new Game(world, view);
const ui = new UI(game);
const controls = new Controls(game, view, ui);

// wiring: game emits, UI/Controls react
game.toast = (msg, cls) => ui.toast(msg, cls);
game.onSelect = obj => ui.showInspector(obj);
ui.onMode = m => controls.setMode(m);

game.init();
view.centerOn(world.wx(game.store.x) + 0.5, world.wz(game.store.y) + 2);

// ---------- main loop ----------
let last = performance.now();
let uiT = 0, mmT = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;

  controls.update(dt);            // keyboard camera panning
  view.animate(dt, game.buildings); // sails & clouds (real-time, ignores pause)

  const sdt = dt * game.simSpeed;
  if (sdt > 0) game.update(sdt);

  uiT += dt; if (uiT > 0.4) { uiT = 0; ui.tick(); }
  mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }

  view.render();
}
view.drawMinimap(game.units);
requestAnimationFrame(frame);
