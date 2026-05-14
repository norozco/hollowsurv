// XP orb spawner. Listens for `enemy_killed` events and drops a pickup at the
// kill location. The collection side (player overlap, level-up flow) lives in
// pickupSystem + runStore._applyEvent — this file only handles spawning.
// Owner: Agent C4.
//
// Tick role (ARCHITECTURE.md §3):
//   pickupSystem -> xpSystem. xpSystem does no per-frame work beyond draining
//   the pending-drop queue (populated by the eventBus subscription) so that
//   spawning happens on the simulation tick (consistent with the rest of the
//   pipeline).
//
// Rendering: handled by the batched renderer (`batchedRender.ts`). xpSystem
// only writes ECS components — Position + Sprite.tint + Hitbox.radius drive
// the procedural draw. No per-orb Phaser GameObjects are created.
import { addComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { acquirePickup } from '../../core/pool';
import { rng } from '../../core/rng';
import {
  Hitbox,
  Pickup,
  Position,
  Sprite,
  Velocity,
  XPValue,
} from '../components';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

/** Pickup.kind values, mirroring CONTRACTS.md §1 / GameEvent.pickup_collected.kind. */
export const PICKUP_KIND_XP = 0;
export const PICKUP_KIND_GOLD = 1;
export const PICKUP_KIND_HEAL = 2;

/** Default XP awarded by an orb dropped by a non-boss enemy kill. */
const DEFAULT_XP_VALUE = 1;

/** Pickup hitbox radius in pixels. Combined with the player hitbox in pickupSystem. */
const PICKUP_HITBOX_RADIUS_PX = 10;

/** Visual placeholder colour: matches the spec note (`Sprite.tint=0xa6e36c`). */
const PICKUP_TINT = 0xa6e36c;

/** Health-pack colour and value. Drops on a small % of kills. */
const HEAL_TINT = 0xff5577;
const HEAL_DROP_CHANCE = 0.08; // 8% chance per kill
const HEAL_VALUE = 20;

/**
 * Internal queue of (x, y, value) triples to spawn on the next xp tick.
 * Synchronous emit -> tick spawn keeps spawning consistent with the rest of
 * the simulation (no entities created mid-tick from a different system).
 */
interface PendingDrop {
  x: number;
  y: number;
  value: number;
  kind: number; // PICKUP_KIND_*
}
const _pendingDrops: PendingDrop[] = [];

/**
 * eventBus unsubscribe handle. We register lazily on the first tick so module
 * initialization order can't deadlock against scene boot. v1 keeps the
 * subscription alive for the lifetime of the page; ArenaScene calls
 * `eventBus.clear()` on shutdown which removes our handler too.
 */
let _unsubscribe: (() => void) | null = null;

function ensureSubscribed(): void {
  if (_unsubscribe) return;
  _unsubscribe = eventBus.on('enemy_killed', (e) => {
    // Read fields immediately — event payload may be reused across emissions.
    const x = e.position?.x ?? 0;
    const y = e.position?.y ?? 0;
    _pendingDrops.push({ x, y, value: DEFAULT_XP_VALUE, kind: PICKUP_KIND_XP });
    // Roll for a health-pack drop on top of the XP orb.
    // Use rng() so heal drops are deterministic under Daily Seed.
    if (rng() < HEAL_DROP_CHANCE) {
      // Offset slightly so the heal pack and XP orb don't perfectly overlap visually.
      _pendingDrops.push({ x: x + 16, y: y + 4, value: HEAL_VALUE, kind: PICKUP_KIND_HEAL });
    }
  });
}

/**
 * Spawn one pickup orb at world coordinates. `kind` is PICKUP_KIND_XP or
 * PICKUP_KIND_HEAL. XP orbs progress level; heal packs restore HP via runStore.
 */
function spawnPickup(world: World, x: number, y: number, value: number, kind: number): void {
  const eid = acquirePickup(world);

  addComponent(world, Position, eid);
  addComponent(world, Velocity, eid);
  addComponent(world, Pickup, eid);
  addComponent(world, XPValue, eid);
  addComponent(world, Hitbox, eid);
  addComponent(world, Sprite, eid);

  const isHeal = kind === PICKUP_KIND_HEAL;
  const tint = isHeal ? HEAL_TINT : PICKUP_TINT;

  Position.x[eid] = x;
  Position.y[eid] = y;
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  Pickup.kind[eid] = kind;
  Pickup.value[eid] = value;
  Pickup.magnetized[eid] = 0;
  XPValue.amount[eid] = value;
  Hitbox.radius[eid] = isHeal ? PICKUP_HITBOX_RADIUS_PX + 2 : PICKUP_HITBOX_RADIUS_PX;
  Sprite.textureIndex[eid] = 0;
  Sprite.tint[eid] = tint;
  Sprite.scale[eid] = 1;
  Sprite.rotation[eid] = 0;
}

/**
 * Tick the XP system. Drains the pending-drop queue (populated by the
 * eventBus subscription) and spawns one orb per drop.
 *
 * Skipped while the run is not in the 'playing' phase — but the subscription
 * stays live so events queued during pause are still processed once the run
 * resumes.
 */
export function xpSystem(world: World, _dtMs: number): void {
  ensureSubscribed();

  if (useRunStore.getState().phase !== 'playing') return;

  // --- drain queued drops (allocations only on the rare spawn path) ---
  if (_pendingDrops.length > 0) {
    for (let i = 0; i < _pendingDrops.length; i++) {
      const drop = _pendingDrops[i];
      if (!drop) continue;
      spawnPickup(world, drop.x, drop.y, drop.value, drop.kind);
    }
    _pendingDrops.length = 0;
  }
}

/**
 * Test/dev hook. Resets the subscription and clears pending drops so unit
 * tests don't leak handlers between cases. Not called in production.
 */
export function _resetXpSystemForTest(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _pendingDrops.length = 0;
}
