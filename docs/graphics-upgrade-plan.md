# Graphics Upgrade Plan — Cel-Shaded Look + Desktop Performance

Goal: move from the current flat-lit low-poly look to a **cel-shaded (toon)**
style with ink outlines, while **optimizing rendering for maximum desktop/laptop
performance**. This is a desktop-first target (not mobile, yet).

## Current state (assessment)

- **One material chokepoint:** `mat()` / `mkMat()` in
  [src/render/models.ts](../src/render/models.ts) produce every doodad/building/unit
  material (`MeshLambertMaterial`, cached by hex). Ground, roads and hills are a
  handful of `MeshLambertMaterial` in [src/render/View.ts](../src/render/View.ts).
  UI overlays (selection rings, HP bars, ghost, road cursor) are
  `MeshBasicMaterial` and should **stay flat**.
- **One render call:** [src/render/View.ts](../src/render/View.ts) →
  `renderer.render(scene, camera)`. No post-processing composer yet.
- **Lighting:** ambient + hemisphere + one shadow-casting sun — ideal for toon
  banding.
- **Static-heavy scenes:** trees / deposits / buildings never move; only units
  do. The sun never moves. This is a large performance opportunity.

## Plan

### Phase 1 — Toon materials (≈80% of the visual win, low risk, reversible)

- Add a `GRAPHICS` config block in [src/constants.ts](../src/constants.ts) with a
  `toon` flag + band count, so the whole look toggles and is easy to revert/tune.
- Build one shared 3-step `gradientMap` and switch `mat()` / `mkMat()` in
  [src/render/models.ts](../src/render/models.ts) to `MeshToonMaterial` when the
  flag is on.
- Apply the same to ground (`vertexColors`), roads and hills/background in
  [src/render/View.ts](../src/render/View.ts).
- Tune lights: slightly stronger sun + a cool rim/fill so the bands read well.
- `npm run build` + view live.

### Phase 2 — Outlines (the "ink" edges)

- Use Three's drop-in `OutlineEffect`
  (`three/examples/jsm/effects/OutlineEffect.js`): replace the single
  `renderer.render` call with `outline.render`. No geometry changes, per-material
  outline control, exclude UI overlays. Reversible via the same flag.
- Alternative (future option): a single full-screen depth+normal edge pass in an
  `EffectComposer` — cheaper at scale but more plumbing. Start with
  `OutlineEffect`.

### Phase 3 — Optional polish (only if wanted)

- `EffectComposer` with light bloom + a subtle color-grade/LUT (and SMAA). Flag
  the `OutlineEffect` ↔ composer integration wrinkle when we get there.

## Performance track (desktop-first, runs alongside)

1. `powerPreference: 'high-performance'` on the renderer.
2. **Shadow auto-update off** — the sun and most geometry are static, so render
   shadows on demand (mark dirty when a building is placed/removed) instead of
   every frame. Big GPU saving, low risk.
3. **Freeze static matrices** — `matrixAutoUpdate = false` (+ one
   `updateMatrix()`) on placed trees / deposits / buildings / ground; units keep
   it on. Cuts per-frame matrix work with hundreds of objects.
4. Keep pixel-ratio cap at 2, keep MSAA (`antialias: true`) — fine on desktop.
5. **Optional bigger win — `InstancedMesh`** for repeated doodads (trees / grass
   / rocks). Largest FPS gain but a real refactor of the doodad path; do it only
   if wanted, as its own phase.

## Recommended order

Do **Phase 1 + performance items 1–3 first**, view it live, then **Phase 2**.
Phases 3 and the `InstancedMesh` work are optional follow-ups.
