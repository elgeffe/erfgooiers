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
    story: 'For a hundred quiet years the erfgooiers held the heath of Het Gooi — commoners with an ancient right to the land, answerable to no lord. Then, on a still autumn night, a red light climbed over the Alps far to the south, and by dawn a farmstead near Laren lay in ash. Henk the Brave, chosen speaker of the free-holders, calls the villages to army. But an army marches on more than courage: first it needs timber, and timber needs hands. Raise the first workshops before the danger reaches your own door.',
    how: [
      'Your goal: produce 8 Timber. Watch the objective card, top-right.',
      'From the build menu at the bottom, place a Woodcutter’s Hut next to some trees — serfs carry the timber & stone from your castle, then a builder raises it.',
      'Place a Sawmill nearby: it turns the woodcutter’s trunks into finished Timber.',
      'Open the Guild Hall and train Serfs and Villagers there (cost: 1 coin each).',
      'Tip: click any building to inspect it. Speed the world up with the 3× button, once the chain is flowing.',
    ],
  },
  2: {
    title: 'Bread Before Spears',
    story: 'The army grows, and a growing army grows hungry. Pieter the Wise, an old miller with flour in his beard, reminds the council of a truth every campaign forgets: a warband fed is a warband that fights, and a warband starved simply goes home. Before you sharpen a single blade, fill the granaries. The dragon has not been seen since Laren — but the crows have flown south, and the crows are seldom wrong.',
    how: [
      'Your goal: produce 8 Bread.',
      'Place a Farm and add crop Plots around it (select the farm, then use its Plot button) so a farmer can grow wheat.',
      'Chain it: Farm → Mill (wheat → flour) → Bakery (flour → bread).',
      'A Tavern keeps workers fed and fast — build one once bread is flowing.',
    ],
  },
  3: {
    title: 'The Weight of Coin',
    story: 'Word comes from the passes: the beast was seen escaping south, toward the high stone country. To chase it you will need coin — for coin buys weapons, and weapons give power. Koenraad the Greedy, a mine-captain the villagers only half-trust, offers diggers. He is a hard man and asks no thanks, only that you keep the furnaces lit.',
    how: [
      'Your goal: produce 5 Coin.',
      'Build a Gold Mine on gold deposits and a Coal Mine on coal — mines must sit right on the coloured rocks.',
      'A Mint turns gold ore + coal straight into coins in your treasury.',
      'The Market lets you sell surplus goods to passing traders for extra coin.',
    ],
  },
  4: {
    title: 'The Vintner’s Gamble',
    story: 'On the eve of the march, the free-holders drink to the dead of Het Gooi. Wine loosens tongues, and a scout’s tale hardens every face at the table: the dragon is not fleeing at all — it is leading you on, deeper and deeper from home. Henk sets down his cup. “Then we drink tonight, and die tomorrow. Fill the cellars, and arm my soldiers by dusk.”',
    how: [
      'Your goal: produce the food & wine the contract names, then train 5 fighters.',
      'Wine chain: Vineyard (with plots) → Winery. Keep the bakery running for bread.',
      'To arm troops: Iron Mine → Weaponsmith makes weapons; build a Barracks and train soldiers there.',
    ],
  },
  5: {
    title: 'Raiders at the Gate',
    story: 'They come before you can leave — the dragon’s outriders, a warband of bandits drawn to the smell of a wine and bread. This is the first challenge: bleed the erfgooiers here, and there will be no army to chase anything. Hold the line!',
    how: [
      'Your goal: survive the raids. Grow your army to provoke the first wave, then weather two.',
      'Train at the Barracks; build Watchtowers along the raiders’ path — they shoot on their own.',
      'Box-select fighters (drag), right-click to position them.',
    ],
  },
  6: {
    title: 'The Wild Hunt',
    story: 'The raiders routed, the land itself turns feral in the dragon’s wake — boars and wolves driven mad, encroaching the woods south. A local villager warrants the approaching army. “Please defeat the beasts,” she says, “or they’ll take your lives before any dragon does.”',
    how: [
      'Your goal: hunt down the beasts and survive.',
      'Keep your economy training fresh troops, then send fighters to slay the packs on the map.',
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

/** A proud, self-contained victory banner for the dragon-slain modal: a golden
 *  sunrise over Het Gooi and a lone armoured knight on the mound with their
 *  sword raised high. Inline SVG (no external asset), sized to the modal width
 *  and theme-agnostic. */
export const VICTORY_IMAGE = `
<svg viewBox="0 0 440 168" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="A knight raises their sword in victory" style="display:block">
  <defs>
    <linearGradient id="vsky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a2b4a"/><stop offset=".5" stop-color="#8a4a3a"/><stop offset="1" stop-color="#e0a341"/>
    </linearGradient>
    <radialGradient id="vsun" cx="50%" cy="90%" r="62%">
      <stop offset="0" stop-color="#ffe9a8"/><stop offset=".5" stop-color="#ffd24a" stop-opacity=".9"/><stop offset="1" stop-color="#ffd24a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="vsteel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eef2f7"/><stop offset="1" stop-color="#98a2ae"/>
    </linearGradient>
  </defs>
  <rect width="440" height="168" fill="url(#vsky)"/>
  <circle cx="220" cy="150" r="140" fill="url(#vsun)"/>
  <g stroke="#ffe9a8" stroke-width="2" opacity=".42" stroke-linecap="round">
    <path d="M220 150 L120 10"/><path d="M220 150 L180 4"/><path d="M220 150 L260 4"/><path d="M220 150 L320 10"/><path d="M220 150 L50 66"/><path d="M220 150 L390 66"/>
  </g>
  <path d="M0 150 Q90 116 180 138 T440 128 V168 H0 Z" fill="#3f6d3a"/>
  <path d="M0 168 Q120 132 250 152 T440 150 V168 H0 Z" fill="#2f5330"/>
  <!-- the victorious knight on the central mound, sword raised high -->
  <g transform="translate(214 78)">
    <ellipse cx="6" cy="70" rx="38" ry="8" fill="#284226"/>
    <!-- legs in plate -->
    <rect x="-3" y="44" width="8" height="24" rx="3" fill="#6a7480"/>
    <rect x="9" y="44" width="8" height="24" rx="3" fill="#5c6672"/>
    <!-- torso in steel plate with a red surcoat -->
    <path d="M-9 20 Q6 11 21 20 L18 47 Q6 53 -6 47 Z" fill="url(#vsteel)"/>
    <path d="M-3 30 L15 30 L11 49 L1 49 Z" fill="#7b2233"/>
    <path d="M6 16 L6 47" stroke="#7d8794" stroke-width="1.2"/>
    <!-- shield-side arm, lowered at the flank -->
    <path d="M-8 24 L-14 46" stroke="#9aa4b0" stroke-width="6" stroke-linecap="round"/>
    <!-- helm with a proud plume -->
    <circle cx="6" cy="8" r="9" fill="url(#vsteel)"/>
    <rect x="1" y="5" width="10" height="3" fill="#3a4048"/>
    <path d="M6 -1 q11 -9 5 -21 q-3 11 -9 13 Z" fill="#c9354a"/>
    <!-- sword arm thrust to the sky -->
    <path d="M19 22 L35 -6" stroke="#9aa4b0" stroke-width="6" stroke-linecap="round"/>
    <path d="M35 -6 L47 -48" stroke="#dfe6ee" stroke-width="5" stroke-linecap="round"/>
    <path d="M30 -4 L44 -8" stroke="#c9a94e" stroke-width="4" stroke-linecap="round"/>
    <circle cx="48" cy="-50" r="3.6" fill="#fff3c4"/>
  </g>
  <g fill="#ffe9a8" opacity=".85">
    <circle cx="70" cy="30" r="2"/><circle cx="110" cy="52" r="1.6"/><circle cx="350" cy="30" r="2"/><circle cx="392" cy="54" r="1.6"/><circle cx="250" cy="20" r="1.6"/>
  </g>
</svg>`;

/** The one-time congratulations shown when the dragon falls on Normal — the
 *  reward for the whole first-ascension journey, and the doorway to Hard. */
export const VICTORY_STORY = {
  title: 'Het Gooi Stands',
  story: 'The dragon falls, and the fires with it. In the grey dawn the erfgooiers walk their scorched heath and begin, as they always have, to rebuild — free commoners on their own free land. Bards will sing of Henk the Brave and the army that chased a dragon to the world’s edge and dragged it home to die. Your first watch is ended. But the old songs warn that a beast slain is not a beast gone forever, and harder roads wait for those bold enough to walk them.',
  cta: 'You have completed the Normal campaign. The Hard ascension is now open from the main menu — thinner armies, a longer march into stranger lands, and no more stories to hold your hand. Ready when you are.',
};
