---
name: render-model
description: Render a single Erfgooiers building model in isolation to inspect and iterate on its mesh quickly — without launching or driving the whole game. Use when adjusting building geometry in src/render/buildingModels.ts (parts sticking out, intersecting, wrong size).
---

# Rendering one model in isolation

`model-viewer.html` (entry `src/dev/modelViewer.ts`) renders a single building
model on a grass tile with the game's exact lights, camera and materials. It is
a **dev-only** page — Vite serves it in `npm run dev`; it is not in the
production bundle. Use it to iterate on `buildingModels.ts` far faster than
placing a building in-game.

## Launch

```bash
npm run dev -- --port 5199 &   # http://localhost:5199/erfgooiers/model-viewer.html
```

Open in a browser with `?model=<key>` (e.g. `?model=barracks`). Any `BuildingKey`
from `src/data/buildings.ts` works, including enemy structures. Other params:
`ghost=1`, `spin=1`, `seed=<n>` (scatter seed — props are deterministic per
seed), `biome=<key>`, `view=iso|front|back|left|right|top`.

In the browser: the camera preset buttons, prev/next (or `[` / `]`), the
footprint toggle and the **readout panel** (overall size, mesh count, and any
parts that poke past the 2×2 tile footprint) are the fast inspection loop. Edit
`buildingModels.ts` and Vite hot-reloads the model in place.

## Headless screenshot + report (Playwright)

The page exposes `window.__ready`, a `window.__viewer` API and a
`window.__modelReport` snapshot. Drive it with the globally installed Playwright
(same setup as the `verify` skill):

```js
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('http://localhost:5199/erfgooiers/model-viewer.html?model=barracks');
await page.waitForFunction(() => window.__ready === true);

// switch models / views without reloading, then read the footprint report
const report = await page.evaluate(k => window.__viewer.show(k), 'ironmine');
await page.evaluate(() => window.__viewer.setView('front'));
await page.waitForTimeout(300);              // let one frame render before shooting
await page.screenshot({ path: 'ironmine.png' });
await browser.close();
```

`window.__viewer`: `show(key) → report`, `keys`, `report()`, `setView(name)`,
`setGhost(bool)`, `setBiome(key)`, `setSeed(n)`.

## Reading the footprint report

`__modelReport` / the panel lists parts whose bounding box reaches past
`±1.05` (the half-extent of the 2×2 tile a building occupies — units walk the
tiles just outside it) and flags any mesh dipping below ground (`minY < 0`). Use
it to catch the classic mesh bugs: a prop or beam poking into a neighbouring
tile, or floating/buried geometry. A big rounded base mound (mine) or an
authored eave legitimately reaches ~1.1–1.3; a stray small box out there is the
thing to move.

## Gotcha

- Geometry and materials are shared/cached across the app, so the viewer never
  disposes them on model switch — that's intentional. Toggling **Wire** mutates
  the shared cached materials for this page only (harmless; it's a separate
  page from the game).
