fix each of these items, always start with bugs first, then design changes > improvements > features > epics should always be last and first written out as docs/.md file.

## Bugs
- it should not be possible to build a building in front of the only exit of a block of other buildings. when you overlap 3 building their exits on top of each other, you can place another building sideways to block it. also make buildings not have their entries overlap (the green square). FIXED

- the transported blocks are not exactly on top of the hats, but are inside of the hats now and it doesnt look nice

- the fisherman is not doing anything after i built a fish hut next to a large pond

- the market resource picklists are not working. i select something but nothing is saved.

## Design changes


## Improvements
- make the enemy bandit camp buildings have higher hp

- walls need to be cheaper or stone ore's need way more default resource in it.

- redesign harder first levels on ascensions. think about multi objective goals with way higher counts

- improve map tile details to make it look prettier, especially the standard grass tiles

- coin and gold share the same icon. can we give the gold coins (the one we use for purchasing in the shop) a unique symbol. maybe a crown inside the coin emblem? > also design a unique coin for heritage with a erfgooiers game emblem in it

- implement cattle farming with choices of cow, goat and sheep, chicken and pigs to replace pigs only. make sure maps have specific types of animals avaiable (goats in mountains, sheep on texel, etc). make sure that relevant animals have cheese production line, wool, leather, cloth, armor, butcher, etc.

- add performance metrics in the nav bar like fps and ticks?

- increase loudness of background music a bit

- add card to shop: increases carry capacity of serfs to two (uncommon)

- what does Crafting mean in the shop cards? shouldn't this be 'Production' is 18% faster?

- allow aggresion level for unit formations. add another row with: auto-attack, defensive, hold ground

- add mute button in the homescreen panel

- allow spaces in the name of a co-op user. add name field to normal runs too and in settings.

- increase max zoom level, have a toggle in settings for max zoom level so that users can choose to enable it.

- enemy stongholds input field validation for numbers 0-6

- redesign hero's > update effects and names

- shift+click on train buttons should set 5 units in the queue.

- shift+click on sandbox spawn icon should x10 the output

- each tree should give 2 trunks

- level 8 the fortified village should have a 'clear all enemy structures' goal instead

- a castle with units in it after clicking the bell should have additional arrow output. increase the default health of the castle too

- reduce builders to 1 in all levels by default

- level 5 > next raid in 1 min

- only show rally point for barracks when that specific barracks has been selected

- fish should not be able to travel through non-water tiles

- watchtower should only consume wood

- The Vintner's gamble should track trained units at Guild Hall, not military

- improve the cloud designs, make them look more like real clouds, improve the fidelity of the animal shapes that sometimes pass by.

- remove clear save data button from main menu

- when targeting a building when using demolish, show a red outline or something similar to indicate destruction. show returned resources (if any, otherwise warn that no resources are returned)

- remove the melody notes from the songs, i only want pads and chords (use extended chords or chord substitutions to make it more dynamic.) make sure only 1 melody plays at the home screen and continues into the new game. only change the melody on a new run or refresh of the whole page or returning to the home screen. FIXED

- the strongholds in the sandbox should be distributed across the map in different locations, not all in the same corner

- Military pathfind update to villagers:
Good question. There are actually two distinct pieces of pathfinding here, and they benefit villagers differently:

1. The A* + string-pulling (findPath/smooth) — already shared
The core pathfinder in pathfinding.ts — 8-directional A* with road-cost weighting and the string-pull smooth step that turns grid staircases into natural straight lines — is the same code villagers already use. Serfs, builders, carriers, etc. all move through sendTo(), which calls findPath(...) with the unit's faction, and that runs the same smoothing. So any improvement to findPath/smooth already helps villagers automatically. Nothing to wire up there.

2. The flow field (buildFlowField/fieldPath) — military-only, and mostly shouldn't apply to villagers
The genuinely "new for military" part is the shared flow field in flowfield.ts. It's built only on group orders gated by FLOW_FIELD_MIN_UNITS (Game.ts:2245) and consumed only by the combat order code (1400, 1433, 1496). Villagers never touch it.

The reason it isn't (and largely shouldn't be) reused for villagers is that the flow field is a rank-one optimization: its whole win is "many units, one shared destination area" — one reverse-Dijkstra flood replaces hundreds of near-identical A* searches. Villager movement is the opposite shape: each serf heads to a different resource node, storehouse, or build site, so there's no shared destination to amortize. A per-villager flow field would just be a full-map flood feeding one descent — strictly worse than the single A* they already run.

Where it could help villagers
The one place the premise fits is when many villagers converge on the same tile — e.g. a swarm of serfs all hauling to one storehouse door, or a mass of builders dispatched to one construction site. There you'd get the same many-units-one-destination redundancy the flow field was built to kill. Today those still run individual A* through the per-tick path budget (Game.ts:540, 591).

So: the smoothing/A is already doing double duty; the flow field is not, and only worth extending to villagers in the narrow "everyone to the same door" case.* Want me to check whether serf hauling actually bunches enough to make that worthwhile?

the castle is a prime target for serf piling


## Features

- let players pick an emblem out of a selection of colors and symbols in normal run and settings. only 1 player may have 1 specific selection in co-op, let them

- let the dragon in the last level restore health very slowly to annoy the player, in higher ascensions restore speed is increased. let the restore start after a minute of last damage received. TESTING

- in the beginner ascension level, allow destruction of buildings that return the resources fully. in later levels deminish by half, in final levels no resource return.

- add a defensive construction objective level in hard+ ascensions in early levels (build a gated wall with x amount of wall pieces (10/20?), with 4 defense towers), and a harder multi wave defense level where the player has to defend their encampment from ever stronger enemies in higher ascensions. give ample time to build the objective, only after the objective is completed in the level start the waves.

- actually introduce a speedrun like score system in the main menu (warns users in the settings menu when they clear cache this high score settings are destroyed too, pro tip: use export to save runs), let players type in their name when starting a run, and let them select a title after that like: (name) the Brave / the Wise / the Stout / the Drunkard / the Gamer / etc.

- implement unit max caps in the settings to control max unit counts if player is on a slower laptop. also implement a godlike mode for maximum unit counts. do the same for dead bodies and their duration on the battlefield.



- how can we make the levels of hell difficult EXTRA hellishly difficult? it should be actually really hard to defeat them (use maximum size maps and many many enemies, strongholds and difficult objectives). maybe start from the the hell levels from the start?


- add more rare and legendary cards, they are unlocked through achievements. add an achievements menu in the main menu to show which cards have been unlocked, give a hint for cards that have not been unlocked yet. make sure achievements are linked to the save state and exported with the export setting.

- production modal with clear input / output overview > this should be the start of micromanagement side of the game.

- implement a gore mode in the settings that introduces blood spots on bodies and other blood related visual effects. 

- can we also introduce a setting or easter egg in the settings menu to enable the wilhelm scream when units die?



## Epics

- Implement next generation enemy AI in (local) skirmish multiplayer to implement later online multiplayer, with 3 exponantially increasing difficulty levels: Easy, Hard, Godlike > use simulations and machine learning + quantum-inspired algorithms to design an AI that feels 'human-like' based on different core strategies: defensive, offensive, balanced. first implement basic AI as baseline. i want to use this feature to innovate on algorithmic design using stuff like tensor networks and new insights from ML to design innovative experimental AI systems in gaming. the game is actually an optimization problem in disguise. the idea is that tensor networks or ML models can play 'adaptively' based on my own actions. we can probably use a ML technique to let me play against the model and record and adapt my actions to fine tune the enemy ai. let users select the type of AI (classic / any experimental model) when configuring the skirmish.

## Architecture
- move all tests to a proper folder
