import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RoomSettings, ServerMessage } from '../src/net/protocol';
import { createCoOpServer } from './server';

const settings: RoomSettings = {
  visibility: 'public', roomName: 'Socket Polder', region: 'test',
  difficulty: 'journey', mode: 'sandbox', passwordProtected: false,
};

const apps: Array<ReturnType<typeof createCoOpServer>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('co-op HTTP/WebSocket service', () => {
  it('creates, lists, joins, and relays ordered commands', async () => {
    const app = createCoOpServer(); apps.push(app);
    const port = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const host = await post(`${base}/v1/rooms`, { playerName: 'Ada', settings });
    const guest = await post(`${base}/v1/rooms/${host.room.inviteCode}/join`, { playerName: 'Bram' });
    const listed = await fetch(`${base}/v1/rooms`).then(r => r.json()) as any;
    expect(listed.rooms).toEqual([expect.objectContaining({ players: 2, roomName: 'Socket Polder' })]);

    const hostWs = await connect(port, host.ticket);
    const guestWs = await connect(port, guest.ticket);
    const hostMessages = collect(hostWs);
    const guestMessages = collect(guestWs);
    hostWs.send(JSON.stringify({ type: 'hostTick', tick: 20 }));
    hostWs.send(JSON.stringify({ type: 'ping', sentAt: 1 }));
    await waitFor(hostMessages, message => message.type === 'pong');
    guestWs.send(JSON.stringify({ type: 'command', commandId: 'g-1', command: { type: 'setBell', active: true } }));
    const accepted = await waitFor(guestMessages, message => message.type === 'commandAccepted');
    expect(accepted).toMatchObject({ accepted: { playerId: 'p2', sequence: 1, applyTick: 22 } });
    expect(await waitFor(hostMessages, message => message.type === 'commandAccepted')).toMatchObject({ accepted: { commandId: 'g-1' } });
    hostWs.close(); guestWs.close();
  });

  it('rejoins the same seat through the invite endpoint', async () => {
    const app = createCoOpServer(); apps.push(app);
    const port = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const host = await post(`${base}/v1/rooms`, { playerName: 'Ada', settings });
    const first = await post(`${base}/v1/rooms/${host.room.inviteCode}/join`, { playerName: 'Bram' });
    const firstWs = await connect(port, first.ticket);
    firstWs.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    const rejoined = await post(`${base}/v1/rooms/${host.room.inviteCode}/rejoin`, {
      playerName: 'Bram', reconnectSecret: first.reconnectSecret,
    });
    expect(rejoined).toMatchObject({ status: 'joined', grant: { playerId: 'p2' } });
  });

  it('delivers lost-secret reclaim requests to the connected teammate', async () => {
    const app = createCoOpServer(); apps.push(app);
    const port = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const host = await post(`${base}/v1/rooms`, { playerName: 'Ada', settings });
    const guest = await post(`${base}/v1/rooms/${host.room.inviteCode}/join`, { playerName: 'Bram' });
    const hostWs = await connect(port, host.ticket);
    const guestWs = await connect(port, guest.ticket);
    const hostMessages = collect(hostWs);
    guestWs.close();
    await waitFor(hostMessages, message => message.type === 'roomState' && message.room.players.some(player => player.id === 'p2' && player.presence === 'offline'));

    const pending = await post(`${base}/v1/rooms/${host.room.inviteCode}/rejoin`, { playerName: 'Bram on laptop' });
    expect(pending.status).toBe('pending');
    const request = await waitFor(hostMessages, message => message.type === 'reclaimRequested');
    expect(request).toMatchObject({ seat: 'p2', playerName: 'Bram on laptop' });
    hostWs.send(JSON.stringify({ type: 'reclaimDecision', requestId: pending.requestId, approve: true }));

    let approved: any = null;
    for (let i = 0; i < 100 && !approved; i++) {
      const status = await fetch(`${base}/v1/reclaims/${pending.requestId}`).then(r => r.json()) as any;
      if (status.status === 'approved') approved = status;
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(approved).toMatchObject({ status: 'approved', grant: { playerId: 'p2' } });
    hostWs.close();
  });
});

async function post(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function connect(port: number, ticket: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session?ticket=${encodeURIComponent(ticket)}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

function collect(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  return messages;
}

async function waitFor(messages: ServerMessage[], predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Message not received: ${JSON.stringify(messages)}`);
}
