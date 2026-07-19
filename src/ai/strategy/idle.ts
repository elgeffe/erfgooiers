import type { GameCommand } from '../../net/protocol';
import type { MacroPolicy } from './types';

/** Phase 0 seam-prover: a seat that does nothing at all. Also the ladder floor
 *  every real policy must demonstrably beat. */
export class IdleMacro implements MacroPolicy {
  plan(): GameCommand[] { return []; }
}
