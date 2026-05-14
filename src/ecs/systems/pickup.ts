// Pickup magnetism + collection. Two passes per tick:
//   1. magnetism — write Velocity toward the player when within Stats-scaled
//      pickup radius; otherwise zero out velocity.
//   2. collection — when a pickup overlaps the player hitbox, emit
//      `pickup_collected` and recycle the entity.
//
// Movement integration is C1's movementSystem, which runs *before* pickupSystem
// in the canonical tick order. That means writes here take effect on the
// *next* frame's draw, but collision detection uses fresh integrated positions
// from this frame. Acceptable: a one-frame visual lag during magnetism is not
// noticeable at 60 fps, and the alternative (running magnet before movement)
// would over-shoot the player for very fast orbs.
//
// Owner: Agent C4.
import { addComponent, defineQuery, hasComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { releaseEntity } from '../../core/pool';
import {
  Dead,
  Hitbox,
  Pickup,
  PlayerTag,
  Position,
  Stats,
  Velocity,
  XPValue,
} from '../components';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

import { PICKUP_KIND_XP } from './xp';

// --- tunables ---------------------------------------------------------------

/** Base magnet radius. Stats.pickupRadiusMul scales this per player. */
const BASE_PICKUP_RADIUS_PX = 80;

/** Speed at which an orb travels toward the player when magnetised. */
const MAGNET_SPEED_PX_PER_SEC = 600;

// --- queries ---------------------------------------------------------------

const playerQuery = defineQuery([PlayerTag, Position, Stats, Hitbox]);
const pickupQuery = defineQuery([Pickup, Position, Velocity, Hitbox]);

/**
 * Tick the pickup system.
 *
 * Allocations: zero in the steady state. Event payloads are reused by the bus
 * (handlers read fields immediately).
 *
 * Skipped while the run is not in the 'playing' phase. Per the brief, this
 * keeps orbs frozen during level-up / pause; they resume on the next tick.
 */
export function pickupSystem(world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  // --- locate the player. There's only one PlayerTag entity in v1 ---
  const players = playerQuery(world);
  let playerEid = -1;
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid !== undefined) {
      playerEid = eid;
      break;
    }
  }
  if (playerEid < 0) return; // player not yet spawned (shouldn't happen mid-run)

  const px = Position.x[playerEid] ?? 0;
  const py = Position.y[playerEid] ?? 0;
  const playerR = Hitbox.radius[playerEid] ?? 0;
  const radiusMul = Stats.pickupRadiusMul[playerEid] ?? 1;
  const magnetRadius = BASE_PICKUP_RADIUS_PX * radiusMul;
  const magnetRadiusSq = magnetRadius * magnetRadius;

  const pickups = pickupQuery(world);

  // --- pass 1: magnetism ---
  for (let i = 0; i < pickups.length; i++) {
    const eid = pickups[i];
    if (eid === undefined) continue;
    // Defensive: skip already-Dead pickups so we don't re-write velocity for
    // entities that are about to be reaped by lifetimeSystem this tick.
    if (hasComponent(world, Dead, eid)) continue;

    const ox = Position.x[eid] ?? 0;
    const oy = Position.y[eid] ?? 0;
    const dx = px - ox;
    const dy = py - oy;
    const distSq = dx * dx + dy * dy;

    if (distSq < magnetRadiusSq) {
      const dist = Math.sqrt(distSq);
      if (dist > 0.0001) {
        const inv = 1 / dist;
        Velocity.vx[eid] = dx * inv * MAGNET_SPEED_PX_PER_SEC;
        Velocity.vy[eid] = dy * inv * MAGNET_SPEED_PX_PER_SEC;
        Pickup.magnetized[eid] = 1;
      } else {
        Velocity.vx[eid] = 0;
        Velocity.vy[eid] = 0;
      }
    } else {
      Velocity.vx[eid] = 0;
      Velocity.vy[eid] = 0;
      Pickup.magnetized[eid] = 0;
    }
  }

  // --- pass 2: collection ---
  // Uses the entity's *current* Position. movementSystem (C1) runs before
  // pickupSystem in the canonical tick order, so by the time we get here the
  // magnet velocity written last frame has already moved the orb closer.
  // First-frame edge: an orb spawned this tick has zero velocity so it
  // can't be collected immediately unless the player is already on top of
  // it — that's correct.
  for (let i = 0; i < pickups.length; i++) {
    const eid = pickups[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;

    const ox = Position.x[eid] ?? 0;
    const oy = Position.y[eid] ?? 0;
    const dx = px - ox;
    const dy = py - oy;
    const distSq = dx * dx + dy * dy;
    const orbR = Hitbox.radius[eid] ?? 0;
    const collectR = playerR + orbR;
    const collectRSq = collectR * collectR;

    if (distSq <= collectRSq) {
      collect(world, eid);
    }
  }
}

/**
 * Internal: emit pickup_collected for the given orb and recycle the entity.
 *
 * Marks the entity Dead per the brief so a future lifetimeSystem (Agent C3)
 * can also recycle it idempotently. Releasing here directly ensures orbs
 * disappear today, before lifetimeSystem ships.
 */
function collect(world: World, eid: number): void {
  const kindCode = Pickup.kind[eid] ?? PICKUP_KIND_XP;
  // Map the ui8 kind back to the GameEvent string. Only 'xp' is wired in v1;
  // other branches fall through to 'xp' as a safe default.
  const kind: 'xp' | 'gold' | 'heal' = kindCode === 1 ? 'gold' : kindCode === 2 ? 'heal' : 'xp';
  // Prefer XPValue.amount (set by xpSystem at spawn) so the contract field
  // drives level-up math; fall back to Pickup.value if XPValue is missing.
  const value = XPValue.amount[eid] ?? Pickup.value[eid] ?? 0;

  eventBus.emit({
    type: 'pickup_collected',
    entity: eid,
    kind,
    value,
  });

  // Pickup visuals are batched (`batchedRender.ts`) — once releaseEntity
  // strips the Pickup component, the renderer's query stops returning this
  // eid so the orb stops drawing without any explicit destroy call.

  // Mark Dead in case any future system (lifetime, audit) wants to observe
  // collection within the same tick. releaseEntity strips this immediately,
  // so no double-recycle risk if lifetimeSystem also queries Dead later.
  if (!hasComponent(world, Dead, eid)) {
    addComponent(world, Dead, eid);
  }
  releaseEntity(world, eid);
}
