# Skirmish AI — Classic mirror calibration

Reproduce: `npm run campaign -- --seeds 100 --base-seed 5000 --max-minutes 30 --pairs classic-hard:classic-hard,classic-godlike:classic-godlike`

Map "Border Clash" · 100 seeds/pairing · seats alternate per seed · draw after 30 sim-min.
Outcomes are deterministic in (seed, profiles); win counts below are stable across runs and machines.

| Mirror | P1 wins | P2 wins | Draws | Avg length | Avg first attack |
|---|--:|--:|--:|--:|--:|
| classic-hard | 40 | 44 | 16 | 19.7m | 11.0m |
| classic-godlike | 32 | 41 | 27 | 21.8m | 13.9m |

## Calibration findings

- Hard reached four standing wooden watchtowers in 119/200 seat outcomes and
  averaged 3.48 at match end. Its conventional first wave launched around
  11 minutes; 187/200 seats attacked before the match ended.
- Godlike reached at least four standing stone towers (home perimeter plus
  possible outposts) in 122/200 seat outcomes and averaged 4.18 at match end.
- Godlike reached its Stable/Engineer/Monastery late-game layer in 150/200 seat
  outcomes. At the final snapshot, 84/200 seats still fielded at least two
  trebuchets and 62/200 still fielded armies of 40 or more; destroyed units are
  not counted, so these are conservative late-game participation measures.
- Godlike's average match is 2.1 minutes longer than Hard's and its first
  aggression is 2.9 minutes later. It is reaching the intended late game; the
  27% draw rate says its decisive conversion remains the next tuning target.
- Physical-seat results are close enough for this sample: among decisive games,
  P1 won 47.6% of Hard mirrors and 43.8% of Godlike mirrors. The latter is worth
  watching in larger campaigns but is not strong evidence of systematic bias at
  73 decisive games.

## Fairness and follow-up

- The initial campaign recorded four rejected commands, all repeated coal-mine
  placements by Hard seed 5094 after a cached deposit became unworkable.
  Placement search now calls the simulation's exact live workability gate.
  Re-running that complete 30-minute seed produced 892 commands with **0
  rejected**. The other 199 campaign matches already had zero rejections.
- Worst single AI decision pass: 52ms.
- Full campaign wall time: 1,209 seconds on eight workers. A few dense
  late-game seeds were pathfinding outliers; performance profiling is separate
  from the balance result.
