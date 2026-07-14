import type { PlayerId } from '../types';
import {
  CONTENT_VERSION, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, parseClientMessage,
  type AcceptedCommand, type ClientMessage, type RoomSettings, type RoomState, type ServerMessage,
} from './protocol';
import {
  INVITE_LIFETIME_MS, createHostKeyPair, deriveSafetyCode, exportPublicKey, importPublicKey, openInvite, openJoin,
  randomToken, sealInvite, sealJoin, type PeerInvite, type PeerJoin,
} from './peerSignaling';

type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'error';
type PeerRole = 'host' | 'guest' | null;

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  room: RoomState | null;
  playerId: PlayerId | null;
  rtt: number | null;
  reconnectAttempt: number;
  error: string | null;
  role: PeerRole;
}

export interface PendingPeerJoin { playerName: string }

type PeerFactory = (configuration: RTCConfiguration) => RTCPeerConnection;

const ICE_CONFIG: RTCConfiguration = {
  // STUN only discovers a direct route. Game data never traverses this service.
  // There is deliberately no TURN relay, account, or application server.
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
  iceCandidatePoolSize: 4,
};

/**
 * Browser-only, two-peer co-op transport. Manual encrypted offer/answer codes
 * replace server signaling; after admission, the host sequences all commands.
 */
export class PeerCoOpClient {
  onConnection: (snapshot: ConnectionSnapshot) => void = () => {};
  onMessage: (message: ServerMessage) => void = () => {};
  onJoinRequest: (request: PendingPeerJoin) => void = () => {};

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private room: RoomState | null = null;
  private playerId: PlayerId | null = null;
  private role: PeerRole = null;
  private status: ConnectionStatus = 'offline';
  private rtt: number | null = null;
  private lastError: string | null = null;
  private invite: PeerInvite | null = null;
  private inviteCode = '';
  private responseCode = '';
  private hostKeys: CryptoKeyPair | null = null;
  private pending: PeerJoin | null = null;
  private safetyCode = '';
  private admission: 'pending' | 'accepted' | 'rejected' = 'pending';
  private sequence = 0;
  private hostTick = 0;
  private manualClose = false;

  constructor(private readonly makePeer: PeerFactory = configuration => new RTCPeerConnection(configuration)) {}

  snapshot(): ConnectionSnapshot {
    return {
      status: this.status, room: this.room, playerId: this.playerId, rtt: this.rtt,
      reconnectAttempt: 0, error: this.lastError, role: this.role,
    };
  }

  async createRoom(playerName: string, settings: RoomSettings): Promise<RoomState> {
    this.leave();
    this.manualClose = false;
    this.role = 'host';
    this.playerId = 'p1';
    this.status = 'connecting';
    const now = Date.now();
    const roomId = randomToken(16);
    this.room = {
      id: roomId,
      inviteCode: readableCode(),
      settings: { ...settings, visibility: 'unlisted', passwordProtected: false },
      phase: 'lobby',
      level: 1,
      players: [player('p1', cleanName(playerName), true, 'reconnecting')],
      protocolVersion: PROTOCOL_VERSION,
      contentVersion: CONTENT_VERSION,
    };
    this.pc = this.createPeer();
    this.bindChannel(this.pc.createDataChannel('erfgooiers', { ordered: true, protocol: `erfgooiers-v${PROTOCOL_VERSION}` }));
    this.hostKeys = await createHostKeyPair();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    this.invite = {
      kind: 'invite', createdAt: now, expiresAt: now + INVITE_LIFETIME_MS, nonce: randomToken(16),
      room: structuredClone(this.room), offer: description(this.pc.localDescription),
      hostPublicKey: await exportPublicKey(this.hostKeys.publicKey),
    };
    this.inviteCode = await sealInvite(this.invite);
    this.emit();
    return this.room;
  }

  async joinByInvite(code: string, playerName: string): Promise<RoomState> {
    this.leave();
    this.manualClose = false;
    this.role = 'guest';
    this.playerId = 'p2';
    this.status = 'connecting';
    const invite = await openInvite(code);
    if (invite.room.protocolVersion !== PROTOCOL_VERSION || invite.room.contentVersion !== CONTENT_VERSION) {
      throw new Error('This invite was made by an incompatible game version');
    }
    this.invite = invite;
    this.room = structuredClone(invite.room);
    this.room.players.push(player('p2', cleanName(playerName), false, 'reconnecting'));
    this.pc = this.createPeer();
    this.pc.addEventListener('datachannel', event => this.bindChannel(event.channel), { once: true });
    await this.pc.setRemoteDescription(invite.offer);
    const guestKeys = await createHostKeyPair();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    const hostPublicKey = await importPublicKey(invite.hostPublicKey);
    this.safetyCode = await deriveSafetyCode(guestKeys.privateKey, hostPublicKey, invite.nonce, invite.room.id);
    const join: PeerJoin = {
      kind: 'join', roomId: invite.room.id, inviteNonce: invite.nonce, guestNonce: randomToken(16),
      playerName: cleanName(playerName), safetyCode: this.safetyCode, answer: description(this.pc.localDescription),
    };
    this.responseCode = await sealJoin(
      join, guestKeys.privateKey, guestKeys.publicKey, hostPublicKey,
    );
    this.emit();
    return this.room;
  }

  async reviewJoinResponse(code: string): Promise<PendingPeerJoin> {
    if (this.role !== 'host' || !this.invite || !this.hostKeys) throw new Error('Create a host invite first');
    if (Date.now() > this.invite.expiresAt) throw new Error('This host invite has expired; create a new room');
    this.pending = await openJoin(code, this.hostKeys.privateKey, this.invite);
    this.safetyCode = this.pending.safetyCode;
    const request = { playerName: this.pending.playerName };
    this.onJoinRequest(request);
    this.emit();
    return request;
  }

  async acceptPendingJoin(): Promise<void> {
    if (this.role !== 'host' || !this.pc || !this.room || !this.pending) throw new Error('No join request to accept');
    const accepted = this.pending;
    this.pending = null;
    this.admission = 'accepted';
    this.room.players = [this.room.players[0], player('p2', accepted.playerName, false, 'reconnecting')];
    this.status = 'connecting';
    await this.pc.setRemoteDescription(accepted.answer);
    this.emit();
  }

  async rejectPendingJoin(): Promise<void> {
    if (this.role !== 'host' || !this.pc || !this.pending) throw new Error('No join request to reject');
    const rejected = this.pending;
    this.pending = null;
    this.admission = 'rejected';
    this.safetyCode = '';
    this.status = 'connecting';
    // Complete only the authenticated transport handshake so the guest receives
    // an explicit denial. No welcome, room state, or gameplay access is granted.
    await this.pc.setRemoteDescription(rejected.answer);
    this.emit();
  }

  pendingJoin(): PendingPeerJoin | null {
    return this.pending ? { playerName: this.pending.playerName } : null;
  }

  encryptedInvite(): string { return this.inviteCode; }
  encryptedJoinResponse(): string { return this.responseCode; }
  verificationCode(): string { return this.safetyCode; }
  inviteUrl(): string { return this.inviteCode; }

  send(message: ClientMessage): boolean {
    if (!this.room || !this.playerId || this.status !== 'connected') return false;
    if (this.role === 'host') return this.processClientMessage(message, 'p1');
    return this.sendRaw(message);
  }

  setReady(ready: boolean): boolean { return this.send({ type: 'ready', ready }); }
  /** Claim a preset building colour and hero for this seat (lobby only). */
  setLoadout(color: string, hero: string | null): boolean { return this.send({ type: 'setLoadout', color, hero }); }
  ping(): void { this.send({ type: 'ping', sentAt: performance.now() }); }

  reconnectNow(): void {
    this.lastError = 'Direct sessions need a fresh invite after a failed connection';
    this.status = 'error';
    this.emit();
  }

  leave(): void {
    this.manualClose = true;
    this.channel?.close();
    this.pc?.close();
    this.pc = null;
    this.channel = null;
    this.room = null;
    this.playerId = null;
    this.role = null;
    this.status = 'offline';
    this.rtt = null;
    this.lastError = null;
    this.invite = null;
    this.inviteCode = '';
    this.responseCode = '';
    this.hostKeys = null;
    this.pending = null;
    this.safetyCode = '';
    this.admission = 'pending';
    this.sequence = 0;
    this.hostTick = 0;
    this.emit();
  }

  private createPeer(): RTCPeerConnection {
    const pc = this.makePeer(ICE_CONFIG);
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc || this.manualClose) return;
      if (pc.connectionState === 'failed') {
        this.lastError = 'Direct connection failed. Some strict NATs require a TURN relay.';
        this.status = 'error';
      } else if (pc.connectionState === 'disconnected') {
        this.status = 'paused';
      } else if (pc.connectionState === 'connected' && this.channel?.readyState === 'open') {
        this.status = 'connected';
      }
      this.emit();
    });
    return pc;
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.addEventListener('message', event => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw || raw.length > MAX_MESSAGE_BYTES) return;
      if (this.role === 'host') {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; }
        const result = parseClientMessage(parsed);
        if (result.ok) this.processClientMessage(result.value, 'p2');
      } else {
        this.receiveServer(raw);
      }
    });
    channel.addEventListener('open', () => {
      if (!this.room) return;
      this.status = 'connected';
      this.lastError = null;
      if (this.role === 'host') {
        if (this.admission === 'rejected') {
          this.sendToGuest({ type: 'error', code: 'join_rejected', message: 'The host rejected this join request' });
          this.lastError = 'Join request rejected. Leave and host a fresh room for another guest.';
          this.status = 'error';
          this.emit();
          return;
        }
        if (this.admission !== 'accepted') { channel.close(); return; }
        for (const peer of this.room.players) peer.presence = 'connected';
        this.sendToGuest({ type: 'welcome', room: this.room, playerId: 'p2' });
        this.broadcastRoom();
      }
      this.emit();
    });
    channel.addEventListener('close', () => {
      if (this.manualClose) return;
      this.status = 'paused';
      this.lastError = 'The direct peer connection closed';
      if (this.room) for (const peer of this.room.players) if (peer.id !== this.playerId) peer.presence = 'offline';
      this.emit();
    });
  }

  private processClientMessage(message: ClientMessage, actor: PlayerId): boolean {
    if (!this.room) return false;
    switch (message.type) {
      case 'command': {
        if (message.command.type === 'startExpedition' && actor !== 'p1') {
          this.reply(actor, { type: 'commandRejected', commandId: message.commandId, reason: 'Only the host may start the Expedition' });
          return true;
        }
        if (message.command.type === 'startExpedition') {
          this.room.phase = 'playing';
          this.room.level = message.command.level;
        }
        const accepted: AcceptedCommand = {
          commandId: message.commandId, playerId: actor, command: message.command,
          sequence: ++this.sequence, applyTick: this.hostTick + 2,
        };
        this.broadcast({ type: 'commandAccepted', accepted });
        if (message.command.type === 'startExpedition') this.broadcastRoom();
        return true;
      }
      case 'ready': {
        const peer = this.room.players.find(value => value.id === actor);
        if (peer) { peer.ready = message.ready; peer.lastSeenAt = Date.now(); this.broadcastRoom(); }
        return true;
      }
      case 'setLoadout': {
        if (this.room.phase !== 'lobby') return true;
        const peer = this.room.players.find(value => value.id === actor);
        if (peer) {
          // Colours stay unique: ignore a pick already held by the other seat
          // (the picker greys it out too, so this is just a safety net).
          const taken = this.room.players.some(value => value.id !== actor && value.color === message.color);
          if (!taken) peer.color = message.color;
          peer.hero = message.hero;
          peer.ready = false; // a loadout change drops ready so both re-confirm
          peer.lastSeenAt = Date.now();
          this.broadcastRoom();
        }
        return true;
      }
      case 'hostTick':
        if (actor === 'p1') this.hostTick = Math.max(this.hostTick, message.tick);
        return true;
      case 'ping':
        this.reply(actor, { type: 'pong', sentAt: message.sentAt, serverAt: performance.now() });
        return true;
      case 'checkpoint':
        if (actor === 'p1') this.reply('p2', { type: 'checkpoint', tick: message.tick, sequence: message.sequence, payload: message.payload });
        return true;
      case 'reclaimDecision':
        return true;
    }
  }

  private broadcastRoom(): void {
    if (this.room) this.broadcast({ type: 'roomState', room: this.room });
  }

  private broadcast(message: ServerMessage): void {
    this.receiveServer(message);
    this.sendToGuest(message);
  }

  private reply(playerId: PlayerId, message: ServerMessage): void {
    if (playerId === 'p1') this.receiveServer(message);
    else this.sendToGuest(message);
  }

  private sendToGuest(message: ServerMessage): boolean { return this.sendRaw(message); }

  private sendRaw(message: ClientMessage | ServerMessage): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    const raw = JSON.stringify(message);
    if (raw.length > MAX_MESSAGE_BYTES) return false;
    this.channel.send(raw);
    return true;
  }

  private receiveServer(message: ServerMessage | string): void {
    let parsed: ServerMessage;
    try { parsed = typeof message === 'string' ? JSON.parse(message) as ServerMessage : message; } catch { return; }
    if (parsed.type === 'welcome' || parsed.type === 'roomState') this.room = structuredClone(parsed.room);
    if (parsed.type === 'welcome') { this.playerId = parsed.playerId; this.status = 'connected'; }
    if (parsed.type === 'pong') this.rtt = Math.max(0, performance.now() - parsed.sentAt);
    if (parsed.type === 'connectionPaused') this.status = 'paused';
    if (parsed.type === 'error') { this.lastError = parsed.message; this.status = 'error'; }
    this.onMessage(parsed);
    this.emit();
  }

  private emit(): void { this.onConnection(this.snapshot()); }
}

function player(id: PlayerId, name: string, host: boolean, presence: 'connected' | 'reconnecting' | 'offline') {
  return { id, name, color: id === 'p1' ? '#5b8c5a' : '#d59b45', hero: null, host, ready: false, presence, lastSeenAt: Date.now() };
}

function cleanName(value: string): string { return value.trim().slice(0, 24) || 'Erfgooier'; }

function readableCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const data = new Uint8Array(8); crypto.getRandomValues(data);
  const text = [...data].map(value => alphabet[value % alphabet.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function description(value: RTCSessionDescription | null): RTCSessionDescriptionInit {
  if (!value?.sdp) throw new Error('WebRTC did not produce a session description');
  return { type: value.type, sdp: value.sdp };
}

function waitForIce(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', changed); clearTimeout(timer); resolve(); };
    const changed = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', changed);
  });
}
