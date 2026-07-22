import { beforeAll, describe, expect, it } from 'vitest';
import { runSelfPlayMatch } from '../../src/ai/selfplay';
import { extractDataset, datasetToJsonl, macroLabel, FEATURE_NAMES, type DatasetRow } from '../../src/ai/dataset';
import type { Replay } from '../../src/game/replay';

describe('replay dataset extraction', () => {
  let replay: Replay;
  let rows: DatasetRow[];

  beforeAll(() => {
    const match = runSelfPlayMatch({ seed: 8000, p1: 'classic-hard', p2: 'classic-easy', maxSeconds: 120 });
    replay = match.replay;
    rows = extractDataset(replay, { everySeconds: 20, horizonSeconds: 60 });
  });

  it('emits labelled feature rows per seat per snapshot, deterministically', () => {
    expect(rows.length).toBeGreaterThan(10);
    // every row carries the full, fixed feature space
    for (const row of rows) {
      expect(Object.keys(row.features)).toEqual([...FEATURE_NAMES]);
      for (const name of FEATURE_NAMES) expect(typeof row.features[name]).toBe('number');
    }
    // opening snapshot: fresh castle + guild, the granted warband, no economy yet
    const opening = rows.find(row => row.tick === 0 && row.seat === 'p1')!;
    expect(opening.features.own_buildings).toBe(2);
    expect(opening.features.own_army).toBe(6);
    expect(opening.features.has_woodcutter).toBe(0);
    // and the first thing a classic bot does is lay the wood chain
    expect(opening.label).toBe('build:woodcutter');

    // re-simulation is pure: identical seed + replay → identical rows
    const again = extractDataset(replay, { everySeconds: 20, horizonSeconds: 60 });
    expect(again).toEqual(rows);
  }, 120_000);

  it('labels macro intent and excludes micro commands', () => {
    expect(macroLabel(null)).toBe('idle');
    expect(macroLabel({ type: 'placeBuilding', key: 'barracks', x: 1, y: 1, rot: 0 })).toBe('build:barracks');
    expect(macroLabel({ type: 'queueTraining', buildingId: 1, unit: 'soldier' })).toBe('train:soldier');
    expect(macroLabel({ type: 'setBell', active: true })).toBe('other');
  });

  it('serializes to flat JSONL that parses back to the same feature values', () => {
    const jsonl = datasetToJsonl(rows);
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBe(rows.length);
    const first = JSON.parse(lines[0]);
    expect(first.seat).toBe(rows[0].seat);
    expect(first.label).toBe(rows[0].label);
    for (const name of FEATURE_NAMES) expect(first[name]).toBe(rows[0].features[name]);
  }, 120_000);
});
