fix each of these items, always start with bugs first, then design changes > improvements > features > epics should always be last and first written out as docs/.md file.

## Bugs
- when large groups of units have been selected (100's) there is some performance impact when orders are sent. i think we need to look for unique ways to overcome this. i can already see that different units get different commands in steps over time, perhaps we can improve this by clustering units together in ever smaller groups so that the command is spread out over time? use the priorities of the formation as guidance? investigate if novel linear or quantum-inspired approaches like tensor networks can help us out here? maybe SVD? what about a small ML model somehow? FIXED — shared flow field per group order (one Dijkstra flood from the destination, each unit descends it) replaces one full A* per unit; ~10× cheaper mass orders, host under way in 0.1s instead of drip-feeding over seconds DOING

- no Coal has spawned on the map, this should not be possible. make sure to increase the default amount of coal to accomodate coin and military equipment.

- builders are very often in the way of serfs moving around, blocking the movement. can we fix this?

- when starting a level i want the build menu to always default to the Materials tab.

- in sandbox mode, there was still a small group of enemies coming to my castle as a wave. remove that from the logic.

- when i have a large host of units, then i  have a second host with a lot of siege units. my normal units were attacking enemies, my siege units about to attack a castle wall. suddenly the game performance dropped very badly. seems like a bug?

- priest and archers should keep a distance from enemy units when selected to attack.

- rally point set before building construction was finished did not save correctly to the state of the building. the rallypoint for the building before completion is allowed but should maintain when units are trained.

## Design changes

- re-order all workers order: Villagers first (tooltip should say: Ready to work), Serfs, Builders

- when the game is run on small screens, the sandbox spawn panel does not properly display (the collapse button is underneath the panel. the button to collapse should always be visible.)

- add some spacing in between the fullscreen and mute button 

- villagers not showing in expanded workers panel as a pill (show negative number in the pill of villagers if buildings are missing)

- the 'no curses' pill is now using the whole card width. let it adapt width to its content

- remove tooltip info for rotation when mouse over on the build menu cards, only tooltip for the specific building.

- remove coin requirement for Castle, Market, Monastery, stone watchtower

- move defensive military buildings to 'Fortifications' tab

- move Guild Hall to the left of Castle in build menu

- Some building models have objects running through (saw mill has a log, woodcutter has a log. etc.)

- Barracks model is nice, but needs slightly larger inner cube to reach the outline of the building. add windows like the castle.

- barracks button should have resources under the title and responsive (show resource titles instead of just icons)

- there is something stickout out that looks red in the iron mine. remove that or hang it correctly from the beam.

- the weaponsmith has something orange sticking out of the front door? make this nicer.

- coin and gold share the same icon. can we give the gold coins (the one we use for purchasing in the shop) a unique symbol. maybe a crown inside the coin emblem? > also design a unique coin for heritage with a erfgooiers game emblem in it

- rallypoint flag should be purple for barracks

- improve map tile details to make it look prettier, especially the standard grass tiles

## Improvements
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

- make the mouth of the mountain range wider for levels with enemies, also get more creative with the shape of the mountain range instead of just a circle. > the main castle of ours does not have to be dead center, it can also be in the opposite corner of the enemy. DOING

- remove clear save data button from main menu

- when targeting a building when using demolish, show a red outline or something similar to indicate destruction. show returned resources (if any, otherwise warn that no resources are returned)

- the red arrow above the farm (or other plot buildings) does not appear directly after construction is finished

- remove the melody notes from the songs, i only want pads and chords (use extended chords or chord substitutions to make it more dynamic.) make sure only 1 melody plays at the home screen and continues into the new game. only change the melody on a new run or refresh of the whole page or returning to the home screen. FIXED

- the strongholds in the sandbox should be distributed across the map in different locations, not all in the same corner


## Features

- let players pick an emblem out of a selection of colors and symbols in normal run and settings. only 1 player may have 1 specific selection in co-op, let them

- let the dragon in the last level restore health very slowly to annoy the player, in higher ascensions restore speed is increased. let the restore start after a minute of last damage received. TESTING


- in the coin build tab, add a market building. users can assign additional resources there with an input field and see a timer with expected coin income (per minute?). a great way to monetize overproduction of a resource. a caravan of traders with horses passes by the market, goes in and leaves again automatically. the caravan cannot be attacked or slain by enemies. TESTING



- maybe we need to grey out some of the buildings in early levels in the first ascension to reduce the overload to the user? just enable some beginner things and slowly unlock the build menu throughout the levels. make sure we do not block any objectives, otherwise fix the issue.


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

- we need to help new players to guide them in the objectives. i'm thinking either a modal at the start of the level with a cute, but slowly evolving brutal story that reads like a japanase anime but with a Het Gooi / Netherlands / Europe kind of vibe. almost like lord of the rings? pick names that sound dutch and english at the same time like Henk the Brave, Pieter the Wise, Koenraad the Merciless. the dragon of het gooi in their journey leads them to the alps as they chase him because he attacked het gooi recently. once they get to the alps the dragon flies over the player into the sky and flies down again on het gooi, it was a trap. in the end the player arrives just in time to defeat or get beaten by the dragon. in the modal you show how to produce the objective briefly with hints, as the levels go by the hints get fewer so the player has to put some effort in. when the player wins the first time against the dragon there is a final modal with a congratulations for the player of saving het gooi. in the hard ascension no more story just gameplay, only have the modal to show the objective and the timer and other stats. let users click the objective panel in the game to revisit the modal with instructions. adapt the biomes to the storyline in the first ascension run.

## Architecture
- move all tests to a proper folder

- refactor main.ts to be minimal
