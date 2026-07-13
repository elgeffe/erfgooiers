import { describe, expect, it } from 'vitest';
import { CONTENT_VERSION, MAX_BATCH_CELLS, PROTOCOL_VERSION, parseClientMessage, roomCompatible } from './protocol';

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

  it('bounds checkpoint payloads and validates control messages', () => {
    expect(parseClientMessage({ type: 'ready', ready: true }).ok).toBe(true);
    expect(parseClientMessage({ type: 'ping', sentAt: 123.5 }).ok).toBe(true);
    expect(parseClientMessage({ type: 'checkpoint', tick: -1, sequence: 0, payload: '' }).ok).toBe(false);
  });

  it('rejects incompatible room versions', () => {
    expect(roomCompatible({ protocolVersion: PROTOCOL_VERSION, contentVersion: CONTENT_VERSION })).toBe(true);
    expect(roomCompatible({ protocolVersion: PROTOCOL_VERSION + 1, contentVersion: CONTENT_VERSION })).toBe(false);
  });
});
