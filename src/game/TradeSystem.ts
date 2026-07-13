import { BASE_SPEED } from '../constants';
import { ITEMS } from '../data/items';
import type { Building, Coord, ItemKey, PlayerId, Site, Unit } from '../types';
import { doorTile } from './util';
import {
  TRADE, tradeEta, tradeLoadTime, tradePartner, tradeShipmentActive,
  type TradeHistoryEntry, type TradeRequest, type TradeShipment,
} from './trade';

/** Operations trade needs from the simulation facade. Keeping this port small
 * prevents a runtime Game <-> TradeSystem dependency and makes ownership of
 * entity arrays, movement, rendering callbacks, and selection explicit. */
export interface TradePort {
  readonly localPlayerId: PlayerId;
  now(): number;
  entityById(id: number): Building | Site | Unit | null;
  stores(owner: PlayerId): Building[];
  pathLength(from: Coord, to: Coord): number | null;
  spawnCarrier(owner: PlayerId, at: Coord): Unit;
  setCarrying(unit: Unit, item: string | null): void;
  despawnCarrier(unit: Unit): void;
  sendTo(unit: Unit, destination: Coord): boolean;
  moveUnit(unit: Unit, dt: number): void;
  toast(message: string, cls?: string): void;
  sfx(name: string): void;
}

/** Physical co-op shipments and requests. Game retains the public facade;
 * this system owns only trade state and advances it once per fixed sim tick. */
export class TradeSystem {
  readonly requests: TradeRequest[] = [];
  readonly shipments: TradeShipment[] = [];
  readonly history: TradeHistoryEntry[] = [];
  private seq = 0;

  constructor(private readonly port: TradePort) {}

  private log(kind: TradeHistoryEntry['kind'], text: string): void {
    this.history.unshift({ at: this.port.now(), kind, text });
    if (this.history.length > TRADE.historyCap) this.history.length = TRADE.historyCap;
  }

  private storeById(id: number, owner: PlayerId): Building | null {
    const b = this.port.entityById(id);
    if (!b || !('def' in b) || b.isSite || !b.def.store || b.removed || b.owner !== owner) return null;
    return b as Building;
  }

  request(owner: PlayerId, item: string, amount: number, destinationId: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0 || !(item in ITEMS)) return false;
    if (!this.storeById(destinationId, owner)) {
      if (owner === this.port.localPlayerId) this.port.toast('Choose one of your own storehouses for the delivery', 'err');
      return false;
    }
    const request: TradeRequest = {
      id: `t${++this.seq}`, from: owner, item: item as ItemKey,
      amount, destinationId, status: 'open', at: this.port.now(),
    };
    this.requests.unshift(request);
    this.log('requested', `${owner === this.port.localPlayerId ? 'You' : 'Your ally'} requested ${amount} ${ITEMS[request.item].name.toLowerCase()}`);
    if (owner !== this.port.localPlayerId) {
      this.port.toast(`Your ally asks for ${amount} ${ITEMS[request.item].name.toLowerCase()} — open the Trade tab`, 'err');
      this.port.sfx('click');
    }
    return true;
  }

  cancelRequest(actor: PlayerId, requestId: string): boolean {
    const request = this.requests.find(candidate => candidate.id === requestId && candidate.status === 'open');
    if (!request) return false;
    request.status = request.from === actor ? 'cancelled' : 'declined';
    this.log(request.status, `Request for ${request.amount} ${ITEMS[request.item].name.toLowerCase()} ${request.status}`);
    return true;
  }

  send(owner: PlayerId, item: string, amount: number, sourceId: number, destinationId: number, requestId?: string): boolean {
    const local = owner === this.port.localPlayerId;
    if (!Number.isInteger(amount) || amount <= 0 || !(item in ITEMS)) return false;
    const source = this.storeById(sourceId, owner);
    const destination = this.storeById(destinationId, tradePartner(owner));
    if (!source || !destination) {
      if (local) this.port.toast('Trade needs your storehouse and a standing allied storehouse', 'err');
      return false;
    }
    const amountSent = Math.min(amount, source.stock![item] || 0);
    if (amountSent <= 0) {
      if (local) {
        this.port.toast('Not enough ' + ITEMS[item as keyof typeof ITEMS].name.toLowerCase() + ' in that storehouse', 'err');
        this.port.sfx('error');
      }
      return false;
    }
    const sourceDoor = doorTile(source), destinationDoor = doorTile(destination);
    const pathLength = this.port.pathLength(sourceDoor, destinationDoor);
    if (pathLength === null) {
      if (local) {
        this.port.toast("No land route to your ally's storehouse", 'err');
        this.port.sfx('error');
      }
      return false;
    }
    source.stock![item] = (source.stock![item] || 0) - amountSent;
    const carrier = this.port.spawnCarrier(owner, sourceDoor);
    carrier.roleName = 'Carrier';
    carrier.status = 'Loading the cart';
    carrier.hp = carrier.maxHp = TRADE.carrierHp;
    carrier.spd = BASE_SPEED * TRADE.carrierSpeedMult;
    this.port.setCarrying(carrier, item);
    const shipment: TradeShipment = {
      id: `t${++this.seq}`, from: owner, to: tradePartner(owner),
      item: item as ItemKey, amount: amountSent, sourceId, destinationId,
      phase: 'loading', loadT: tradeLoadTime(amountSent), eta: tradeEta(pathLength, BASE_SPEED),
      carrier, requestId, at: this.port.now(),
    };
    this.shipments.unshift(shipment);
    if (requestId) {
      const request = this.requests.find(candidate => candidate.id === requestId && candidate.status === 'open' && candidate.from === shipment.to);
      if (request) {
        request.status = 'fulfilled';
        shipment.destinationId = this.storeById(request.destinationId, shipment.to) ? request.destinationId : shipment.destinationId;
      }
    }
    if (local) this.port.toast(`Cart loading — ${amountSent} ${ITEMS[shipment.item].name.toLowerCase()} bound for your ally`);
    else this.port.toast(`Your ally is sending ${amountSent} ${ITEMS[shipment.item].name.toLowerCase()}`);
    this.port.sfx('place');
    return true;
  }

  cancelShipment(actor: PlayerId, shipmentId: string): boolean {
    const shipment = this.shipments.find(candidate => candidate.id === shipmentId && candidate.from === actor);
    if (!shipment || !tradeShipmentActive(shipment)) return false;
    if (shipment.phase === 'loading') {
      this.refund(shipment);
      shipment.phase = 'recalled';
      this.despawn(shipment);
      this.log('recalled', `Shipment of ${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} cancelled before departure`);
      return true;
    }
    if (shipment.phase === 'enroute') {
      shipment.phase = 'returning';
      if (shipment.carrier) {
        shipment.carrier.path = null;
        shipment.carrier.status = 'Recalled — turning the cart around';
      }
      if (actor === this.port.localPlayerId) this.port.toast('Shipment recalled — the cart turns for home');
      return true;
    }
    return false;
  }

  private refund(shipment: TradeShipment): void {
    const source = this.storeById(shipment.sourceId, shipment.from) ?? this.port.stores(shipment.from)[0] ?? null;
    if (!source) {
      this.log('lost', `${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} had nowhere to return to`);
      return;
    }
    source.stock![shipment.item] = (source.stock![shipment.item] || 0) + shipment.amount;
  }

  private despawn(shipment: TradeShipment): void {
    const carrier = shipment.carrier;
    shipment.carrier = null;
    if (carrier) this.port.despawnCarrier(carrier);
  }

  update(dt: number): void {
    for (const shipment of this.shipments) {
      if (!tradeShipmentActive(shipment)) continue;
      const carrier = shipment.carrier;
      if (!carrier || carrier.dead) {
        shipment.phase = 'lost';
        shipment.carrier = null;
        this.log('lost', `A caravan was lost with ${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()}`);
        this.port.toast(`A trade caravan was ambushed — ${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} lost`, 'err');
        continue;
      }
      if (shipment.phase === 'loading') {
        shipment.loadT -= dt;
        carrier.mesh.position.y = 0;
        if (shipment.loadT <= 0) {
          shipment.phase = 'enroute';
          carrier.status = `Hauling ${ITEMS[shipment.item].name.toLowerCase()} to the ally`;
        }
        continue;
      }
      if (shipment.phase === 'enroute') {
        const destination = this.storeById(shipment.destinationId, shipment.to);
        if (!destination) {
          shipment.phase = 'returning';
          carrier.path = null;
          carrier.status = 'Destination gone — returning';
          continue;
        }
        const door = doorTile(destination);
        if (carrier.tx === door.x && carrier.ty === door.y && !carrier.path) {
          destination.stock![shipment.item] = (destination.stock![shipment.item] || 0) + shipment.amount;
          shipment.phase = 'delivered';
          this.log('delivered', `${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} delivered to ${shipment.to === this.port.localPlayerId ? 'you' : 'your ally'}`);
          this.port.toast(shipment.to === this.port.localPlayerId
            ? `Trade arrived: ${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} from your ally`
            : `Your shipment of ${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} was delivered`);
          this.port.sfx('coin');
          this.despawn(shipment);
          continue;
        }
        this.walk(carrier, door, dt);
        continue;
      }
      const home = this.storeById(shipment.sourceId, shipment.from) ?? this.port.stores(shipment.from)[0] ?? null;
      if (!home) {
        shipment.phase = 'lost';
        this.log('lost', `${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} had nowhere to return to`);
        this.despawn(shipment);
        continue;
      }
      const door = doorTile(home);
      if (carrier.tx === door.x && carrier.ty === door.y && !carrier.path) {
        home.stock![shipment.item] = (home.stock![shipment.item] || 0) + shipment.amount;
        shipment.phase = 'recalled';
        this.log('recalled', `${shipment.amount} ${ITEMS[shipment.item].name.toLowerCase()} returned to the storehouse`);
        if (shipment.from === this.port.localPlayerId) this.port.toast('Recalled shipment unloaded back into your storehouse');
        this.despawn(shipment);
        continue;
      }
      this.walk(carrier, door, dt);
    }
  }

  private walk(carrier: Unit, destination: Coord, dt: number): void {
    if (!carrier.path) {
      carrier.timer -= dt;
      if (carrier.timer <= 0) {
        carrier.timer = 1;
        this.port.sendTo(carrier, destination);
      }
    }
    if (carrier.path) this.port.moveUnit(carrier, dt); else carrier.mesh.position.y = 0;
  }
}
