import type { UnitKind } from '../data/units';
import { isPlayerId } from '../game/ownership';
import type { BuildingKey, Coord, Formation, ItemKey, PlayerId } from '../types';

export const PROTOCOL_VERSION = 1;
export const CONTENT_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_ROOM_NAME = 48;
export const MAX_PLAYER_NAME = 24;
export const MAX_BATCH_CELLS = 128;
export const MAX_ORDER_UNITS = 256;
export const MAX_TRADE_AMOUNT = 999;

export type EntityId = number;
export type TradeRequestId = string;
export type TradeShipmentId = string;
export type RoomVisibility = 'public' | 'unlisted';
export type ExpeditionDifficulty = 'journey' | 'erfgooiers' | 'veldheer';
export type RoomPhase = 'lobby' | 'playing' | 'betweenLevels' | 'summary';
export type Presence = 'connected' | 'reconnecting' | 'offline';

export interface RoomSettings {
  visibility: RoomVisibility;
  roomName: string;
  region: string;
  difficulty: ExpeditionDifficulty;
  mode: 'expedition' | 'sandbox';
  passwordProtected: boolean;
}

export interface RoomPlayer {
  id: PlayerId;
  name: string;
  color: string;
  host: boolean;
  ready: boolean;
  presence: Presence;
  lastSeenAt: number;
}

export interface RoomState {
  id: string;
  inviteCode: string;
  settings: RoomSettings;
  phase: RoomPhase;
  level: number;
  players: RoomPlayer[];
  protocolVersion: number;
  contentVersion: number;
}

export interface RoomSummary {
  inviteCode: string;
  roomName: string;
  hostName: string;
  region: string;
  difficulty: ExpeditionDifficulty;
  mode: RoomSettings['mode'];
  phase: RoomPhase;
  level: number;
  players: number;
  capacity: 2;
  passwordProtected: boolean;
  protocolVersion: number;
  contentVersion: number;
}

export type NetUnitOrder =
  | { type: 'move' | 'attackMove'; x: number; y: number }
  | { type: 'attack'; targetId: EntityId };

export type GameCommand =
  | { type: 'placeBuilding'; key: BuildingKey; x: number; y: number; rot: number }
  | { type: 'paintRoad'; cells: Coord[] }
  | { type: 'placePlots'; buildingId: EntityId; cells: Coord[] }
  | { type: 'demolish'; x: number; y: number }
  | { type: 'setPriority'; siteId: EntityId; priority: boolean }
  | { type: 'queueTraining'; buildingId: EntityId; unit: UnitKind }
  | { type: 'cancelTraining'; buildingId: EntityId; index: number }
  | { type: 'setRally'; buildingId: EntityId; x: number; y: number }
  | { type: 'orderUnits'; unitIds: EntityId[]; order: NetUnitOrder; formation: Formation }
  | { type: 'collectPickup'; pickupId: EntityId }
  | { type: 'setBell'; active: boolean }
  | { type: 'requestTrade'; item: ItemKey; amount: number; destinationId: EntityId }
  | { type: 'cancelTradeRequest'; requestId: TradeRequestId }
  | { type: 'sendTrade'; item: ItemKey; amount: number; sourceId: EntityId;
      destinationId: EntityId; requestId?: TradeRequestId }
  | { type: 'cancelTradeShipment'; shipmentId: TradeShipmentId };

export interface AcceptedCommand {
  commandId: string;
  playerId: PlayerId;
  sequence: number;
  applyTick: number;
  command: GameCommand;
}

export type ClientMessage =
  | { type: 'command'; commandId: string; command: GameCommand }
  | { type: 'ready'; ready: boolean }
  | { type: 'ping'; sentAt: number }
  | { type: 'checkpoint'; tick: number; sequence: number; payload: string }
  | { type: 'reclaimDecision'; requestId: string; approve: boolean };

export type ServerMessage =
  | { type: 'welcome'; room: RoomState; playerId: PlayerId; reconnectSecret: string }
  | { type: 'roomState'; room: RoomState }
  | { type: 'commandAccepted'; accepted: AcceptedCommand }
  | { type: 'commandRejected'; commandId: string; reason: string }
  | { type: 'pong'; sentAt: number; serverAt: number }
  | { type: 'checkpoint'; tick: number; sequence: number; payload: string }
  | { type: 'reclaimRequested'; requestId: string; playerName: string; seat: PlayerId }
  | { type: 'connectionPaused'; reason: string }
  | { type: 'error'; code: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isInteger(value);
const shortString = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const coord = (value: unknown): value is Coord => object(value) && integer(value.x) && integer(value.y);

function validCommand(value: unknown): value is GameCommand {
  if (!object(value) || !shortString(value.type, 32)) return false;
  switch (value.type) {
    case 'placeBuilding': return shortString(value.key, 32) && integer(value.x) && integer(value.y) && integer(value.rot);
    case 'paintRoad': return Array.isArray(value.cells) && value.cells.length <= MAX_BATCH_CELLS && value.cells.every(coord);
    case 'placePlots': return integer(value.buildingId) && Array.isArray(value.cells) && value.cells.length <= MAX_BATCH_CELLS && value.cells.every(coord);
    case 'demolish': return integer(value.x) && integer(value.y);
    case 'setPriority': return integer(value.siteId) && typeof value.priority === 'boolean';
    case 'queueTraining': return integer(value.buildingId) && shortString(value.unit, 32);
    case 'cancelTraining': return integer(value.buildingId) && integer(value.index) && value.index >= 0;
    case 'setRally': return integer(value.buildingId) && integer(value.x) && integer(value.y);
    case 'orderUnits': {
      if (!Array.isArray(value.unitIds) || value.unitIds.length > MAX_ORDER_UNITS || !value.unitIds.every(integer)) return false;
      if (!shortString(value.formation, 16) || !object(value.order) || !shortString(value.order.type, 16)) return false;
      return value.order.type === 'attack'
        ? integer(value.order.targetId)
        : (value.order.type === 'move' || value.order.type === 'attackMove') && integer(value.order.x) && integer(value.order.y);
    }
    case 'collectPickup': return integer(value.pickupId);
    case 'setBell': return typeof value.active === 'boolean';
    case 'requestTrade': return shortString(value.item, 32) && integer(value.amount) && value.amount > 0 && value.amount <= MAX_TRADE_AMOUNT && integer(value.destinationId);
    case 'cancelTradeRequest': return shortString(value.requestId, 64);
    case 'sendTrade': return shortString(value.item, 32) && integer(value.amount) && value.amount > 0 && value.amount <= MAX_TRADE_AMOUNT && integer(value.sourceId) && integer(value.destinationId) && (value.requestId === undefined || shortString(value.requestId, 64));
    case 'cancelTradeShipment': return shortString(value.shipmentId, 64);
    default: return false;
  }
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'message_too_large' };
    try { value = JSON.parse(raw); } catch { return { ok: false, error: 'invalid_json' }; }
  }
  if (!object(value) || !shortString(value.type, 32)) return { ok: false, error: 'invalid_message' };
  switch (value.type) {
    case 'command':
      return shortString(value.commandId, 64) && validCommand(value.command)
        ? { ok: true, value: value as unknown as ClientMessage }
        : { ok: false, error: 'invalid_command' };
    case 'ready':
      return typeof value.ready === 'boolean'
        ? { ok: true, value: value as unknown as ClientMessage }
        : { ok: false, error: 'invalid_ready' };
    case 'ping':
      return finite(value.sentAt)
        ? { ok: true, value: value as unknown as ClientMessage }
        : { ok: false, error: 'invalid_ping' };
    case 'checkpoint':
      return integer(value.tick) && value.tick >= 0 && integer(value.sequence) && value.sequence >= 0 && typeof value.payload === 'string' && value.payload.length <= MAX_MESSAGE_BYTES
        ? { ok: true, value: value as unknown as ClientMessage }
        : { ok: false, error: 'invalid_checkpoint' };
    case 'reclaimDecision':
      return shortString(value.requestId, 64) && typeof value.approve === 'boolean'
        ? { ok: true, value: value as unknown as ClientMessage }
        : { ok: false, error: 'invalid_reclaim_decision' };
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

export function roomCompatible(room: Pick<RoomSummary, 'protocolVersion' | 'contentVersion'>): boolean {
  return room.protocolVersion === PROTOCOL_VERSION && room.contentVersion === CONTENT_VERSION;
}

export function validPlayerId(value: unknown): value is PlayerId {
  return isPlayerId(value);
}
