import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  CONTENT_VERSION,
  MAX_PLAYER_NAME,
  MAX_ROOM_NAME,
  PROTOCOL_VERSION,
  type AcceptedCommand,
  type GameCommand,
  type RoomPlayer,
  type RoomSettings,
  type RoomState,
  type RoomSummary,
} from '../src/net/protocol';
import type { PlayerId } from '../src/types';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_COLORS: Record<PlayerId, string> = { p1: '#4f78d1', p2: '#d17938' };
const TICKET_TTL_MS = 60_000;
const RECLAIM_TTL_MS = 5 * 60_000;

interface Seat {
  player: RoomPlayer;
  reconnectHash: string;
}

interface StoredRoom {
  state: RoomState;
  seats: Partial<Record<PlayerId, Seat>>;
  passwordHash: string | null;
  sequence: number;
  hostTick: number;
  checkpoint: { tick: number; sequence: number; payload: string } | null;
  updatedAt: number;
}

interface Ticket {
  roomId: string;
  playerId: PlayerId;
  expiresAt: number;
}

interface Reclaim {
  id: string;
  roomId: string;
  seat: PlayerId;
  playerName: string;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
  ticket?: string;
  reconnectSecret?: string;
}

export interface CreateRoomInput {
  playerName: string;
  settings: RoomSettings;
  password?: string;
}

export interface SessionGrant {
  room: RoomState;
  playerId: PlayerId;
  ticket: string;
  reconnectSecret: string;
}

export type RejoinResult =
  | { status: 'joined'; grant: SessionGrant }
  | { status: 'pending'; requestId: string; seat: PlayerId };

export interface ReclaimStatus {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  grant?: SessionGrant;
}

export class RoomError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export class RoomStore {
  private readonly roomsById = new Map<string, StoredRoom>();
  private readonly roomIdByCode = new Map<string, string>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly reclaims = new Map<string, Reclaim>();

  constructor(private readonly now: () => number = Date.now) {}

  createRoom(input: CreateRoomInput): SessionGrant {
    const playerName = cleanName(input.playerName, MAX_PLAYER_NAME, 'Player name');
    const settings = { ...validateSettings(input.settings), passwordProtected: !!input.password };
    const id = randomToken(16);
    const inviteCode = this.uniqueInviteCode();
    const reconnectSecret = randomToken(24);
    const player = makePlayer('p1', playerName, true, this.now());
    const state: RoomState = {
      id,
      inviteCode,
      settings,
      phase: 'lobby',
      level: 1,
      players: [player],
      protocolVersion: PROTOCOL_VERSION,
      contentVersion: CONTENT_VERSION,
    };
    const room: StoredRoom = {
      state,
      seats: { p1: { player, reconnectHash: secretHash(reconnectSecret) } },
      passwordHash: hashPassword(input.password),
      sequence: 0,
      hostTick: 0,
      checkpoint: null,
      updatedAt: this.now(),
    };
    this.roomsById.set(id, room);
    this.roomIdByCode.set(inviteCode, id);
    return this.grant(room, 'p1', reconnectSecret);
  }

  join(inviteCode: string, playerName: string, password?: string): SessionGrant {
    const room = this.roomByCode(inviteCode);
    this.verifyPassword(room, password);
    if (room.seats.p2) throw new RoomError('room_full', 'This room already has two reserved seats', 409);
    const name = cleanName(playerName, MAX_PLAYER_NAME, 'Player name');
    const reconnectSecret = randomToken(24);
    const player = makePlayer('p2', name, false, this.now());
    room.seats.p2 = { player, reconnectHash: secretHash(reconnectSecret) };
    room.state.players.push(player);
    room.updatedAt = this.now();
    return this.grant(room, 'p2', reconnectSecret);
  }

  rejoin(inviteCode: string, playerName: string, reconnectSecret?: string, password?: string): RejoinResult {
    const room = this.roomByCode(inviteCode);
    this.verifyPassword(room, password);
    const name = cleanName(playerName, MAX_PLAYER_NAME, 'Player name');
    if (reconnectSecret) {
      const seat = this.findSeatBySecret(room, reconnectSecret);
      if (!seat) throw new RoomError('invalid_reconnect_secret', 'Reconnect credential is no longer valid', 401);
      seat.player.name = name;
      return { status: 'joined', grant: this.grant(room, seat.player.id, reconnectSecret) };
    }

    const offline = (['p1', 'p2'] as PlayerId[])
      .map(id => room.seats[id])
      .filter((seat): seat is Seat => !!seat && seat.player.presence !== 'connected');
    if (offline.length !== 1) {
      throw new RoomError('seat_ambiguous', 'A reconnect credential is required when the seat cannot be identified', 409);
    }
    const connectedPeer = room.state.players.some(p => p.presence === 'connected' && p.id !== offline[0].player.id);
    if (!connectedPeer) throw new RoomError('approval_unavailable', 'The other player must be connected to approve this rejoin', 409);
    const requestId = randomToken(18);
    this.reclaims.set(requestId, {
      id: requestId,
      roomId: room.state.id,
      seat: offline[0].player.id,
      playerName: name,
      expiresAt: this.now() + RECLAIM_TTL_MS,
      status: 'pending',
    });
    return { status: 'pending', requestId, seat: offline[0].player.id };
  }

  decideReclaim(roomId: string, actor: PlayerId, requestId: string, approve: boolean): void {
    const room = this.roomById(roomId);
    const reclaim = this.activeReclaim(requestId);
    if (reclaim.roomId !== roomId) throw new RoomError('wrong_room', 'Rejoin request belongs to another room', 403);
    if (actor === reclaim.seat || room.seats[actor]?.player.presence !== 'connected') {
      throw new RoomError('not_allowed', 'Only the connected teammate can decide this request', 403);
    }
    if (!approve) { reclaim.status = 'denied'; return; }
    const seat = room.seats[reclaim.seat];
    if (!seat) throw new RoomError('seat_missing', 'Reserved seat no longer exists', 409);
    const reconnectSecret = randomToken(24);
    seat.reconnectHash = secretHash(reconnectSecret);
    seat.player.name = reclaim.playerName;
    reclaim.status = 'approved';
    reclaim.reconnectSecret = reconnectSecret;
    reclaim.ticket = this.issueTicket(room.state.id, reclaim.seat);
    room.updatedAt = this.now();
  }

  reclaimStatus(requestId: string): ReclaimStatus {
    const reclaim = this.reclaims.get(requestId);
    if (!reclaim || reclaim.expiresAt <= this.now()) return { status: 'expired' };
    if (reclaim.status !== 'approved') return { status: reclaim.status };
    const room = this.roomById(reclaim.roomId);
    return {
      status: 'approved',
      grant: {
        room: cloneRoom(room.state),
        playerId: reclaim.seat,
        ticket: reclaim.ticket!,
        reconnectSecret: reclaim.reconnectSecret!,
      },
    };
  }

  consumeTicket(ticket: string): { room: RoomState; playerId: PlayerId } {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!record || record.expiresAt <= this.now()) throw new RoomError('invalid_ticket', 'Session ticket expired', 401);
    const room = this.roomById(record.roomId);
    const seat = room.seats[record.playerId];
    if (!seat) throw new RoomError('seat_missing', 'Reserved seat no longer exists', 409);
    seat.player.presence = 'connected';
    seat.player.lastSeenAt = this.now();
    room.updatedAt = this.now();
    return { room: cloneRoom(room.state), playerId: record.playerId };
  }

  disconnect(roomId: string, playerId: PlayerId): RoomState {
    const room = this.roomById(roomId);
    const seat = room.seats[playerId];
    if (seat) {
      seat.player.presence = 'offline';
      seat.player.lastSeenAt = this.now();
      room.updatedAt = this.now();
    }
    return cloneRoom(room.state);
  }

  setReady(roomId: string, playerId: PlayerId, ready: boolean): RoomState {
    const room = this.roomById(roomId);
    const seat = room.seats[playerId];
    if (!seat) throw new RoomError('seat_missing', 'Reserved seat no longer exists', 409);
    seat.player.ready = ready;
    room.updatedAt = this.now();
    return cloneRoom(room.state);
  }

  updateHostTick(roomId: string, actor: PlayerId, tick: number): void {
    const room = this.roomById(roomId);
    if (!room.seats[actor]?.player.host) throw new RoomError('host_only', 'Only the host may update the authoritative tick', 403);
    if (!Number.isInteger(tick) || tick < room.hostTick) throw new RoomError('invalid_tick', 'Host tick must be monotonic');
    room.hostTick = tick;
  }

  acceptCommand(roomId: string, playerId: PlayerId, commandId: string, command: GameCommand): AcceptedCommand {
    const room = this.roomById(roomId);
    if (!room.seats[playerId]) throw new RoomError('seat_missing', 'Reserved seat no longer exists', 409);
    if (command.type === 'startExpedition') {
      if (!room.seats[playerId].player.host) throw new RoomError('host_only', 'Only the host may start a level', 403);
      room.state.phase = 'playing';
      room.state.level = command.level;
      room.updatedAt = this.now();
    }
    return { commandId, playerId, command, sequence: ++room.sequence, applyTick: room.hostTick + 2 };
  }

  saveCheckpoint(roomId: string, actor: PlayerId, checkpoint: { tick: number; sequence: number; payload: string }): void {
    const room = this.roomById(roomId);
    if (!room.seats[actor]?.player.host) throw new RoomError('host_only', 'Only the host may upload checkpoints', 403);
    if (checkpoint.sequence > room.sequence || checkpoint.tick < 0) throw new RoomError('invalid_checkpoint', 'Checkpoint is ahead of room state');
    room.checkpoint = { ...checkpoint };
    room.updatedAt = this.now();
  }

  checkpoint(roomId: string): StoredRoom['checkpoint'] {
    const checkpoint = this.roomById(roomId).checkpoint;
    return checkpoint ? { ...checkpoint } : null;
  }

  state(roomId: string): RoomState { return cloneRoom(this.roomById(roomId).state); }
  stateByCode(inviteCode: string): RoomState { return cloneRoom(this.roomByCode(inviteCode).state); }

  summary(inviteCode: string): RoomSummary {
    const room = this.roomByCode(inviteCode);
    return this.summaryFor(room);
  }

  listPublic(): RoomSummary[] {
    return [...this.roomsById.values()]
      .filter(room => room.state.settings.visibility === 'public')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(room => this.summaryFor(room));
  }

  pendingReclaims(roomId: string): Array<{ requestId: string; playerName: string; seat: PlayerId }> {
    return [...this.reclaims.values()]
      .filter(r => r.roomId === roomId && r.status === 'pending' && r.expiresAt > this.now())
      .map(r => ({ requestId: r.id, playerName: r.playerName, seat: r.seat }));
  }

  private grant(room: StoredRoom, playerId: PlayerId, reconnectSecret: string): SessionGrant {
    return { room: cloneRoom(room.state), playerId, reconnectSecret, ticket: this.issueTicket(room.state.id, playerId) };
  }

  private summaryFor(room: StoredRoom): RoomSummary {
    return {
      inviteCode: room.state.inviteCode,
      roomName: room.state.settings.roomName,
      hostName: room.seats.p1?.player.name ?? 'Host',
      region: room.state.settings.region,
      difficulty: room.state.settings.difficulty,
      mode: room.state.settings.mode,
      phase: room.state.phase,
      level: room.state.level,
      players: room.state.players.length,
      capacity: 2,
      passwordProtected: !!room.passwordHash,
      protocolVersion: room.state.protocolVersion,
      contentVersion: room.state.contentVersion,
    };
  }

  private issueTicket(roomId: string, playerId: PlayerId): string {
    const ticket = randomToken(24);
    this.tickets.set(ticket, { roomId, playerId, expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  private activeReclaim(requestId: string): Reclaim {
    const reclaim = this.reclaims.get(requestId);
    if (!reclaim || reclaim.status !== 'pending' || reclaim.expiresAt <= this.now()) {
      throw new RoomError('reclaim_expired', 'Rejoin request is no longer pending', 409);
    }
    return reclaim;
  }

  private findSeatBySecret(room: StoredRoom, secret: string): Seat | null {
    const hash = secretHash(secret);
    return (['p1', 'p2'] as PlayerId[]).map(id => room.seats[id]).find(seat => seat && safeEqual(seat.reconnectHash, hash)) ?? null;
  }

  private roomByCode(code: string): StoredRoom {
    const id = this.roomIdByCode.get(normalizeCode(code));
    if (!id) throw new RoomError('room_not_found', 'Invite code was not found', 404);
    return this.roomById(id);
  }

  private roomById(id: string): StoredRoom {
    const room = this.roomsById.get(id);
    if (!room) throw new RoomError('room_not_found', 'Room was not found', 404);
    return room;
  }

  private uniqueInviteCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const bytes = randomBytes(8);
      let raw = '';
      for (let i = 0; i < 8; i++) raw += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      if (!this.roomIdByCode.has(code)) return code;
    }
    throw new RoomError('code_exhausted', 'Could not allocate an invite code', 503);
  }

  private verifyPassword(room: StoredRoom, password?: string): void {
    if (!room.passwordHash) return;
    if (!password || !verifyPassword(password, room.passwordHash)) throw new RoomError('bad_password', 'Room password is incorrect', 401);
  }
}

function makePlayer(id: PlayerId, name: string, host: boolean, now: number): RoomPlayer {
  return { id, name, host, color: PLAYER_COLORS[id], ready: false, presence: 'offline', lastSeenAt: now };
}

function validateSettings(value: RoomSettings): RoomSettings {
  const roomName = cleanName(value.roomName, MAX_ROOM_NAME, 'Room name');
  if (!['public', 'unlisted'].includes(value.visibility)) throw new RoomError('invalid_visibility', 'Invalid room visibility');
  if (!['journey', 'erfgooiers', 'veldheer'].includes(value.difficulty)) throw new RoomError('invalid_difficulty', 'Invalid Expedition difficulty');
  if (!['expedition', 'sandbox'].includes(value.mode)) throw new RoomError('invalid_mode', 'Invalid room mode');
  const region = cleanName(value.region, 24, 'Region');
  return { ...value, roomName, region, passwordProtected: !!value.passwordProtected };
}

function cleanName(value: string, max: number, label: string): string {
  if (typeof value !== 'string') throw new RoomError('invalid_name', `${label} is required`);
  const cleaned = value.replace(/[<>\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > max) throw new RoomError('invalid_name', `${label} must be 1–${max} characters`);
  return cleaned;
}

function normalizeCode(code: string): string { return String(code).trim().toUpperCase(); }
function randomToken(bytes: number): string { return randomBytes(bytes).toString('base64url'); }
function secretHash(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function hashPassword(password?: string): string | null {
  if (!password) return null;
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function verifyPassword(password: string, encoded: string): boolean {
  const [salt, wanted] = encoded.split(':');
  return safeEqual(scryptSync(password, salt, 32).toString('hex'), wanted);
}
function cloneRoom(room: RoomState): RoomState { return structuredClone(room); }
