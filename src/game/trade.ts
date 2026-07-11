import type { ItemKey, PlayerId, Unit } from '../types';

/**
 * Physical trade between the two allied co-op economies. The Trade tab is the
 * only way goods cross ownership: a confirmed send reserves the goods, loads a
 * visible carrier at the sender's storehouse and walks it to the ally's store.
 * Goods enter the recipient's stock only on arrival; a slain carrier's cargo
 * is lost on the road — nothing teleports and nothing reappears magically.
 */
export type TradeShipmentPhase = 'loading' | 'enroute' | 'returning' | 'delivered' | 'lost' | 'recalled';
export type TradeRequestStatus = 'open' | 'fulfilled' | 'declined' | 'cancelled';

export interface TradeRequest {
  id: string;
  from: PlayerId;              // who is asking for goods
  item: ItemKey;
  amount: number;
  destinationId: number;       // the requester's storehouse the goods should reach
  status: TradeRequestStatus;
  at: number;                  // sim seconds when the request was made
}

export interface TradeShipment {
  id: string;
  from: PlayerId;              // sender (pays the goods, owns the carrier)
  to: PlayerId;                // recipient
  item: ItemKey;
  amount: number;
  sourceId: number;            // sender's storehouse the carrier loads at
  destinationId: number;       // recipient's storehouse it delivers to
  phase: TradeShipmentPhase;
  loadT: number;               // seconds of loading left before departure
  eta: number;                 // travel estimate (seconds) computed at dispatch
  carrier: Unit | null;        // the walking cart (null once resolved)
  requestId?: string;          // the request this send fulfils, if any
  at: number;                  // sim seconds when the send was confirmed
}

export interface TradeHistoryEntry {
  at: number;
  kind: 'delivered' | 'lost' | 'recalled' | 'requested' | 'declined' | 'cancelled';
  text: string;
}

/** Tunables for shipment logistics (playtest targets, not engine constants). */
export const TRADE = {
  /** Seconds to load a cart before it departs, plus per-item handling. */
  loadTimeBase: 2,
  loadTimePerItem: 0.1,
  /** Carrier walk speed as a multiple of the base worker speed. */
  carrierSpeedMult: 0.9,
  /** A cart is sturdier than a serf but still very much interceptable. */
  carrierHp: 40,
  /** Most recent history entries kept per game. */
  historyCap: 30,
} as const;

/** Seconds a shipment of `amount` goods spends loading before departure. */
export function tradeLoadTime(amount: number): number {
  return TRADE.loadTimeBase + TRADE.loadTimePerItem * Math.max(0, amount);
}

/** Travel-time estimate for a path of `tiles` steps at carrier speed. */
export function tradeEta(tiles: number, baseSpeed: number): number {
  const speed = baseSpeed * TRADE.carrierSpeedMult;
  return speed > 0 ? tiles / speed : Infinity;
}

/** The ally a player trades with (exactly two seats in co-op). */
export function tradePartner(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
}

/** A shipment still on the map (loading, walking out, or walking back). */
export function tradeShipmentActive(s: TradeShipment): boolean {
  return s.phase === 'loading' || s.phase === 'enroute' || s.phase === 'returning';
}
