// Projectile-specific behaviors.
// Owner: Agent C3.
//
// Responsibilities:
//   - Decrement Lifetime.remainingMs for each projectile. When the timer
//     reaches zero or below, mark the projectile Dead so lifetimeSystem
//     recycles it at the end of the tick.
//   - Boomerang flip + ricochet bookkeeping for evolved projectiles.
//
// Rendering is handled by the batched renderer (`batchedRender.ts`). This
// system writes ECS-only side effects; visuals come from Sprite.tint +
// Hitbox.radius read once per tick by `batchedRenderSystem`.
//
// Note: Velocity -> Position integration happens in C1's movementSystem
// upstream of us in the tick order. We must not duplicate the integration.

import { addComponent, defineQuery, hasComponent } from 'bitecs';

import { Dead, Lifetime, Position, ProjectileTag, Velocity } from '../components';
import {
  consumeBoomerangFlip,
  consumeRicochet,
  getRicochetsRemaining,
  isOrbiter,
} from './autoAttack';
import { useRunStore } from '../../stores/runStore';
import { ARENA_SIZE_PX } from '../../core/flowfield';
import type { World } from '../world';

/**
 * Eternal Return ricochet: when a boomerang projectile crosses an arena edge,
 * mirror its velocity along the breached axis and clamp the position back
 * inside the arena. Returns true when a ricochet was consumed so the caller
 * can skip the flip pass (consuming both effects on the same tick would
 * undo the bounce).
 */
function tryRicochetOffEdge(eid: number): boolean {
  const remaining = getRicochetsRemaining(eid);
  if (remaining <= 0) return false;
  const px = Position.x[eid] ?? 0;
  const py = Position.y[eid] ?? 0;
  const vx = Velocity.vx[eid] ?? 0;
  const vy = Velocity.vy[eid] ?? 0;
  let bounced = false;
  if (px < 0 && vx < 0) {
    Position.x[eid] = 0;
    Velocity.vx[eid] = -vx;
    bounced = true;
  } else if (px > ARENA_SIZE_PX && vx > 0) {
    Position.x[eid] = ARENA_SIZE_PX;
    Velocity.vx[eid] = -vx;
    bounced = true;
  }
  if (py < 0 && vy < 0) {
    Position.y[eid] = 0;
    Velocity.vy[eid] = -vy;
    bounced = true;
  } else if (py > ARENA_SIZE_PX && vy > 0) {
    Position.y[eid] = ARENA_SIZE_PX;
    Velocity.vy[eid] = -vy;
    bounced = true;
  }
  if (bounced) consumeRicochet(eid);
  return bounced;
}

const projectileQuery = defineQuery([ProjectileTag, Lifetime, Position]);

export function projectileSystem(world: World, dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  const projectiles = projectileQuery(world);

  for (let i = 0; i < projectiles.length; i++) {
    const eid = projectiles[i];
    if (eid === undefined) continue;

    // Lifetime decrement. Skip for orbiters (they live as long as the weapon is equipped).
    if (hasComponent(world, Dead, eid) || isOrbiter(eid)) continue;

    let remaining = Lifetime.remainingMs[eid] ?? 0;
    remaining -= dtMs;
    if (remaining <= 0) {
      Lifetime.remainingMs[eid] = 0;
      addComponent(world, Dead, eid);
      continue;
    }
    Lifetime.remainingMs[eid] = remaining;

    // Eternal Return: ricochet off arena edges. Process BEFORE the boomerang
    // flip so a projectile that crosses the edge near the flip-time still
    // bounces correctly. A ricochet refunds the projectile some lifetime so
    // it can complete the bounced trajectory; otherwise edge-hits at end of
    // life would just die mid-air. +400ms per bounce is enough to clear the
    // edge and still be reaped before stacking up.
    if (tryRicochetOffEdge(eid)) {
      const cur = Lifetime.remainingMs[eid] ?? 0;
      Lifetime.remainingMs[eid] = cur + 400;
    }

    // Boomerang flip: at midpoint, reverse velocity so it returns.
    if (consumeBoomerangFlip(eid)) {
      Velocity.vx[eid] = -(Velocity.vx[eid] ?? 0);
      Velocity.vy[eid] = -(Velocity.vy[eid] ?? 0);
    }
  }
}
