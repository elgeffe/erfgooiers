import { DEFS } from '../data/buildings';
import { isCommandableRole } from '../data/units';
import type { GameCommand } from '../net/protocol';
import type { Building, Formation, PlayerId, Site, Unit } from '../types';
import type { Game } from './Game';

/**
 * The single seam every gameplay mutation flows through. UI and Controls
 * submit `GameCommand`s; singleplayer applies them immediately, co-op relays
 * them through the host-ordered path and applies the accepted broadcast on
 * both peers. Validation here is the ownership boundary: a command may only
 * touch entities its issuing player owns.
 */
export interface CommandResult { ok: boolean; reason?: string }

const ok: CommandResult = { ok: true };
const fail = (reason: string): CommandResult => ({ ok: false, reason });

const FORMATIONS: readonly Formation[] = ['box', 'line', 'column', 'split'];

function buildingOwnedBy(game: Game, id: number, owner: PlayerId): Building | null {
  const e = game.entityById(id);
  if (!e || !('def' in e) || e.isSite || e.removed || e.owner !== owner) return null;
  return e as Building;
}

export function applyGameCommand(game: Game, playerId: PlayerId, command: GameCommand): CommandResult {
  switch (command.type) {
    case 'placeBuilding': {
      if (!(command.key in DEFS)) return fail('unknown_building');
      game.tryPlace(command.key, command.x, command.y, command.rot, playerId);
      return ok;
    }
    case 'paintRoad': {
      for (const c of command.cells) game.paintRoad(c.x, c.y, playerId);
      return ok;
    }
    case 'placePlots': {
      const b = buildingOwnedBy(game, command.buildingId, playerId);
      if (!b || !b.def.fields) return fail('not_your_fields');
      for (const c of command.cells) game.placePlot(c.x, c.y, b, playerId);
      return ok;
    }
    case 'demolish': {
      game.demolishAt(command.x, command.y, command.drag, playerId);
      return ok;
    }
    case 'setPriority': {
      const entity = game.entityById(command.siteId);
      if (!entity || !('def' in entity) || entity.removed || entity.owner !== playerId) return fail('not_your_building');
      const prioritizable = entity.isSite || !!(entity.def.recipe || entity.def.gather);
      if (!prioritizable) return fail('not_prioritizable');
      if (!!entity.priority !== command.priority) game.togglePriority(entity as Site | Building);
      return ok;
    }
    case 'queueTraining': {
      const b = buildingOwnedBy(game, command.buildingId, playerId);
      if (!b || !(b.def.military || b.def.trainer)) return fail('not_your_trainer');
      game.trainUnit(b, command.unit);
      return ok;
    }
    case 'cancelTraining': {
      const b = buildingOwnedBy(game, command.buildingId, playerId);
      if (!b || !(b.def.military || b.def.trainer)) return fail('not_your_trainer');
      game.cancelTrain(b, command.index);
      return ok;
    }
    case 'setRally': {
      const entity = game.entityById(command.buildingId);
      if (!entity || !('def' in entity) || entity.removed || entity.owner !== playerId || !entity.def.military) {
        return fail('not_your_barracks');
      }
      game.setRally(entity as Building | Site, command.x, command.y);
      return ok;
    }
    case 'orderUnits': {
      const units: Unit[] = [];
      for (const id of command.unitIds) {
        const e = game.entityById(id);
        if (!e || !('role' in e)) continue;
        const u = e as Unit;
        if (u.dead || u.owner !== playerId || u.faction !== 'player' || !isCommandableRole(u.role)) continue;
        units.push(u);
      }
      if (!units.length) return fail('no_owned_units');
      const formation = FORMATIONS.includes(command.formation) ? command.formation : 'box';
      const order = command.order;
      if (order.type === 'attack') {
        const target = game.entityById(order.targetId);
        if (!target || !('role' in target)) return fail('bad_target');
        const foe = target as Unit;
        if (foe.dead || !game.hostileOwners(playerId, foe.owner)) return fail('bad_target');
        game.orderGroup(units, 'attack', foe.tx, foe.ty, foe, formation, undefined, !!command.queue);
        return ok;
      }
      if (order.type === 'attackBuilding') {
        const target = game.entityById(order.targetId);
        if (!target || !('def' in target) || target.isSite || target.removed || !game.hostileOwners(playerId, target.owner)) return fail('bad_target');
        game.orderGroupAttackBuilding(units, target as Building, !!command.queue);
        return ok;
      }
      game.orderGroup(units, order.type, order.x, order.y, null, formation, command.facing, !!command.queue);
      return ok;
    }
    case 'collectPickup': {
      game.collectGoldAt(command.x, command.y, playerId);
      return ok;
    }
    case 'setBell': {
      game.setBell(playerId, command.active);
      return ok;
    }
    case 'requestTrade':
      return game.requestTrade(playerId, command.item, command.amount, command.destinationId) ? ok : fail('bad_request');
    case 'cancelTradeRequest':
      return game.cancelTradeRequest(playerId, command.requestId) ? ok : fail('unknown_request');
    case 'sendTrade':
      return game.sendTrade(playerId, command.item, command.amount, command.sourceId, command.destinationId, command.requestId) ? ok : fail('bad_send');
    case 'cancelTradeShipment':
      return game.cancelTradeShipment(playerId, command.shipmentId) ? ok : fail('unknown_shipment');
    case 'startExpedition':
      // run lifecycle belongs to main.ts, not the simulation
      return fail('lifecycle_command');
  }
}
