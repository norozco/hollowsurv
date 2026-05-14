// Hidden synergies. When the player owns a specific pair of weapon + augment
// (or two weapons), a "synergy" activates and produces a bonus combat effect.
//
// Discovery is half the fun, so there is no UI tab listing these — the only
// acknowledgement is a one-shot SynergyToast the first time the pair is
// completed in a run.
//
// Owner: Integration agent.
//
// API surface (kept tiny on purpose):
//   - SYNERGY_DEFINITIONS    -> static metadata array
//   - SynergyId              -> union of the 4 ids
//   - hasSynergy(id)         -> O(1) lookup used in combat hot paths
//   - tickSynergies()        -> called once per autoAttack tick; emits
//                               'synergy_activated' the first time a
//                               synergy becomes active in this run
//   - resetSynergies()       -> wipes per-run state (current active + which
//                               toasts already fired). Called automatically
//                               when 'character_selected' fires.
//
// The active set is recomputed inside tickSynergies(): we do a tiny linear
// scan over runStore.player.weapons + augment scalar fields. Cost is bounded
// by the number of synergies (4) × the number of weapons owned (<=6), and we
// only allocate when the set actually changes (which is at most a handful of
// times per run).

import { eventBus } from '../../core/eventBus';
import { useRunStore } from '../../stores/runStore';

export type SynergyId = 'frostbite' | 'hollowfield' | 'chainstrike' | 'last_stand';

interface SynergyDefinition {
  id: SynergyId;
  /** Display name shown in the toast. ALL CAPS for that "skill unlocked" feel. */
  name: string;
  /** Weapons that must be in runStore.player.weapons for the synergy to be active. */
  requiredWeapons: readonly string[];
  /**
   * Augment scalar field on RunState['player'] that must be > 0 for the
   * synergy to be active. Optional — Frostbite only needs two weapons.
   */
  requiredAugmentField?: 'thornsReflect' | 'critChance' | 'berserkerMul';
  /** One-line designer note. Not shown to the player. */
  description: string;
}

export const SYNERGY_DEFINITIONS: readonly SynergyDefinition[] = [
  {
    id: 'frostbite',
    name: 'FROSTBITE',
    requiredWeapons: ['blade', 'frost-nova'],
    description: 'Blade deals 3x damage to slowed enemies.',
  },
  {
    id: 'hollowfield',
    name: 'HOLLOWFIELD',
    requiredWeapons: ['aura'],
    requiredAugmentField: 'thornsReflect',
    description: 'Taking damage fires a free aura tick around the player.',
  },
  {
    id: 'chainstrike',
    name: 'CHAINSTRIKE',
    requiredWeapons: ['lightning'],
    requiredAugmentField: 'critChance',
    description: 'Lightning crits double the chain count.',
  },
  {
    id: 'last_stand',
    name: 'LAST STAND',
    requiredWeapons: ['shotgun'],
    requiredAugmentField: 'berserkerMul',
    description: 'Below 30% HP, shotgun fires 8 pellets in a full 360.',
  },
];

// --- per-run state --------------------------------------------------------

/** Synergies currently active given the player's loadout (recomputed each tick). */
const activeSet: Set<SynergyId> = new Set();
/** Synergies that have already produced a toast this run. */
const seenSet: Set<SynergyId> = new Set();
/** Subscribe once; idempotent. */
let _resetSubscribed = false;

export function hasSynergy(id: SynergyId): boolean {
  return activeSet.has(id);
}

export function resetSynergies(): void {
  activeSet.clear();
  seenSet.clear();
}

/**
 * Re-evaluate which synergies are active, given the current runStore state.
 * Fires a `synergy_activated` event the first time each synergy goes active
 * during this run. Cheap — called from autoAttackSystem once per tick.
 */
export function tickSynergies(): void {
  ensureResetSubscription();
  const store = useRunStore.getState();
  const player = store.player;
  const ownedIds = ownedWeaponIdSet(player.weapons);

  for (let i = 0; i < SYNERGY_DEFINITIONS.length; i++) {
    const def = SYNERGY_DEFINITIONS[i];
    if (!def) continue;
    const active = isActive(def, player, ownedIds);
    if (active) {
      if (!activeSet.has(def.id)) {
        activeSet.add(def.id);
        if (!seenSet.has(def.id)) {
          seenSet.add(def.id);
          eventBus.emit({ type: 'synergy_activated', synergyId: def.id, name: def.name });
        }
      }
    } else if (activeSet.has(def.id)) {
      // Effect stops applying when the requirements are no longer met.
      // The first-time toast is intentionally not replayed on re-activation.
      activeSet.delete(def.id);
    }
  }
}

// --- helpers --------------------------------------------------------------

type PlayerSnapshot = ReturnType<typeof useRunStore.getState>['player'];

function ownedWeaponIdSet(weapons: PlayerSnapshot['weapons']): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < weapons.length; i++) {
    const w = weapons[i];
    if (w) out.add(w.id);
  }
  return out;
}

function isActive(
  def: SynergyDefinition,
  player: PlayerSnapshot,
  ownedIds: Set<string>,
): boolean {
  for (let i = 0; i < def.requiredWeapons.length; i++) {
    const id = def.requiredWeapons[i];
    if (id !== undefined && !ownedIds.has(id)) return false;
  }
  if (def.requiredAugmentField) {
    const val = player[def.requiredAugmentField];
    if (!(val > 0)) return false;
  }
  return true;
}

function ensureResetSubscription(): void {
  if (_resetSubscribed) return;
  _resetSubscribed = true;
  eventBus.on('character_selected', () => {
    resetSynergies();
  });
}
