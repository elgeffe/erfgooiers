---
name: verify
description: Build, launch and drive Erfgooiers end-to-end to verify a change works at runtime (not just typechecks).
---

# Verifying Erfgooiers

Build gate: `npm run build` (tsc --noEmit + vite build). That is necessary but not
sufficient — drive the running game for anything gameplay-facing.

## Launch

```bash
npm run dev -- --port 5199 &   # serves http://localhost:5199/erfgooiers/  (note the base path!)
```

Drive it headless with the globally installed Playwright + Chromium:

```js
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

Collect `page.on('pageerror')` and console errors — the game has no error UI.

## Gotchas

- **Sim time ≠ real time headless.** The fixed-timestep loop clamps frame dt to 0.05 s;
  under SwiftShader the game runs at ~0.1× real time. Never wait wall-clock for game
  events — the dev build exposes `window.game` (main.ts, DEV only): poll
  `window.game.elapsed` and click `#sp3` (3× speed) first.
- **Inspector buttons detach every 300 ms** (`#inspBody` innerHTML rebuilds each UI
  tick). `page.click` times out retrying; use
  `locator.dispatchEvent('pointerdown')` — the game's delegated handler listens for it.
- Menu flow: `#btnSandbox` → free build with the spawn toolbar (`#sbSoldier`,
  `#sbBandit`, `#sbDragon`, …) — the fastest combat testbed. `#btnNewRun` starts level 1;
  `#btnDebugWin` + `#btnShopContinue` skips levels (combat starts at level 5).
- Useful `window.game` probes: `units` (tx/ty, order, path, foe, hp), `buildings`,
  `projectiles`, `flames`, `countItem('trunk')`, `placeBuilding(key, x, y, true)` +
  `select(b)` to open any inspector instantly, `canPlace`/`tryPlace` for legal spots.

## Flows worth driving

- Sandbox battle: spawn soldiers/archers + bandits at the camera, watch hp bars,
  arrows (`game.projectiles`), corpses.
- Formation & control: drag a box over fighters, right-click ground (fan-out),
  Shift+1 assign / 1 recall squads.
- Economy smoke: new run, `tryPlace('woodcutter', …)` near trees, wait ~50 game-s,
  assert the site completes and `countItem('trunk')` grows.
