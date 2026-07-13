import { ITEMS } from '../data/items';
import type { BuildingDef, BuildingKey, ItemKey } from '../types';

function itemShapes(key: ItemKey): string {
  switch (key) {
    case 'trunk': return '<rect x="3" y="7" width="17" height="10" rx="5"/><circle cx="19" cy="12" r="4" fill="#d6a269"/><circle cx="19" cy="12" r="2" fill="none" stroke="#71451f" stroke-width="1"/><path d="M5 9l10 6M7 7l10 6" fill="none" stroke="#71451f" stroke-width="1.3"/>';
    case 'timber': return '<path d="M3 6h18v5H3zM5 13h16v5H5z"/><path d="M6 8h10M8 15h9" fill="none" stroke="#7b4d25" stroke-width="1.2"/>';
    case 'stone': return '<path d="M3 16l3-8 7-3 7 5 1 7-5 3H7z"/><path d="M6 9l6 3 7-2M12 12l1 7" fill="none" stroke="#6f7479" stroke-width="1.2"/>';
    case 'wheat': return '<path d="M12 21V5M12 9L8 6M12 12l-5-2M12 15l-5-1M12 9l4-3M12 12l5-2M12 15l5-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 4l2-3 2 3-2 3z"/>';
    case 'flour': return '<path d="M7 4h10l-1 4c3 3 4 9 1 12H7c-3-3-2-9 1-12z"/><path d="M7 8h10M9 13c2-2 4-2 6 0" fill="none" stroke="#a99f8d" stroke-width="1.2"/>';
    case 'bread': return '<path d="M3 14c0-5 4-9 9-9s9 4 9 9v5H3z"/><path d="M8 8l2 4M13 6l2 5M17 8l1 3" fill="none" stroke="#895126" stroke-width="1.4"/>';
    case 'goldore': return '<path d="M3 14l4-8 7-2 7 7-3 8-9 1z"/><path d="M8 8l4 4 5-3M12 12l-2 6" fill="none" stroke="#8e7225" stroke-width="1.1"/>';
    case 'coal': return '<path d="M3 15l3-8 7-3 7 6 1 7-7 3-8-1z"/><path d="M7 8l5 4 7-2M12 12l2 7" fill="none" stroke="#19191d" stroke-width="1.2"/>';
    case 'coin': return '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="6" fill="none" stroke="#a98219" stroke-width="1.4"/><path d="M14.5 8.5c-4-2-6 1-3 3 4 1 3 5-1 4M12 6v12" fill="none" stroke="#a98219" stroke-width="1.3"/>';
    case 'grape': return '<path d="M10 4c2-3 5-3 7-2-1 3-3 5-6 4"/><path d="M12 5v3" fill="none" stroke="#4d6b36" stroke-width="1.5"/><g><circle cx="9" cy="9" r="3"/><circle cx="15" cy="9" r="3"/><circle cx="7" cy="14" r="3"/><circle cx="12" cy="14" r="3"/><circle cx="17" cy="14" r="3"/><circle cx="10" cy="19" r="3"/><circle cx="15" cy="19" r="3"/></g>';
    case 'wine': return '<path d="M8 3h8l-1 7c-.3 2-1.4 3-3 3s-2.7-1-3-3zM12 13v6M8 20h8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 8h5l-.3 2.5c-.2 1-1 1.5-2.2 1.5s-2-.5-2.2-1.5z"/>';
    case 'meat': return '<path d="M4 13c0-5 4-9 9-9 4 0 7 3 7 7 0 5-5 9-10 9-4 0-6-3-6-7z"/><circle cx="13" cy="11" r="3" fill="#f0b8a5"/><circle cx="13" cy="11" r="1.2" fill="#fff0df"/>';
    case 'sausage': return '<path d="M5 7c3-3 6 0 7 3s4 6 7 3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M3 5l3 3M18 12l3 3" fill="none" stroke="#5f2a1d" stroke-width="1.2"/>';
    case 'fish': return '<path d="M3 12l-3-5v10zM3 12c4-6 12-7 18 0-6 7-14 6-18 0z"/><circle cx="16" cy="10.5" r="1.2" fill="#26343b"/><path d="M9 8l3-4 2 5"/>';
    case 'clam': return '<path d="M12 21C5.5 21 2 15 2 8c3 2.5 6.5 4 10 4s7-1.5 10-4c0 7-3.5 13-10 13z"/><path d="M12 12v9M7 11.5l2.5 8M17 11.5l-2.5 8M3.5 10l4 8.5M20.5 10l-4 8.5" fill="none" stroke="#8a7248" stroke-width="1.2"/><circle cx="12" cy="6" r="2.4"/>';
    case 'iron': return '<path d="M5 7h14l3 9-4 3H6l-4-3z"/><path d="M5 7l3 6h11M8 13l-2 6" fill="none" stroke="#633c2c" stroke-width="1.2"/>';
    case 'weapon': return '<path d="M5 20l3-5 8-11 3 1-1 3L9 16z"/><path d="M5 14l5 5M3 20l2-2 2 2-2 2z" fill="none" stroke="#59616a" stroke-width="1.8"/>';
    case 'armor': return '<path d="M12 2l8 3v6c0 5-3 9-8 11-5-2-8-6-8-11V5z"/><path d="M12 5v13M7 9h10" fill="none" stroke="#4f5864" stroke-width="1.3"/>';
  }
}

export function itemIconSVG(key: ItemKey, size = 14, className = 'resicon'): string {
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="color:${ITEMS[key].color};fill:${ITEMS[key].color}">${itemShapes(key)}</svg>`;
}

const OUTPUT_ICON: Partial<Record<BuildingKey, ItemKey>> = {
  woodcutter: 'trunk', sawmill: 'timber', quarry: 'stone', farm: 'wheat', mill: 'flour', bakery: 'bread',
  goldmine: 'goldore', coalmine: 'coal', mint: 'coin', vineyard: 'grape', winery: 'wine', pigfarm: 'meat',
  butcher: 'sausage', fishery: 'fish', clamdigger: 'clam', ironmine: 'iron', smithy: 'weapon', armory: 'armor',
};

function specialMark(key: BuildingKey): string {
  switch (key) {
    case 'storehouse': return '<path d="M8 11h8v7H8zM5 14h3v5H5zM16 13h3v6h-3z"/><path d="M9 13h6M10 16h4" fill="none" stroke="#4c3724"/>';
    case 'guildhall': return '<circle cx="9" cy="11" r="2.5"/><circle cx="15" cy="11" r="2.5"/><path d="M5 18c1-4 7-4 8 0M11 18c1-4 7-4 8 0"/>';
    case 'forester': return '<path d="M12 6l-6 8h4l-3 4h10l-3-4h4zM11 18h2v3h-2z"/><path d="M18 6v5M15.5 8.5h5" fill="none" stroke="#e7d9b9" stroke-width="1.4"/>';
    case 'tavern': return '<path d="M7 9h9v8c0 2-2 3-4.5 3S7 19 7 17zM16 11h2c3 0 3 5 0 5h-2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 6c-1-2 2-2 1-4M14 6c-1-2 2-2 1-4" fill="none" stroke="currentColor"/>';
    case 'stable': return '<path d="M7 18v-6c0-4 4-6 7-4 2 1 3 3 3 5l2-1v4l-2 1v1h-3v-2h-4v2H7z"/><circle cx="14.5" cy="10.5" r=".9" fill="#2b2119"/>';
    case 'engineer': return '<path d="M5 19l7-9M12 10l6 9M12 10V5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="4" r="1.6"/><path d="M4 19h16v2H4z"/>';
    case 'barracks': return '<path d="M6 19l12-14M6 5l12 14M5 7l3-3M16 4l3 3M5 17l3 3M16 20l3-3" fill="none" stroke="currentColor" stroke-width="2.3"/>';
    case 'monastery': return '<path d="M6 20V9h12v11zM9 9V6h6v3"/><path d="M12 3v8M9 6h6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 20v-5c0-3 4-3 4 0v5" fill="#493727"/>';
    case 'market': return '<path d="M4 10h16l-2-5H6zM5 10v10h14V10"/><path d="M8 10v10M16 10v10M5 14h14" fill="none" stroke="#493727"/><circle cx="12" cy="16" r="2" fill="#ffd24a"/>';
    case 'watchtower': case 'enemywatchtower': case 'stonetower': return '<path d="M8 20h8l-1-11H9zM7 6h10v4H7zM6 5h3v3H6zM11 5h3v3h-3zM16 5h3v3h-3z"/><path d="M12 10v10" stroke="#493727"/>';
    case 'wall': case 'enemywall': return '<path d="M4 20V9h16v11z"/><path d="M4 6h4v3H4zM10 6h4v3h-4zM16 6h4v3h-4z"/><path d="M4 13h16M9 9v4M15 9v4M6 13v4M12 13v4M18 13v4" fill="none" stroke="#2b2119"/>';
    case 'gate': case 'enemygate': return '<path d="M4 20V6h4v14zM16 20V6h4v14z"/><path d="M8 6h8v4H8z"/><path d="M9 20v-8c0-4 6-4 6 0v8z" fill="#493727"/><path d="M12 12v8M10 14h4M10 17h4" fill="none" stroke="#2b2119"/>';
    case 'banditcamp': return '<path d="M5 19L12 5l7 14z"/><circle cx="10" cy="14" r="1.5" fill="#2b2119"/><circle cx="14" cy="14" r="1.5" fill="#2b2119"/><path d="M10 18l2-2 2 2" fill="none" stroke="#2b2119"/>';
    case 'enemycastle': return '<path d="M5 20V8h3V5h3v3h3V5h3v3h2v12z"/><path d="M10 20v-5c0-3 4-3 4 0v5" fill="#2b2119"/>';
    default: return '<path d="M6 19V9l6-5 6 5v10z"/>';
  }
}

export function buildingIconSVG(key: BuildingKey, def: BuildingDef): string {
  const roof = `#${def.roof.toString(16).padStart(6, '0')}`, wall = `#${def.wall.toString(16).padStart(6, '0')}`;
  const output = OUTPUT_ICON[key];
  const mark = output
    ? `<g transform="translate(8 6) scale(.68)" style="color:${ITEMS[output].color};fill:${ITEMS[output].color}">${itemShapes(output)}</g>`
    : `<g transform="translate(8 6) scale(.68)" style="color:${def.accent ? `#${def.accent.toString(16).padStart(6, '0')}` : roof};fill:${def.accent ? `#${def.accent.toString(16).padStart(6, '0')}` : roof}">${specialMark(key)}</g>`;
  return `<svg width="38" height="32" viewBox="0 0 40 34" aria-hidden="true"><path d="M4 15L20 3l16 12v16H4z" fill="${wall}" stroke="#211912" stroke-width="1.5"/><path d="M2 16L20 1l18 15-3 3L20 7 5 19z" fill="${roof}" stroke="#211912" stroke-width="1.5"/>${mark}</svg>`;
}
