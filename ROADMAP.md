A roguelite economy builder is a great fit — it solves the classic city-builder problem ("I optimized once, why replay?") by making each run short, seeded, and escalating. Here's the roadmap:

The Core Loop (roguelite reframe)



Run = one settlement. 20–40 min. Random map, a contract to fulfill (e.g. "deliver 30 bread + 10 coins before winter"), escalating pressure (seasons, dwindling deposits, rising quotas). Win or fail, the settlement is abandoned — you keep meta-progress.



    Contracts as the "boss": a caravan arrives every N minutes demanding goods. Fulfill = rewards + harder next contract. Fail twice = run over.

    Draft-style building unlocks: start with 3–4 buildings; after each contract, pick 1 of 3 offered buildings/upgrades (K&M meets Slay the Spire). This makes every run's economy genuinely different.

    Relics/blessings: run modifiers found or earned — "serfs carry 2 items", "roads 50% faster", "bakeries never idle". Combos create build variety.

    Meta-progression between runs: unlock new buildings, starting kits, map biomes, harder difficulty tiers. Cosmetic village heraldry.



Roadmap



Phase 1 — Solid foundation (now → next)



    Random map generator (seeded — shareable seed codes, that's free replayability + "daily map")

    Hunger loop for real: bread consumption → productivity buff/debuff (the economy needs a sink!)

    Tuning pass: pacing, serf priorities, save/load via localStorage



Phase 2 — The roguelite skeleton 4. Contract/caravan system (the quota clock) 5. Seasons: winter slows farming → forces stockpiling, gives runs an arc 6. Building draft after each contract 7. Run summary screen (goods produced, distance serfs walked, "economy replay")



Phase 3 — Juice & charm (cute > graphics, but cheap wins) 8. Sound: ambient birds, chop/hammer/coin ticks — hugely cozy for low effort 9. Tiny narratives: serfs get names, milestones toast ("Willem carried his 100th loaf") 10. Weather/day-night tint, walk-trails forming on grass paths



Phase 4 — Replayability infrastructure 11. Daily challenge (same seed for everyone + fixed modifiers, local best score) 12. Achievements ("Mint 10 coins with no roads", "Feed everyone all run") 13. Meta-unlock tree + difficulty ascension levels



Phase 5 — Online-lite (still fully browser, no backend needed at first) 14. Share-a-seed links, exportable run results, maybe async leaderboard later



add this to the roadmap in the README
