// XP orb spawner. Listens for `enemy_killed` events and drops a pickup at the
// kill location. The collection side (player overlap, level-up flow) lives in
// pickupSystem + runStore._applyEvent — this file only handles spawning.
// Owner: Agent C4.
//
// Tick role (ARCHITECTURE.md §3):
//   pickupSystem -> xpSystem. xpSystem does no per-frame work; it consumes an
//   internal queue populated by the eventBus subscription so that spawning
//   happens on the simulation tick (consistent with the rest of the pipeline).
//
// Phaser visuals: the orb is rendered by a placeholder Arc GameObject created
// in `acquireOrbSprite`. We keep a Map<eid, Arc> updated each tick from the
// ECS Position. When pickupSystem releases the entity, the sprite is destroyed.
// Once C3/C1 ship a SpriteGPULayer, this throwaway-render code can be deleted.
import { addComponent } from 'bitecs';
import Phaser from 'phaser';

import { eventBus } from '../../core/eventBus';
import { acquirePickup } from '../../core/pool';
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

/** Visual placeholder radius for the Phaser circle. */
const ORB_VISUAL_RADIUS_PX = 6;
const HEAL_VISUAL_RADIUS_PX = 9;

/**
 * Map of pickup eid -> Phaser Arc used as a stand-in sprite. Module-local
 * because there's only ever one ArenaScene at a time (ARCHITECTURE.md §3).
 *
 * Exported so pickupSystem can update positions and destroy on collection
 * without re-importing Phaser internals.
 */
export const ORB_SPRITES: Map<number, Phaser.GameObjects.Arc> = new Map();

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
    if (Math.random() < HEAL_DROP_CHANCE) {
      // Offset slightly so the heal pack and XP orb don't perfectly overlap visually.
      _pendingDrops.push({ x: x + 16, y: y + 4, value: HEAL_VALUE, kind: PICKUP_KIND_HEAL });
    }
  });
}

/**
 * Find the active Phaser ArenaScene if Phaser has booted. Returns null when
 * the scene isn't running (e.g. during boot, between runs). Visual orbs are
 * skipped in that case but the ECS state still updates — safe.
 */
function findArenaScene(): Phaser.Scene | null {
  const game = (globalThis as { __game?: Phaser.Game }).__game;
  if (!game) return null;
  const scene = game.scene.getScene('ArenaScene');
  if (!scene) return null;
  // `getScene` can return a non-running scene; only use it when active so we
  // don't add GameObjects to a scene that hasn't created its display list.
  if (!game.scene.isActive('ArenaScene')) return null;
  return scene;
}

function acquireOrbSprite(scene: Phaser.Scene, eid: number, x: number, y: number, isHeal: boolean): void {
  const radius = isHeal ? HEAL_VISUAL_RADIUS_PX : ORB_VISUAL_RADIUS_PX;
  const tint = isHeal ? HEAL_TINT : PICKUP_TINT;
  const arc = scene.add.circle(x, y, radius, tint);
  arc.setStrokeStyle(isHeal ? 2 : 1, 0xffffff, isHeal ? 0.85 : 0.5);
  ORB_SPRITES.set(eid, arc);
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

  const scene = findArenaScene();
  if (scene) {
    acquireOrbSprite(scene, eid, x, y, isHeal);
  }
}

/**
 * Tick the XP system. Drains the pending-drop queue (populated by the
 * eventBus subscription) and spawns one orb per drop. Then syncs each orb's
 * Phaser sprite to its ECS Position so movement/magnetism is visible.
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

  // --- sync orb sprites to ECS Position ---
  // The Map is small (bounded by PoolKind.Pickup cap = 1000) and only iterated
  // when there are active orbs.
  if (ORB_SPRITES.size > 0) {
    for (const [eid, arc] of ORB_SPRITES) {
      arc.x = Position.x[eid] ?? arc.x;
      arc.y = Position.y[eid] ?? arc.y;
    }
  }
}

/**
 * Destroy the Phaser sprite for a pickup eid. Called by pickupSystem when an
 * orb is collected (and would also be called on forced pool recycle if/when
 * lifetimeSystem grows that hook).
 */
export function destroyOrbSprite(eid: number): void {
  const arc = ORB_SPRITES.get(eid);
  if (arc) {
    arc.destroy();
    ORB_SPRITES.delete(eid);
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
  for (const arc of ORB_SPRITES.values()) arc.destroy();
  ORB_SPRITES.clear();
}
