import type {
  ClientMessage, RoomSettings, RoomState, RoomSummary, ServerMessage,
} from './protocol';
import type { PlayerId } from '../types';

type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'error';

interface SessionGrant {
  room: RoomState;
  playerId: PlayerId;
  ticket: string;
  reconnectSecret: string;
}

interface StoredSeat {
  playerId: PlayerId;
  playerName: string;
  reconnectSecret: string;
}

interface RejoinJoined { status: 'joined'; grant: SessionGrant }
interface RejoinPending { status: 'pending'; requestId: string; seat: PlayerId }
type RejoinResult = RejoinJoined | RejoinPending;

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  room: RoomState | null;
  playerId: PlayerId | null;
  rtt: number | null;
  reconnectAttempt: number;
  error: string | null;
}

type WebSocketFactory = (url: string) => WebSocket;

export class CoOpClient {
  onConnection: (snapshot: ConnectionSnapshot) => void = () => {};
  onMessage: (message: ServerMessage) => void = () => {};
  onReclaimPending: (requestId: string) => void = () => {};

  private ws: WebSocket | null = null;
  private room: RoomState | null = null;
  private playerId: PlayerId | null = null;
  private playerName = '';
  private reconnectSecret = '';
  private status: ConnectionStatus = 'offline';
  private rtt: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private lastError: string | null = null;

  constructor(
    readonly baseUrl = (import.meta.env.VITE_COOP_SERVER_URL || 'http://localhost:8787').replace(/\/$/, ''),
    private readonly storage: Storage = localStorage,
    private readonly makeWebSocket: WebSocketFactory = url => new WebSocket(url),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  snapshot(): ConnectionSnapshot {
    return {
      status: this.status, room: this.room, playerId: this.playerId, rtt: this.rtt,
      reconnectAttempt: this.reconnectAttempt, error: this.lastError,
    };
  }

  async listRooms(): Promise<RoomSummary[]> {
    const value = await this.api<{ rooms: RoomSummary[] }>('/v1/rooms');
    return value.rooms;
  }

  async createRoom(playerName: string, settings: RoomSettings, password?: string): Promise<RoomState> {
    const grant = await this.api<SessionGrant>('/v1/rooms', { playerName, settings, password });
    await this.useGrant(grant, playerName);
    return grant.room;
  }

  async joinByInvite(inviteCode: string, playerName: string, password?: string): Promise<RoomState | RejoinPending> {
    const code = normalizeCode(inviteCode);
    const saved = this.loadSeat(code);
    if (saved) {
      const result = await this.rejoin(code, playerName || saved.playerName, saved.reconnectSecret, password);
      if (result.status === 'joined') { await this.useGrant(result.grant, playerName || saved.playerName); return result.grant.room; }
      this.onReclaimPending(result.requestId); return result;
    }

    const preview = await this.api<RoomSummary>(`/v1/rooms/${encodeURIComponent(code)}`);
    if (preview.players < preview.capacity) {
      const grant = await this.api<SessionGrant>(`/v1/rooms/${encodeURIComponent(code)}/join`, { playerName, password });
      await this.useGrant(grant, playerName);
      return grant.room;
    }
    const result = await this.rejoin(code, playerName, undefined, password);
    if (result.status === 'joined') { await this.useGrant(result.grant, playerName); return result.grant.room; }
    this.onReclaimPending(result.requestId);
    return result;
  }

  async pollReclaim(requestId: string): Promise<'pending' | 'denied' | 'expired' | RoomState> {
    const result = await this.api<{ status: 'pending' | 'approved' | 'denied' | 'expired'; grant?: SessionGrant }>(
      `/v1/reclaims/${encodeURIComponent(requestId)}`,
    );
    if (result.status === 'approved') {
      if (!result.grant) throw new Error('Approved rejoin did not include a session grant');
      await this.useGrant(result.grant, this.playerName || 'Player');
      return result.grant.room;
    }
    return result.status;
  }

  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  setReady(ready: boolean): boolean { return this.send({ type: 'ready', ready }); }
  approveReclaim(requestId: string, approve: boolean): boolean {
    return this.send({ type: 'reclaimDecision', requestId, approve });
  }

  ping(): void { this.send({ type: 'ping', sentAt: performance.now() }); }

  reconnectNow(): void {
    if (!this.room || !this.reconnectSecret) return;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    void this.reconnect();
  }

  leave(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.ws?.close(1000, 'Player left');
    this.ws = null;
    this.status = 'offline';
    this.emit();
  }

  inviteUrl(): string {
    if (!this.room) return '';
    const url = new URL(location.href);
    url.searchParams.set('coop', this.room.inviteCode);
    return url.toString();
  }

  private async rejoin(code: string, playerName: string, reconnectSecret?: string, password?: string): Promise<RejoinResult> {
    this.playerName = playerName;
    return this.api<RejoinResult>(`/v1/rooms/${encodeURIComponent(code)}/rejoin`, {
      playerName, reconnectSecret, password,
    });
  }

  private async useGrant(grant: SessionGrant, playerName: string): Promise<void> {
    this.manualClose = false;
    this.room = grant.room;
    this.playerId = grant.playerId;
    this.playerName = playerName;
    this.reconnectSecret = grant.reconnectSecret;
    this.saveSeat(grant.room.inviteCode, {
      playerId: grant.playerId, playerName, reconnectSecret: grant.reconnectSecret,
    });
    await this.connect(grant.ticket);
  }

  private async connect(ticket: string): Promise<void> {
    this.clearReconnectTimer();
    this.status = this.reconnectAttempt ? 'reconnecting' : 'connecting';
    this.lastError = null;
    this.emit();
    const ws = this.makeWebSocket(this.websocketUrl(ticket));
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        this.status = 'connected';
        this.reconnectAttempt = 0;
        this.emit();
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('Could not connect to the co-op room service'));
      }, { once: true });
      ws.addEventListener('message', event => this.receive(String(event.data)));
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.manualClose) return;
        this.status = this.playerId === 'p1' ? 'paused' : 'reconnecting';
        this.emit();
        this.scheduleReconnect();
      });
    });
  }

  private receive(raw: string): void {
    let message: ServerMessage;
    try { message = JSON.parse(raw) as ServerMessage; }
    catch { return; }
    if (message.type === 'welcome' || message.type === 'roomState') this.room = message.room;
    if (message.type === 'pong') this.rtt = Math.max(0, performance.now() - message.sentAt);
    if (message.type === 'connectionPaused') this.status = 'paused';
    if (message.type === 'error') this.lastError = message.message;
    this.onMessage(message);
    this.emit();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.manualClose) return;
    const delays = [500, 1000, 2000, 4000, 8000, 12_000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.room || !this.reconnectSecret || this.manualClose) return;
    this.reconnectAttempt++;
    this.status = 'reconnecting';
    this.emit();
    try {
      const result = await this.rejoin(this.room.inviteCode, this.playerName, this.reconnectSecret);
      if (result.status !== 'joined') throw new Error('Reconnect requires teammate approval');
      await this.useGrant(result.grant, this.playerName);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.status = 'error';
      this.emit();
      this.scheduleReconnect();
    }
  }

  private emit(): void { this.onConnection(this.snapshot()); }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private websocketUrl(ticket: string): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/session`;
    url.search = '';
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(value.message || `Co-op service returned ${response.status}`);
    return value as T;
  }

  private saveSeat(code: string, seat: StoredSeat): void {
    try { this.storage.setItem(storageKey(code), JSON.stringify(seat)); } catch { /* private mode */ }
  }

  private loadSeat(code: string): StoredSeat | null {
    try {
      const raw = this.storage.getItem(storageKey(code));
      if (!raw) return null;
      const seat = JSON.parse(raw) as StoredSeat;
      return seat?.reconnectSecret && seat?.playerId ? seat : null;
    } catch { return null; }
  }
}

function normalizeCode(code: string): string { return code.trim().toUpperCase(); }
function storageKey(code: string): string { return `erfgooiers.coop.seat.v1.${normalizeCode(code)}`; }
