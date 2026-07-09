# Graphics Upgrade Plan — Cel-Shaded Look + Desktop Performance

Goal: move from the current flat-lit low-poly look to a **cel-shaded (toon)**
style with ink outlines, while **optimizing rendering for maximum desktop/laptop
performance**. This is a desktop-first target (not mobile, yet).

**Status: Phases 1–2 and performance items 1–3 are implemented** on
`refactor/graphics`, behind the `GRAPHICS` block in
[src/constants.ts](../src/constants.ts). Set `GRAPHICS.toon`/`outlines` to
`false` to get the old flat-Lambert look back exactly.

## Current state (assessment)

- **One material chokepoint:** every lit material now funnels through
  `stdMat()` in [src/render/models.ts](../src/render/models.ts) (which `mat()`
  / `mkMat()` and all View ambiance materials use), so the whole look flips on
  one flag. UI overlays (selection rings, HP bars, ghost markers, road cursor)
  are `MeshBasicMaterial` and **stay flat**.
- **One render call:** `View.render()` — `OutlineEffect.render` when outlines
  are on, plain `renderer.render` otherwise. No post-processing composer.
- **Lighting:** ambient + hemisphere + one shadow-casting sun — ideal for toon
  banding. Toon mode runs a slightly stronger sun over a lower ambient floor,
  plus a cool fill light from the shaded side so the dark band stays airy.
- **Static-heavy scenes:** trees / deposits / buildings never move; only units
  do. The sun never moves. Static matrices are frozen (see below).

## Phase 1 — Toon materials ✅ (implemented)

- `GRAPHICS` config block in [src/constants.ts](../src/constants.ts): `toon`,
  `toonBands`, plus outline tunables. The whole look toggles and reverts.
- One shared gradient map quantizes lighting into `toonBands` flat bands.
  Implementation note for r152: the toon shader samples only the **red
  channel**, so the `DataTexture` must be `RedFormat` + `NearestFilter`.
  Band values are `255·(i+1)/n` — the ambient/hemisphere floor lifts the
  darkest band enough that nothing goes muddy.
- `stdMat(params, outline?)` builds `MeshToonMaterial` (toon on) or
  `MeshLambertMaterial` (off). Everything routes through it: the `mat()` hex
  cache, ghosts, ground (`vertexColors`), roads (canvas cobble texture), the
  merged-geometry corpses, and all View ambiance (hills, treeline, mill,
  clouds, plain, slab).

## Phase 2 — Outlines ✅ (implemented)

- Three's drop-in `OutlineEffect` (`three/examples/jsm/effects/OutlineEffect.js`)
  wraps the single render call. No geometry changes; reversible via
  `GRAPHICS.outlines`.
- **Ortho-camera note:** with an orthographic camera the projected `w` is 1, so
  `defaultThickness` is a constant *screen-space* width at any zoom (0.0022 ≈
  2px at 1080p). Warm ink color (`0x241c14`) reads softer than pure black.
- **Exclusions** (via `material.userData.outlineParameters = { visible: false }`,
  wrapped as `noOutline()`):
  - Transparent materials — expanded backfaces look wrong on them (clouds,
    smoke, ghosts, fishery net). `stdMat` applies this automatically.
  - Flat-on-ground meshes whose outline would be invisible but still cost a
    draw call each: ground, roads, the horizon plain.
  - UI overlay `MeshBasicMaterial`s (selection rings, cursors, markers).
    HP bars are `depthTest: false`, which `OutlineEffect` auto-skips.
  - Fading corpses: the moment a body starts its fade, its outline is switched
    off so the ink doesn't outlive the fading mesh.

## Performance track ✅ (items 1–3 implemented, amended)

1. `powerPreference: 'high-performance'` on the renderer. ✅
2. **Shadows — plan amended.** On-demand shadow rendering (autoUpdate off,
   mark-dirty on building placement) was dropped: units, pigs, fish, windmill
   sails and smoke animate **every frame** and cast shadows, so a frozen map
   would visibly freeze their moving shadows. Instead the toon look switches
   `PCFSoftShadowMap` → `PCFShadowMap`: hard-edged shadows suit cel shading
   *and* cost less per pixel. On-demand shadows remain a future option only if
   unit shadows are ever replaced with blob decals.
3. **Freeze static matrices.** ✅ `View.freeze()` sets
   `matrixAutoUpdate = false` (+ one `updateMatrix()`) recursively on placed
   buildings, roads, doodads, ground, ambiance and corpses. Animated subtrees
   (windmill sails, smoke puffs, scaffold frames) carry `userData.dynamic` and
   keep auto updates; roots that grow or walk (trees, crops, units, pigs,
   fish, clouds) stay auto while their rigid children are frozen
   (`freeze(g, false)`).
4. Pixel-ratio cap at 2 and MSAA (`antialias: true`) kept — fine on desktop. ✅
5. **Optional bigger win — `InstancedMesh`** for repeated doodads (trees /
   grass / rocks). Largest FPS gain but a real refactor of the doodad path;
   do it only if wanted, as its own phase. ⏳ future

## Phase 3 — Optional polish ⏳ (future, only if wanted)

- `EffectComposer` with light bloom + a subtle color-grade/LUT (and SMAA).
  Note the wrinkle: `OutlineEffect` wraps the renderer while a composer owns
  the frame — integrating both means either the composer's own outline pass or
  rendering the outline pass into the composer's input target.

## Tuning knobs (all in `GRAPHICS`, src/constants.ts)

| Knob | Default | Effect |
|---|---|---|
| `toon` | `true` | Whole cel look on/off (off = exact old Lambert look) |
| `toonBands` | `3` | Fewer = flatter/posterized, more = closer to smooth |
| `outlines` | `true` | Ink edge pass on/off |
| `outlineThickness` | `0.0022` | Screen-space edge width (NDC) |
| `outlineColor` | `0x241c14` | Warm ink |
| `outlineAlpha` | `0.85` | Edge opacity |

## Verification

`npm run build` clean (typecheck + bundle). Visual check: sandbox mode in
headless Chrome, screenshots at menu / default / zoomed-in / zoomed-out, with
an A/B against `toon: false` to confirm the toggle reverts cleanly and that
shadow behavior is unchanged.
