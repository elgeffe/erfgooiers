import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFS } from '../../src/data/buildings';
import { makeBuilding } from '../../src/render/buildingModels';

/** True when any mesh in the group carries a material of the given colour. */
function hasColor(group: THREE.Object3D, hex: number): boolean {
  let found = false;
  group.traverse(object => {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (material?.color && material.color.getHex() === hex) found = true;
  });
  return found;
}

const CO_OP = 0x123456; // a colour no building palette uses on its own

describe('co-op player building colour', () => {
  it('repaints a roofed building with the player colour, leaving single player untouched', () => {
    expect(hasColor(makeBuilding('barracks', DEFS.barracks, false, CO_OP), CO_OP)).toBe(true);
    expect(hasColor(makeBuilding('barracks', DEFS.barracks, false), CO_OP)).toBe(false);
  });

  it('keeps a mine mound grey while colouring its headframe attachment', () => {
    const tinted = makeBuilding('goldmine', DEFS.goldmine, false, CO_OP);
    expect(hasColor(tinted, CO_OP)).toBe(true);              // headframe took the colour
    expect(hasColor(tinted, DEFS.goldmine.wall)).toBe(true); // mound kept its own wall colour
  });

  it('colours the quarry derrick but not its rock steps', () => {
    const tinted = makeBuilding('quarry', DEFS.quarry, false, CO_OP);
    expect(hasColor(tinted, CO_OP)).toBe(true);
    expect(hasColor(tinted, DEFS.quarry.wall)).toBe(true);
  });
});
