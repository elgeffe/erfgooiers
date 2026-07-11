import { describe, expect, it } from 'vitest';
import type { RoomSettings } from '../src/net/protocol';
import { RoomError, RoomStore } from './RoomStore';

const settings: RoomSettings = {
  visibility: 'public', roomName: 'Polder Friends', region: 'eu-west',
  difficulty: 'journey', mode: 'expedition', passwordProtected: false,
};

describe('RoomStore', () => {
  it('creates and lists rooms without exposing credentials', () => {
    const store = new RoomStore(() => 1000);
    const host = store.createRoom({ playerName: 'Ada', settings });
    expect(host.playerId).toBe('p1');
    expect(host.room.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(store.listPublic()).toEqual([expect.objectContaining({ roomName: 'Polder Friends', hostName: 'Ada', players: 1 })]);
  });

  it('reserves two seats and reconnects the original owner by secret', () => {
    const store = new RoomStore(() => 1000);
    const host = store.createRoom({ playerName: 'Ada', settings });
    const guest = store.join(host.room.inviteCode, 'Bram');
    store.consumeTicket(host.ticket);
    store.consumeTicket(guest.ticket);
    store.disconnect(host.room.id, 'p2');
    const result = store.rejoin(host.room.inviteCode, 'Bram', guest.reconnectSecret);
    expect(result.status).toBe('joined');
    if (result.status === 'joined') expect(result.grant.playerId).toBe('p2');
    expect(() => store.join(host.room.inviteCode, 'Intruder')).toThrowError(RoomError);
  });

  it('requires connected-peer approval when a reconnect secret is lost', () => {
    let now = 1000;
    const store = new RoomStore(() => now);
    const host = store.createRoom({ playerName: 'Ada', settings });
    const guest = store.join(host.room.inviteCode, 'Bram');
    store.consumeTicket(host.ticket);
    store.consumeTicket(guest.ticket);
    store.disconnect(host.room.id, 'p2');
    const pending = store.rejoin(host.room.inviteCode, 'Bram on laptop');
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') return;
    store.decideReclaim(host.room.id, 'p1', pending.requestId, true);
    const status = store.reclaimStatus(pending.requestId);
    expect(status.status).toBe('approved');
    expect(status.grant?.playerId).toBe('p2');
    expect(status.grant?.reconnectSecret).toBeTruthy();
    expect(() => store.rejoin(host.room.inviteCode, 'Old Bram', guest.reconnectSecret)).toThrowError(RoomError);
    now += 1;
  });

  it('orders commands from both owners against the host tick', () => {
    const store = new RoomStore(() => 1000);
    const host = store.createRoom({ playerName: 'Ada', settings });
    const guest = store.join(host.room.inviteCode, 'Bram');
    store.updateHostTick(host.room.id, 'p1', 40);
    const a = store.acceptCommand(host.room.id, 'p2', 'g-1', { type: 'setBell', active: true });
    const b = store.acceptCommand(host.room.id, 'p1', 'h-1', { type: 'demolish', x: 2, y: 3 });
    expect(a).toMatchObject({ playerId: 'p2', sequence: 1, applyTick: 42 });
    expect(b).toMatchObject({ playerId: 'p1', sequence: 2, applyTick: 42 });
    expect(() => store.updateHostTick(host.room.id, guest.playerId, 41)).toThrowError(RoomError);
  });

  it('retains the latest host checkpoint and rejects guest uploads', () => {
    const store = new RoomStore(() => 1000);
    const host = store.createRoom({ playerName: 'Ada', settings });
    store.saveCheckpoint(host.room.id, 'p1', { tick: 0, sequence: 0, payload: 'checkpoint' });
    expect(store.checkpoint(host.room.id)?.payload).toBe('checkpoint');
    expect(() => store.saveCheckpoint(host.room.id, 'p2', { tick: 0, sequence: 0, payload: 'bad' })).toThrowError(RoomError);
  });
});
