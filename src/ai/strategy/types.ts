import type { Rng } from '../../engine/rng';
import type { Game } from '../../game/Game';
import type { World } from '../../world/World';
import type { GameCommand } from '../../net/protocol';
import type { AIProfile } from '../../data/aiProfiles';
import type { Coord } from '../../types';
import type { AIView } from '../perception';

/** Everything a decision pass may consult. `view` is the perception snapshot;
 *  `game`/`world` are passed only for legality queries (canPlace, canPlotFor) —
 *  policies must not read sim state directly (that is perception's job). */
export interface PolicyContext {
  game: Game;
  world: World;
  view: AIView;
  profile: AIProfile;
  rng: Rng;
  /** Tile on the route toward the enemy base: towers guard it, armies muster on it. */
  approach: Coord;
}

/**
 * The macro seam every policy implements — classic scripts today, learned
 * models and research-track optimizers later, all interchangeable behind it.
 * A pass returns the commands it wants submitted, best first; the controller
 * applies its action budget and drops the tail when the budget runs dry.
 */
export interface MacroPolicy {
  plan(ctx: PolicyContext): GameCommand[];
  /** Optional posture the policy wants the tactics layer to adopt — army cap,
   *  siege/healer quotas, wave commitment, home guard, raid appetite. A policy
   *  that chooses strategy must be able to choose its END-GAME too, rather than
   *  inheriting fixed profile defaults it never picked. The controller merges
   *  these over the profile for tactics only; the fairness budgets (cadence,
   *  APM, reaction delay, visibility) are NOT overridable. */
  readonly directives?: Partial<AIProfile>;
}
