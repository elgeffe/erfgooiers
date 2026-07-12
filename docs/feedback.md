fix each of these items, always start with bugs first, then design changes > improvements > features > epics should always be last and first written out as docs/.md file.

## Bugs

- two serfs walked into each other and got stuck. this should not happen.

- for some reason resources are stored in the Storehouse (rename to Castle btw) and not used by production buildings? even when i set prioritize (rename the button from Prioritize this chain to Prioritize)

## Design changes

- add some spacing in between the fullscreen and mute button 

- improve the cloud designs, make them look more like real clouds, improve the fidelity of the animal shapes that sometimes pass by.


## Improvements




## Features

- add a persistent warning when there are too few villagers or too few serfs. implement a way to visualize both these kpi's as metrics that the user can see in the workers button on the top left. add counts of units, with maybe some metric next to them to indicate if the user has enough of the unit. same for builders.

- let the dragon in the last level restore health very slowly to annoy the player, in higher ascensions restore speed is increased. let the restore start after a minute of last damage received.


- in the coin build tab, add a market building. users can assign additional resources there with an input field and see a timer with expected coin income (per minute?). a great way to monetize overproduction of a resource. a caravan of traders with horses passes by the market, goes in and leaves again automatically. the caravan cannot be attacked or slain by enemies.



- maybe we need to grey out some of the buildings in early levels in the first ascension to reduce the overload to the user? just enable some beginner things and slowly unlock the build menu throughout the levels. make sure we do not block any objectives, otherwise fix the issue.


- in the beginner ascension level, allow destruction of buildings that return the resources fully. in later levels deminish by half, in final levels no resource return.


- add a defensive construction objective level in hard+ ascensions in early levels (build a gated wall with x amount of wall pieces (10/20?), with 4 defense towers), and a harder multi wave defense level where the player has to defend their encampment from ever stronger enemies in higher ascensions. give ample time to build the objective, only after the objective is completed in the level start the waves.

- actually introduce a speedrun like score system in the main menu (warns users in the settings menu when they clear cache this high score settings are destroyed too, pro tip: use export to save runs), let players type in their name when starting a run, and let them select a title after that like: (name) the Brave / the Wise / the Stout / the Drunkard / the Gamer / etc.

- implement unit max caps in the settings to control max unit counts if player is on a slower laptop. also implement a godlike mode for maximum unit counts. do the same for dead bodies and their duration on the battlefield.



- how can we make the levels of hell difficult EXTRA hellishly difficult? it should be actually really hard to defeat them (use maximum size maps and many many enemies, strongholds and difficult objectives). maybe start from the the hell levels from the start?


- add more rare and legendary cards, they are unlocked through achievements. add an achievements menu in the main menu to show which cards have been unlocked, give a hint for cards that have not been unlocked yet. make sure achievements are linked to the save state and exported with the export setting.



- implement a gore mode in the settings that introduces blood spots on bodies and other blood related visual effects. 

- can we also introduce a setting or easter egg in the settings menu to enable the wilhelm scream when units die?




## Epics

- we need to help new players to guide them in the objectives. i'm thinking either a modal at the start of the level with a cute, but slowly evolving brutal story that reads like a japanase anime but with a Het Gooi / Netherlands / Europe kind of vibe. almost like lord of the rings? pick names that sound dutch and english at the same time like Henk the Brave, Pieter the Wise, Koenraad the Merciless. the dragon of het gooi in their journey leads them to the alps as they chase him because he attacked het gooi recently. once they get to the alps the dragon flies over the player into the sky and flies down again on het gooi, it was a trap. in the end the player arrives just in time to defeat or get beaten by the dragon. in the modal you show how to produce the objective briefly with hints, as the levels go by the hints get fewer so the player has to put some effort in. when the player wins the first time against the dragon there is a final modal with a congratulations for the player of saving het gooi. in the hard ascension no more story just gameplay, only have the modal to show the objective and the timer and other stats. let users click the objective panel in the game to revisit the modal with instructions. adapt the biomes to the storyline in the first ascension run.

## Architecture
- move all tests to a proper folder

- refactor main.ts to be minimal