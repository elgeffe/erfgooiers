/**
 * The first-ascension story — a briefing modal that opens each Normal-tier
 * level. One evolving paragraph in a Het Gooi / Low-Lands-meets-Tolkien key
 * (names that ring both Dutch and English: Henk the Brave, Pieter the Wise,
 * Koenraad the Merciless), followed by concrete instructions for the level's
 * objective. The instructions thin out as the run goes on — the opening levels
 * spell out every step, the later ones only nudge — so the player is weaned off
 * the hand-holding. The arc: a dragon scorches Het Gooi, the erfgooiers muster
 * and give chase toward the far mountains, the beast doubles back in a trap,
 * and the run ends in one last stand for the heath. Shown only at ascension 0;
 * harder tiers get no story (see StoryModal / main.startLevel).
 */
export interface LevelStory {
  /** A short evocative chapter title. */
  title: string;
  /** One paragraph of story — the evolving, slowly-darkening thread. */
  story: string;
  /** How to achieve the objective. Fewer, terser lines as the run advances. */
  how: string[];
}

export const LEVEL_STORY: Record<number, LevelStory> = {
  1: {
    title: 'The Ember on the Horizon',
    story: 'For a hundred quiet years the erfgooiers held the heath of Het Gooi — commoners with an ancient right to the land, answerable to no lord. Then, on a still autumn night, a red light climbed over the Alps far to the south, and by dawn a farmstead near Laren lay in ash. Henk the Brave, chosen speaker of the free-holders, calls the villages to muster. But an army marches on more than courage: first it needs timber, and timber needs hands. Raise the first workshops before the smoke reaches your own door.',
    how: [
      'Your goal: produce 8 Timber. Watch the objective card, top-right.',
      'From the build menu at the bottom, place a Woodcutter’s Hut next to some trees — serfs carry the timber & stone from your castle, then a builder raises it.',
      'Place a Sawmill nearby: it turns the woodcutter’s trunks into finished Timber.',
      'Build a Guild Hall and train Villagers there (cost: 1 coin each) — each one walks out to staff an empty workshop.',
      'Tip: click any building to inspect it. Speed the world up with the 3× button, top-left, once the chain is flowing.',
    ],
  },
  2: {
    title: 'Bread Before Spears',
    story: 'The muster grows, and a growing muster grows hungry. Pieter the Wise, an old miller with flour in his beard, reminds the council of a truth every campaign forgets: a warband fed is a warband that fights, and a warband starved simply goes home. Before you sharpen a single blade, fill the granaries. The dragon has not been seen since Laren — but the crows have flown south, and the crows are seldom wrong.',
    how: [
      'Your goal: produce 8 Bread.',
      'Place a Farm and add crop Plots around it (select the farm, then use its Plot button) so a farmer can grow wheat.',
      'Chain it: Farm → Mill (wheat → flour) → Bakery (flour → bread).',
      'A Tavern keeps workers fed and fast — build one once bread is flowing.',
    ],
  },
  3: {
    title: 'The Weight of Coin',
    story: 'Word comes from the passes: the beast was seen wheeling south, toward the high stone country. To chase it you will need coin — for coin buys weapons, and weapons buy time. Koenraad, a mine-captain the villagers only half-trust, offers his diggers. He is a hard man and asks no thanks, only that you keep the furnaces lit.',
    how: [
      'Your goal: produce 5 Coin.',
      'Build a Gold Mine on gold deposits and a Coal Mine on coal — mines must sit right on the coloured rocks.',
      'A Mint turns gold ore + coal straight into coins in your treasury.',
      'The Market lets you sell surplus goods to passing traders for extra coin.',
    ],
  },
  4: {
    title: 'The Vintner’s Gamble',
    story: 'On the eve of the march, the free-holders drink to the dead of Laren. Wine loosens tongues, and a scout’s tale hardens every face at the table: the dragon is not fleeing at all — it is leading you on, deeper and deeper from home. Henk sets down his cup. “Then we drink tonight, and drill tomorrow. Fill the cellars, and give me soldiers by dusk.”',
    how: [
      'Your goal: produce the food & wine the contract names, then train 5 fighters.',
      'Wine chain: Vineyard (with plots) → Winery. Keep the bakery running for bread.',
      'To arm troops: Iron Mine → Weaponsmith makes weapons; build a Barracks and train soldiers there.',
    ],
  },
  5: {
    title: 'Raiders at the Gate',
    story: 'They come before you can leave — the dragon’s outriders, a warband of bandits drawn to the smell of a rich, distracted village. This is the trap’s first jaw: bleed the erfgooiers here, and there will be no army to chase anything. Hold the heath.',
    how: [
      'Your goal: survive the raids. Grow your muster to provoke the first wave, then weather two.',
      'Train at the Barracks; build Watchtowers along the raiders’ path — they shoot on their own.',
      'Box-select fighters (drag), right-click to position them at the gate.',
    ],
  },
  6: {
    title: 'The Wild Hunt',
    story: 'The raiders broken, the land itself turns feral in the dragon’s wake — boars and wolves driven mad, fouling the roads south. Vrouwe Aefke, huntress of the eastern woods, joins the column with her hounds. “Clear the beasts,” she says, “or they’ll take your baggage train before any dragon does.”',
    how: [
      'Your goal: hunt down the beasts the contract names.',
      'Keep your economy arming fresh troops, then send fighters to kill the packs on the map.',
    ],
  },
  7: {
    title: 'Bandit Country',
    story: 'You cross into the marches at last — a broken frontier of camps and cutthroats who took the dragon’s coin. Beyond the mountain pass lies the road south, and the road south is barred. Break the bandit holds and force the gap.',
    how: [
      'Your goal: destroy the enemy structures.',
      'March your army through the pass and besiege their camps — right-click walls and buildings to attack them.',
    ],
  },
  8: {
    title: 'The Fortified Village',
    story: 'Deeper south the dead keep watch. A village long dead mans its own walls — skeletons on the ramparts, and something older stirring behind the gate. Koenraad spits. “The beast leaves graves for a rearguard. It knows we’re close.”',
    how: [
      'Your goal: raze the fortified village’s structures. Bring siege patience and numbers.',
    ],
  },
  9: {
    title: 'The Enemy Keep',
    story: 'The last hold before the peaks: a demon-crowned keep barring the final pass. Take it, and the dragon’s own lair lies open beyond. But a runner has come from the north, grey-faced and half-dead — Het Gooi is burning. The trap has closed. The dragon was never ahead of you at all.',
    how: [
      'Your goal: break the keep. Then turn for home — everything has led here.',
    ],
  },
  10: {
    title: 'Dragon’s Hoard',
    story: 'You arrive as the sun sets red over the heath, and the dragon of Het Gooi turns from the ruin of your home to face the ragged army that chased it across a continent. Henk the Brave, or what the road left of him, raises his blade one last time. This is the end of the hunt. Save Het Gooi, or fall with it.',
    how: [
      'Your goal: slay the dragon. Muster everything and end it.',
    ],
  },
};

/** Fetch a level's story chapter (undefined outside the campaign's 1..10). */
export function storyFor(level: number): LevelStory | undefined {
  return LEVEL_STORY[level];
}

/** The one-time congratulations shown when the dragon falls on Normal — the
 *  reward for the whole first-ascension journey, and the doorway to Hard. */
export const VICTORY_STORY = {
  title: 'Het Gooi Stands',
  story: 'The dragon falls, and the fires with it. In the grey dawn the erfgooiers walk their scorched heath and begin, as they always have, to rebuild — free commoners on their own free land. Bards will sing of Henk the Brave and the army that chased a dragon to the world’s edge and dragged it home to die. Your first watch is ended. But the old songs warn that a beast slain is not a beast gone forever, and harder roads wait for those bold enough to walk them.',
  cta: 'You have completed the Normal campaign. The Hard ascension is now open from the main menu — thinner armies, a longer march into stranger lands, and no more stories to hold your hand. Ready when you are.',
};
