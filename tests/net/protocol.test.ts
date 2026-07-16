import { describe, expect, it } from 'vitest';
import { CONTENT_VERSION, MAX_BATCH_CELLS, MAX_ORDER_UNITS, PLAYER_COLOR_PRESETS, PROTOCOL_VERSION, parseClientMessage, roomCompatible } from '../../src/net/protocol';

describe('network protocol validation', () => {
  it('accepts bounded gameplay commands', () => {
    const parsed = parseClientMessage(JSON.stringify({
      type: 'command',
      commandId: 'p2-12',
      command: { type: 'sendTrade', item: 'timber', amount: 8, sourceId: 4, destinationId: 9 },
    }));
    expect(parsed.ok).toBe(true);
  });

  it('rejects malformed, oversized, and unknown commands', () => {
    expect(parseClientMessage('{nope').ok).toBe(false);
    expect(parseClientMessage({ type: 'command', commandId: 'x', command: { type: 'sendTrade', item: 'timber', amount: 0, sourceId: 4, destinationId: 9 } }).ok).toBe(false);
    expect(parseClientMessage({ type: 'command', commandId: 'x', command: { type: 'paintRoad', cells: Array.from({ length: MAX_BATCH_CELLS + 1 }, () => ({ x: 1, y: 1 })) } }).ok).toBe(false);
    expect(parseClientMessage({ type: 'command', commandId: 'x', command: { type: 'winNow' } }).ok).toBe(false);
  });

  it('accepts a whole large army as one formation command', () => {
    const command = (unitIds: number[]) => ({
      type: 'command', commandId: 'p1-army',
      command: { type: 'orderUnits', unitIds, order: { type: 'attackMove', x: 20, y: 20 }, formation: 'box' },
    });
    expect(parseClientMessage(command(Array.from({ length: 1000 }, (_, i) => i + 1))).ok).toBe(true);
    expect(parseClientMessage(command(Array.from({ length: MAX_ORDER_UNITS + 1 }, (_, i) => i + 1))).ok).toBe(false);
  });

  it('bounds checkpoint payloads and validates control messages', () => {
    expect(parseClientMessage({ type: 'ready', ready: true }).ok).toBe(true);
    expect(parseClientMessage({ type: 'ping', sentAt: 123.5 }).ok).toBe(true);
    expect(parseClientMessage({ type: 'checkpoint', tick: -1, sequence: 0, payload: '' }).ok).toBe(false);
  });

  it('accepts a lobby loadout with a preset colour and hero, and rejects off-palette picks', () => {
    expect(parseClientMessage({ type: 'setLoadout', color: PLAYER_COLOR_PRESETS[0], hero: 'warlord' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'setLoadout', color: PLAYER_COLOR_PRESETS[2], hero: null }).ok).toBe(true);
    expect(parseClientMessage({ type: 'setLoadout', color: '#ffffff', hero: null }).ok).toBe(false);
    expect(parseClientMessage({ type: 'setLoadout', color: PLAYER_COLOR_PRESETS[0], hero: 42 }).ok).toBe(false);
  });

  it('rejects incompatible room versions', () => {
    expect(roomCompatible({ protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION })).toBe(true);
    expect(roomCompatible({ protocolVersion: PROTOCOL_VERSION + 1, contentVersion: CONTENT_VERSION })).toBe(false);
  });
});
