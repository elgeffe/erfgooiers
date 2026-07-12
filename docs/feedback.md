fix each of these items, always start with bugs first, then design changes > improvements > features > epics should always be last and first written out as docs/.md file.

## Bugs

- formations are broken, when i select a large number of units not all of them move. fix the bug. while looking at this, improve fps performance when large number of units are moving and getting commands, push it to the limit of your capabilities

- implement priority system for resource buildings too so serfs also prioritize chains. the game has a problem that important buildings have full output, i have a bunch of serfs running around but no output is picked up. this is halting progress in objectives.

- the coal mine has some kind of black square section sticking out, remove it.

- the objective panel is sometimes touching the building panel when i have a building or unit open, give them some space in between.

- let messages and timers not overlay each other in the top, fix this bug.

- in bandit country objective, the enemy camps spawned inside the mouth of the mountain range, also because there is a large body of water on the other side. update the map generation to prevent this situation. let enemy encampments also spawn inside the mountain range area.

- in dragon's hoard, enemy encampments where spawned inside the player area to close to the castle. we should prevent this.

## Design changes

- walls should not have entrances. gates should have entrances on both sides and 2 wide.

- the woodcutter building should have the logwalls rotated 90 degrees so that they align with the bottom of the rooftop. there should be an open entrance, unless you can fix it to be a fully logged 4 walls?

- the little blue flag on the school building should be removed.

- water should not be a selectable in the sandbox menu, it should be linked to the biome selection.

- show the text of the curse in the shop on the card so i can see what the curse is.

## Improvements

- let me purchase cards in sandbox mode in the card menu for free up to 5 cards.

- trebuchet weapons should have high damage against all structural buildings such as walls and castles, etc.

- maybe we need to grey out some of the buildings in early levels in the first ascension to reduce the overload to the user? just enable some beginner things and slowly unlock the build menu throughout the levels. make sure we do not block any objectives, otherwise fix the issue.

- let the dragon in the last level restore health very slowly to annoy the player, in higher ascensions restore speed is increased. let the restore start after a minute of last damage received.

- increase difficulty of later ascensions in the dragon level by first objective: kill all the enemy encampments and fortresses, only then the dragon randomly appears on the map in the next section of the level. in higher ascensions increase the number of enemy units significantly.

- the boar hunt should have a larger map on higher ascensions levels.

- increase the difficulty of higher ascension levels by increasing the number of enemies significantly and also making the objective the exact amount that has spawned on the map (buildings and units), or just make it 'clear all enemy units and buildings, survive all raids' as objective. increase the enemy wave configuration with more enemies and diverse enemies per wave.

- how can we make the levels of hell difficult EXTRA hellishly difficult? it should be actually really hard to defeat them (use maximum size maps and many many enemies, strongholds and difficult objectives). maybe start from the the hell levels from the start?

- in sandbox mode, i meant that number of strongholds should be 6 other castles with walls and towers across the map in the corners and behind mountain ranges or walls / forests.

- change enemies menu to toggles to include wild beasts, bandit camps, the other option is number of strongholds (as the enemies say = none, then input field for number of strongholds until max 6).

- keep wild beast detection as is, but increase detection sensitivity for enemy units.

- improve the sound effect of friendly melee attacks and enemy attacks for each type of unit.

## Features

- implement a few new beginning motifs and start them randomly. i want a random one to load at startup and at the first levels to give the player some more variety. i'm thinking: a few different modal jazz motifs (refactor the audio engine if needed for better architecture). a retro 8bit inspired motif.

- i want 360 degree right click hold formation.

- add a column formation too.

- introduce a priest unit (with a christian pointy hat) that can be purchased with coin at a monestary building (give it a proper design). it can heal friendly units who are nearby automatically. they have a low rank and are far in the back when in formation.

- in the coin build tab, add a market building. users can assign additional resources there with an input field and see a timer with expected coin income (per minute?). a great way to monetize overproduction of a resource. a caravan of traders with horses passes by the market, goes in and leaves again automatically. the caravan cannot be attacked or slain by enemies.

- use shift+click to chain commands.

- implement unit max caps in the settings to control max unit counts if player is on a slower laptop. also implement a godlike mode for maximum unit counts. do the same for dead bodies and their duration on the battlefield.

- implement a gore mode in the settings that introduces blood spots on bodies and other blood related visual effects. can we also introduce a setting or easter egg in the settings menu to enable the wilhelm scream when units die?

- in the beginner ascension level, allow destruction of buildings that return the resources fully. in later levels deminish by half, in final levels no resource return.

- add a defensive construction objective level in hard+ ascensions in early levels (build a gated wall with x amount of wall pieces (10/20?), with 4 defense towers), and a harder multi wave defense level where the player has to defend their encampment from ever stronger enemies in higher ascensions. give ample time to build the objective, only after the objective is completed in the level start the waves.

- actually introduce a speedrun like score system in the main menu (warns users in the settings menu when they clear cache this high score settings are destroyed too, pro tip: use export to save runs), let players type in their name when starting a run, and let them select a title after that like: (name) the Brave / the Wise / the Stout / the Drunkard / the Gamer / etc.

- add a persistent warning when there are too few villagers or too few serfs. implement a way to visualize both these kpi's as metrics that the user can see in the workers button on the top left. add counts of units, with maybe some metric next to them to indicate if the user has enough of the unit. same for builders.

- should we add??: when buildings are training, add a floating clock icon above them to indicate that training is being done. add a empty and full resources floating icon above buildings.

- heritage and power ups in sandbox should be a modal with responsive design and cards. copy the ux of the shop for this purpose. let me select and remove cards as i wish.

- add more rare and legendary cards, they are unlocked through achievements. add an achievements menu in the main menu to show which cards have been unlocked, give a hint for cards that have not been unlocked yet. make sure achievements are linked to the save state and exported with the export setting.

- in the modal for enemies in the sandbox, let me input for each type of enemy how many should arrive individually.

## Epics

- we need to help new players to guide them in the objectives. i'm thinking either a modal at the start of the level with a cute, but slowly evolving brutal story that reads like a japanase anime but with a Het Gooi / Netherlands / Europe kind of vibe. almost like lord of the rings? pick names that sound dutch and english at the same time like Henk the Brave, Pieter the Wise, Koenraad the Merciless. the dragon of het gooi in their journey leads them to the alps as they chase him because he attacked het gooi recently. once they get to the alps the dragon flies over the player into the sky and flies down again on het gooi, it was a trap. in the end the player arrives just in time to defeat or get beaten by the dragon. in the modal you show how to produce the objective briefly with hints, as the levels go by the hints get fewer so the player has to put some effort in. when the player wins the first time against the dragon there is a final modal with a congratulations for the player of saving het gooi. in the hard ascension no more story just gameplay, only have the modal to show the objective and the timer and other stats. let users click the objective panel in the game to revisit the modal with instructions. adapt the biomes to the storyline in the first ascension run.
