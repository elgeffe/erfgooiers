import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from '../src/net/protocol';
import type { PlayerId } from '../src/types';
import { RoomError, RoomStore, type CreateRoomInput } from './RoomStore';

interface LiveSession {
  ws: WebSocket;
  roomId: string;
  playerId: PlayerId;
  windowStartedAt: number;
  messagesInWindow: number;
}

export interface CoOpServerOptions {
  store?: RoomStore;
  allowedOrigins?: string[];
}

export function createCoOpServer(options: CoOpServerOptions = {}) {
  const store = options.store ?? new RoomStore();
  const allowedOrigins = new Set(options.allowedOrigins ?? localOrigins());
  const sessions = new Map<string, LiveSession>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const server = createServer(async (req, res) => {
    try {
      if (!originAllowed(req, allowedOrigins)) throw new RoomError('origin_denied', 'Request origin is not allowed', 403);
      setCors(req, res, allowedOrigins);
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      await routeHttp(req, res, store);
    } catch (error) {
      sendError(res, error);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      if (!originAllowed(req, allowedOrigins)) throw new RoomError('origin_denied', 'Request origin is not allowed', 403);
      const url = requestUrl(req);
      if (url.pathname !== '/v1/session') throw new RoomError('not_found', 'WebSocket endpoint not found', 404);
      const ticket = url.searchParams.get('ticket');
      if (!ticket) throw new RoomError('missing_ticket', 'Session ticket is required', 401);
      const joined = store.consumeTicket(ticket);
      wss.handleUpgrade(req, socket, head, ws => {
        attachSession(ws, joined.room.id, joined.playerId);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  function attachSession(ws: WebSocket, roomId: string, playerId: PlayerId): void {
    const key = sessionKey(roomId, playerId);
    const previous = sessions.get(key);
    if (previous) previous.ws.close(4001, 'Replaced by reconnect');
    const session: LiveSession = {
      ws, roomId, playerId, windowStartedAt: Date.now(), messagesInWindow: 0,
    };
    sessions.set(key, session);
    send(ws, { type: 'welcome', room: store.state(roomId), playerId });
    const checkpoint = store.checkpoint(roomId);
    if (checkpoint) send(ws, { type: 'checkpoint', ...checkpoint });
    broadcastRoom(roomId);
    for (const reclaim of store.pendingReclaims(roomId)) {
      if (reclaim.seat !== playerId) send(ws, { type: 'reclaimRequested', ...reclaim });
    }

    ws.on('message', data => {
      try {
        if (!allowMessage(session)) throw new RoomError('rate_limited', 'Too many messages', 429);
        const raw = typeof data === 'string' ? data : data.toString();
        const parsed = parseClientMessage(raw);
        if (!parsed.ok) throw new RoomError(parsed.error, 'Invalid session message');
        const message = parsed.value;
        switch (message.type) {
          case 'command': {
            const accepted = store.acceptCommand(roomId, playerId, message.commandId, message.command);
            broadcast(roomId, { type: 'commandAccepted', accepted });
            break;
          }
          case 'ready':
            store.setReady(roomId, playerId, message.ready);
            broadcastRoom(roomId);
            break;
          case 'hostTick':
            store.updateHostTick(roomId, playerId, message.tick);
            break;
          case 'ping':
            send(ws, { type: 'pong', sentAt: message.sentAt, serverAt: Date.now() });
            break;
          case 'checkpoint':
            store.saveCheckpoint(roomId, playerId, message);
            break;
          case 'reclaimDecision':
            store.decideReclaim(roomId, playerId, message.requestId, message.approve);
            break;
        }
      } catch (error) {
        const e = asRoomError(error);
        send(ws, { type: 'error', code: e.code, message: e.message });
      }
    });

    ws.on('close', () => {
      if (sessions.get(key)?.ws !== ws) return;
      sessions.delete(key);
      const room = store.disconnect(roomId, playerId);
      broadcastRoom(roomId);
      if (room.players.find(p => p.id === playerId)?.host) {
        broadcast(roomId, { type: 'connectionPaused', reason: 'The host disconnected. Reconnecting…' });
      }
    });
  }

  function broadcastRoom(roomId: string): void {
    broadcast(roomId, { type: 'roomState', room: store.state(roomId) });
  }

  function broadcast(roomId: string, message: ServerMessage): void {
    for (const session of sessions.values()) {
      if (session.roomId === roomId) send(session.ws, message);
    }
  }

  return {
    server,
    store,
    async listen(port = 0, host = '127.0.0.1'): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      return (server.address() as AddressInfo).port;
    },
    async close(): Promise<void> {
      for (const session of sessions.values()) session.ws.close(1001, 'Server closing');
      wss.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function routeHttp(req: IncomingMessage, res: ServerResponse, store: RoomStore): Promise<void> {
  const url = requestUrl(req);
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(res, 200, { ok: true, service: 'erfgooiers-coop' }); return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/rooms') {
    sendJson(res, 200, { rooms: store.listPublic() }); return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/rooms') {
    const body = await readJson(req) as CreateRoomInput;
    sendJson(res, 201, store.createRoom(body)); return;
  }
  if (segments[0] === 'v1' && segments[1] === 'rooms' && segments[2]) {
    const code = decodeURIComponent(segments[2]);
    if (req.method === 'GET' && segments.length === 3) {
      sendJson(res, 200, store.summary(code)); return;
    }
    if (req.method === 'POST' && segments[3] === 'join') {
      const body = await readJson(req) as { playerName: string; password?: string };
      sendJson(res, 200, store.join(code, body.playerName, body.password)); return;
    }
    if (req.method === 'POST' && segments[3] === 'rejoin') {
      const body = await readJson(req) as { playerName: string; reconnectSecret?: string; password?: string };
      sendJson(res, 200, store.rejoin(code, body.playerName, body.reconnectSecret, body.password)); return;
    }
  }
  if (req.method === 'GET' && segments[0] === 'v1' && segments[1] === 'reclaims' && segments[2]) {
    sendJson(res, 200, store.reclaimStatus(decodeURIComponent(segments[2]))); return;
  }
  throw new RoomError('not_found', 'Endpoint not found', 404);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_MESSAGE_BYTES) throw new RoomError('body_too_large', 'Request body is too large', 413);
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new RoomError('invalid_json', 'Request body is not valid JSON'); }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const e = asRoomError(error);
  sendJson(res, e.status, { error: e.code, message: e.message });
}

function asRoomError(error: unknown): RoomError {
  return error instanceof RoomError ? error : new RoomError('internal_error', 'Internal server error', 500);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function allowMessage(session: LiveSession): boolean {
  const now = Date.now();
  if (now - session.windowStartedAt >= 10_000) {
    session.windowStartedAt = now;
    session.messagesInWindow = 0;
  }
  return ++session.messagesInWindow <= 600;
}

function sessionKey(roomId: string, playerId: PlayerId): string { return `${roomId}:${playerId}`; }

function localOrigins(): string[] {
  const configured = process.env.COOP_ORIGINS?.split(',').map(v => v.trim()).filter(Boolean);
  return configured?.length ? configured : ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

function originAllowed(req: IncomingMessage, allowed: Set<string>): boolean {
  const origin = req.headers.origin;
  return !origin || allowed.has(origin);
}

function setCors(req: IncomingMessage, res: ServerResponse, allowed: Set<string>): void {
  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}
