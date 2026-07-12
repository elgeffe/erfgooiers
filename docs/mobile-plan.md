# Mobile plan — bringing Erfgooiers to touch screens

Status: proposal (nothing here is implemented). Companion to
[graphics-upgrade-plan.md](graphics-upgrade-plan.md) and
[scale-and-tactics.md](scale-and-tactics.md).

## Verdict first: is it wise?

**Qualified yes — target tablets in landscape first, treat phones as a
separate, later decision.**

The economy half of the game is genuinely well suited to touch: it is
indirect (you place buildings and watch serfs work — no APM pressure), the
pace is gentle, sessions are short by design (ten short levels), and the
between-level shop/hero/contract screens are ordinary scrollable UI that
already reflows responsively. Cozy builder-roguelites are a proven genre on
tablets.

The combat half is the risk. Box-selecting fighters, squad hotkeys 1–5,
drag-to-aim formations and attack-move micromanagement were designed around
a mouse and keyboard. On a 6-inch phone, an isometric map with 2×2-tile
buildings and sub-tile units is below comfortable touch accuracy, and the
HUD already occupies all four corners plus both bottom edges. A phone port
is therefore **a redesign, not a resize** — different HUD, coarser combat
verbs, probably a smaller default map.

A tablet-landscape target, by contrast, is mostly incremental: the screen
is laptop-sized, the existing HUD fits, and the work concentrates in one
place (the input layer) plus touch-target sizing that also helps desktop
users. Roughly 70% of the tablet work (pointer unification, bigger targets,
collapsible panels, quality presets) is a straight improvement to the
desktop game, so it is a low-regret investment even if mobile uptake is
small. Recommendation:

1. **Do now (cheap, benefits desktop too):** the Phase 1 items below.
2. **Do next if Phase 1 feels good on a real iPad:** Phase 2 tablet polish.
3. **Only with evidence of demand:** Phase 3 phone redesign. Do not fork
   the UI speculatively.

## Where the game stands today

Good foundations for touch:

- **Pointer Events everywhere.** `Controls` already listens to
  `pointerdown/move/up`, so fingers reach the same code path as the mouse.
- **Adaptive quality.** The renderer already steps `pixelRatio` down when
  frames run long — the single most important mobile performance lever
  exists and is now user-pinnable (Settings → Render quality → Low).
- **Responsive screens.** Menu, shop, hero select, sandbox setup and the
  new Settings screen use fluid grids and `min(1500px, 96vw)` cards.
- **A settings system** (`Settings.ts`) to hang mobile toggles off.
- **Fixed-timestep sim** decoupled from rendering — frame drops don't
  corrupt gameplay.

What breaks on a touch screen today:

| Problem | Where |
|---|---|
| Right-click is load-bearing: orders, drag-to-aim, rally flags, cancel placement | `Controls` |
| Keyboard is load-bearing: WASD pan, R rotate, B bell, Space pause, 1–5 squads, Esc cancel, Shift-keep-placing | `Controls`, `UI` |
| Wheel zoom has no touch equivalent (no pinch) | `Controls` |
| One finger is ambiguous: pan vs box-select vs order | `Controls` |
| Hover tooltips carry real information (curse effects, train costs, build cards) | HUD everywhere |
| Hit targets: build cards, speed buttons, formation buttons, sandbox bar are 27–38 px; Apple/Google guidelines say 44–48 px | `style.css` |
| HUD claims all four corners + two bottom bars; no safe-area insets for notches | `index.html`, `style.css` |
| Double-click select-type has no touch mapping | `Controls` |
| iOS Safari quirks: 100vh, audio unlock (handled), WebGL memory ceilings on older devices | `View`, `Audio` |

## Phase 1 — touch input + reachability (tablet landscape, ~desktop-neutral)

**Input mapping.** All in `Controls`, keeping the mouse paths untouched:

- One-finger drag on empty ground → pan (already nearly works via the
  right/middle-drag path; route single-touch drags there).
- **Pinch → zoom** (track two active pointers; ratio of distances drives
  `view.zoom`). Two-finger drag → pan, so pinch and pan blend.
- Tap → select (existing click path). Tap on ground with an army selected
  must NOT instantly order — see the mode toggle below.
- **Long-press (450 ms) → context order** for the current selection:
  hostile under finger = attack, ground = attack-move. Continue holding and
  dragging = the existing drag-to-aim formation preview, which is already a
  perfect touch gesture.
- **Selection mode toggle** in the formation bar: a `☝ Select / ⚔ Order`
  switch replaces the left/right button distinction. In Select mode a drag
  draws the box; in Order mode a tap orders. Auto-return to Select after an
  order. (Desktop ignores this entirely.)
- `touch-action: none` on the canvas; `user-select: none` on HUD.

**Keyboard replacements** (all appear only when a coarse pointer is
detected — `matchMedia('(pointer: coarse)')`):

- Rotate ⟳ already has an on-screen button in the placement hint. Add an
  on-screen ✕ cancel next to it (Esc replacement).
- Bell 🔔 button in the top bar (B replacement); pause already has ⏸.
- Squad chips 1–5 along the formation bar (tap = recall, long-press =
  assign) replacing the digit keys.

**Reachability & sizing:**

- Bump every HUD button to ≥ 44 px on coarse pointers via a
  `@media (pointer: coarse)` block — no markup changes.
- Replace load-bearing `title=` tooltips with **long-press popovers** (one
  shared implementation) for build cards, curses, train buttons and shop
  wares; keep `title` for mouse users.
- `viewport-fit=cover` + `env(safe-area-inset-*)` padding on the four HUD
  anchors; `100dvh` instead of `100vh`.
- Collapse-by-default on small heights: workers panel, sandbox bar (has a
  toggle already), minimap shrink.

**Performance defaults on mobile detection:** start Settings → quality at
`low` (user can raise it), cap `maxPixelRatio` at 1.5, halve cloud/wildlife
counts via the existing ambience knobs, and default sandbox size to
`medium` — `colossal` (144²) with a thousand-unit brawl is a desktop toy.

Estimated effort: the whole phase is concentrated in `Controls`,
`style.css` and one popover helper — comparable to the drag-to-aim feature,
maybe 3–4× its size. No sim, world or render architecture changes.

## Phase 2 — tablet polish

- Orientation: request landscape (`screen.orientation.lock` where allowed,
  a polite "rotate your device" overlay elsewhere).
- PWA shell: manifest + icons + service-worker cache of the (already
  fully static) bundle → installable, offline-capable. This is nearly free
  with `vite-plugin-pwa` and helps desktop too.
- Inspector and build menu as **bottom sheets** with drag handles on coarse
  pointers (same DOM, different CSS).
- Battery: add a 30 fps cap option to Settings (render every other frame;
  the 20 tps sim is unaffected).
- Playtest checklist: full 10-level run on a mid-range iPad and one
  Android tablet; watch memory in level 9–10 (80–86 tile maps, two
  fortified quarters).

## Phase 3 — phones (only with demand)

Held deliberately out of scope until Phases 1–2 prove out:

- A one-handed portrait HUD (probably: top resource strip, single bottom
  sheet that swaps between build/inspect/army contexts).
- Coarser combat verbs (tap a banner to select a whole squad instead of
  box-select; formation presets instead of drag-to-aim).
- Smaller campaign maps or a zoomed "commander view" — 86-tile maps at
  phone size are unreadable.
- App-store packaging (Capacitor) if distribution beyond the browser is
  wanted.

## Explicit non-goals

- No separate mobile codebase or UI fork — every change must be a
  progressive enhancement behind pointer/viewport media queries.
- No gameplay simplification on desktop to accommodate touch.
- No touch analog of every hotkey — only the load-bearing ones (order,
  cancel, rotate, bell, squads, pause).

## Success criteria

Phase 1 ships when, on an iPad in Safari with no keyboard or mouse, a
player can: clear level 1; place and rotate a building; paint a road;
select an army three ways (tap, box, squad chip); order, aim and cancel a
formation move; read a curse's effect; and finish a shop visit — all
without ever needing a hover or a key.
